import Module = require('node:module');
import path = require('node:path');

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ERRORCORE_CAPTURE_ID_SYMBOL,
  InspectorManager,
  LocalsRingBuffer
} from '../../src/capture/inspector-manager';
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
      expect(timers.timers).toHaveLength(2);
      expect(timers.timers[0]?.unref).toHaveBeenCalledTimes(1);
      expect(timers.timers[1]?.unref).toHaveBeenCalledTimes(1);
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

  it('collects app-frame locals and caches them one-shot by request plus frame location', () => {
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
    let activeRequestId: string | undefined = 'req-1';

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => activeRequestId
      });

      manager.ensureDebuggerActive();
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'boom' },
        callFrames: [createCallFrame({ objectId: 'scope-1' })]
      });

      const first = manager.getLocals(buildErrorAt());
      const second = manager.getLocals(buildErrorAt());

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
      expect(second).toBeNull();
      manager.shutdown();
    });
  });

  it('uses request context to keep identical messages isolated across requests', () => {
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

  it('drops ambiguous collisions instead of guessing locals', () => {
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
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom' },
        callFrames: [createCallFrame({ objectId: 'scope-2' })]
      });

      expect(manager.getLocalsWithDiagnostics(buildErrorAt())).toEqual({
        frames: null,
        missReason: 'ambiguous_correlation'
      });
      manager.shutdown();
    });
  });

  it('drops paused locals when no request context is active', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 7 } }]
        })
      }
    });
    let activeRequestId: string | undefined;

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

      activeRequestId = 'req-1';
      const result = manager.getLocalsWithDiagnostics(buildErrorAt());

      expect(result.frames).toBeNull();
      expect(result.missReason).toContain('cache_miss');
      manager.shutdown();
    });
  });

  it('returns secure miss reasons when lookup lacks request context or an app frame key', () => {
    createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();
    let activeRequestId: string | undefined;

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => activeRequestId
      });

      manager.ensureDebuggerActive();

      const noContextResult = manager.getLocalsWithDiagnostics(buildErrorAt());
      expect(noContextResult.frames).toBeNull();
      expect(noContextResult.missReason).toContain('cache_miss');

      activeRequestId = 'req-1';
      expect(
        manager.getLocalsWithDiagnostics(
          Object.assign(new Error('no parsable app frame'), {
            stack:
              'Error: no parsable app frame\n' +
              '    at processTicksAndRejections (node:internal/process/task_queues:96:5)'
          })
        )
      ).toEqual({
        frames: null,
        missReason: 'no_app_frame_key'
      });

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

      expect(manager.getLocals(buildErrorAt('deferred', '/app/src/first.js', 1, 1))).toEqual([
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

  it('applies gate ordering for rate limiting and cache capacity', () => {
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
          maxCachedLocals: 1
        }),
        { getRequestId: () => 'req-1' }
      ) as unknown as {
        collectionCountThisSecond: number;
        cache: Map<string, { frames: unknown[] | null; timestamp: number; ambiguous: boolean }>;
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      manager.collectionCountThisSecond = 1;
      manager._onPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'rate-limited' },
        callFrames: [createCallFrame({ objectId: 'scope-rate' })]
      });

      manager.collectionCountThisSecond = 0;
      manager.cache.set('existing', {
        frames: [],
        timestamp: Date.now(),
        ambiguous: false
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
        manager._serializeRemoteObject({ type: 'function', description: 'fn()' })
      ).toBe('[Function: fn()]');
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

  it('drops expired cache entries on sweep', () => {
    const timers = createTimerStubs();
    createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig()) as unknown as {
        ensureDebuggerActive(): void;
        cache: Map<string, { frames: unknown[] | null; timestamp: number; ambiguous: boolean }>;
        shutdown(): void;
      };

      manager.ensureDebuggerActive();

      manager.cache.set('expired', {
        frames: [],
        timestamp: Date.now() - 31_000,
        ambiguous: false
      });

      timers.timers[1]?.fn();

      expect(manager.cache.size).toBe(0);
      manager.shutdown();
    });
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

  it('shutdown disconnects the session, clears timers, empties cache, and marks unavailable', () => {
    const timers = createTimerStubs();
    const timeoutTimers = createTimeoutStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(createInspectorConfig(), {
        getRequestId: () => 'req-1'
      }) as unknown as {
        cache: Map<string, { frames: unknown[] | null; timestamp: number; ambiguous: boolean }>;
        isAvailable(): boolean;
        ensureDebuggerActive(): void;
        shutdown(): void;
      };

      manager.cache.set('Error: boom', {
        frames: [],
        timestamp: Date.now(),
        ambiguous: false
      });
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
      expect(timers.clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(timeoutTimers.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(manager.cache.size).toBe(0);
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

    it('returns frames with null missReason on cache hit', () => {
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

      mock.emitPaused({
        reason: 'exception',
        data: { type: 'object', className: 'Error', description: 'Error: diag test' },
        callFrames: [
          createCallFrame({
            filePath: '/app/handler.js',
            lineNumber: 11,
            columnNumber: 6,
            objectId: 'obj-1'
          })
        ]
      });

      const result = manager.getLocalsWithDiagnostics(
        buildErrorAt('diag test', '/app/handler.js', 11, 6)
      );

      expect(result.frames).not.toBeNull();
      expect(result.frames).toHaveLength(1);
      expect(result.frames![0].locals.x).toBe(42);
      expect(result.missReason).toBeNull();

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
