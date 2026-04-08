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
});
