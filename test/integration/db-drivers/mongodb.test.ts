import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALSManager } from '../../../src/context/als-manager';
import { EventClock } from '../../../src/context/event-clock';
import { IOEventBuffer } from '../../../src/buffer/io-event-buffer';
import { install as installMongodbPatch } from '../../../src/recording/patches/mongodb';
import { resolveTestConfig } from '../../helpers/test-config';
import { envFlag, tryRequire } from './fixtures/install-test-deps';

const mongodb = tryRequire<typeof import('mongodb')>('mongodb');
const memoryServer = tryRequire<typeof import('mongodb-memory-server')>(
  'mongodb-memory-server'
);
const externalMongoUri = process.env.EC_MONGODB_URI ?? process.env.MONGODB_URI;
const unsupportedLocalMemoryServer =
  process.platform === 'win32' && externalMongoUri === undefined;
const skipMongoIntegration =
  envFlag('EC_SKIP_MONGODB_INTEGRATION') || unsupportedLocalMemoryServer;

if (unsupportedLocalMemoryServer) {
  console.warn(
    'Skipping mongodb-memory-server on Windows; the required MongoDB integration runs against an explicit Linux CI service. Set EC_MONGODB_URI to test a Windows-accessible service.',
  );
}

// First-run note: mongodb-memory-server downloads a mongod binary on
// the first invocation (~30s on a cold cache). Subsequent runs reuse
// the cached binary at ~/.cache/mongodb-binaries.

describe.skipIf(
  skipMongoIntegration ||
  mongodb === null ||
  (externalMongoUri === undefined && memoryServer === null)
)(
  'mongodb driver integration',
  () => {
    let server: import('mongodb-memory-server').MongoMemoryServer | undefined;
    let client: import('mongodb').MongoClient;

    beforeAll(async () => {
      try {
        const { MongoClient } = mongodb!;
        let uri = externalMongoUri;
        if (uri === undefined) {
          const { MongoMemoryServer } = memoryServer!;
          server = await MongoMemoryServer.create();
          uri = server.getUri();
        }
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
        await client.connect();
        if (externalMongoUri !== undefined) {
          await client.db('itest').dropDatabase();
        }
      } catch (error) {
        const source = externalMongoUri === undefined
          ? 'mongodb-memory-server'
          : 'the MongoDB service configured by EC_MONGODB_URI';
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `MongoDB integration startup failed using ${source}. ` +
          `Verify the binary/service is supported and reachable. Original error: ${detail}`,
          { cause: error }
        );
      }
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

    it('captures scrubbed user values in dbMeta.params when enabled', async () => {
      const buffer = makeBuffer();
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
        expect(recordedParams).toContain('[REDACTED]');
        expect(recordedParams).toContain('_id');
      } finally {
        uninstall();
      }
    });
  },
);
