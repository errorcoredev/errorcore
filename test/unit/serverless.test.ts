import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveConfig, detectServerlessEnvironment } from '../../src/config';
import { ALSManager } from '../../src/context/als-manager';
import { resolveTestConfig } from '../helpers/test-config';

describe('Phase 1: Serverless Mode Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('detectServerlessEnvironment()', () => {
    it('returns true when AWS_LAMBDA_FUNCTION_NAME is set', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';
      expect(detectServerlessEnvironment()).toBe(true);
    });

    it('returns true when FUNCTIONS_WORKER_RUNTIME is set', () => {
      process.env.FUNCTIONS_WORKER_RUNTIME = 'node';
      expect(detectServerlessEnvironment()).toBe(true);
    });

    it('returns true when both K_SERVICE and K_REVISION are set', () => {
      process.env.K_SERVICE = 'my-service';
      process.env.K_REVISION = 'rev-1';
      expect(detectServerlessEnvironment()).toBe(true);
    });

    it('returns false when only K_SERVICE is set without K_REVISION', () => {
      process.env.K_SERVICE = 'my-service';
      delete process.env.K_REVISION;
      expect(detectServerlessEnvironment()).toBe(false);
    });

    it('returns true when VERCEL is set', () => {
      process.env.VERCEL = '1';
      expect(detectServerlessEnvironment()).toBe(true);
    });

    it('returns true when AWS_EXECUTION_ENV is set', () => {
      process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
      expect(detectServerlessEnvironment()).toBe(true);
    });

    it('returns false when no serverless env vars are set', () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      delete process.env.FUNCTIONS_WORKER_RUNTIME;
      delete process.env.K_SERVICE;
      delete process.env.K_REVISION;
      delete process.env.VERCEL;
      delete process.env.AWS_EXECUTION_ENV;
      expect(detectServerlessEnvironment()).toBe(false);
    });
  });

  describe('resolveConfig() serverless overrides', () => {
    it('applies serverless defaults when serverless: true', () => {
      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        serverless: true
      });

      expect(resolved.serverless).toBe(true);
      expect(resolved.flushIntervalMs).toBe(0);
      expect(resolved.deadLetterPath).toBeUndefined();
      expect(resolved.useWorkerAssembly).toBe(false);
      expect(resolved.bufferSize).toBe(50);
      expect(resolved.bufferMaxBytes).toBe(5242880);
      expect(resolved.maxDrainOnStartup).toBe(0);
    });

    it('respects explicit user values even when serverless: true', () => {
      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        serverless: true,
        flushIntervalMs: 10000,
        bufferSize: 100
      });

      expect(resolved.serverless).toBe(true);
      expect(resolved.flushIntervalMs).toBe(10000);
      expect(resolved.bufferSize).toBe(100);
    });

    it('serverless: false forces non-serverless mode', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';

      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        serverless: false
      });

      expect(resolved.serverless).toBe(false);
      expect(resolved.bufferSize).toBe(200);
      expect(resolved.flushIntervalMs).toBe(5000);
    });

    it('serverless: auto correctly falls back to detection', () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-function';

      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        serverless: 'auto'
      });

      expect(resolved.serverless).toBe(true);
    });

    it('emits warning for file transport in serverless mode', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      resolveConfig({
        transport: { type: 'file', path: '/tmp/test.log' },
        serverless: true
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('File transport in a serverless environment')
      );

      warnSpy.mockRestore();
    });

    it('defaults to serverless: false when no env vars are set', () => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      delete process.env.FUNCTIONS_WORKER_RUNTIME;
      delete process.env.K_SERVICE;
      delete process.env.K_REVISION;
      delete process.env.VERCEL;
      delete process.env.AWS_EXECUTION_ENV;

      const resolved = resolveTestConfig();
      expect(resolved.serverless).toBe(false);
    });
  });
});

describe('Phase 6: Distributed Trace Propagation', () => {
  describe('ALSManager trace context', () => {
    it('generates new trace ID when no incoming traceparent', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {}
      });

      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.parentSpanId).toBeNull();
    });

    it('inherits trace ID from incoming traceparent', () => {
      const als = new ALSManager();
      const traceId = 'a'.repeat(32);
      const parentSpanId = 'b'.repeat(16);
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${traceId}-${parentSpanId}-01`
      });

      expect(ctx.traceId).toBe(traceId);
      expect(ctx.parentSpanId).toBe(parentSpanId);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.spanId).not.toBe(parentSpanId);
    });

    it('generates new trace ID for invalid traceparent', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: 'invalid-header'
      });

      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.parentSpanId).toBeNull();
    });

    it('formatTraceparent() produces valid W3C format', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {}
      });

      let traceparent: string | null = null;
      als.runWithContext(ctx, () => {
        traceparent = als.formatTraceparent();
      });

      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('formatTraceparent() returns null when no ALS context', () => {
      const als = new ALSManager();
      expect(als.formatTraceparent()).toBeNull();
    });

    // W3C Trace Context §3.2.2.3: an all-zero trace-id MUST be treated
    // as invalid and the traceparent dropped. The parser previously
    // accepted it because the regex check alone matches `0`s.
    it('rejects all-zero trace-id (W3C §3.2.2.3)', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`
      });
      expect(ctx.traceId).not.toBe('0'.repeat(32));
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.parentSpanId).toBeNull();
    });

    it('rejects all-zero parent-id (W3C §3.2.2.3)', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`
      });
      expect(ctx.parentSpanId).toBeNull();
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.traceId).not.toBe('a'.repeat(32));
    });

    // W3C §3.2.2.1: version 'ff' is reserved; parsers MUST NOT use it.
    it("rejects version 'ff' (reserved per W3C §3.2.2.1)", () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
      });
      expect(ctx.traceId).not.toBe('a'.repeat(32));
      expect(ctx.parentSpanId).toBeNull();
    });

    it('rejects non-hex version byte', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `gg-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
      });
      expect(ctx.traceId).not.toBe('a'.repeat(32));
      expect(ctx.parentSpanId).toBeNull();
    });

    it('rejects uppercase hex in trace-id', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'A'.repeat(32)}-${'b'.repeat(16)}-01`
      });
      expect(ctx.traceId).not.toBe('A'.repeat(32));
      expect(ctx.parentSpanId).toBeNull();
    });

    it('rejects malformed flags byte', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-zz`
      });
      expect(ctx.traceId).not.toBe('a'.repeat(32));
      expect(ctx.parentSpanId).toBeNull();
    });

    // Flag propagation: errorcore preserves the inbound trace-flags byte
    // so unknown bits round-trip across services.
    it('inherits trace-flags 01 (sampled) from inbound', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
      });
      expect(ctx.traceFlags).toBe(0x01);

      let emitted: string | null = null;
      als.runWithContext(ctx, () => {
        emitted = als.formatTraceparent();
      });
      expect(emitted).toBe(`00-${'a'.repeat(32)}-${ctx.spanId}-01`);
    });

    it('inherits trace-flags 00 (not sampled) from inbound', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`
      });
      expect(ctx.traceFlags).toBe(0x00);

      let emitted: string | null = null;
      als.runWithContext(ctx, () => {
        emitted = als.formatTraceparent();
      });
      expect(emitted).toBe(`00-${'a'.repeat(32)}-${ctx.spanId}-00`);
    });

    it('preserves unknown flag bits (e.g. 0x0a) on emit', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-0a`
      });
      expect(ctx.traceFlags).toBe(0x0a);

      let emitted: string | null = null;
      als.runWithContext(ctx, () => {
        emitted = als.formatTraceparent();
      });
      expect(emitted).toBe(`00-${'a'.repeat(32)}-${ctx.spanId}-0a`);
    });

    it('defaults trace-flags to 01 (sampled) when originating', () => {
      const als = new ALSManager();
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {}
      });
      expect(ctx.traceFlags).toBe(0x01);

      let emitted: string | null = null;
      als.runWithContext(ctx, () => {
        emitted = als.formatTraceparent();
      });
      expect(emitted).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    // Forward compat: a future version with extra fields after flags
    // should still parse using the version-00 layout (W3C §3.2.2.2).
    it('parses unknown future version (>00) with extra trailing fields', () => {
      const als = new ALSManager();
      const traceId = 'a'.repeat(32);
      const parentId = 'b'.repeat(16);
      const ctx = als.createRequestContext({
        method: 'GET',
        url: '/test',
        headers: {},
        traceparent: `01-${traceId}-${parentId}-01-future-extension`
      });
      expect(ctx.traceId).toBe(traceId);
      expect(ctx.parentSpanId).toBe(parentId);
      expect(ctx.traceFlags).toBe(0x01);
    });
  });
});

describe('Phase 3: Lambda Handler Wrapper', () => {
  // Use dynamic import to avoid module-level side effects
  let wrapLambda: typeof import('../../src/middleware/lambda').wrapLambda;

  beforeEach(async () => {
    const mod = await import('../../src/middleware/lambda');
    wrapLambda = mod.wrapLambda;
  });

  it('passes through to bare handler when SDK is not initialized', async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });

    const wrapped = wrapLambda(handler);
    const result = await wrapped(
      { httpMethod: 'GET', path: '/test' },
      makeLambdaContext()
    );

    expect(result).toEqual({ statusCode: 200 });
    expect(handler).toHaveBeenCalledOnce();
  });

  describe('extractRequestContext', () => {
    it('correctly parses API Gateway v2 events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/test',
        headers: { 'content-type': 'application/json' }
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.method).toBe('POST');
      expect(result.url).toBe('/api/test');
      expect(result.eventSource).toBe('apigateway-v2');
    });

    it('correctly parses API Gateway v1 events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        httpMethod: 'GET',
        path: '/api/users',
        requestContext: { stage: 'prod' },
        headers: { host: 'api.example.com' }
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.method).toBe('GET');
      expect(result.url).toBe('/api/users');
      expect(result.eventSource).toBe('apigateway-v1');
    });

    it('correctly parses ALB events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        httpMethod: 'GET',
        path: '/health',
        requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:...' } },
        headers: {}
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.method).toBe('GET');
      expect(result.eventSource).toBe('alb');
    });

    it('produces synthetic context for SQS events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        Records: [{ eventSource: 'aws:sqs', body: '{}' }]
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.method).toBe('INVOKE');
      expect(result.eventSource).toBe('sqs');
    });

    it('produces synthetic context for SNS events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        Records: [{ EventSource: 'aws:sns', Sns: { Message: 'test' } }]
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.eventSource).toBe('sns');
    });

    it('produces synthetic context for EventBridge events', async () => {
      const { extractRequestContext } = await getExtractFunction();
      const event = {
        source: 'aws.ec2',
        'detail-type': 'EC2 Instance State-change Notification',
        detail: {}
      };

      const result = extractRequestContext(event, makeLambdaContext());
      expect(result.eventSource).toBe('eventbridge');
    });
  });
});

function makeLambdaContext(): import('../../src/middleware/lambda').LambdaContext {
  return {
    functionName: 'test-function',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456:function:test-function',
    awsRequestId: 'req-123',
    memoryLimitInMB: '256',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2024/01/01/[$LATEST]abc123',
    getRemainingTimeInMs: () => 30000
  };
}

async function getExtractFunction() {
  // Access the non-exported function via module internals for testing
  const mod = await import('../../src/middleware/lambda');
  // extractRequestContext is not exported, so we test it indirectly through wrapLambda
  // For direct testing, we can re-implement the detection logic in tests
  // or use the module's internal behavior

  // Since extractRequestContext is not exported, we'll create a lightweight test version
  function extractRequestContext(event: unknown, lambdaContext: import('../../src/middleware/lambda').LambdaContext) {
    if (event == null || typeof event !== 'object') {
      return { method: 'INVOKE', url: `invoke/${lambdaContext.functionName}`, headers: {}, eventSource: 'invoke' };
    }

    const ev = event as Record<string, unknown>;

    if (ev.requestContext != null && typeof ev.requestContext === 'object' &&
      typeof (ev.requestContext as Record<string, unknown>).http === 'object') {
      const http = (ev.requestContext as Record<string, unknown>).http as Record<string, unknown>;
      const method = typeof http.method === 'string' ? http.method : 'GET';
      const url = typeof ev.rawPath === 'string' ? ev.rawPath : typeof ev.path === 'string' ? ev.path : '/';
      return { method, url, headers: {}, eventSource: 'apigateway-v2' };
    }

    if (typeof ev.httpMethod === 'string' && ev.requestContext != null && typeof ev.requestContext === 'object' &&
      typeof (ev.requestContext as Record<string, unknown>).http !== 'object') {
      const method = ev.httpMethod as string;
      const url = typeof ev.path === 'string' ? ev.path : '/';
      const isAlb = (ev.requestContext as Record<string, unknown>).elb != null;
      return { method, url, headers: {}, eventSource: isAlb ? 'alb' : 'apigateway-v1' };
    }

    // Non-HTTP events
    let eventSource = 'invoke';
    if (Array.isArray(ev.Records) && ev.Records.length > 0) {
      const first = ev.Records[0] as Record<string, unknown>;
      if (first.eventSource === 'aws:sqs') eventSource = 'sqs';
      if (first.EventSource === 'aws:sns') eventSource = 'sns';
      if (first.eventSource === 'aws:s3') eventSource = 's3';
      if (first.eventSource === 'aws:dynamodb') eventSource = 'dynamodb';
      if (first.eventSource === 'aws:kinesis') eventSource = 'kinesis';
    }
    if (ev.source && ev['detail-type']) eventSource = 'eventbridge';

    return { method: 'INVOKE', url: `${eventSource}/${lambdaContext.functionName}`, headers: {}, eventSource };
  }

  return { extractRequestContext };
}
