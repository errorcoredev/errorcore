import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { RequestTracker } from '../../src/context/request-tracker';
import type { RequestContext } from '../../src/types';

function createContext(
  requestId: string,
  startTime: bigint = 1n
): RequestContext {
  return {
    requestId,
    startTime,
    method: 'GET',
    url: `/requests/${requestId}`,
    headers: { host: 'localhost' },
    body: null,
    bodyTruncated: false,
    ioEvents: [],
    stateReads: []
  };
}

function stubTrackerTimer() {
  let callback: (() => void) | undefined;
  const unref = vi.fn();
  const timer = { unref } as unknown as NodeJS.Timeout;
  const setIntervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((fn: TimerHandler) => {
      callback = fn as () => void;
      return timer;
    }) as typeof setInterval);
  const clearIntervalSpy = vi
    .spyOn(globalThis, 'clearInterval')
    .mockImplementation(() => undefined as never);

  return {
    timer,
    unref,
    invoke: () => callback?.(),
    setIntervalSpy,
    clearIntervalSpy
  };
}

describe('ALSManager', () => {
  it('propagates context across async boundaries', async () => {
    const manager = new ALSManager();
    const context = manager.createRequestContext({
      method: 'GET',
      url: '/users',
      headers: { host: 'localhost' }
    });
    const emitter = new EventEmitter();

    await new Promise<void>((resolve) => {
      emitter.once('done', () => {
        expect(manager.getRequestId()).toBe(context.requestId);
        resolve();
      });

      manager.runWithContext(context, () => {
        Promise.resolve().then(() => {
          expect(manager.getRequestId()).toBe(context.requestId);

          setImmediate(() => {
            expect(manager.getRequestId()).toBe(context.requestId);

            setTimeout(() => {
              expect(manager.getRequestId()).toBe(context.requestId);
              emitter.emit('done');
            }, 0);
          });
        });
      });
    });
  });

  it('isolates context between concurrent requests', async () => {
    const manager = new ALSManager();
    const first = createContext('req-1');
    const second = createContext('req-2');

    const results = await Promise.all([
      new Promise<string | undefined>((resolve) => {
        manager.runWithContext(first, () => {
          setTimeout(() => resolve(manager.getRequestId()), 5);
        });
      }),
      new Promise<string | undefined>((resolve) => {
        manager.runWithContext(second, () => {
          setTimeout(() => resolve(manager.getRequestId()), 0);
        });
      })
    ]);

    expect(results).toEqual(['req-1', 'req-2']);
  });

  it('returns undefined outside request scope', () => {
    const manager = new ALSManager();

    expect(manager.getContext()).toBeUndefined();
    expect(manager.getRequestId()).toBeUndefined();
  });

  it('keeps multiple ALSManager instances independent', () => {
    const firstManager = new ALSManager();
    const secondManager = new ALSManager();
    const firstContext = createContext('req-a');
    const secondContext = createContext('req-b');

    firstManager.runWithContext(firstContext, () => {
      expect(firstManager.getRequestId()).toBe('req-a');
      expect(secondManager.getRequestId()).toBeUndefined();

      secondManager.runWithContext(secondContext, () => {
        expect(firstManager.getRequestId()).toBe('req-a');
        expect(secondManager.getRequestId()).toBe('req-b');
      });
    });
  });

  it('copies request metadata while reusing the prepared headers object', () => {
    const manager = new ALSManager();
    const headers = {
      host: 'localhost',
      'x-request-id': 'req-1'
    };
    const req = {
      method: 'POST',
      url: '/login',
      headers
    };

    const context = manager.createRequestContext(req);

    req.method = 'DELETE';
    req.url = '/mutated';

    expect(context.method).toBe('POST');
    expect(context.url).toBe('/login');
    expect(context.headers).toBe(headers);
  });

  it('does not reuse released contexts across ALS lifetimes', () => {
    const manager = new ALSManager();
    const first = manager.createRequestContext({
      method: 'POST',
      url: '/first',
      headers: { host: 'localhost' }
    });

    first.body = Buffer.from('body');
    first.bodyTruncated = true;
    first.ioEvents.push({ requestId: 'req-1' } as never);
    first.stateReads.push({
      container: 'cache',
      operation: 'get',
      key: 'user',
      value: 1,
      timestamp: 1n
    });
    manager.releaseRequestContext(first);

    const second = manager.createRequestContext({
      method: 'GET',
      url: '/second',
      headers: { host: 'service.local' }
    });

    expect(second).not.toBe(first);
    expect(second.requestId).toMatch(new RegExp(`^${process.pid}-\\d+$`));
    expect(second.method).toBe('GET');
    expect(second.url).toBe('/second');
    expect(second.headers).toEqual({ host: 'service.local' });
    expect(second.body).toBeNull();
    expect(second.bodyTruncated).toBe(false);
    expect(second.ioEvents).toEqual([]);
    expect(second.stateReads).toEqual([]);
  });
});

describe('RequestTracker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds, removes, and returns tracked contexts', () => {
    stubTrackerTimer();
    const tracker = new RequestTracker({ maxConcurrent: 3, ttlMs: 1000 });
    const first = createContext('req-1');
    const second = createContext('req-2');

    tracker.add(first);
    tracker.add(second);

    expect(tracker.getAll()).toEqual([first, second]);
    expect(tracker.getCount()).toBe(2);

    tracker.remove('req-1');

    expect(tracker.getAll()).toEqual([second]);
    expect(tracker.getCount()).toBe(1);
  });

  it('returns lightweight summaries', () => {
    stubTrackerTimer();
    const tracker = new RequestTracker({ maxConcurrent: 2, ttlMs: 1000 });

    tracker.add(createContext('req-1', 10n));

    expect(tracker.getSummaries()).toEqual([
      {
        requestId: 'req-1',
        method: 'GET',
        url: '/requests/req-1',
        startTime: '10'
      }
    ]);
  });

  it('enforces the maxConcurrent cap and logs a debug warning', () => {
    stubTrackerTimer();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const tracker = new RequestTracker({ maxConcurrent: 1, ttlMs: 1000 });

    tracker.add(createContext('req-1'));
    tracker.add(createContext('req-2'));

    expect(tracker.getCount()).toBe(1);
    expect(tracker.getAll()[0]?.requestId).toBe('req-1');
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('sweeps stale entries and unreferences the interval timer', () => {
    const timer = stubTrackerTimer();
    const hrtimeSpy = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(500_000_000n);
    const tracker = new RequestTracker({ maxConcurrent: 3, ttlMs: 100 });

    tracker.add(createContext('stale', 0n));
    tracker.add(createContext('fresh', 450_000_000n));

    timer.invoke();

    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(hrtimeSpy).toHaveBeenCalled();
    expect(tracker.getAll().map((ctx) => ctx.requestId)).toEqual(['fresh']);
  });

  it('supports idempotent removal', () => {
    stubTrackerTimer();
    const tracker = new RequestTracker({ maxConcurrent: 2, ttlMs: 1000 });

    tracker.add(createContext('req-1'));
    tracker.remove('req-1');
    tracker.remove('req-1');

    expect(tracker.getCount()).toBe(0);
  });

  it('shutdown clears the map and stops the timer', () => {
    const timer = stubTrackerTimer();
    const tracker = new RequestTracker({ maxConcurrent: 2, ttlMs: 1000 });

    tracker.add(createContext('req-1'));
    tracker.shutdown();

    expect(tracker.getCount()).toBe(0);
    expect(timer.clearIntervalSpy).toHaveBeenCalledWith(timer.timer);
  });
});
