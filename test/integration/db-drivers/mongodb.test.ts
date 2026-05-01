import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALSManager } from '../../../src/context/als-manager';
import { EventClock } from '../../../src/context/event-clock';
import { IOEventBuffer } from '../../../src/buffer/io-event-buffer';
import { install as installMongodbPatch } from '../../../src/recording/patches/mongodb';
import { resolveTestConfig } from '../../helpers/test-config';
import { tryRequire } from './fixtures/install-test-deps';

const mongodb = tryRequire<typeof import('mongodb')>('mongodb');
const memoryServer = tryRequire<typeof import('mongodb-memory-server')>(
  'mongodb-memory-server'
);

// First-run note: mongodb-memory-server downloads a mongod binary on
// the first invocation (~30s on a cold cache). Subsequent runs reuse
// the cached binary at ~/.cache/mongodb-binaries.

describe.skipIf(mongodb === null || memoryServer === null)(
  'mongodb driver integration',
  () => {
    let server: import('mongodb-memory-server').MongoMemoryServer;
    let client: import('mongodb').MongoClient;

    beforeAll(async () => {
      const { MongoMemoryServer } = memoryServer!;
      const { MongoClient } = mongodb!;
      server = await MongoMemoryServer.create();
      client = new MongoClient(server.getUri());
      await client.connect();
    }, 120_000);

    afterAll(async () => {
      try {
        await client?.close();
      } catch {
        /* ignore */
      }
      try {
        await server?.stop();
      } catch {
        /* ignore */
      }
    }, 30_000);

    function makeBuffer(): IOEventBuffer {
      return new IOEventBuffer({
        capacity: 50,
        maxBytes: 1_000_000,
        eventClock: new EventClock(),
      });
    }

    it('records a basic findOne as a db-query event', async () => {
      const buffer = makeBuffer();
      const config = resolveTestConfig({});
      const { uninstall } = installMongodbPatch({
        buffer,
        als: new ALSManager(),
        config,
        explicitDriver: mongodb!,
      });
      try {
        const db = client.db('itest');
        const coll = db.collection('users');
        await coll.insertOne({ _id: 'u1' as unknown as never, name: 'Alice' });
        const found = await coll.findOne({ _id: 'u1' as unknown as never });
        expect(found?.name).toBe('Alice');

        const events = buffer.getRecentWithContext(50).events;
        const findEvent = events.find(
          (e) => e.method?.toLowerCase().includes('find') ?? false,
        );
        expect(findEvent).toBeDefined();
        expect(findEvent!.type).toBe('db-query');
        expect(findEvent!.direction).toBe('outbound');
        expect(findEvent!.dbMeta?.collection).toBe('users');
        expect(findEvent!.target?.startsWith('mongodb://')).toBe(true);
      } finally {
        uninstall();
      }
    });

    it('records insertOne with collection name and rowCount', async () => {
      const buffer = makeBuffer();
      const config = resolveTestConfig({});
      const { uninstall } = installMongodbPatch({
        buffer,
        als: new ALSManager(),
        config,
        explicitDriver: mongodb!,
      });
      try {
        const coll = client.db('itest').collection('rowcount');
        await coll.insertOne({ _id: 'rc1' as unknown as never, v: 1 });

        const events = buffer.getRecentWithContext(50).events;
        const insertEvent = events.find(
          (e) => e.method?.toLowerCase().includes('insert') ?? false,
        );
        expect(insertEvent).toBeDefined();
        expect(insertEvent!.dbMeta?.collection).toBe('rowcount');
        expect(insertEvent!.dbMeta?.rowCount).toBe(1);
        expect(insertEvent!.phase).toBe('done');
      } finally {
        uninstall();
      }
    });

    it('does not record raw user values verbatim in dbMeta.query', async () => {
      const buffer = makeBuffer();
      // The mongodb patch summarizes filter shape (key list) and never
      // emits values. Asserting this on a real driver guarantees we
      // never regress that contract by adding a verbose-mode shortcut.
      const config = resolveTestConfig({ captureDbBindParams: true });
      const { uninstall } = installMongodbPatch({
        buffer,
        als: new ALSManager(),
        config,
        explicitDriver: mongodb!,
      });
      try {
        const coll = client.db('itest').collection('secrets');
        await coll.insertOne({
          _id: 's1' as unknown as never,
          token: 'super-secret-token',
        });

        const events = buffer.getRecentWithContext(50).events;
        const insertEvent = events.find(
          (e) => e.method?.toLowerCase().includes('insert') ?? false,
        );
        expect(insertEvent).toBeDefined();
        const recordedQuery = insertEvent!.dbMeta?.query ?? '';
        const recordedParams = insertEvent!.dbMeta?.params ?? '';
        expect(recordedQuery).not.toContain('super-secret-token');
        expect(recordedParams).not.toContain('super-secret-token');
      } finally {
        uninstall();
      }
    });
  },
);
