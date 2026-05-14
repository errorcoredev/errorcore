import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveConfig, detectServerlessEnvironment } from '../../src/config';
import { ALSManager } from '../../src/context/als-manager';
import type { SDKInstanceLike } from '../../src/middleware/common';
import type { RequestContext } from '../../src/types';
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
  let wrapServerless: typeof import('../../src/middleware/lambda').wrapServerless;

  beforeEach(async () => {
    const mod = await import('../../src/middleware/lambda');
    wrapLambda = mod.wrapLambda;
    wrapServerless = mod.wrapServerless;
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

  it('tracks API Gateway v2 context through wrapLambda', async () => {
    const sdk = makeActiveSdk();
    const handler = vi.fn().mockImplementation(async () => {
      expect(sdk.als.getContext?.()?.method).toBe('POST');
      return { statusCode: 201 };
    });

    const wrapped = wrapLambda(handler, sdk);
    await expect(wrapped(
      {
        requestContext: { http: { method: 'POST' } },
        rawPath: '/api/test',
        headers: {
          'content-type': 'application/json',
          traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
          tracestate: 'vendor=value'
        }
      },
      makeLambdaContext()
    )).resolves.toEqual({ statusCode: 201 });

    expect(sdk.als.createRequestContext).toHaveBeenCalledWith({
      method: 'POST',
      url: '/api/test',
      headers: {
        'content-type': 'application/json',
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
        tracestate: 'vendor=value'
      },
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      tracestate: 'vendor=value'
    });
    expect(sdk.requestTracker.add).toHaveBeenCalledOnce();
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith('lambda-request');
    expect(sdk.flush).toHaveBeenCalledOnce();
  });

  it('tracks API Gateway v1 multi-value headers through wrapLambda', async () => {
    const sdk = makeActiveSdk();
    const handler = vi.fn().mockResolvedValue({ statusCode: 204 });
    const wrapped = wrapLambda(handler, sdk);

    await wrapped(
      {
        httpMethod: 'GET',
        path: '/api/users',
        requestContext: { stage: 'prod' },
        headers: { host: 'api.example.com' },
        multiValueHeaders: { 'x-request-id': ['a', 'b'] }
      },
      makeLambdaContext()
    );

    expect(sdk.als.createRequestContext).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/api/users',
      headers: {
        host: 'api.example.com',
        'x-request-id': 'a, b'
      }
    }));
  });

  it('reports ALB event source to the watchdog', async () => {
    const sdk = makeActiveSdk();
    const wrapped = wrapLambda(vi.fn().mockResolvedValue({ statusCode: 200 }), sdk);

    await wrapped(
      {
        httpMethod: 'GET',
        path: '/health',
        requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:...' } },
        headers: {}
      },
      makeLambdaContext()
    );

    expect(sdk.getWatchdog?.()?.notifyInvokeStart).toHaveBeenCalledWith(expect.objectContaining({
      eventSource: 'alb',
      lambdaRequestId: 'req-123'
    }));
  });

  it('extracts SQS trace attributes and reports the synthetic event source', async () => {
    const sdk = makeActiveSdk();
    const wrapped = wrapLambda(vi.fn().mockResolvedValue('ok'), sdk);

    await wrapped(
      {
        Records: [{
          eventSource: 'aws:sqs',
          body: '{}',
          messageAttributes: {
            traceparent: { stringValue: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00` },
            tracestate: { stringValue: 'queue=alpha' }
          }
        }]
      },
      makeLambdaContext()
    );

    expect(sdk.als.createRequestContext).toHaveBeenCalledWith(expect.objectContaining({
      method: 'INVOKE',
      url: 'sqs/test-function',
      traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`,
      tracestate: 'queue=alpha'
    }));
    expect(sdk.getWatchdog?.()?.notifyInvokeStart).toHaveBeenCalledWith(expect.objectContaining({
      eventSource: 'sqs'
    }));
  });

  it('captures thrown handler errors and removes request context once', async () => {
    const sdk = makeActiveSdk();
    const thrown = new Error('lambda failed');
    const wrapped = wrapLambda(vi.fn().mockRejectedValue(thrown), sdk);

    await expect(wrapped(
      { Records: [{ EventSource: 'aws:sns', Sns: { Message: 'test' } }] },
      makeLambdaContext()
    )).rejects.toThrow('lambda failed');

    expect(sdk.captureError).toHaveBeenCalledWith(thrown);
    expect(sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(sdk.getWatchdog?.()?.notifyInvokeEnd).toHaveBeenCalledOnce();
  });

  it('captures 5xx API Gateway results', async () => {
    const sdk = makeActiveSdk();
    const wrapped = wrapLambda(vi.fn().mockResolvedValue({ statusCode: 503 }), sdk);

    await expect(wrapped(
      {
        source: 'aws.ec2',
        'detail-type': 'EC2 Instance State-change Notification',
        detail: {}
      },
      makeLambdaContext()
    )).resolves.toEqual({ statusCode: 503 });

    expect(sdk.als.createRequestContext).toHaveBeenCalledWith(expect.objectContaining({
      method: 'INVOKE',
      url: 'eventbridge/test-function'
    }));
    expect(sdk.captureError).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ServerError',
      message: 'HTTP 503'
    }));
  });

  it('re-arms local capture before Lambda and generic serverless handlers run', async () => {
    const lambdaSdk = makeActiveSdk();
    const lambdaPrepare = lambdaSdk.prepareForRequestStart;
    const lambdaWrapped = wrapLambda(async () => {
      expect(lambdaPrepare).toHaveBeenCalledTimes(1);
      return { statusCode: 200 };
    }, lambdaSdk);

    await lambdaWrapped(
      { httpMethod: 'GET', path: '/lambda', headers: {} },
      makeLambdaContext()
    );

    const moduleRef = await import('../../src/index');
    await moduleRef.shutdown();
    const serverlessSdk = moduleRef.init({
      allowUnencrypted: true,
      captureLocalVariables: false,
      silent: true,
      transport: { type: 'stdout' }
    });
    const serverlessPrepare = vi.spyOn(serverlessSdk, 'prepareForRequestStart');

    const serverlessWrapped = wrapServerless(async () => {
      expect(serverlessPrepare).toHaveBeenCalledTimes(1);
      return 'ok';
    });

    try {
      await expect(serverlessWrapped()).resolves.toBe('ok');
    } finally {
      await moduleRef.shutdown();
    }
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

function makeRequestContext(input?: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'lambda-request',
    startTime: 1n,
    method: input?.method ?? 'GET',
    url: input?.url ?? '/',
    headers: input?.headers ?? {},
    body: null,
    bodyTruncated: false,
    ioEvents: [],
    stateReads: [],
    stateWrites: [],
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    traceFlags: 1,
    isEntrySpan: true,
    ...input
  };
}

function makeActiveSdk(): SDKInstanceLike & { prepareForRequestStart: ReturnType<typeof vi.fn> } {
  let currentContext: RequestContext | undefined;
  const watchdog = {
    notifyInvokeStart: vi.fn(),
    notifyInvokeEnd: vi.fn()
  };

  const sdk: SDKInstanceLike = {
    isActive: vi.fn(() => true),
    captureError: vi.fn(),
    prepareForRequestStart: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    als: {
      createRequestContext: vi.fn((input) => makeRequestContext({
        method: input.method,
        url: input.url,
        headers: input.headers,
        inboundTracestate: input.tracestate
      })),
      getContext: vi.fn(() => currentContext),
      runWithContext: vi.fn((ctx, fn) => {
        const previous = currentContext;
        currentContext = ctx;
        try {
          return fn();
        } finally {
          currentContext = previous;
        }
      })
    },
    requestTracker: {
      add: vi.fn(),
      remove: vi.fn()
    },
    headerFilter: {
      filterAndNormalizeHeaders: vi.fn((headers: unknown) => {
        const result: Record<string, string> = {};
        if (headers != null && typeof headers === 'object') {
          for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof value === 'string') result[key.toLowerCase()] = value;
          }
        }
        return result;
      })
    },
    processMetadata: {
      setServerlessMetadata: vi.fn()
    },
    getWatchdog: vi.fn(() => watchdog)
  };

  return sdk;
}
