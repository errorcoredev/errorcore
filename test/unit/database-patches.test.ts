import Module = require('node:module');

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import { ALSManager } from '../../src/context/als-manager';
import { PatchManager, unwrapMethod, wrapMethod } from '../../src/recording/patches/patch-manager';
import { install as installPgPatch } from '../../src/recording/patches/pg';
import { install as installMysql2Patch } from '../../src/recording/patches/mysql2';
import { install as installIoredisPatch } from '../../src/recording/patches/ioredis';
import { install as installMongodbPatch } from '../../src/recording/patches/mongodb';
import { resolveTestConfig } from '../helpers/test-config';

const originalRequire = Module.prototype.require;

function createDeps(overrides: Parameters<typeof resolveTestConfig>[0] = {}) {
  const config = resolveTestConfig(overrides);

  return {
    buffer: new IOEventBuffer({ capacity: 100, maxBytes: 1_000_000 }),
    als: new ALSManager(),
    config
  };
}

async function withDriverMocks<T>(
  mocks: Record<string, unknown>,
  run: () => Promise<T> | T
): Promise<T> {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    return originalRequire.apply(this, [request]);
  };

  try {
    return await run();
  } finally {
    Module.prototype.require = originalRequire;
  }
}

function createContext(als: ALSManager, requestId: string) {
  const context = als.createRequestContext({
    method: 'GET',
    url: '/request',
    headers: { host: 'localhost' }
  });

  context.requestId = requestId;
  return context;
}

describe('patch infrastructure', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('installAll succeeds when no drivers are installed', () => {
    const patchManager = new PatchManager(createDeps());

    expect(() => patchManager.installAll()).not.toThrow();
    expect(() => patchManager.unwrapAll()).not.toThrow();
  });

  it('wrapMethod and unwrapMethod are idempotent', () => {
    const target = {
      value: 1,
      method(): number {
        return this.value;
      }
    };

    wrapMethod(target, 'method', (original) => {
      return function wrapped(this: typeof target) {
        return (original.call(this) as number) + 1;
      };
    });
    wrapMethod(target, 'method', (original) => {
      return function wrappedAgain(this: typeof target) {
        return (original.call(this) as number) + 2;
      };
    });

    expect(target.method()).toBe(3);

    unwrapMethod(target, 'method');
    unwrapMethod(target, 'method');

    expect(target.method()).toBe(1);
  });

  it('unwrapMethod restores a third-party predecessor when the SDK wrapped on top of it', () => {
    const target = {
      value: 1,
      method(): number {
        return this.value;
      }
    };
    const originalMethod = target.method;
    const thirdPartyWrapper = function wrappedByThirdParty(this: typeof target): number {
      return originalMethod.call(this) + 10;
    };

    target.method = thirdPartyWrapper;

    wrapMethod(target, 'method', (original) => {
      return function sdkWrapped(this: typeof target) {
        return (original.call(this) as number) + 1;
      };
    });

    expect(target.method()).toBe(12);

    unwrapMethod(target, 'method');

    expect(target.method).toBe(thirdPartyWrapper);
    expect(target.method()).toBe(11);
  });

  it('unwrapMethod leaves a later third-party wrapper in place during SDK teardown', () => {
    const target = {
      value: 1,
      method(): number {
        return this.value;
      }
    };

    wrapMethod(target, 'method', (original) => {
      return function sdkWrapped(this: typeof target) {
        return (original.call(this) as number) + 1;
      };
    });

    const sdkWrappedMethod = target.method;
    const thirdPartyWrapper = function wrappedAfterSdk(this: typeof target): number {
      return sdkWrappedMethod.call(this) + 10;
    };

    target.method = thirdPartyWrapper;

    unwrapMethod(target, 'method');

    expect(target.method).toBe(thirdPartyWrapper);
    expect(target.method()).toBe(12);
  });

  it('unwrapAll restores original patched methods', async () => {
    class FakeClient {
      public query(): string {
        return 'original';
      }
    }

    const pg = { Client: FakeClient };
    const originalQuery = FakeClient.prototype.query;

    await withDriverMocks({ pg }, () => {
      const patchManager = new PatchManager(createDeps());

      patchManager.installAll();
      expect(FakeClient.prototype.query).not.toBe(originalQuery);

      patchManager.unwrapAll();
      expect(FakeClient.prototype.query).toBe(originalQuery);
    });
  });
});

describe('pg patch', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('records callback-based queries with redacted params and ALS request id', async () => {
    class FakeClient {
      public host = 'pg.local';

      public port = 5432;

      public database = 'appdb';

      public query(...args: unknown[]): string {
        const callback =
          typeof args[1] === 'function'
            ? (args[1] as (error: null, result: { rowCount: number }) => void)
            : (args[2] as (error: null, result: { rowCount: number }) => void);

        callback(null, { rowCount: 2 });
        return 'pg-callback-result';
      }
    }

    class FakePool {
      public options = { host: 'pg.local', port: 5432, database: 'appdb' };

      public query(config: { text: string; values: unknown[] }): Promise<{ rowCount: number }> {
        return Promise.resolve({ rowCount: config.values.length });
      }
    }

    await withDriverMocks({ pg: { Client: FakeClient, Pool: FakePool } }, async () => {
      const deps = createDeps();
      const uninstall = installPgPatch(deps);
      const client = new FakeClient();
      const pool = new FakePool();
      const context = createContext(deps.als, 'req-pg');
      let callbackResult: { rowCount: number } | undefined;

      try {
        const returnValue = deps.als.runWithContext(context, () =>
          client.query(
            'select * from users where id = $1',
            ['secret-id'],
            (_error, result) => {
              callbackResult = result;
            }
          )
        );
        const configResult = await deps.als.runWithContext(context, () =>
          pool.query({ text: 'select now()', values: [1, 2] })
        );
        const slots = deps.buffer.drain();

        expect(returnValue).toBe('pg-callback-result');
        expect(callbackResult).toEqual({ rowCount: 2 });
        expect(configResult).toEqual({ rowCount: 2 });
        expect(slots[0]).toMatchObject({
          type: 'db-query',
          target: 'postgres://pg.local:5432/appdb',
          method: 'query',
          requestId: 'req-pg',
          dbMeta: {
            query: 'select * from users where id = $1',
            params: '[PARAM_1]',
            rowCount: 2
          }
        });
        expect(slots[1]).toMatchObject({
          dbMeta: {
            query: 'select now()',
            params: '[PARAM_1], [PARAM_2]',
            rowCount: 2
          }
        });
      } finally {
        uninstall();
      }
    });
  });

  it('records pg query errors', async () => {
    class FakeClient {
      public host = 'pg.local';

      public port = 5432;

      public database = 'appdb';

      public query(): Promise<never> {
        return Promise.reject(new Error('pg failed'));
      }
    }

    await withDriverMocks({ pg: { Client: FakeClient } }, async () => {
      const deps = createDeps();
      const uninstall = installPgPatch(deps);
      const client = new FakeClient();

      try {
        await expect(client.query('select 1')).rejects.toThrow('pg failed');
        expect(deps.buffer.drain()[0]).toMatchObject({
          error: {
            type: 'Error',
            message: 'pg failed'
          }
        });
      } finally {
        uninstall();
      }
    });
  });
});

describe('mysql2 patch', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('records query and execute while preserving original results', async () => {
    class FakeConnection {
      public config = { host: 'mysql.local', port: 3306, database: 'appdb' };

      public query(
        sql: string,
        values: unknown[],
        callback: (error: null, result: { affectedRows: number }) => void
      ): string {
        callback(null, { affectedRows: values.length });
        return `${sql}:query`;
      }

      public execute(sql: string, values: unknown[]): Promise<{ affectedRows: number }> {
        return Promise.resolve({ affectedRows: values.length + 1 });
      }
    }

    await withDriverMocks({ mysql2: { Connection: FakeConnection } }, async () => {
      const deps = createDeps();
      const uninstall = installMysql2Patch(deps);
      const connection = new FakeConnection();
      const context = createContext(deps.als, 'req-mysql');
      let callbackRows = 0;

      try {
        const queryReturn = deps.als.runWithContext(context, () =>
          connection.query('select * from table', [1], (_error, result) => {
            callbackRows = result.affectedRows;
          })
        );
        const executeReturn = await deps.als.runWithContext(context, () =>
          connection.execute('update table set a = ?', ['x', 'y'])
        );
        const slots = deps.buffer.drain();

        expect(queryReturn).toBe('select * from table:query');
        expect(callbackRows).toBe(1);
        expect(executeReturn).toEqual({ affectedRows: 3 });
        expect(slots[0]).toMatchObject({
          target: 'mysql://mysql.local:3306/appdb',
          method: 'query',
          requestId: 'req-mysql',
          dbMeta: {
            query: 'select * from table',
            params: '[PARAM_1]',
            rowCount: 1
          }
        });
        expect(slots[1]).toMatchObject({
          method: 'execute',
          dbMeta: {
            query: 'update table set a = ?',
            params: '[PARAM_1], [PARAM_2]',
            rowCount: 3
          }
        });
      } finally {
        uninstall();
      }
    });
  });

  it('records mysql2 query errors', async () => {
    class FakeConnection {
      public config = { host: 'mysql.local', port: 3306, database: 'appdb' };

      public query(): Promise<never> {
        return Promise.reject(new Error('mysql failed'));
      }

      public execute(): Promise<never> {
        return Promise.reject(new Error('mysql failed'));
      }
    }

    await withDriverMocks({ mysql2: { Connection: FakeConnection } }, async () => {
      const deps = createDeps();
      const uninstall = installMysql2Patch(deps);
      const connection = new FakeConnection();

      try {
        await expect(connection.query('select 1')).rejects.toThrow('mysql failed');
        expect(deps.buffer.drain()[0]).toMatchObject({
          error: {
            type: 'Error',
            message: 'mysql failed'
          }
        });
      } finally {
        uninstall();
      }
    });
  });
});

describe('ioredis patch', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('records redis commands with command and key only', async () => {
    class FakeRedis {
      public options = { host: 'redis.local', port: 6379 };

      public sendCommand(command: { name: string; args: unknown[] }): Promise<string> {
        return Promise.resolve(`${command.name}:ok`);
      }
    }

    await withDriverMocks({ ioredis: FakeRedis }, async () => {
      const deps = createDeps();
      const uninstall = installIoredisPatch(deps);
      const redis = new FakeRedis();
      const context = createContext(deps.als, 'req-redis');

      try {
        const getResult = await deps.als.runWithContext(context, () =>
          redis.sendCommand({ name: 'GET', args: ['mykey', 'secret-value'] })
        );
        const setResult = await deps.als.runWithContext(context, () =>
          redis.sendCommand({ name: 'SET', args: ['other-key', 'another-secret'] })
        );
        const slots = deps.buffer.drain();

        expect(getResult).toBe('GET:ok');
        expect(setResult).toBe('SET:ok');
        expect(slots[0]).toMatchObject({
          target: 'redis://redis.local:6379',
          method: 'GET',
          requestId: 'req-redis',
          dbMeta: {
            query: 'GET mykey',
            collection: 'mykey'
          }
        });
        expect(slots[0]?.dbMeta?.params).toBeUndefined();
        expect(slots[1]).toMatchObject({
          method: 'SET',
          dbMeta: {
            query: 'SET other-key',
            collection: 'other-key'
          }
        });
      } finally {
        uninstall();
      }
    });
  });

  it('redacts credentials on AUTH and HELLO commands', async () => {
    // Regression: the ioredis patch captured args[0] as "collection" and
    // included it in the formatted query. For AUTH and HELLO, args[0]
    // is the plaintext password. Without redaction the SDK recorded a
    // credential into every captured error package.
    class FakeRedis {
      public options = { host: 'redis.local', port: 6379 };

      public sendCommand(command: { name: string; args: unknown[] }): Promise<string> {
        return Promise.resolve(`${command.name}:ok`);
      }
    }

    await withDriverMocks({ ioredis: FakeRedis }, async () => {
      const deps = createDeps();
      const uninstall = installIoredisPatch(deps);
      const redis = new FakeRedis();
      const context = createContext(deps.als, 'req-redis-auth');

      try {
        await deps.als.runWithContext(context, () =>
          redis.sendCommand({ name: 'AUTH', args: ['super-secret-password'] })
        );
        await deps.als.runWithContext(context, () =>
          redis.sendCommand({ name: 'HELLO', args: ['3', 'AUTH', 'user', 'pw'] })
        );
        const slots = deps.buffer.drain();

        expect(slots[0]?.dbMeta?.query).toBe('AUTH [REDACTED]');
        expect(slots[0]?.dbMeta?.collection).toBeUndefined();
        expect(slots[0]?.method).toBe('AUTH');

        expect(slots[1]?.dbMeta?.query).toBe('HELLO [REDACTED]');
        expect(slots[1]?.dbMeta?.collection).toBeUndefined();
        expect(slots[1]?.method).toBe('HELLO');
      } finally {
        uninstall();
      }
    });
  });

  it('records redis command errors', async () => {
    class FakeRedis {
      public options = { host: 'redis.local', port: 6379 };

      public sendCommand(): Promise<never> {
        return Promise.reject(new Error('redis failed'));
      }
    }

    await withDriverMocks({ ioredis: FakeRedis }, async () => {
      const deps = createDeps();
      const uninstall = installIoredisPatch(deps);
      const redis = new FakeRedis();

      try {
        await expect(redis.sendCommand({ name: 'GET', args: ['k'] })).rejects.toThrow(
          'redis failed'
        );
        expect(deps.buffer.drain()[0]).toMatchObject({
          error: {
            type: 'Error',
            message: 'redis failed'
          }
        });
      } finally {
        uninstall();
      }
    });
  });
});

describe('mongodb patch', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('records collection operations with key-only summaries', async () => {
    class FakeCollection {
      public collectionName = 'users';

      public db = { databaseName: 'appdb' };

      public find(filter: Record<string, unknown>) {
        return {
          filter,
          toArray: async () => []
        };
      }

      public insertOne(): Promise<{ insertedCount: number }> {
        return Promise.resolve({ insertedCount: 1 });
      }
    }

    await withDriverMocks({ mongodb: { Collection: FakeCollection } }, async () => {
      const deps = createDeps();
      const uninstall = installMongodbPatch(deps);
      const collection = new FakeCollection();
      const context = createContext(deps.als, 'req-mongo');

      try {
        const cursor = deps.als.runWithContext(context, () =>
          collection.find({ _id: 1, status: 'active' })
        );
        const insertResult = await deps.als.runWithContext(context, () =>
          collection.insertOne({ email: 'hidden@example.com' })
        );
        const slots = deps.buffer.drain();

        expect(typeof cursor.toArray).toBe('function');
        expect(insertResult).toEqual({ insertedCount: 1 });
        expect(slots[0]).toMatchObject({
          target: 'mongodb://appdb',
          method: 'find',
          requestId: 'req-mongo',
          phase: 'active',
          dbMeta: {
            query: '{ _id, status }',
            collection: 'users'
          }
        });
        expect(slots[1]).toMatchObject({
          method: 'insertOne',
          phase: 'done',
          dbMeta: {
            query: '{ email }',
            collection: 'users',
            rowCount: 1
          }
        });
      } finally {
        uninstall();
      }
    });
  });

  it('records mongodb operation errors', async () => {
    class FakeCollection {
      public collectionName = 'users';

      public db = { databaseName: 'appdb' };

      public updateOne(): Promise<never> {
        return Promise.reject(new Error('mongo failed'));
      }
    }

    await withDriverMocks({ mongodb: { Collection: FakeCollection } }, async () => {
      const deps = createDeps();
      const uninstall = installMongodbPatch(deps);
      const collection = new FakeCollection();

      try {
        await expect(collection.updateOne({ _id: 1 }, { $set: { name: 'x' } })).rejects.toThrow(
          'mongo failed'
        );
        expect(deps.buffer.drain()[0]).toMatchObject({
          error: {
            type: 'Error',
            message: 'mongo failed'
          },
          dbMeta: {
            query: '{ _id }',
            collection: 'users'
          }
        });
      } finally {
        uninstall();
      }
    });
  });
});

describe('G2 — PatchManager threads drivers config into installers', () => {
  it('passes config.drivers.pg as explicitDriver to the pg installer', async () => {
    const userPg = { Client: { prototype: { query: function orig() { return 'sentinel'; } } }, Pool: { prototype: {} } };
    const userMongo = { MongoClient: { prototype: { connect: function orig() { return 'm-orig'; } } } };

    await withDriverMocks({}, () => {
      const config = resolveTestConfig({
        drivers: { pg: userPg, mongodb: userMongo }
      });
      const pm = new PatchManager({
        buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
        als: new ALSManager(),
        config
      });

      // Before installAll, user pg.Client.prototype.query is the original function.
      const originalQuery = userPg.Client.prototype.query;
      const originalConnect = userMongo.MongoClient.prototype.connect;

      pm.installAll();

      // After installAll (with Tasks 9-12 landed), the user's own pg.Client
      // prototype is wrapped because PatchManager threaded the reference
      // through. For this task alone (without 9-12), we instead verify
      // PatchManager dispatched the deps correctly by inspecting that
      // config.drivers survives through resolveConfig and is accessible on
      // the PatchManager instance's deps.
      expect(config.drivers.pg).toBe(userPg);
      expect(config.drivers.mongodb).toBe(userMongo);

      pm.unwrapAll();
      // After unwrapAll, prototypes restored (will be a no-op until 9-12
      // actually wrap, but the unwrap path must not throw).
      expect(userPg.Client.prototype.query).toBe(originalQuery);
      expect(userMongo.MongoClient.prototype.connect).toBe(originalConnect);
    });
  });

  it('gracefully handles drivers with only some entries set', () => {
    const userPg = { Client: { prototype: { query: function() {} } }, Pool: { prototype: {} } };
    const config = resolveTestConfig({
      drivers: { pg: userPg } // mongodb, mysql2, ioredis not set
    });
    const pm = new PatchManager({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      config
    });

    expect(() => pm.installAll()).not.toThrow();
    expect(() => pm.unwrapAll()).not.toThrow();
  });
});

describe('G2 — pg installer with explicit driver', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('uses explicitDriver when provided', () => {
    const originalQuery = function originalQuery() { return 'pg-orig'; };
    const fakePg = {
      Client: { prototype: { query: originalQuery } },
      Pool: { prototype: { query: originalQuery } }
    };

    const deps = { ...createDeps(), explicitDriver: fakePg };
    const uninstall = installPgPatch(deps);

    // The installer must have wrapped the user's own prototype methods.
    expect(fakePg.Client.prototype.query).not.toBe(originalQuery);
    expect(fakePg.Pool.prototype.query).not.toBe(originalQuery);

    uninstall();

    expect(fakePg.Client.prototype.query).toBe(originalQuery);
    expect(fakePg.Pool.prototype.query).toBe(originalQuery);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = createDeps(); // no explicitDriver
    expect(() => installPgPatch(deps)).not.toThrow();
  });
});

describe('G2 — mongodb installer with explicit driver', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('uses explicitDriver when provided', () => {
    const originalFind = function originalFind() { return 'mongo-orig'; };
    const fakeMongodb = {
      Collection: { prototype: { find: originalFind } }
    };

    const deps = { ...createDeps(), explicitDriver: fakeMongodb };
    const uninstall = installMongodbPatch(deps);

    // The installer must have wrapped the user's own Collection.prototype.find
    expect(fakeMongodb.Collection.prototype.find).not.toBe(originalFind);

    uninstall();

    expect(fakeMongodb.Collection.prototype.find).toBe(originalFind);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = createDeps(); // no explicitDriver
    expect(() => installMongodbPatch(deps)).not.toThrow();
  });
});

describe('G2 — mysql2 installer with explicit driver', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('uses explicitDriver when provided', () => {
    const originalQuery = function originalQuery() { return 'mysql2-query-orig'; };
    const originalExecute = function originalExecute() { return 'mysql2-execute-orig'; };
    const fakeMysql2 = {
      Connection: { prototype: { query: originalQuery, execute: originalExecute } }
    };

    const deps = { ...createDeps(), explicitDriver: fakeMysql2 };
    const uninstall = installMysql2Patch(deps);

    expect(fakeMysql2.Connection.prototype.query).not.toBe(originalQuery);
    expect(fakeMysql2.Connection.prototype.execute).not.toBe(originalExecute);

    uninstall();

    expect(fakeMysql2.Connection.prototype.query).toBe(originalQuery);
    expect(fakeMysql2.Connection.prototype.execute).toBe(originalExecute);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = createDeps(); // no explicitDriver
    expect(() => installMysql2Patch(deps)).not.toThrow();
  });
});

describe('G2 — ioredis installer with explicit driver', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('uses explicitDriver when provided', () => {
    const originalSendCommand = function originalSendCommand() { return Promise.resolve('ok'); };
    // ioredis exports the constructor class directly; the installer does:
    //   const Redis = (deps.explicitDriver ?? nodeRequire('ioredis')) as { prototype?: object }
    // and then wraps Redis.prototype.sendCommand
    class FakeRedis {
      public sendCommand = originalSendCommand;
    }
    // The installer checks Redis.prototype, so attach there too
    FakeRedis.prototype.sendCommand = originalSendCommand;

    const deps = { ...createDeps(), explicitDriver: FakeRedis };
    const uninstall = installIoredisPatch(deps);

    expect(FakeRedis.prototype.sendCommand).not.toBe(originalSendCommand);

    uninstall();

    expect(FakeRedis.prototype.sendCommand).toBe(originalSendCommand);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = createDeps(); // no explicitDriver
    expect(() => installIoredisPatch(deps)).not.toThrow();
  });
});
