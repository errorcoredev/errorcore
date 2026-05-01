import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALSManager } from '../../../src/context/als-manager';
import { EventClock } from '../../../src/context/event-clock';
import { IOEventBuffer } from '../../../src/buffer/io-event-buffer';
import { install as installIoredisPatch } from '../../../src/recording/patches/ioredis';
import { resolveTestConfig } from '../../helpers/test-config';
import { tryRequire } from './fixtures/install-test-deps';
import { startRedisStub, type StubServer } from './fixtures/redis-stub-server';

// ioredis exports the Redis class as the module's callable default. The
// CJS module.exports is the constructor with extra named exports glued
// on (.default, .Redis, .Cluster, ...). The driver patch wraps
// methods on `Redis.prototype` — passing the module reference itself as
// `explicitDriver` works because the module IS the constructor.
const ioredisModule = tryRequire<typeof import('ioredis').default & { default?: unknown }>(
  'ioredis'
);
const Redis = ioredisModule;

describe.skipIf(Redis === null)('ioredis driver integration', () => {
  let stub: StubServer;
  let buffer: IOEventBuffer;
  let als: ALSManager;
  let uninstall: () => void;
  let redis: import('ioredis').default;

  beforeEach(async () => {
    stub = await startRedisStub();
    buffer = new IOEventBuffer({
      capacity: 50,
      maxBytes: 1_000_000,
      eventClock: new EventClock(),
    });
    als = new ALSManager();
    const config = resolveTestConfig({});

    const result = installIoredisPatch({
      buffer,
      als,
      config,
      explicitDriver: Redis,
    });
    uninstall = result.uninstall;

    redis = new Redis!({
      port: stub.port,
      host: '127.0.0.1',
      lazyConnect: true,
      // Keep ioredis from emitting noisy reconnect chatter against the stub.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
    await redis.connect();
  });

  afterEach(async () => {
    try {
      await redis.quit();
    } catch {
      /* socket may already be gone */
    }
    redis.disconnect();
    uninstall();
    await stub.close();
  });

  it('records a basic SET/GET as outbound db-query events', async () => {
    await redis.set('foo', 'bar');
    const value = await redis.get('foo');
    expect(value).toBe('bar');

    const events = buffer.getRecentWithContext(50).events;
    const setEvent = events.find((e) => e.method?.toLowerCase() === 'set');
    const getEvent = events.find((e) => e.method?.toLowerCase() === 'get');
    expect(setEvent).toBeDefined();
    expect(getEvent).toBeDefined();
    expect(setEvent!.type).toBe('db-query');
    expect(setEvent!.direction).toBe('outbound');
    expect(setEvent!.target).toBe(`redis://127.0.0.1:${stub.port}`);
    expect(setEvent!.dbMeta?.query).toBe('set foo');
    expect(setEvent!.dbMeta?.collection).toBe('foo');
    expect(setEvent!.phase).toBe('done');
    expect(setEvent!.endTime).not.toBeNull();
  });

  it('redacts AUTH credentials in dbMeta', async () => {
    // Send AUTH directly via raw command. ioredis's high-level .auth()
    // helper goes through internal queues that may or may not surface
    // the password to the patched sendCommand path; .call() is the
    // explicit path that does.
    await redis.call('AUTH', 'hunter2').catch(() => undefined);
    const events = buffer.getRecentWithContext(50).events;
    const auth = events.find((e) => e.method?.toLowerCase() === 'auth');
    expect(auth).toBeDefined();
    expect(auth!.dbMeta?.query).toBe('AUTH [REDACTED]');
    // The collection slot must not retain the secret either.
    expect(auth!.dbMeta?.collection).toBeUndefined();

    // The stub server saw the password, but the SDK did not record it.
    expect(stub.authAttempts.some((a) => a === 'hunter2')).toBe(true);
  });

  it('redacts HELLO password in dbMeta', async () => {
    // HELLO 2 AUTH default hunter2 — ioredis sends this when version
    // negotiation needs auth. We invoke sendCommand directly to avoid
    // depending on ioredis's internal auth orchestration.
    await redis.call('HELLO', '2', 'AUTH', 'default', 'hunter2').catch(() => undefined);
    const events = buffer.getRecentWithContext(50).events;
    const hello = events.find((e) => e.method?.toLowerCase() === 'hello');
    expect(hello).toBeDefined();
    expect(hello!.dbMeta?.query).toBe('HELLO [REDACTED]');
    expect(hello!.dbMeta?.collection).toBeUndefined();
  });
});
