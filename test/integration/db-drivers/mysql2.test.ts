import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALSManager } from '../../../src/context/als-manager';
import { EventClock } from '../../../src/context/event-clock';
import { IOEventBuffer } from '../../../src/buffer/io-event-buffer';
import { install as installMysql2Patch } from '../../../src/recording/patches/mysql2';
import { resolveTestConfig } from '../../helpers/test-config';
import { envFlag, tryRequire } from './fixtures/install-test-deps';

// This suite is OPT-IN. It requires a reachable MySQL server and
// the `mysql2` driver in node_modules. Set EC_INTEGRATION_MYSQL=1 to enable.
//
//   docker run --rm -e MYSQL_ALLOW_EMPTY_PASSWORD=true -p 3306:3306 mysql:8
//   EC_INTEGRATION_MYSQL=1 npm test
//
// CI does NOT run this suite — see CONTRIBUTING.md.
const mysql2 = tryRequire<typeof import('mysql2/promise')>('mysql2/promise');
const mysql2Root = tryRequire<typeof import('mysql2')>('mysql2');

describe.skipIf(!envFlag('EC_INTEGRATION_MYSQL') || mysql2 === null || mysql2Root === null)(
  'mysql2 driver integration (EC_INTEGRATION_MYSQL=1)',
  () => {
    const MYSQL_HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
    const MYSQL_PORT = parseInt(process.env.MYSQL_PORT ?? '3306', 10);
    const MYSQL_USER = process.env.MYSQL_USER ?? 'root';
    const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? '';
    const MYSQL_DATABASE = process.env.MYSQL_DATABASE ?? 'mysql';

    let connection: import('mysql2/promise').Connection;

    beforeAll(async () => {
      connection = await mysql2!.createConnection({
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DATABASE,
      });
    });

    afterAll(async () => {
      try {
        await connection?.end();
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

    it('records SELECT 1 as a db-query event', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installMysql2Patch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({}),
        explicitDriver: mysql2Root!,
      });
      try {
        const [rows] = await connection.query('SELECT 1 AS one');
        expect(Array.isArray(rows) && rows.length).toBe(1);
        const events = buffer.getRecentWithContext(50).events;
        const queryEvent = events.find(
          (e) => e.dbMeta?.query?.startsWith('SELECT 1') ?? false,
        );
        expect(queryEvent).toBeDefined();
        expect(queryEvent!.type).toBe('db-query');
        expect(queryEvent!.direction).toBe('outbound');
      } finally {
        uninstall();
      }
    });

    it('redacts bind params when captureDbBindParams is false', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installMysql2Patch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({ captureDbBindParams: false }),
        explicitDriver: mysql2Root!,
      });
      try {
        await connection.execute('SELECT ? + ? AS sum', [40, 2]);
        const events = buffer.getRecentWithContext(50).events;
        const event = events.find((e) => e.dbMeta?.query?.includes('SELECT ?') ?? false);
        expect(event).toBeDefined();
        expect(event!.dbMeta?.params).toBe('[PARAM_1], [PARAM_2]');
      } finally {
        uninstall();
      }
    });

    it('captures bind params verbatim when captureDbBindParams is true', async () => {
      const buffer = makeBuffer();
      const { uninstall } = installMysql2Patch({
        buffer,
        als: new ALSManager(),
        config: resolveTestConfig({ captureDbBindParams: true }),
        explicitDriver: mysql2Root!,
      });
      try {
        await connection.execute('SELECT ? AS name', ['alice']);
        const events = buffer.getRecentWithContext(50).events;
        const event = events.find((e) => e.dbMeta?.query?.includes('SELECT ?') ?? false);
        expect(event).toBeDefined();
        expect(event!.dbMeta?.params).toContain('alice');
      } finally {
        uninstall();
      }
    });
  },
);
