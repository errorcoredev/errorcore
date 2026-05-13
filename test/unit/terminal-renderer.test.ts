import { describe, expect, it } from 'vitest';

import { renderErrorRecord } from '../../src/ui';
import type { ErrorPackage } from '../../src/types';

describe('terminal error renderer', () => {
  it('renders representative package sections without exposing redacted values', () => {
    const output = renderErrorRecord(makeErrorPackage());

    expect(output).toContain('TypeError: database write failed');
    expect(output).toContain('Origin');
    expect(output).toContain('/srv/app/src/routes.ts:42');
    expect(output).toContain('Stack Trace');
    expect(output).toContain('System Snapshot');
    expect(output).toContain('Request Context');
    expect(output).toContain('POST /checkout?token=[REDACTED]');
    expect(output).toContain('IO Timeline');
    expect(output).toContain('https://api.example.test/orders?api_key=[REDACTED]');
    expect(output).toContain('DB Queries');
    expect(output).toContain("select * from users where password='[REDACTED]'");
    expect(output).toContain('Local Variables');
    expect(output).toContain('password: "[REDACTED]"');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('hunter2');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('renders minimal packages with empty optional sections gracefully', () => {
    const output = renderErrorRecord({
      ...makeErrorPackage(),
      error: {
        type: 'Error',
        message: 'no stack',
        stack: '',
        properties: {}
      },
      request: undefined,
      ioTimeline: [],
      localVariables: []
    });

    expect(output).toContain('Error: no stack');
    expect(output).toContain('Stack Trace');
    expect(output).toContain('(no stack frames)');
    expect(output).toContain('System Snapshot');
    expect(output).not.toContain('Request Context');
    expect(output).not.toContain('IO Timeline');
    expect(output).not.toContain('DB Queries');
    expect(output).not.toContain('Local Variables');
  });

  it('surfaces external library origin while keeping app boundary visible', () => {
    const output = renderErrorRecord({
      ...makeErrorPackage(),
      errorOrigin: {
        origin: 'external',
        package: '@prisma/client',
        errorType: 'PrismaClientKnownRequestError',
        appBoundaryFrame: {
          functionName: 'loadUser',
          filePath: '/srv/app/src/services/user.ts',
          lineNumber: 42,
          columnNumber: 9
        },
        externalFramesCollapsed: true,
        externalFrameCount: 2,
        appFrameCount: 1
      },
      error: {
        type: 'PrismaClientKnownRequestError',
        message: 'unique constraint failed',
        stack: [
          'PrismaClientKnownRequestError: unique constraint failed',
          '    at request (/srv/app/node_modules/@prisma/client/runtime/index.js:10:5)',
          '    at loadUser (/srv/app/src/services/user.ts:42:9)'
        ].join('\n'),
        properties: {}
      }
    });

    expect(output).toContain('external library: @prisma/client');
    expect(output).toContain('/srv/app/src/services/user.ts:42');
    expect(output).toContain('(1 node_modules frame)');
  });
});

function makeErrorPackage(): ErrorPackage {
  return {
    schemaVersion: '1.1.0',
    eventId: 'evt_terminal_renderer',
    service: 'checkout-api',
    capturedAt: '2026-05-06T00:00:00.000Z',
    errorEventSeq: 7,
    errorEventHrtimeNs: '7000',
    eventClockRange: { min: 1, max: 7 },
    fingerprint: 'fingerprint',
    timeAnchor: { wallClockMs: 1_777_680_000_000, hrtimeNs: '1' },
    error: {
      type: 'TypeError',
      message: 'database write failed',
      stack: [
        'TypeError: database write failed',
        '    at handleCheckout (/srv/app/src/routes.ts:42:7)',
        '    at invoke (/srv/app/node_modules/framework/index.js:10:2)'
      ].join('\n'),
      properties: {}
    },
    localVariables: [{
      functionName: 'handleCheckout',
      filePath: '/srv/app/src/routes.ts',
      lineNumber: 42,
      columnNumber: 7,
      locals: {
        userId: 123,
        password: '[REDACTED]'
      }
    }],
    request: {
      id: 'req-1',
      method: 'POST',
      url: '/checkout?token=[REDACTED]',
      headers: { authorization: '[REDACTED]' },
      receivedAt: '2026-05-06T00:00:00.000Z'
    },
    ioTimeline: [
      {
        seq: 1,
        hrtimeNs: '1000',
        type: 'http-server',
        direction: 'inbound',
        target: '/checkout',
        method: 'POST',
        url: '/checkout?token=[REDACTED]',
        statusCode: 503,
        fd: null,
        requestId: 'req-1',
        contextLost: false,
        startTime: '2026-05-06T00:00:00.000Z',
        endTime: '2026-05-06T00:00:00.050Z',
        durationMs: 50,
        requestHeaders: null,
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error: null,
        aborted: false
      },
      {
        seq: 2,
        hrtimeNs: '2000',
        type: 'http-client',
        direction: 'outbound',
        target: 'api.example.test',
        method: 'GET',
        url: 'https://api.example.test/orders?api_key=[REDACTED]',
        statusCode: 200,
        fd: null,
        requestId: 'req-1',
        contextLost: false,
        startTime: '2026-05-06T00:00:00.010Z',
        endTime: '2026-05-06T00:00:00.020Z',
        durationMs: 10,
        requestHeaders: null,
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error: null,
        aborted: false
      },
      {
        seq: 3,
        hrtimeNs: '3000',
        type: 'db-query',
        direction: 'outbound',
        target: 'postgres',
        method: null,
        url: null,
        statusCode: null,
        fd: null,
        requestId: 'req-1',
        contextLost: false,
        startTime: '2026-05-06T00:00:00.020Z',
        endTime: '2026-05-06T00:00:00.055Z',
        durationMs: 35,
        requestHeaders: null,
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error: null,
        aborted: false,
        dbMeta: {
          query: "select * from users where password='[REDACTED]'",
          params: '[REDACTED]',
          rowCount: 0
        }
      }
    ],
    evictionLog: [],
    stateReads: [],
    stateWrites: [],
    concurrentRequests: [],
    processMetadata: {
      nodeVersion: 'v20.0.0',
      v8Version: '11.0',
      platform: 'linux',
      arch: 'x64',
      pid: 1234,
      hostname: 'checkout-host',
      uptime: 60,
      memoryUsage: {
        rss: 104857600,
        heapTotal: 52428800,
        heapUsed: 26214400,
        external: 0,
        arrayBuffers: 0
      },
      activeHandles: 1,
      activeRequests: 0,
      eventLoopLagMs: 2,
      processStartAnchor: { wallClockMs: 1_777_680_000_000, hrtimeNs: '1' }
    },
    codeVersion: { gitSha: 'abc123', packageVersion: '1.0.0' },
    environment: {},
    trace: {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      traceFlags: 1,
      isEntrySpan: true
    },
    completeness: {
      requestCaptured: true,
      requestBodyTruncated: false,
      ioTimelineCaptured: true,
      usedAmbientEvents: false,
      ioEventsDropped: 0,
      ioPayloadsTruncated: 0,
      alsContextAvailable: true,
      localVariablesCaptured: true,
      localVariablesTruncated: false,
      stateTrackingEnabled: false,
      stateReadsCaptured: false,
      concurrentRequestsCaptured: false,
      piiScrubbed: true,
      encrypted: false,
      captureFailures: []
    }
  };
}
