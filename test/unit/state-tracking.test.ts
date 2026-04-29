import { describe, expect, it } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { StateTracker } from '../../src/state/state-tracker';

function createContext(als: ALSManager, requestId: string) {
  const context = als.createRequestContext({
    method: 'GET',
    url: '/request',
    headers: { host: 'localhost' }
  });

  context.requestId = requestId;
  return context;
}

describe('StateTracker', () => {
  it('records Map.get reads with serialized values', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const source = new Map<string, { profile: { role: string } }>([
      ['user-1', { profile: { role: 'admin' } }]
    ]);
    const tracked = tracker.track('users', source);
    const context = createContext(als, 'req-map-get');

    const value = als.runWithContext(context, () => tracked.get('user-1'));

    expect(value).toEqual({ profile: { role: 'admin' } });
    expect(context.stateReads).toEqual([
      {
        seq: expect.any(Number),
        container: 'users',
        operation: 'get',
        key: 'user-1',
        value: { profile: { role: 'admin' } },
        timestamp: context.stateReads[0]?.timestamp
      }
    ]);
  });

  it('records Map.has reads with boolean results', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('flags', new Map([['enabled', true]]));
    const context = createContext(als, 'req-map-has');

    const result = als.runWithContext(context, () => tracked.has('enabled'));

    expect(result).toBe(true);
    expect(context.stateReads[0]).toMatchObject({
      container: 'flags',
      operation: 'has',
      key: 'enabled',
      value: true
    });
  });

  it('records plain object property access', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('config', {
      featureFlag: { enabled: true }
    });
    const context = createContext(als, 'req-object');

    const value = als.runWithContext(context, () => tracked.featureFlag);

    expect(value).toEqual({ enabled: true });
    expect(context.stateReads[0]).toMatchObject({
      container: 'config',
      operation: 'get',
      key: 'featureFlag',
      value: { enabled: true }
    });
  });

  it('does not record symbol or internal property access', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('obj', { value: 1 });
    const context = createContext(als, 'req-internal');

    als.runWithContext(context, () => {
      void tracked[Symbol.toStringTag as never];
      void tracked.constructor;
      return tracked.value;
    });

    expect(context.stateReads).toHaveLength(1);
    expect(context.stateReads[0]).toMatchObject({
      key: 'value',
      value: 1
    });
  });

  it('eagerly serializes values so later mutation does not affect recorded reads', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const original = { nested: { counter: 1 } };
    const tracked = tracker.track('state', { original });
    const context = createContext(als, 'req-serialize');

    als.runWithContext(context, () => tracked.original);
    original.nested.counter = 99;

    expect(context.stateReads[0]?.value).toEqual({
      nested: { counter: 1 }
    });
  });

  it('drops reads silently when ALS context is unavailable', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('settings', { theme: 'dark' });

    expect(tracked.theme).toBe('dark');
  });

  it('applies tight limits to large values', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const deepValue = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: 'too-deep'
            }
          }
        }
      }
    };
    const tracked = tracker.track('deep', { deepValue });
    const context = createContext(als, 'req-limits');

    als.runWithContext(context, () => tracked.deepValue);

    expect(context.stateReads[0]?.value).toEqual({
      level1: {
        level2: {
          level3: {
            level4: {
              level5: '[Depth limit]'
            }
          }
        }
      }
    });
  });

  it('does not alter application-visible behavior', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const map = new Map([
      ['alpha', 1],
      ['beta', 2]
    ]);
    const trackedMap = tracker.track('map', map);
    const trackedObject = tracker.track('object', {
      feature: 'on'
    });
    const context = createContext(als, 'req-behavior');

    const results = als.runWithContext(context, () => ({
      mapValue: trackedMap.get('beta'),
      hasAlpha: trackedMap.has('alpha'),
      entries: Array.from(trackedMap.entries()),
      feature: trackedObject.feature
    }));

    expect(results).toEqual({
      mapValue: 2,
      hasAlpha: true,
      entries: [
        ['alpha', 1],
        ['beta', 2]
      ],
      feature: 'on'
    });
  });

  it('keeps different tracked container names separate', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const trackedUsers = tracker.track('users', new Map([['id', 1]]));
    const trackedCache = tracker.track('cache', { hit: true });
    const context = createContext(als, 'req-multi');

    als.runWithContext(context, () => {
      trackedUsers.get('id');
      return trackedCache.hit;
    });

    expect(context.stateReads.map((read) => read.container)).toEqual([
      'users',
      'cache'
    ]);
  });

  it('caps recorded reads per request context', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track(
      'cache',
      Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key${index}`, index]))
    );
    const context = createContext(als, 'req-cap');

    als.runWithContext(context, () => {
      for (let index = 0; index < 60; index += 1) {
        void tracked[`key${index}`];
      }
    });

    expect(context.stateReads).toHaveLength(50);
    expect(context.stateReads[49]?.key).toBe('key49');
  });

  it('does not swallow host getter throws (Reflect.get errors propagate)', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, 'boom', {
      enumerable: true,
      get: () => { throw new Error('host getter threw'); }
    });
    const tracked = tracker.track('dangerous', source);
    const context = createContext(als, 'req-host-throw');

    expect(() =>
      als.runWithContext(context, () => tracked.boom)
    ).toThrow('host getter threw');
  });

  it('survives a recorder failure caused by a hostile value without breaking the host read', () => {
    // cloneAndLimit is invoked on the value by recordStateRead. If the value
    // has a toJSON (or any serialization surface) that throws, the recorder
    // must fail closed and the proxy must still return the raw value.
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const hostile = {
      get toJSON() {
        // cloneAndLimit does not call toJSON directly, but future versions
        // might. We simulate a recorder-side failure by installing a
        // getter on a property we still want to read through the proxy.
        throw new Error('hostile toJSON');
      }
    };
    const tracked = tracker.track('hostile-ish', { payload: hostile });
    const context = createContext(als, 'req-hostile');

    // Reading .payload must succeed and return the raw hostile object.
    const value = als.runWithContext(context, () => tracked.payload);
    expect(value).toBe(hostile);
  });
});

describe('StateTracker — write capture (module 22)', () => {
  it('records object set via the Proxy set trap', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);
    const context = createContext(als, 'req-obj-set');

    als.runWithContext(context, () => {
      tracked.foo = 'bar';
    });

    expect(context.stateWrites).toHaveLength(1);
    expect(context.stateWrites[0]).toMatchObject({
      container: 'cfg',
      operation: 'set',
      key: 'foo',
      value: 'bar',
      seq: expect.any(Number)
    });
    expect(typeof context.stateWrites[0]?.hrtimeNs).toBe('bigint');
  });

  it('records object delete via the deleteProperty trap', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', { foo: 1 } as Record<string, unknown>);
    const context = createContext(als, 'req-obj-del');

    als.runWithContext(context, () => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete tracked.foo;
    });

    expect(context.stateWrites).toHaveLength(1);
    expect(context.stateWrites[0]).toMatchObject({
      operation: 'delete',
      key: 'foo',
      value: undefined
    });
  });

  it('records Map.set with chained calls and preserves the Map return value', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cache', new Map<string, number>()) as Map<string, number>;
    const context = createContext(als, 'req-map-set');

    let chained: Map<string, number> | undefined;
    als.runWithContext(context, () => {
      chained = tracked.set('a', 1).set('b', 2);
    });

    expect(chained).toBe(tracked);
    expect(context.stateWrites).toHaveLength(2);
    expect(context.stateWrites[0]).toMatchObject({ operation: 'set', key: 'a', value: 1 });
    expect(context.stateWrites[1]).toMatchObject({ operation: 'set', key: 'b', value: 2 });
  });

  it('records Map.delete and returns the boolean result unchanged', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track(
      'cache',
      new Map<string, number>([['a', 1]])
    ) as Map<string, number>;
    const context = createContext(als, 'req-map-del');

    let deletedExisting: boolean | undefined;
    let deletedMissing: boolean | undefined;
    als.runWithContext(context, () => {
      deletedExisting = tracked.delete('a');
      deletedMissing = tracked.delete('nonexistent');
    });

    expect(deletedExisting).toBe(true);
    expect(deletedMissing).toBe(false);
    expect(context.stateWrites).toHaveLength(2);
    expect(context.stateWrites[0]).toMatchObject({ operation: 'delete', key: 'a', value: undefined });
    expect(context.stateWrites[1]).toMatchObject({ operation: 'delete', key: 'nonexistent', value: undefined });
  });

  it('caps writes at maxWritesPerContext and counts overflow on completenessOverflow', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({
      als,
      config: { stateTracking: { captureWrites: true, maxWritesPerContext: 3 } }
    });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);
    const context = createContext(als, 'req-cap');

    als.runWithContext(context, () => {
      for (let i = 0; i < 10; i += 1) tracked[`k${i}`] = i;
    });

    expect(context.stateWrites).toHaveLength(3);
    expect(context.completenessOverflow?.stateWritesDropped).toBe(7);
  });

  it('does not record writes when captureWrites is false', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({
      als,
      config: { stateTracking: { captureWrites: false, maxWritesPerContext: 50 } }
    });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);
    const context = createContext(als, 'req-disabled');

    als.runWithContext(context, () => {
      tracked.x = 1;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete tracked.x;
    });

    expect(context.stateWrites).toHaveLength(0);
  });

  it('skips Symbol and internal property writes', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);
    const context = createContext(als, 'req-internals');

    als.runWithContext(context, () => {
      const sym = Symbol('s');
      (tracked as Record<symbol | string, unknown>)[sym] = 1;
      // INTERNAL_OBJECT_PROPERTIES — recorder must skip these even on write.
      tracked.constructor = function noop() { /* noop */ };
    });

    expect(context.stateWrites).toHaveLength(0);
  });

  it('returns the boolean from Reflect.set unchanged for frozen targets', () => {
    'use strict';
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const frozen = Object.freeze({ a: 1 } as Record<string, unknown>);
    const tracked = tracker.track('cfg', frozen);
    const context = createContext(als, 'req-frozen');

    // Strict mode: writing to a frozen target throws TypeError. This is a
    // strict-mode invariant on the proxy: returning false from set without
    // throwing would be a violation; returning true would be a lie.
    expect(() =>
      als.runWithContext(context, () => {
        (tracked as Record<string, unknown>).a = 2;
      })
    ).toThrow(TypeError);
  });

  it('does not record writes outside ALS context', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);

    expect(() => {
      tracked.x = 1;
    }).not.toThrow();
  });

  it('survives a recorder failure on hostile write values without breaking the host write', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', {} as Record<string, unknown>);
    const context = createContext(als, 'req-hostile-write');

    const hostile: { toJSON: () => never } = {
      get toJSON(): never {
        throw new Error('hostile toJSON on write');
      }
    };

    als.runWithContext(context, () => {
      tracked.payload = hostile;
    });

    // Host write must succeed even if the recorder threw.
    expect(tracked.payload).toBe(hostile);
  });

  it('stamps strictly increasing seq across reads and writes', () => {
    const als = new ALSManager();
    const tracker = new StateTracker({ als });
    const tracked = tracker.track('cfg', { initial: 1 } as Record<string, unknown>);
    const context = createContext(als, 'req-seq-order');

    als.runWithContext(context, () => {
      void tracked.initial; // read
      tracked.foo = 'bar'; // write
      void tracked.foo; // read
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete tracked.foo; // write
    });

    const seqs = [
      context.stateReads[0]?.seq,
      context.stateWrites[0]?.seq,
      context.stateReads[1]?.seq,
      context.stateWrites[1]?.seq
    ].filter((s): s is number => typeof s === 'number');

    expect(seqs).toHaveLength(4);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

describe('ALSManager throw-unwind', () => {
  it('unwinds the context store when the callback throws', () => {
    const als = new ALSManager();
    const context = als.createRequestContext({
      method: 'GET',
      url: '/throws',
      headers: { host: 'localhost' }
    });

    expect(() =>
      als.runWithContext(context, () => {
        // Context is live here.
        expect(als.getContext()).toBe(context);
        throw new Error('inner');
      })
    ).toThrow('inner');

    // After the throw propagates, the outer (empty) store must be restored.
    expect(als.getContext()).toBeUndefined();
  });
});
