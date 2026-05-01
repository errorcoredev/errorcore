import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALSManager } from '../../../src/context/als-manager';
import { EventClock } from '../../../src/context/event-clock';
import { IOEventBuffer } from '../../../src/buffer/io-event-buffer';
import { install as installPgPatch } from '../../../src/recording/patches/pg';
import { resolveTestConfig } from '../../helpers/test-config';
import { envFlag, tryRequire } from './fixtures/install-test-deps';

// This suite is OPT-IN. It requires a reachable PostgreSQL server and
// the `pg` driver in node_modules. Set EC_INTEGRATION_PG=1 to enable.
//
//   docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
//   EC_INTEGRATION_PG=1 PGPASSWORD=postgres npm test
//
// CI does NOT run this suite — see CONTRIBUTING.md.
const pg = tryRequire<typeof import('pg')>('pg');

describe.skipIf(!envFlag('EC_INTEGRATION_PG') || pg === null)(
  'pg driver integration (EC_INTEGRATION_PG=1)',
  () => {
    const PGHOST = process.env.PGHOST ?? '127.0.0.1';
    const PGPORT = parseInt(process.env.PGPORT ?? '5432', 10);
    const PGUSER = process.env.PGUSER ?? 'postgres';
    const PGPASSWORD = process.env.PGPASSWORD ?? 'postgres';
    const PGDATABASE = process.env.PGDATABASE ?? 'postgres';

    let client: import('pg').Client;

    beforeAll(async () => {
      const { Client } = pg!;
      client = new Client({
        host: PGHOST,
        port: PGPORT,
        user: PGUSER,
        password: PGPASSWORD,
        database: PGDATABASE,
      });
      await client.connect();
    });

    afterAll(async () => {
      try {
        await client?.end();
      } catch {
        /* ignored */
      }
    });

    function makeBuffer(): IOEventBuffer {
      return new IOEventBuffer({
        capacity: 50,
        maxBytes: 1_000_000,
        eventClock: new EventClock(),
      });
    }

    it('records SELECT 1 as an outbound db-query event with rowCount', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installPgPatch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({}),
        explicitDriver: pg!,
      });
      try {
        const result = await client.query('SELECT 1 AS one');
        expect(result.rowCount).toBe(1);
        const events = buffer.getRecentWithContext(50).events;
        const queryEvent = events.find(
          (e) => e.dbMeta?.query?.startsWith('SELECT 1') ?? false,
        );
        expect(queryEvent).toBeDefined();
        expect(queryEvent!.type).toBe('db-query');
        expect(queryEvent!.direction).toBe('outbound');
        expect(queryEvent!.dbMeta?.rowCount).toBe(1);
        expect(queryEvent!.target).toContain(`${PGHOST}:${PGPORT}`);
      } finally {
        uninstall();
      }
    });

    it('redacts bind params when captureDbBindParams is false', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installPgPatch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({ captureDbBindParams: false }),
        explicitDriver: pg!,
      });
      try {
        await client.query('SELECT $1::int + $2::int AS sum', [40, 2]);
        const events = buffer.getRecentWithContext(50).events;
        const event = events.find((e) => e.dbMeta?.query?.includes('SELECT $1') ?? false);
        expect(event).toBeDefined();
        // formatParams returns "[PARAM_1], [PARAM_2]" for each value when redacted.
        expect(event!.dbMeta?.params).toBe('[PARAM_1], [PARAM_2]');
      } finally {
        uninstall();
      }
    });

    it('captures bind params verbatim when captureDbBindParams is true', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installPgPatch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({ captureDbBindParams: true }),
        explicitDriver: pg!,
      });
      try {
        await client.query('SELECT $1::text AS name', ['alice']);
        const events = buffer.getRecentWithContext(50).events;
        const event = events.find((e) => e.dbMeta?.query?.includes('SELECT $1') ?? false);
        expect(event).toBeDefined();
        expect(event!.dbMeta?.params).toContain('alice');
      } finally {
        uninstall();
      }
    });
  },
);
