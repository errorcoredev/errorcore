import Module = require('node:module');
import path = require('node:path');

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ERRORCORE_CAPTURE_ID_SYMBOL,
  InspectorManager,
  LocalsRingBuffer,
  computeStructuralHash,
  countCallFrames,
  parseStackForFunctionNames,
  shouldExcludeSdkRootForRuntime
} from '../../src/capture/inspector-manager';
import { normalizeThrown } from '../../src/capture/normalize-thrown';
import { resolveTestConfig } from '../helpers/test-config';

const originalRequire = Module.prototype.require;
const APP_FILE = '/app/src/handler.js';

function createInspectorConfig(overrides = {}) {
  return resolveTestConfig({
    captureLocalVariables: true,
    ...overrides
  });
}

function buildErrorAt(
  message = 'boom',
  filePath = APP_FILE,
  lineNumber = 10,
  columnNumber = 5
): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at handler (${filePath}:${lineNumber}:${columnNumber})`;
  return error;
}

function createCallFrame(input: {
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
  objectId?: string;
}) {
  return {
    functionName: input.functionName ?? 'handler',
    location: {
      lineNumber: (input.lineNumber ?? 10) - 1,
      columnNumber: (input.columnNumber ?? 5) - 1
    },
    url: input.filePath ?? APP_FILE,
    scopeChain: [
      {
        type: 'local',
        object: { type: 'object', objectId: input.objectId ?? 'scope-1' }
      }
    ]
  };
}

interface MockSession {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createTimerStubs() {
  const timers: Array<{ id: NodeJS.Timeout; fn: () => void; unref: ReturnType<typeof vi.fn> }> =
    [];
  const setIntervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((fn: TimerHandler) => {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;

      timers.push({ id: timer, fn: fn as () => void, unref });
      return timer;
    }) as typeof setInterval);
  const clearIntervalSpy = vi
    .spyOn(globalThis, 'clearInterval')
    .mockImplementation(() => undefined as never);

  return { timers, setIntervalSpy, clearIntervalSpy };
}

function createTimeoutStubs() {
  const timers: Array<{ id: NodeJS.Timeout; fn: () => void; unref: ReturnType<typeof vi.fn> }> =
    [];
  const setTimeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: TimerHandler) => {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;

      timers.push({ id: timer, fn: fn as () => void, unref });
      return timer;
    }) as typeof setTimeout);
  const clearTimeoutSpy = vi
    .spyOn(globalThis, 'clearTimeout')
    .mockImplementation(() => undefined as never);

  return { timers, setTimeoutSpy, clearTimeoutSpy };
}

function createInspectorMock(options?: {
  url?: string;
  connectThrows?: boolean;
  postHandlers?: Record<
    string,
    (params: Record<string, unknown> | undefined) => unknown
  >;
  postImplementation?: (input: {
    method: string;
    params: Record<string, unknown> | undefined;
    callback?: (error?: Error | null, result?: unknown) => void;
  }) => boolean | void;
}) {
  const pausedHandlers: Array<(event: { params: unknown }) => void> = [];
  const session: MockSession = {
    connect: vi.fn(() => {
      if (options?.connectThrows) {
        throw new Error('connect failed');
      }
    }),
    disconnect: vi.fn(),
    post: vi.fn((method: string, paramsOrCallback?: unknown, callback?: unknown) => {
      const params =
        typeof paramsOrCallback === 'function'
          ? undefined
          : (paramsOrCallback as Record<string, unknown> | undefined);
      const cb =
        typeof paramsOrCallback === 'function'
          ? (paramsOrCallback as (error?: Error | null, result?: unknown) => void)
          : (callback as (error?: Error | null, result?: unknown) => void);
      const handled = options?.postImplementation?.({
        method,
        params,
        callback: cb
      });

      if (handled === true) {
        return;
      }

      const result = options?.postHandlers?.[method]?.(params);

      cb?.(null, result);
    }),
    on: vi.fn((event: string, handler: (event: { params: unknown }) => void) => {
      if (event === 'Debugger.paused') {
        pausedHandlers.push(handler);
      }
    })
  };
  class SessionConstructor {
    public constructor() {
      return session as unknown as SessionConstructor;
    }
  }
  const inspectorModule = {
    url: vi.fn(() => options?.url),
    Session: SessionConstructor
  };

  return {
    inspectorModule,
    session,
    emitPaused(params: unknown) {
      for (const handler of pausedHandlers) {
        handler({ params });
      }
    }
  };
}

function withInspectorMock<T>(
  inspectorModule: unknown,
  run: () => Promise<T> | T
): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:inspector') {
      return inspectorModule;
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function getPrivateRingEntries(manager: InspectorManager): unknown[] {
  return (
    manager as unknown as {
      ringBuffer: { entries: unknown[] };
    }
  ).ringBuffer.entries;
}

describe('InspectorManager', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('is unavailable when captureLocalVariables is false', () => {
    const manager = new InspectorManager(resolveTestConfig({ captureLocalVariables: false }));

    expect(manager.isAvailable()).toBe(false);
    expect(manager.getLocals(buildErrorAt())).toBeNull();
  });

  it('enables the debugger and defers pause-on-exceptions until first use', () => {
    const timers = createTimerStubs();
    const timeoutTimers = createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      expect(manager.isAvailable()).toBe(true);
      expect(inspector.session.connect).toHaveBeenCalledTimes(0);
      expect(timers.timers).toHaveLength(0);

      manager.ensureDebuggerActive();

      expect(inspector.session.connect).toHaveBeenCalledTimes(1);
      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.enable',
        expect.any(Function)
      );
      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.setPauseOnExceptions',
        { state: 'all' },
        expect.any(Function)
      );
      // Only 1 setInterval now (rate-limit timer); cache sweep timer removed
      expect(timers.timers).toHaveLength(1);
      expect(timers.timers[0]?.unref).toHaveBeenCalledTimes(1);
      expect(timeoutTimers.timers).toHaveLength(1);
      expect(timeoutTimers.timers[0]?.unref).toHaveBeenCalledTimes(1);
      manager.shutdown();
    });
  });

  it('disables pause-on-exceptions again after the idle timeout', () => {
    createTimerStubs();
    const timeoutTimers = createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      timeoutTimers.timers[0]?.fn();

      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.setPauseOnExceptions',
        { state: 'none' },
        expect.any(Function)
      );
      manager.shutdown();
    });
  });

  it('re-enables pause-on-exceptions when ensureDebuggerActive is called after idle deactivation', () => {
    createTimerStubs();
    const timeoutTimers = createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      timeoutTimers.timers[0]?.fn();
      manager.ensureDebuggerActive();

      const pauseCalls = inspector.session.post.mock.calls.filter(
        (call) => call[0] === 'Debugger.setPauseOnExceptions'
      );
      expect(pauseCalls.map((call) => call[1])).toEqual([
        { state: 'all' },
        { state: 'none' },
        { state: 'all' }
      ]);
      manager.shutdown();
    });
  });

  it('resumes immediately for non-exception pauses', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'other',
        callFrames: []
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Debugger.resume')
      ).toHaveLength(1);
      manager.shutdown();
    });
  });

  it('resumes without collecting when all frames are library code', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'boom' },
        callFrames: [
          {
            functionName: 'lib',
            location: { lineNumber: 0, columnNumber: 0 },
            url: '/app/node_modules/lib/index.js',
            scopeChain: []
          }
        ]
      });

      expect(manager.getLocals(buildErrorAt())).toBeNull();
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('skips empty-url internal stream exceptions without reading locals', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'writer', value: { type: 'string', value: 'released' } }]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-stream'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: {
          className: 'Error',
          description: [
            'Error [ERR_INVALID_STATE]: Invalid state: Writer has been released',
            '    at writableStreamDefaultWriterRelease (node:internal/webstreams/writablestream:1045:13)',
            '    at WritableStreamDefaultWriter.releaseLock (node:internal/webstreams/writablestream:514:5)'
          ].join('\n'),
          objectId: 'stream-error'
        },
        callFrames: [
          createCallFrame({ functionName: 'releaseLock', filePath: '', objectId: 'scope-stream' })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.callFunctionOn')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Debugger.resume')
      ).toHaveLength(1);
      expect(getPrivateRingEntries(manager)).toHaveLength(0);

      const error = new Error('Invalid state: Writer has been released');
      error.stack = [
        'Error [ERR_INVALID_STATE]: Invalid state: Writer has been released',
        '    at writableStreamDefaultWriterRelease (node:internal/webstreams/writablestream:1045:13)',
        '    at WritableStreamDefaultWriter.releaseLock (node:internal/webstreams/writablestream:514:5)'
      ].join('\n');
      expect(manager.getLocalsWithDiagnostics(error).missReason).toContain(
        'non_app_empty_url_exception'
      );
      manager.shutdown();
    });
  });

  it('collects empty-url bundled Next route errors when the description stack has an app frame', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'orderId', value: { type: 'string', value: '42' } }]
        })
      }
    });
    const stack = [
      'Error: order failed',
      '    at GET (/app/services/next-web/.next/server/app/api/orders/[id]/route.js:42:13)'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-order'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: stack, objectId: 'order-error' },
        callFrames: [
          createCallFrame({
            functionName: 'GET',
            filePath: '',
            lineNumber: 42,
            columnNumber: 13,
            objectId: 'scope-order'
          })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(1);
      expect(getPrivateRingEntries(manager)).toHaveLength(1);

      const error = new Error('order failed');
      error.stack = stack;
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.orderId).toBe('42');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('exact');
      manager.shutdown();
    });
  });

  it('collects indexed empty-url bundled frames when an external throw site is followed by app code', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') {
          return false;
        }

        callback?.(null, {
          result: [
            {
              name: 'tagNames',
              value: {
                type: 'object',
                subtype: 'array',
                description: 'Array(2)'
              }
            },
            {
              name: 'cacheName',
              value: {
                type: 'string',
                value: 'tags:global'
              }
            }
          ]
        });
        expect(params?.objectId).toBe('scope-app');
        return true;
      }
    });
    const stack = [
      'Error: Stream is not writable',
      '    at EventEmitter.sendCommand (/app/node_modules/ioredis/built/Redis.js:400:19)',
      '    at lookupTags (/app/dist/server.js:798:2878)'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-redis'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: stack, objectId: 'redis-error' },
        callFrames: [
          createCallFrame({
            functionName: 'EventEmitter.sendCommand',
            filePath: '',
            lineNumber: 400,
            columnNumber: 19,
            objectId: 'scope-redis'
          }),
          createCallFrame({
            functionName: 'lookupTags',
            filePath: '',
            lineNumber: 798,
            columnNumber: 2878,
            objectId: 'scope-app'
          })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(1);

      const error = new Error('Stream is not writable');
      error.stack = stack;
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).toEqual([
        {
          functionName: 'lookupTags',
          filePath: '/app/dist/server.js',
          lineNumber: 798,
          columnNumber: 2878,
          locals: {
            tagNames: '[Array(Array(2))]',
            cacheName: 'tags:global'
          }
        }
      ]);
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('exact');
      manager.shutdown();
    });
  });

  it('collects empty-url bundled frames when app evidence is present but V8 frame indexes are clipped', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [
            { name: 'articleTitle', value: { type: 'string', value: 'F4 Pool Exhaustion' } },
            { name: 'tagList', value: { type: 'object', subtype: 'array', description: 'Array(3)' } }
          ]
        })
      }
    });
    const stack = [
      'SequelizeDatabaseError: Operation timeout',
      '    at Query.formatError (/app/node_modules/sequelize/lib/dialects/postgres/query.js:386:16)',
      '    at Query.run (/app/node_modules/sequelize/lib/dialects/postgres/query.js:87:18)',
      '    at createArticle (/app/dist/server.js:472:20484)'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-article'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'SequelizeDatabaseError', description: stack, objectId: 'pg-error' },
        callFrames: [
          createCallFrame({
            functionName: 'formatError',
            filePath: '',
            objectId: 'scope-lib-a'
          }),
          createCallFrame({
            functionName: 'run',
            filePath: '',
            objectId: 'scope-lib-b'
          })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(1);

      const error = new Error('Operation timeout');
      error.name = 'SequelizeDatabaseError';
      error.stack = stack;
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]).toMatchObject({
        functionName: 'createArticle',
        filePath: '/app/dist/server.js',
        lineNumber: 472,
        columnNumber: 20484,
        locals: {
          articleTitle: 'F4 Pool Exhaustion',
          tagList: '[Array(Array(3))]'
        }
      });
      expect(result.captureLayer).toBe('identity');
      manager.shutdown();
    });
  });

  it('collects a single empty-url bundled frame for external-library-origin failures', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [
            { name: 'articleTitle', value: { type: 'string', value: 'Latency Story' } }
          ]
        })
      }
    });
    const stack = [
      'SequelizeConnectionAcquireTimeoutError: Operation timeout',
      '    at a.getConnection (/app/node_modules/sequelize/lib/dialects/abstract/connection-manager.js:288:48)',
      '    at async /app/dist/server.js:438:194747',
      '    at async /app/dist/server.js:472:20537'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-pg-timeout'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: {
          className: 'SequelizeConnectionAcquireTimeoutError',
          description: stack,
          objectId: 'pg-timeout'
        },
        callFrames: [
          createCallFrame({
            functionName: 'getConnection',
            filePath: '',
            objectId: 'scope-only'
          })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(1);

      const error = new Error('Operation timeout');
      error.name = 'SequelizeConnectionAcquireTimeoutError';
      error.stack = stack;
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]).toMatchObject({
        functionName: '<anonymous>',
        filePath: '/app/dist/server.js',
        lineNumber: 438,
        columnNumber: 194747,
        locals: {
          articleTitle: 'Latency Story'
        }
      });
      expect(result.captureLayer).toBe('identity');
      manager.shutdown();
    });
  });

  it('collects a single empty-url frame when source-mapped app evidence follows an external driver frame', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [
            { name: 'tagNames', value: { type: 'object', subtype: 'array', description: 'Array(2)' } }
          ]
        })
      }
    });
    const stack = [
      'SequelizeConnectionAcquireTimeoutError: Operation timeout',
      '    at a.getConnection (../node_modules/sequelize/lib/dialects/abstract/connection-manager.js:288:48)',
      '    at async ../routes/api/tags.js:60:20'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-tags-timeout'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: {
          className: 'SequelizeConnectionAcquireTimeoutError',
          description: stack,
          objectId: 'pg-timeout'
        },
        callFrames: [
          createCallFrame({
            functionName: 'getConnection',
            filePath: '',
            objectId: 'scope-only'
          })
        ]
      });

      const error = new Error('Operation timeout');
      error.name = 'SequelizeConnectionAcquireTimeoutError';
      error.stack = stack;
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]).toMatchObject({
        functionName: '<anonymous>',
        filePath: '../routes/api/tags.js',
        lineNumber: 60,
        columnNumber: 20,
        locals: {
          tagNames: '[Array(Array(2))]'
        }
      });
      expect(result.captureLayer).toBe('identity');
      manager.shutdown();
    });
  });

  it('skips empty-url Next cache body ENOENT exceptions without an app stack frame', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'cachePath', value: { type: 'string', value: 'body' } }]
        })
      }
    });
    const stack = [
      "Error: ENOENT: no such file or directory, open '/app/services/next-web/.next/cache/fetch-cache/body'",
      '    at async open (node:internal/fs/promises:640:25)',
      '    at async CacheHandler.get (/app/services/next-web/node_modules/next/dist/server/lib/incremental-cache/file-system-cache.js:87:21)'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-cache'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: stack, objectId: 'cache-error' },
        callFrames: [
          createCallFrame({ functionName: 'get', filePath: '', objectId: 'scope-cache-body' })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.callFunctionOn')
      ).toHaveLength(0);
      expect(getPrivateRingEntries(manager)).toHaveLength(0);

      const error = new Error(
        "ENOENT: no such file or directory, open '/app/services/next-web/.next/cache/fetch-cache/body'"
      );
      error.stack = stack;
      expect(manager.getLocalsWithDiagnostics(error).missReason).toContain(
        'non_app_empty_url_exception'
      );
      manager.shutdown();
    });
  });

  it('skips empty-url framework exceptions even when a route frame appears deeper in the stack', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'request', value: { type: 'string', value: 'internal' } }]
        })
      }
    });
    const stack = [
      'TypeError: The "emitter" argument must be an instance of EventEmitter or EventTarget. Received an instance of AbortSignal',
      '    at getMaxListeners (node:events:957:9)',
      '    at Request (/app/services/next-web/node_modules/next/dist/compiled/@edge-runtime/primitives/fetch.js:9760:17)',
      '    at fromNodeNextRequest (/app/services/next-web/node_modules/next/dist/server/web/spec-extension/adapters/next-request.js:1:100)',
      '    at GET (/app/services/next-web/.next/server/app/api/ping/route.js:1:1234)'
    ].join('\n');

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-ping'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'TypeError', description: stack, objectId: 'request-error' },
        callFrames: [
          createCallFrame({ functionName: 'getMaxListeners', filePath: '', objectId: 'scope-request' })
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.callFunctionOn')
      ).toHaveLength(0);
      expect(getPrivateRingEntries(manager)).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('collects app-frame locals and returns them via Layer 1 tag', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [
            { name: 'userId', value: { type: 'number', value: 42 } },
            { name: 'password', value: { type: 'string', value: 'secret' } },
            {
              name: 'items',
              value: { type: 'object', subtype: 'array', description: 'Array(2)' }
            }
          ]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();

      const error = buildErrorAt();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom', objectId: 'obj-1' },
        callFrames: [createCallFrame({ objectId: 'scope-1' })]
      });

      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      const first = manager.getLocals(error);
      expect(first).toEqual([
        {
          functionName: 'handler',
          filePath: APP_FILE,
          lineNumber: 10,
          columnNumber: 5,
          locals: {
            userId: 42,
            password: '[REDACTED]',
            items: '[Array(Array(2))]'
          }
        }
      ]);
      manager.shutdown();
    });
  });

  it('falls back to Layer 2 identity lookup when tag is absent (same requestId)', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') {
          return false;
        }

        const scopeId = params?.objectId;
        callback?.(null, {
          result: [
            {
              name: 'value',
              value: {
                type: 'number',
                value: scopeId === 'scope-a' ? 1 : 2
              }
            }
          ]
        });
        return true;
      }
    });
    let activeRequestId: string | undefined = 'req-a';

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => activeRequestId
      });

      manager.ensureDebuggerActive();

      activeRequestId = 'req-a';
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: duplicate message' },
        callFrames: [createCallFrame({ objectId: 'scope-a' })]
      });

      activeRequestId = 'req-b';
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: duplicate message' },
        callFrames: [createCallFrame({ objectId: 'scope-b' })]
      });

      activeRequestId = 'req-a';
      // Layer 2 exact key: requestId + errorName + errorMessage + frameCount + structuralHash
      expect(manager.getLocals(buildErrorAt('duplicate message'))?.[0]?.locals).toEqual({
        value: 1
      });

      activeRequestId = 'req-b';
      expect(manager.getLocals(buildErrorAt('duplicate message'))?.[0]?.locals).toEqual({
        value: 2
      });

      manager.shutdown();
    });
  });

  it('returns ambiguous_correlation when two captures match at dropped-hash level but differ by hash', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 7 } }]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      // Same requestId, same error name/message/frameCount but DIFFERENT function names
      // → same dropped-hash key (name+message+frameCount) but different structuralHash
      // → findByIdentity misses (exact match fails due to hash diff)
      // → findByDegradedKey returns 2 entries → ambiguous
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom' },
        callFrames: [createCallFrame({ functionName: 'handlerA', objectId: 'scope-1' })]
      });
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom' },
        callFrames: [createCallFrame({ functionName: 'handlerB', objectId: 'scope-2' })]
      });

      // Error stack with functionName 'handlerC' → structuralHash different from both entries
      nowSpy.mockReturnValue(3000);
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at handlerC (/app/src/handler.js:10:5)';
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('ambiguous_correlation');
      manager.shutdown();
    });
  });

  it('uses the newest recent equivalent capture when stack shape drift creates duplicate loose matches', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const inspector = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') return false;
        callback?.(null, {
          result: [
            {
              name: 'attempt',
              value: { type: 'string', value: params?.objectId === 'scope-new' ? 'new' : 'old' }
            }
          ]
        });
        return true;
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      nowSpy.mockReturnValue(1000);
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: duplicate frame' },
        callFrames: [createCallFrame({ functionName: 'handler', objectId: 'scope-old' })]
      });
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: duplicate frame' },
        callFrames: [createCallFrame({ functionName: 'handler', objectId: 'scope-new' })]
      });

      const error = new Error('duplicate frame');
      error.stack = [
        'Error: duplicate frame',
        '    at handler (/app/src/handler.js:10:5)',
        '    at outer (/app/src/server.js:20:3)'
      ].join('\n');

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.attempt).toBe('new');
      expect(result.degradation).toBe('dropped_count');
      manager.shutdown();
    });
  });

  it('uses the newest recent equivalent capture when request context is lost after duplicate driver pauses', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const inspector = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') return false;
        callback?.(null, {
          result: [
            {
              name: 'commandName',
              value: {
                type: 'string',
                value: params?.objectId === 'scope-new' ? 'hset' : 'xadd'
              }
            }
          ]
        });
        return true;
      }
    });
    let activeRequestId: string | undefined = 'req-redis';

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => activeRequestId
      });

      manager.ensureDebuggerActive();
      nowSpy.mockReturnValue(1000);
      inspector.emitPaused({
        reason: 'exception',
        data: {
          className: 'Error',
          description: 'Error: Stream is not writable'
        },
        callFrames: [createCallFrame({ functionName: 'sendCommand', objectId: 'scope-old' })]
      });
      inspector.emitPaused({
        reason: 'exception',
        data: {
          className: 'Error',
          description: 'Error: Stream is not writable'
        },
        callFrames: [createCallFrame({ functionName: 'sendCommand', objectId: 'scope-new' })]
      });

      activeRequestId = 'req-error-handler';
      const error = new Error('Stream is not writable');
      error.stack = [
        'Error: Stream is not writable',
        '    at sendCommand (/app/src/redis.js:10:5)'
      ].join('\n');

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.commandName).toBe('hset');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('returns cache_miss when no paused event matches the error identity', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 7 } }]
        })
      }
    });
    let activeRequestId: string | undefined = 'req-1';

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => activeRequestId
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom' },
        callFrames: [createCallFrame({ objectId: 'scope-1' })]
      });

      activeRequestId = 'req-2';
      const result = manager.getLocalsWithDiagnostics(buildErrorAt('totally different message'));
      expect(result.frames).toBeNull();
      expect(result.missReason).toContain('cache_miss');
      manager.shutdown();
    });
  });

  it('caches locals after deferred Runtime.getProperties callbacks complete', async () => {
    createTimerStubs();
    createTimeoutStubs();
    const pendingCallbacks: Array<() => void> = [];
    const inspector = createInspectorMock({
      postImplementation: ({ method, callback }) => {
        if (method !== 'Runtime.getProperties') {
          return false;
        }

        pendingCallbacks.push(() => {
          callback?.(null, {
            result: [{ name: 'value', value: { type: 'number', value: pendingCallbacks.length } }]
          });
        });
        return true;
      }
    });

    await withInspectorMock(inspector.inspectorModule, async () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: deferred' },
        callFrames: [
          createCallFrame({
            functionName: 'first',
            filePath: '/app/src/first.js',
            lineNumber: 1,
            columnNumber: 1,
            objectId: 'scope-1'
          }),
          createCallFrame({
            functionName: 'second',
            filePath: '/app/src/second.js',
            lineNumber: 2,
            columnNumber: 1,
            objectId: 'scope-2'
          })
        ]
      });

      for (const callback of pendingCallbacks) {
        queueMicrotask(callback);
      }

      await Promise.resolve();
      await Promise.resolve();

      const error = buildErrorAt('deferred', '/app/src/first.js', 1, 1);
      // deferred has 1 frame in error.stack → frameCount=1
      // captured frames used ALL callFrames (2), structuralHash is of all callFrames
      // Layer 2 identity will not match because frameCount(stack)=1 but captured frameCount=callFrames.length=2
      // Instead look at what the ring buffer stores: frameCount = params.callFrames.length = 2
      // And the error.stack parse of buildErrorAt('deferred', ...) gives 1 frame
      // So Layer 2 identity won't exactly match, but dropped_count may
      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      expect(manager.getLocals(error)).toEqual([
        {
          functionName: 'first',
          filePath: '/app/src/first.js',
          lineNumber: 1,
          columnNumber: 1,
          locals: { value: 2 }
        },
        {
          functionName: 'second',
          filePath: '/app/src/second.js',
          lineNumber: 2,
          columnNumber: 1,
          locals: { value: 2 }
        }
      ]);
      manager.shutdown();
    });
  });

  it('skips rate-limited collections', () => {
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 1 } }]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          maxLocalsCollectionsPerSecond: 1,
          maxCachedLocals: 10
        }),
        { getRequestId: () => 'req-1' }
      ) as unknown as {
        collectionCountThisSecond: number;
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      manager.collectionCountThisSecond = 1;
      manager._onPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'rate-limited' },
        callFrames: [createCallFrame({ objectId: 'scope-rate' })]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('skips collection when ring buffer is at capacity', () => {
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 1 } }]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          maxLocalsCollectionsPerSecond: 100,
          maxCachedLocals: 1
        }),
        { getRequestId: () => 'req-1' }
      ) as unknown as {
        ringBuffer: LocalsRingBuffer;
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      manager.ringBuffer.push({
        id: 'existing',
        requestId: 'req-1',
        errorName: 'Error',
        errorMessage: 'existing',
        frameCount: 1,
        structuralHash: 'h',
        frames: [],
        createdAt: Date.now()
      });

      manager._onPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'cache-full' },
        callFrames: [createCallFrame({ objectId: 'scope-cache' })]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('serializes remote objects according to the shallow type table', () => {
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig()) as unknown as {
        _serializeRemoteObject(object: unknown): unknown;
        shutdown(): void;
      };

      expect(manager._serializeRemoteObject({ type: 'undefined' })).toBeUndefined();
      expect(manager._serializeRemoteObject({ type: 'string', value: 'text' })).toBe('text');
      expect(manager._serializeRemoteObject({ type: 'number', value: 5 })).toBe(5);
      expect(manager._serializeRemoteObject({ type: 'boolean', value: true })).toBe(true);
      expect(
        manager._serializeRemoteObject({ type: 'bigint', description: '10n' })
      ).toEqual({ _type: 'BigInt', value: '10n' });
      expect(
        manager._serializeRemoteObject({ type: 'symbol', description: 'Symbol(x)' })
      ).toEqual({ _type: 'Symbol', description: 'Symbol(x)' });
      expect(
        manager._serializeRemoteObject({ type: 'function', description: 'function fn() {}' })
      ).toEqual({ _type: 'Function', name: 'fn', className: null });
      expect(
        manager._serializeRemoteObject({
          type: 'function',
          description: '(req, res) => { /* 35 lines of source */ }'
        })
      ).toEqual({ _type: 'Function', name: '<anonymous>(req, res)', className: null });
      expect(
        manager._serializeRemoteObject({ type: 'object', subtype: 'null' })
      ).toBeNull();
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'regexp',
          description: '/x/'
        })
      ).toBe('/x/');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'date',
          description: '2026-01-01T00:00:00.000Z'
        })
      ).toBe('2026-01-01T00:00:00.000Z');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'error',
          description: 'Error: boom'
        })
      ).toBe('Error: boom');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'map',
          description: 'Map(1)'
        })
      ).toBe('[Map(Map(1))]');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'set',
          description: 'Set(1)'
        })
      ).toBe('[Set(Set(1))]');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          className: 'Object',
          description: 'Object'
        })
      ).toBe('[Object]');
      // IncomingMessage with preview projects useful subset rather than
      // collapsing to "[IncomingMessage]".
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          className: 'IncomingMessage',
          description: 'IncomingMessage',
          preview: {
            type: 'object',
            properties: [
              { name: 'method', type: 'string', value: 'POST' },
              { name: 'url', type: 'string', value: '/checkout' },
              { name: 'statusCode', type: 'object', subtype: 'null' },
              { name: 'complete', type: 'boolean', value: 'false' },
              { name: '_readableState', type: 'object', subtype: 'object' }
            ]
          }
        })
      ).toEqual({
        _type: 'IncomingMessage',
        method: 'POST',
        url: '/checkout',
        complete: 'false'
      });
      manager.shutdown();
    });
  });

  it('treats SDK frames as non-app frames', () => {
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig()) as unknown as {
        _isAppFrame(url: string | undefined): boolean;
        shutdown(): void;
      };
      const sdkFile = path.join(process.cwd(), 'src', 'transport', 'transport.ts').replace(
        /\\/g,
        '/'
      );

      expect(manager._isAppFrame(sdkFile)).toBe(false);
      expect(manager._isAppFrame(APP_FILE)).toBe(true);
      manager.shutdown();
    });
  });

  it('does not treat a bundled application root as SDK-owned', () => {
    expect(shouldExcludeSdkRootForRuntime('/app/dist', '/app')).toBe(false);
    expect(
      shouldExcludeSdkRootForRuntime(
        '/app/node_modules/errorcore/dist/capture',
        '/app/node_modules/errorcore/dist'
      )
    ).toBe(true);
    expect(
      shouldExcludeSdkRootForRuntime(
        path.join(process.cwd(), 'src', 'capture'),
        path.join(process.cwd(), 'src')
      )
    ).toBe(true);
  });

  it('always resumes even if collection throws inside the paused handler', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => {
          throw new Error('getProperties failed');
        }
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      }) as unknown as {
        ensureDebuggerActive(): void;
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      manager.ensureDebuggerActive();

      expect(() =>
        manager._onPaused({
          reason: 'exception',
          data: { className: 'Error', description: 'boom' },
          callFrames: [createCallFrame({ objectId: 'scope-1' })]
        })
      ).not.toThrow();

      expect(
        inspector.session.post.mock.calls.some((call) => call[0] === 'Debugger.resume')
      ).toBe(true);
      manager.shutdown();
    });
  });

  it('shutdown disconnects the session, clears timers, and marks unavailable', () => {
    const timers = createTimerStubs();
    const timeoutTimers = createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      }) as unknown as {
        isAvailable(): boolean;
        ensureDebuggerActive(): void;
        shutdown(): void;
      };

      manager.ensureDebuggerActive();
      manager.shutdown();

      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.setPauseOnExceptions',
        { state: 'none' },
        expect.any(Function)
      );
      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.disable',
        expect.any(Function)
      );
      const pauseOffIndex = inspector.session.post.mock.calls.findIndex(
        (call) => call[0] === 'Debugger.setPauseOnExceptions' && call[1]?.state === 'none'
      );
      const disableIndex = inspector.session.post.mock.calls.findIndex(
        (call) => call[0] === 'Debugger.disable'
      );
      const disconnectIndex = inspector.session.disconnect.mock.invocationCallOrder[0] ?? Infinity;
      const pauseOffOrder = inspector.session.post.mock.invocationCallOrder[pauseOffIndex] ?? -1;
      const disableOrder = inspector.session.post.mock.invocationCallOrder[disableIndex] ?? -1;

      expect(inspector.session.disconnect).toHaveBeenCalledTimes(1);
      expect(pauseOffOrder).toBeGreaterThan(0);
      expect(disableOrder).toBeGreaterThan(0);
      expect(pauseOffOrder).toBeLessThan(disconnectIndex);
      expect(disableOrder).toBeLessThan(disconnectIndex);
      // Only 1 setInterval now (rate-limit timer; cache sweep removed)
      expect(timers.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(timeoutTimers.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe('getLocalsWithDiagnostics', () => {
    it('returns null missReason when captureLocalVariables is false', () => {
      const manager = new InspectorManager(
      resolveTestConfig({ captureLocalVariables: false })
      );

      const result = manager.getLocalsWithDiagnostics(buildErrorAt('test'));

      expect(result.frames).toBeNull();
      expect(result.missReason).toBeNull();
    });

    it('returns cache_miss with pause count when locals are not found', () => {
      const mock = createInspectorMock();
      createTimerStubs();
      createTimeoutStubs();

      const manager = withInspectorMock(mock.inspectorModule, () => {
        const m = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-1'
        });
        m.ensureDebuggerActive();
        return m;
      }) as InspectorManager;

      const result = manager.getLocalsWithDiagnostics(buildErrorAt('unknown'));

      expect(result.frames).toBeNull();
      expect(result.missReason).toMatch(/^cache_miss/);
      expect(result.missReason).toContain('pauses=');

      manager.shutdown();
    });

    it('returns frames with null missReason on Layer 1 tag hit', () => {
      const mock = createInspectorMock({
        postHandlers: {
          'Runtime.getProperties': () => ({
            result: [{ name: 'x', value: { type: 'number', value: 42 } }]
          })
        }
      });
      createTimerStubs();
      createTimeoutStubs();

      const manager = withInspectorMock(mock.inspectorModule, () => {
        const m = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-1'
        });
        m.ensureDebuggerActive();
        return m;
      }) as InspectorManager;

      const error = buildErrorAt('diag test', '/app/handler.js', 11, 6);

      mock.emitPaused({
        reason: 'exception',
        data: { type: 'object', className: 'Error', description: 'Error: diag test', objectId: 'obj-1' },
        callFrames: [
          createCallFrame({
            filePath: '/app/handler.js',
            lineNumber: 11,
            columnNumber: 6,
            objectId: 'obj-1'
          })
        ]
      });

      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      const result = manager.getLocalsWithDiagnostics(error);

      expect(result.frames).not.toBeNull();
      expect(result.frames).toHaveLength(1);
      expect(result.frames![0].locals.x).toBe(42);
      expect(result.missReason).toBeNull();
      expect(result.captureLayer).toBe('tag');
      expect(result.degradation).toBe('exact');

      manager.shutdown();
    });

    it('reports not_available when debugger is already attached', () => {
      const mock = createInspectorMock({ url: 'ws://127.0.0.1:9229' });
      createTimerStubs();
      createTimeoutStubs();

      const manager = withInspectorMock(mock.inspectorModule, () => {
        const m = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-1'
        });
        m.ensureDebuggerActive();
        return m;
      }) as InspectorManager;

      const result = manager.getLocalsWithDiagnostics(buildErrorAt('test'));

      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('not_available');
    });

    it('returns not_available_in_worker when not on main thread', () => {
      Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
        if (request === 'node:worker_threads') {
          return { isMainThread: false };
        }
        return originalRequire.apply(this, [request]);
      };

      const manager = new InspectorManager(createInspectorConfig());
      const result = manager.getLocalsWithDiagnostics(buildErrorAt('test'));
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('not_available_in_worker');
    });

    it('returns primitive_throw with value type when called with a non-object', () => {
      const manager = new InspectorManager(createInspectorConfig());
      // Cast needed since TS enforces Error type on the public API, but V8 can throw anything
      const result = manager.getLocalsWithDiagnostics(42 as unknown as Error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('primitive_throw (value=number)');
    });

    it('returns primitive_throw for string throws', () => {
      const manager = new InspectorManager(createInspectorConfig());
      const result = manager.getLocalsWithDiagnostics('oops' as unknown as Error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('primitive_throw (value=string)');
    });

    it('returns primitive_throw for null throws', () => {
      const manager = new InspectorManager(createInspectorConfig());
      const result = manager.getLocalsWithDiagnostics(null as unknown as Error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toContain('primitive_throw');
    });

    it('returns Layer 2 identity lookup with captureLayer=identity and degradation=exact', () => {
      createTimerStubs();
      createTimeoutStubs();
      const mock = createInspectorMock({
        postHandlers: {
          'Runtime.getProperties': () => ({
            result: [{ name: 'x', value: { type: 'number', value: 99 } }]
          })
        }
      });

      withInspectorMock(mock.inspectorModule, () => {
        const manager = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-42'
        });
        manager.ensureDebuggerActive();

        mock.emitPaused({
          reason: 'exception',
          data: { className: 'TypeError', description: 'TypeError: oops' },
          callFrames: [createCallFrame({ functionName: 'myFn', objectId: 'scope-x' })]
        });

        const error = new Error('oops');
        error.name = 'TypeError';
        error.stack = 'TypeError: oops\n    at myFn (/app/src/handler.js:10:5)';

        const result = manager.getLocalsWithDiagnostics(error);
        expect(result.frames).not.toBeNull();
        expect(result.captureLayer).toBe('identity');
        expect(result.degradation).toBe('exact');
        manager.shutdown();
      });
    });

    it('calls Runtime.callFunctionOn to install the Symbol tag on exception object', () => {
      createTimerStubs();
      createTimeoutStubs();
      const mock = createInspectorMock({
        postHandlers: {
          'Runtime.getProperties': () => ({ result: [] })
        }
      });

      withInspectorMock(mock.inspectorModule, () => {
        const manager = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-1'
        });
        manager.ensureDebuggerActive();

        mock.emitPaused({
          reason: 'exception',
          data: { className: 'Error', description: 'Error: tag-test', objectId: 'exc-obj-1' },
          callFrames: [createCallFrame({ objectId: 'scope-1' })]
        });

        const callFunctionOnCalls = mock.session.post.mock.calls.filter(
          (call) => call[0] === 'Runtime.callFunctionOn'
        );
        expect(callFunctionOnCalls).toHaveLength(1);
        const callParams = callFunctionOnCalls[0][1] as {
          objectId: string;
          arguments: Array<{ value: string }>;
        };
        expect(callParams.objectId).toBe('exc-obj-1');
        expect(callParams.arguments[0].value).toBe('errorcore.v1.captureId');
        manager.shutdown();
      });
    });

    it('does NOT call Runtime.callFunctionOn when exception has no objectId', () => {
      createTimerStubs();
      createTimeoutStubs();
      const mock = createInspectorMock({
        postHandlers: {
          'Runtime.getProperties': () => ({ result: [] })
        }
      });

      withInspectorMock(mock.inspectorModule, () => {
        const manager = new InspectorManager(createInspectorConfig(), {
          getRequestId: () => 'req-1'
        });
        manager.ensureDebuggerActive();

        mock.emitPaused({
          reason: 'exception',
          data: { className: 'Error', description: 'Error: no-obj-id' },
          callFrames: [createCallFrame({ objectId: 'scope-1' })]
        });

        const callFunctionOnCalls = mock.session.post.mock.calls.filter(
          (call) => call[0] === 'Runtime.callFunctionOn'
        );
        expect(callFunctionOnCalls).toHaveLength(0);
        manager.shutdown();
      });
    });
  });
});

describe('G1 — Layer 1 lookup by Symbol tag', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('resolves via tag even when ring buffer has multiple entries', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') return false;
        callback?.(null, {
          result: [{ name: 'n', value: { type: 'number', value: params?.objectId === 'scope-a' ? 10 : 20 } }]
        });
        return true;
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: msg', objectId: 'exc-a' },
        callFrames: [createCallFrame({ objectId: 'scope-a' })]
      });

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: msg', objectId: 'exc-b' },
        callFrames: [createCallFrame({ objectId: 'scope-b' })]
      });

      const error = buildErrorAt('msg');
      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).not.toBeNull();
      expect(result.frames![0].locals.n).toBe(10);
      expect(result.captureLayer).toBe('tag');
      expect(result.degradation).toBe('exact');
      expect(result.missReason).toBeNull();
      manager.shutdown();
    });
  });

  it('falls through to Layer 2 when tag id is not in ring buffer (evicted)', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'x', value: { type: 'number', value: 5 } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({ maxCachedLocals: 2 }),
        { getRequestId: () => 'req-1' }
      ) as unknown as {
        ringBuffer: LocalsRingBuffer;
        ensureDebuggerActive(): void;
        getLocalsWithDiagnostics(e: Error): { frames: unknown; missReason: string | null };
        shutdown(): void;
      };
      manager.ensureDebuggerActive();

      manager.ringBuffer.push({
        id: '1',
        requestId: 'req-1',
        errorName: 'Error',
        errorMessage: 'old',
        frameCount: 1,
        structuralHash: 'h1',
        frames: [{ functionName: 'fn1', filePath: APP_FILE, lineNumber: 1, columnNumber: 1, locals: {} }],
        createdAt: Date.now()
      });
      manager.ringBuffer.push({
        id: '2',
        requestId: 'req-1',
        errorName: 'Error',
        errorMessage: 'filler',
        frameCount: 1,
        structuralHash: 'h2',
        frames: [],
        createdAt: Date.now()
      });
      manager.ringBuffer.push({
        id: '3',
        requestId: 'req-1',
        errorName: 'Error',
        errorMessage: 'new',
        frameCount: 1,
        structuralHash: 'h3',
        frames: [],
        createdAt: Date.now()
      });

      const error = buildErrorAt('old');
      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      // Layer 2 lookup: requestId='req-1', errorMessage='old' → not in buffer (evicted)
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.missReason).toContain('cache_miss');
      expect(result.frames).toBeNull();
      manager.shutdown();
    });
  });

  it('matches primitive throw pause records against normalized NonErrorThrown lookup', () => {
    createTimerStubs();
    createTimeoutStubs();
    const config = createInspectorConfig();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'visible', value: { type: 'string', value: 'local-value' } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(config, {
        getRequestId: () => 'req-primitive'
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { type: 'string', value: 'primitive-boom', description: 'primitive-boom' },
        callFrames: [createCallFrame({ objectId: 'scope-primitive' })]
      });

      const normalized = normalizeThrown('primitive-boom', config);
      normalized.stack = [
        `${normalized.name}: ${normalized.message}`,
        `    at handler (${APP_FILE}:10:5)`
      ].join('\n');

      const result = manager.getLocalsWithDiagnostics(normalized);

      expect(result.frames).not.toBeNull();
      expect(result.frames?.[0]?.locals.visible).toBe('local-value');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('exact');
      manager.shutdown();
    });
  });
});

describe('G1 — Layer 2 identity-tuple lookup with degradation', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('matches via dropped_hash when structuralHash differs but frameCount matches', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'y', value: { type: 'number', value: 77 } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-hash'
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'RangeError', description: 'RangeError: too big' },
        callFrames: [createCallFrame({ functionName: 'capturedFn', objectId: 'scope-h' })]
      });

      // Lookup error with different functionName → different structuralHash
      // but same frameCount(1), same requestId/errorName/errorMessage → dropped_hash match
      const error = new Error('too big');
      error.name = 'RangeError';
      error.stack = 'RangeError: too big\n    at differentFn (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).not.toBeNull();
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_hash');
      manager.shutdown();
    });
  });

  it('matches via dropped_count when frameCount differs', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'z', value: { type: 'number', value: 88 } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-cnt'
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: count mismatch' },
        callFrames: [
          createCallFrame({ functionName: 'outer', objectId: 'scope-outer' }),
          createCallFrame({ functionName: 'inner', objectId: 'scope-inner' })
        ]
      });

      const error = new Error('count mismatch');
      error.stack = 'Error: count mismatch\n    at onlyOne (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).not.toBeNull();
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_count');
      manager.shutdown();
    });
  });

  it('matches via background when requestId is null at both capture and lookup', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'bg', value: { type: 'number', value: 42 } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => undefined  // no request context
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: bg error' },
        callFrames: [createCallFrame({ functionName: 'bgFn', objectId: 'scope-bg' })]
      });

      const error = new Error('bg error');
      error.stack = 'Error: bg error\n    at bgFn (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).not.toBeNull();
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('background');
      manager.shutdown();
    });
  });

  it('matches a unique paused entry when inspector callback lost the request id', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'jobId', value: { type: 'string', value: 'job-1' } }]
        })
      }
    });

    let currentRequestId: string | undefined = 'req-paused';
    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => currentRequestId
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: worker failed: job-1' },
        callFrames: [createCallFrame({ functionName: 'processJob', objectId: 'scope-job' })]
      });

      currentRequestId = 'req-capture';
      const error = new Error('worker failed: job-1');
      error.stack = 'Error: worker failed: job-1\n    at processJob (/app/services/worker/src/index.js:26:11)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.jobId).toBe('job-1');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('matches a unique paused entry when request id and stack shape drift', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'jobId', value: { type: 'string', value: 'job-1' } }]
        })
      }
    });

    let currentRequestId: string | undefined = 'req-paused';
    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => currentRequestId
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: {
          className: 'Error',
          description: [
            'Error: worker failed: job-1',
            '    at processJob (/app/services/worker/src/index.js:26:11)',
            '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)'
          ].join('\n')
        },
        callFrames: [
          createCallFrame({ functionName: 'processJob', objectId: 'scope-job' }),
          createCallFrame({ functionName: 'processTicksAndRejections', objectId: 'scope-tick' })
        ]
      });

      currentRequestId = 'req-capture';
      const error = new Error('worker failed: job-1');
      error.stack = [
        'Error: worker failed: job-1',
        '    at processJob (/app/services/worker/src/index.js:26:11)',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
        '    at async /app/services/worker/src/index.js:55:9',
        '    at async handleMessage (/app/services/worker/src/index.js:41:3)'
      ].join('\n');

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.jobId).toBe('job-1');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('uses the single recent request-id mismatch when older identical pauses exist', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const mock = createInspectorMock({
      postImplementation: ({ method, params, callback }) => {
        if (method !== 'Runtime.getProperties') return false;
        callback?.(null, {
          result: [
            {
              name: 'chainId',
              value: {
                type: 'string',
                value: params?.objectId === 'scope-new' ? 'new' : 'old'
              }
            }
          ]
        });
        return true;
      }
    });

    let currentRequestId: string | undefined = 'req-old-pause';
    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => currentRequestId
      });
      manager.ensureDebuggerActive();

      nowSpy.mockReturnValue(1000);
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: fastify chain exploded: s3-ok' },
        callFrames: [createCallFrame({ functionName: 'handler', objectId: 'scope-old' })]
      });

      currentRequestId = 'req-new-pause';
      nowSpy.mockReturnValue(10000);
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: fastify chain exploded: s3-ok' },
        callFrames: [createCallFrame({ functionName: 'handler', objectId: 'scope-new' })]
      });

      currentRequestId = 'req-capture';
      nowSpy.mockReturnValue(10050);
      const error = new Error('fastify chain exploded: s3-ok');
      error.stack = 'Error: fastify chain exploded: s3-ok\n    at handler (/app/services/fastify-svc/src/index.js:44:11)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.chainId).toBe('new');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('uses a single recent request-id mismatch when pause error-name identity drifts', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'jobId', value: { type: 'string', value: 'job-1' } }]
        })
      }
    });

    let currentRequestId: string | undefined = 'req-paused';
    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => currentRequestId
      });
      manager.ensureDebuggerActive();

      nowSpy.mockReturnValue(1000);
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'TypeError', description: 'Error: worker failed: job-1' },
        callFrames: [createCallFrame({ functionName: 'processJob', objectId: 'scope-job' })]
      });

      currentRequestId = 'req-capture';
      nowSpy.mockReturnValue(1050);
      const error = new Error('worker failed: job-1');
      error.stack = 'Error: worker failed: job-1\n    at processJob (/app/services/worker/src/index.js:26:11)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.jobId).toBe('job-1');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('uses a single recent non-error pause when the top frame matches', () => {
    createTimerStubs();
    createTimeoutStubs();
    const nowSpy = vi.spyOn(Date, 'now');
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'jobId', value: { type: 'string', value: 'job-1' } }]
        })
      }
    });

    let currentRequestId: string | undefined = 'req-paused';
    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => currentRequestId
      });
      manager.ensureDebuggerActive();

      nowSpy.mockReturnValue(1000);
      mock.emitPaused({
        reason: 'exception',
        data: { type: 'object', className: 'Object', description: 'Object' },
        callFrames: [createCallFrame({ functionName: 'processJob', objectId: 'scope-job' })]
      });

      currentRequestId = 'req-capture';
      nowSpy.mockReturnValue(1050);
      const error = new Error('worker failed: job-1');
      error.stack = 'Error: worker failed: job-1\n    at processJob (/app/services/worker/src/index.js:26:11)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames?.[0]?.locals.jobId).toBe('job-1');
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('dropped_request');
      manager.shutdown();
    });
  });

  it('returns ambiguous_context_less_match when two background entries match', () => {
    createTimerStubs();
    createTimeoutStubs();
    const mock = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'bg', value: { type: 'number', value: 1 } }]
        })
      }
    });

    withInspectorMock(mock.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => undefined
      });
      manager.ensureDebuggerActive();

      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: bg dup' },
        callFrames: [createCallFrame({ functionName: 'bgFn', objectId: 'scope-1' })]
      });
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: bg dup' },
        callFrames: [createCallFrame({ functionName: 'bgFn', objectId: 'scope-2' })]
      });

      const error = new Error('bg dup');
      error.stack = 'Error: bg dup\n    at bgFn (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('ambiguous_context_less_match');
      manager.shutdown();
    });
  });
});

describe('G1 — ring buffer structure', () => {
  it('ERRORCORE_CAPTURE_ID_SYMBOL is Symbol.for-keyed', () => {
    expect(ERRORCORE_CAPTURE_ID_SYMBOL).toBe(Symbol.for('errorcore.v1.captureId'));
  });

  it('LocalsRingBuffer evicts oldest entry when capacity is reached', () => {
    const rb = new LocalsRingBuffer(3);
    rb.push({ id: 'a', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [], createdAt: Date.now() });
    rb.push({ id: 'b', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [], createdAt: Date.now() });
    rb.push({ id: 'c', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [], createdAt: Date.now() });
    rb.push({ id: 'd', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [], createdAt: Date.now() });
    expect(rb.getById('a')).toBeUndefined();
    expect(rb.getById('d')).toBeDefined();
  });

  it('LocalsRingBuffer.findByIdentity returns LIFO-most-recent match', () => {
    const rb = new LocalsRingBuffer(4);
    rb.push({ id: '1', requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h', frames: [], createdAt: Date.now() });
    rb.push({ id: '2', requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h', frames: [], createdAt: Date.now() });
    const match = rb.findByIdentity({ requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h' });
    expect(match?.id).toBe('2');
  });

  it('allocateId returns monotonically increasing string ids', () => {
    const rb = new LocalsRingBuffer(4);
    const a = rb.allocateId();
    const b = rb.allocateId();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
    expect(Number(b)).toBeGreaterThan(Number(a));
  });
});

describe('G1 — structural hash', () => {
  it('hashes function names only, not paths', () => {
    const h1 = computeStructuralHash([
      { functionName: 'GET' },
      { functionName: 'handler' }
    ]);
    const h2 = computeStructuralHash([
      { functionName: 'GET' },
      { functionName: 'handler' }
    ]);
    expect(h1).toBe(h2);
  });

  it('different function names → different hashes', () => {
    const h1 = computeStructuralHash([{ functionName: 'GET' }]);
    const h2 = computeStructuralHash([{ functionName: 'POST' }]);
    expect(h1).not.toBe(h2);
  });

  it('empty function names collapse to a fingerprint-only hash (minification case)', () => {
    const h = computeStructuralHash([
      { functionName: '' },
      { functionName: '' }
    ]);
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('G1 — frame count from callFrames', () => {
  it('returns array length', () => {
    expect(countCallFrames([
      { functionName: 'a' }, { functionName: 'b' }, { functionName: 'c' }
    ])).toBe(3);
  });

  it('returns 0 for empty frames', () => {
    expect(countCallFrames([])).toBe(0);
  });
});

describe('G1 — parseStackForFunctionNames', () => {
  it('extracts function names from standard V8 stack frames', () => {
    const stack = [
      'Error: boom',
      '    at handler (/app/src/handler.js:10:5)',
      '    at processRequest (/app/src/server.js:50:3)'
    ].join('\n');

    const result = parseStackForFunctionNames(stack);
    expect(result).toEqual([
      { functionName: 'handler' },
      { functionName: 'processRequest' }
    ]);
  });

  it('returns empty string for anonymous/path-only frames', () => {
    const stack = [
      'Error: boom',
      '    at /app/src/handler.js:10:5'
    ].join('\n');

    const result = parseStackForFunctionNames(stack);
    expect(result).toEqual([{ functionName: '' }]);
  });

  it('returns empty array for undefined stack', () => {
    expect(parseStackForFunctionNames(undefined)).toEqual([]);
  });

  it('skips non-frame lines', () => {
    const stack = [
      'Error: boom',
      '    at handler (/app/src/handler.js:10:5)',
      'Some other text',
      '    at inner (/app/src/inner.js:1:1)'
    ].join('\n');

    const result = parseStackForFunctionNames(stack);
    expect(result).toEqual([
      { functionName: 'handler' },
      { functionName: 'inner' }
    ]);
  });
});

describe('adaptive locals guard', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('trips after sustained pause-rate overload and disarms pause-on-exceptions', () => {
    const timers = createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          captureMode: 'safe',
          localsGuard: { maxPausesPerSecond: 2, maxPauseMsPerMinute: 1_000_000 }
        }),
        { getRequestId: () => 'req-1' }
      );
      manager.ensureDebuggerActive();

      // The 1s rate-limit interval registered in _initSession is the first timer.
      const tickOneSecond = timers.timers[0].fn;

      // 3 pauses/sec (> max 2) for 10 consecutive seconds
      for (let second = 0; second < 10; second += 1) {
        for (let i = 0; i < 3; i += 1) {
          inspector.emitPaused({ reason: 'other', callFrames: [] });
        }
        tickOneSecond();
      }

      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.setPauseOnExceptions',
        { state: 'none' },
        expect.any(Function)
      );

      const result = manager.getLocalsWithDiagnostics(new Error('x'));
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('disabled_adaptive_guard');

      // Re-arming is refused until an adaptive escalation or quiet recovery window.
      manager.ensureDebuggerActive();
      const rearmCalls = inspector.session.post.mock.calls.filter(
        (call) =>
          call[0] === 'Debugger.setPauseOnExceptions' &&
          (call[1] as { state?: string } | undefined)?.state === 'all'
      );
      expect(rearmCalls).toHaveLength(1); // only the initial arm
      manager.shutdown();
    });
  });

  it('re-arms immediately when adaptive escalation resets the guard', () => {
    const timers = createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          captureMode: 'safe',
          localsGuard: { maxPausesPerSecond: 2, maxPauseMsPerMinute: 1_000_000 }
        }),
        { getRequestId: () => 'req-1' }
      );
      manager.ensureDebuggerActive();
      const tickOneSecond = timers.timers[0].fn;

      for (let second = 0; second < 10; second += 1) {
        for (let i = 0; i < 3; i += 1) {
          inspector.emitPaused({ reason: 'other', callFrames: [] });
        }
        tickOneSecond();
      }

      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).toBe(
        'disabled_adaptive_guard'
      );

      manager.rearmAfterAdaptiveGuard();

      const armCalls = inspector.session.post.mock.calls.filter(
        (call) =>
          call[0] === 'Debugger.setPauseOnExceptions' &&
          (call[1] as { state?: string } | undefined)?.state === 'all'
      );
      expect(armCalls).toHaveLength(2);
      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).not.toBe(
        'disabled_adaptive_guard'
      );
      manager.shutdown();
    });
  });

  it('re-arms after five quiet minutes below guard thresholds', () => {
    const timers = createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          captureMode: 'safe',
          localsGuard: { maxPausesPerSecond: 2, maxPauseMsPerMinute: 1_000_000 }
        }),
        { getRequestId: () => 'req-1' }
      );
      manager.ensureDebuggerActive();
      const tickOneSecond = timers.timers[0].fn;

      for (let second = 0; second < 10; second += 1) {
        for (let i = 0; i < 3; i += 1) {
          inspector.emitPaused({ reason: 'other', callFrames: [] });
        }
        tickOneSecond();
      }

      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).toBe(
        'disabled_adaptive_guard'
      );

      now = 299_999;
      tickOneSecond();
      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).toBe(
        'disabled_adaptive_guard'
      );

      now = 300_000;
      tickOneSecond();

      const armCalls = inspector.session.post.mock.calls.filter(
        (call) =>
          call[0] === 'Debugger.setPauseOnExceptions' &&
          (call[1] as { state?: string } | undefined)?.state === 'all'
      );
      expect(armCalls).toHaveLength(2);
      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).not.toBe(
        'disabled_adaptive_guard'
      );
      manager.shutdown();
    });
  });

  it('does not trip when pause rate stays under the limit', () => {
    const timers = createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          captureMode: 'safe',
          localsGuard: { maxPausesPerSecond: 5, maxPauseMsPerMinute: 1_000_000 }
        }),
        { getRequestId: () => 'req-1' }
      );
      manager.ensureDebuggerActive();
      const tickOneSecond = timers.timers[0].fn;

      for (let second = 0; second < 30; second += 1) {
        inspector.emitPaused({ reason: 'other', callFrames: [] });
        tickOneSecond();
      }

      const disarmCalls = inspector.session.post.mock.calls.filter(
        (call) =>
          call[0] === 'Debugger.setPauseOnExceptions' &&
          (call[1] as { state?: string } | undefined)?.state === 'none'
      );
      expect(disarmCalls).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('trips when cumulative pause wall-time exceeds the per-minute budget', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    // Each _onPaused measures elapsed wall-time via process.hrtime.bigint().
    // Advance 100ms per observation so a handful of pauses blow a 250ms budget.
    let fakeNs = 0n;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => {
      fakeNs += 100_000_000n; // +100ms per observation
      return fakeNs;
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        createInspectorConfig({
          captureMode: 'safe',
          localsGuard: { maxPausesPerSecond: 1_000_000, maxPauseMsPerMinute: 250 }
        }),
        { getRequestId: () => 'req-1' }
      );
      manager.ensureDebuggerActive();

      for (let i = 0; i < 10; i += 1) {
        inspector.emitPaused({ reason: 'other', callFrames: [] });
      }

      const disarmCalls = inspector.session.post.mock.calls.filter(
        (call) =>
          call[0] === 'Debugger.setPauseOnExceptions' &&
          (call[1] as { state?: string } | undefined)?.state === 'none'
      );
      expect(disarmCalls.length).toBeGreaterThan(0);
      expect(manager.getLocalsWithDiagnostics(new Error('x')).missReason).toBe(
        'disabled_adaptive_guard'
      );
      manager.shutdown();
    });
  });
});
