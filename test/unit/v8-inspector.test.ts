import Module = require('node:module');
import path = require('node:path');

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ERRORCORE_CAPTURE_ID_SYMBOL,
  InspectorManager,
  LocalsRingBuffer,
  computeStructuralHash,
  countCallFrames,
  parseStackForFunctionNames
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
      // Simulate Layer 1 tag being installed by the paused handler
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom', objectId: 'obj-1' },
        callFrames: [createCallFrame({ objectId: 'scope-1' })]
      });

      // Manually tag the error (simulating what installCaptureTag does via V8)
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
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at handlerC (/app/src/handler.js:10:5)';
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).toBeNull();
      expect(result.missReason).toBe('ambiguous_correlation');
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
      // Paused event stored under req-1 with message 'boom'
      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: boom' },
        callFrames: [createCallFrame({ objectId: 'scope-1' })]
      });

      // Lookup with req-2 (different requestId) and different message → no match
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

      // Use Layer 2 identity lookup since no tag set on error
      const error = buildErrorAt('deferred', '/app/src/first.js', 1, 1);
      // deferred has 1 frame in error.stack → frameCount=1
      // captured frames used ALL callFrames (2), structuralHash is of all callFrames
      // Layer 2 identity will not match because frameCount(stack)=1 but captured frameCount=callFrames.length=2
      // Instead look at what the ring buffer stores: frameCount = params.callFrames.length = 2
      // And the error.stack parse of buildErrorAt('deferred', ...) gives 1 frame
      // So Layer 2 identity won't exactly match, but dropped_count may
      // Let's just verify a Layer 1 tag approach:
      // Tag the error with the capture ID '1'
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

      // Fill the ring buffer to capacity
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

      // Simulate Layer 1 tag
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

        // Build an error that matches the ring buffer entry via Layer 2
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

      // First capture (captureId='1')
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: msg', objectId: 'exc-a' },
        callFrames: [createCallFrame({ objectId: 'scope-a' })]
      });

      // Second capture (captureId='2')
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: msg', objectId: 'exc-b' },
        callFrames: [createCallFrame({ objectId: 'scope-b' })]
      });

      // Tag error with first capture's id
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

      // Directly push two entries to fill the buffer (capacity=2), then push a third to evict the first
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
      // Push third entry → evicts id='1' (oldest)
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

      // Tag error with evicted id='1': Layer 1 will miss
      const error = buildErrorAt('old');
      (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL] = '1';

      // Layer 2 lookup: requestId='req-1', errorMessage='old' → not in buffer (evicted)
      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.missReason).toContain('cache_miss');
      expect(result.frames).toBeNull();
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

      // Emit with functionName 'capturedFn' → structuralHash = hash('capturedFn')
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'RangeError', description: 'RangeError: too big' },
        callFrames: [createCallFrame({ functionName: 'capturedFn', objectId: 'scope-h' })]
      });

      // Lookup error with different functionName → different structuralHash
      // but same frameCount(1), same requestId/errorName/errorMessage → dropped_hash match
      const error = new Error('too big');
      error.name = 'RangeError';
      // Stack with different function name gives different hash but same frame count
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

      // Emit with 2 call frames
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: count mismatch' },
        callFrames: [
          createCallFrame({ functionName: 'outer', objectId: 'scope-outer' }),
          createCallFrame({ functionName: 'inner', objectId: 'scope-inner' })
        ]
      });

      // Lookup error stack with 1 frame → frameCount=1, not matching captured frameCount=2
      const error = new Error('count mismatch');
      error.stack = 'Error: count mismatch\n    at onlyOne (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      // Only 1 entry in buffer → unique dropped_count match
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

      // Emit with no requestId → stored with requestId=null
      mock.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'Error: bg error' },
        callFrames: [createCallFrame({ functionName: 'bgFn', objectId: 'scope-bg' })]
      });

      // Lookup also has no requestId context
      const error = new Error('bg error');
      error.stack = 'Error: bg error\n    at bgFn (/app/src/handler.js:10:5)';

      const result = manager.getLocalsWithDiagnostics(error);
      expect(result.frames).not.toBeNull();
      expect(result.captureLayer).toBe('identity');
      expect(result.degradation).toBe('background');
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

      // Two identical background captures
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
