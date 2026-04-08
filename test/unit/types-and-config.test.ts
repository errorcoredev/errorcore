import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveConfig } from '../../src/config';
import type {
  ErrorInfo,
  ErrorPackage,
  IOEventSerialized,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  SerializationLimits,
  StateReadSerialized,
  TransportConfig
} from '../../src/types';
import { resolveTestConfig } from '../helpers/test-config';

describe('resolveConfig', () => {
  it('returns the full default configuration when transport is explicit', () => {
    const resolved = resolveTestConfig();

    expect(resolved).toEqual({
      bufferSize: 200,
      bufferMaxBytes: 52428800,
      maxPayloadSize: 32768,
      maxConcurrentRequests: 50,
      rateLimitPerMinute: 60,
      rateLimitWindowMs: 60000,
      headerAllowlist: [
        'content-type',
        'content-length',
        'accept',
        'user-agent',
        'x-request-id',
        'x-correlation-id',
        'host'
      ],
      headerBlocklist: [
        /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
        /auth|token|key|secret|password|credential/i
      ],
      envAllowlist: [
        'NODE_ENV',
        'NODE_VERSION',
        'PORT',
        'HOST',
        'TZ',
        'LANG',
        'npm_package_version',
        'HOSTNAME',
        'POD_NAME',
        'POD_NAMESPACE',
        'POD_IP',
        'NODE_NAME',
        'KUBERNETES_SERVICE_HOST',
        'ECS_CONTAINER_METADATA_URI',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
        'CLOUD_RUN_JOB',
        'K_SERVICE',
        'K_REVISION',
        'RENDER_SERVICE_NAME',
        'FLY_APP_NAME',
        'FLY_REGION',
        'DEPLOYMENT_ID',
        'IMAGE_TAG',
        'REPLICA_SET'
      ],
      envBlocklist: [/key|secret|token|password|credential|auth|private/i],
      encryptionKey: undefined,
      allowUnencrypted: false,
      transport: { type: 'stdout' },
      captureLocalVariables: false,
      captureDbBindParams: false,
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureBody: false,
      captureBodyDigest: false,
      bodyCaptureContentTypes: [
        'application/json',
        'application/x-www-form-urlencoded',
        'text/plain',
        'application/xml'
      ],
      piiScrubber: undefined,
      replaceDefaultScrubber: false,
      serialization: {
        maxDepth: 8,
        maxArrayItems: 20,
        maxObjectKeys: 50,
        maxStringLength: 2048,
        maxPayloadSize: 32768,
        maxTotalPackageSize: 5242880
      },
      maxLocalsCollectionsPerSecond: 20,
      maxCachedLocals: 50,
      maxLocalsFrames: 5,
      uncaughtExceptionExitDelayMs: 1500,
      allowPlainHttpTransport: false,
      allowInvalidCollectorCertificates: false,
      allowInsecureTransport: false,
      maxDrainOnStartup: 100,
      useWorkerAssembly: false,
      flushIntervalMs: 5000,
      resolveSourceMaps: true
    });
  });

  it('merges user config over defaults', () => {
    const resolved = resolveTestConfig({
      bufferSize: 500,
      captureBody: false,
      captureBodyDigest: true,
      bodyCaptureContentTypes: ['application/json'],
      serialization: { maxDepth: 4 },
      transport: { type: 'file', path: '/tmp/errorcore.log' }
    });

    expect(resolved.bufferSize).toBe(500);
    expect(resolved.captureBody).toBe(false);
    expect(resolved.captureRequestBodies).toBe(false);
    expect(resolved.captureResponseBodies).toBe(false);
    expect(resolved.captureBodyDigest).toBe(true);
    expect(resolved.bodyCaptureContentTypes).toEqual(['application/json']);
    expect(resolved.serialization).toEqual({
      maxDepth: 4,
      maxArrayItems: 20,
      maxObjectKeys: 50,
      maxStringLength: 2048,
      maxPayloadSize: 32768,
      maxTotalPackageSize: 5242880
    });
    expect(resolved.transport).toEqual({ type: 'file', path: '/tmp/errorcore.log' });
  });

  it('rejects invalid numeric values with descriptive errors', () => {
    expect(() => resolveTestConfig({ bufferSize: 0 })).toThrow(
      'bufferSize must be a positive integer'
    );
    expect(() => resolveTestConfig({ bufferSize: 9 })).toThrow(
      'bufferSize must be between 10 and 100000'
    );
    expect(() => resolveTestConfig({ bufferMaxBytes: 1048575 })).toThrow(
      'bufferMaxBytes must be at least 1048576'
    );
    expect(() => resolveTestConfig({ maxPayloadSize: 1023 })).toThrow(
      'maxPayloadSize must be at least 1024'
    );
    expect(() =>
      resolveTestConfig({ bufferMaxBytes: 1048576, maxPayloadSize: 1048577 })
    ).toThrow('maxPayloadSize must be less than or equal to bufferMaxBytes');
    expect(() =>
      resolveTestConfig({ serialization: { maxArrayItems: 0 } })
    ).toThrow('serialization.maxArrayItems must be a positive integer');
  });

  it('rejects invalid encryptionKey', () => {
    expect(() => resolveTestConfig({ encryptionKey: 'tooshort' })).toThrow(
      'encryptionKey must be a 64-character hex string'
    );
    expect(() => resolveTestConfig({ encryptionKey: 'zz' + 'a'.repeat(62) })).toThrow(
      'encryptionKey must be a 64-character hex string'
    );
    expect(() =>
      resolveTestConfig({ encryptionKey: 'ab'.repeat(32) })
    ).not.toThrow();
  });

  it('rejects non-function piiScrubber', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ piiScrubber: 'not-a-function' })
    ).toThrow('piiScrubber must be a function or undefined');
    expect(() =>
      resolveTestConfig({ piiScrubber: (_k: string, v: unknown) => v })
    ).not.toThrow();
  });

  it('rejects non-string-array headerAllowlist and envAllowlist', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ headerAllowlist: [123] })
    ).toThrow('headerAllowlist must be an array of strings');
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ envAllowlist: [/regex/] })
    ).toThrow('envAllowlist must be an array of strings');
    expect(() =>
      resolveTestConfig({ headerAllowlist: ['x-custom'] })
    ).not.toThrow();
  });

  it('rejects non-RegExp-array headerBlocklist and envBlocklist', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ headerBlocklist: ['not-a-regexp'] })
    ).toThrow('headerBlocklist must be an array of RegExp');
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ envBlocklist: [42] })
    ).toThrow('envBlocklist must be an array of RegExp');
    expect(() =>
      resolveTestConfig({ headerBlocklist: [/secret/i] })
    ).not.toThrow();
  });

  it('keeps the default header blocklist effective even when allowlisted', () => {
    const resolved = resolveTestConfig({
      headerAllowlist: ['authorization', 'content-type']
    });

    expect(resolved.headerAllowlist).toContain('authorization');
    expect(
      resolved.headerBlocklist.some((pattern) => pattern.test('authorization'))
    ).toBe(true);
  });

  it('ignores unknown keys', () => {
    const resolved = resolveTestConfig({
      bufferSize: 250,
      // @ts-expect-error verifying unknown keys are ignored at runtime
      unknownKey: 'ignored'
    });

    expect(resolved.bufferSize).toBe(250);
    expect('unknownKey' in resolved).toBe(false);
  });

  it('accepts HTTP transport with a valid https:// URL', () => {
    const resolved = resolveTestConfig({
      transport: {
        type: 'http',
        url: 'https://example.com/collect',
        authorization: 'Bearer secret-token'
      }
    });
    expect(resolved.transport).toEqual({ type: 'http', url: 'https://example.com/collect' });
    expect(JSON.stringify(resolved)).not.toContain('secret-token');
  });

  it('requires transport to be configured explicitly in all environments', () => {
    expect(() => resolveConfig({})).toThrow('transport must be configured explicitly');
  });

  it('uses the split HTTP transport flags', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'http', url: 'http://example.com/collect' }
      })
    ).toThrow('allowPlainHttpTransport');

    expect(
      resolveConfig({
        transport: { type: 'http', url: 'http://example.com/collect' },
        allowPlainHttpTransport: true,
        allowInvalidCollectorCertificates: true
      })
    ).toMatchObject({
      allowPlainHttpTransport: true,
      allowInvalidCollectorCertificates: true,
      allowInsecureTransport: true
    });
  });

  it('ships a production-oriented config template', () => {
    const template = fs.readFileSync(
      path.join(process.cwd(), 'config-template', 'errorcore.config.js'),
      'utf8'
    );

    expect(template).toContain('allowUnencrypted: true');
    expect(template).toContain('allowPlainHttpTransport: false');
    expect(template).toContain('allowInvalidCollectorCertificates: false');
    expect(template).not.toContain("'multipart/form-data'");
    expect(template).not.toMatch(/^\s*transport:\s*\{\s*type:\s*'stdout'/m);
    expect(template).toContain('captureRequestBodies: false');
    expect(template).toContain('captureResponseBodies: false');
  });

  it('maps legacy captureBody to both request and response capture for compatibility', () => {
    const resolved = resolveTestConfig({
      captureBody: true
    });

    expect(resolved.captureBody).toBe(true);
    expect(resolved.captureRequestBodies).toBe(true);
    expect(resolved.captureResponseBodies).toBe(true);
  });

  it('prefers explicit request and response capture controls over the legacy alias', () => {
    const resolved = resolveTestConfig({
      captureBody: true,
      captureRequestBodies: true,
      captureResponseBodies: false
    });

    expect(resolved.captureBody).toBe(false);
    expect(resolved.captureRequestBodies).toBe(true);
    expect(resolved.captureResponseBodies).toBe(false);
  });
});

describe('type exports', () => {
  it('exports the shared interfaces successfully', () => {
    const transportConfig: TransportConfig = { type: 'stdout' };
    const requestSummary: RequestSummary = {
      requestId: 'req-1',
      method: 'GET',
      url: '/health',
      startTime: '1'
    };
    const processMetadata: ProcessMetadata = {
      nodeVersion: 'v20.0.0',
      v8Version: '11.0',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      hostname: 'test-host',
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 1,
      activeRequests: 0,
      eventLoopLagMs: 0
    };
    const errorInfo: ErrorInfo = {
      type: 'Error',
      message: 'boom',
      stack: 'stack',
      properties: {}
    };
    const ioEvent: IOEventSerialized = {
      seq: 1,
      type: 'http-server',
      direction: 'inbound',
      target: 'service',
      method: 'GET',
      url: '/health',
      statusCode: 200,
      fd: null,
      requestId: 'req-1',
      contextLost: false,
      startTime: '1',
      endTime: '2',
      durationMs: 1,
      requestHeaders: { host: 'localhost' },
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyTruncated: false,
      responseBodyTruncated: false,
      requestBodyOriginalSize: null,
      responseBodyOriginalSize: null,
      error: null,
      aborted: false
    };
    const stateRead: StateReadSerialized = {
      container: 'cache',
      operation: 'get',
      key: 'user:1',
      value: { id: 1 },
      timestamp: '1'
    };
    const limits: SerializationLimits = {
      maxDepth: 1,
      maxArrayItems: 1,
      maxObjectKeys: 1,
      maxStringLength: 1,
      maxPayloadSize: 1024,
      maxTotalPackageSize: 1024
    };
    const resolved: ResolvedConfig = resolveTestConfig();
    const errorPackage: ErrorPackage = {
      schemaVersion: '1.0.0',
      capturedAt: '2026-01-01T00:00:00.000Z',
      error: {
        type: errorInfo.type,
        message: errorInfo.message,
        stack: errorInfo.stack,
        properties: errorInfo.properties
      },
      ioTimeline: [ioEvent],
      stateReads: [stateRead],
      concurrentRequests: [requestSummary],
      processMetadata,
      codeVersion: {},
      environment: {},
      completeness: {
        requestCaptured: false,
        requestBodyTruncated: false,
        ioTimelineCaptured: true,
        ioEventsDropped: 0,
        ioPayloadsTruncated: 0,
        alsContextAvailable: false,
        localVariablesCaptured: false,
        localVariablesTruncated: false,
        stateTrackingEnabled: false,
        stateReadsCaptured: false,
        concurrentRequestsCaptured: false,
        piiScrubbed: true,
        encrypted: false,
        captureFailures: []
      }
    };

    expect(transportConfig.type).toBe('stdout');
    expect(requestSummary.requestId).toBe('req-1');
    expect(processMetadata.pid).toBe(1);
    expect(errorPackage.schemaVersion).toBe('1.0.0');
    expect(limits.maxPayloadSize).toBe(1024);
    expect(resolved.transport.type).toBe('stdout');
  });
});
