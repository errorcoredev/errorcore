
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';

import { NdjsonReader } from './ndjson-reader';
import { renderHTML } from './frontend';
import type { Encryption } from '../security/encryption';

export interface DashboardOptions {
  filePath: string;
  port: number;
  encryption: Encryption | null;
  token?: string;
  hostname?: string;
}

export function startDashboard(options: DashboardOptions): ReturnType<typeof serve> {
  const { filePath, port, encryption } = options;
  const token = options.token ?? process.env.EC_DASHBOARD_TOKEN;

  if (token !== undefined && token !== '' && !/^[a-zA-Z0-9_\-]+$/.test(token)) {
    throw new Error(
      'Dashboard token must contain only alphanumeric characters, hyphens, and underscores'
    );
  }

  const effectiveToken = token !== undefined && token !== '' ? token : undefined;

  const reader = new NdjsonReader(filePath, encryption);
  reader.watch();

  const app = new Hono();

  if (effectiveToken !== undefined) {
    app.use('/api/*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${effectiveToken}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      await next();
    });
  }

  app.post('*', async (c, next) => {
    if (c.req.header('x-errorcore-action') !== 'true') {
      return c.json({ error: 'Missing X-ErrorCore-Action header' }, 403);
    }

    await next();
  });

  app.get('/', (c: Context) => {
    return c.html(renderHTML(effectiveToken));
  });

  app.get('/api/errors', (c: Context) => {
    const page = parseInt(c.req.query('page') ?? '1', 10) || 1;
    const limit = Math.min(parseInt(c.req.query('limit') ?? '25', 10) || 25, 100);
    const search = c.req.query('search') ?? undefined;
    const type = c.req.query('type') ?? undefined;
    const sort = (c.req.query('sort') as 'newest' | 'oldest') ?? 'newest';

    const result = reader.getAll({ page, limit, search, type, sort });
    return c.json(result);
  });

  app.get('/api/errors/:id', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const pkg = reader.getById(id);

    if (pkg === null) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json(pkg);
  });

  app.get('/api/stats', (c: Context) => {
    return c.json(reader.getStats());
  });

  app.post('/api/refresh', (c: Context) => {
    reader.refresh();
    return c.json({ ok: true });
  });

  app.get('/api/health', (c: Context) => {
    return c.json({ status: 'ok' });
  });

  const hostname = options.hostname ?? (effectiveToken !== undefined ? '0.0.0.0' : '127.0.0.1');

  if (effectiveToken === undefined) {
    console.warn(
      '[ErrorCore] No dashboard token configured. Binding to localhost only.\n' +
      '  Set EC_DASHBOARD_TOKEN or pass token in options to enable remote access.'
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname }, (info: { port: number }) => {
    console.log(`\n  ErrorCore Dashboard running at http://${hostname}:${info.port}\n`);
  });

  const shutdown = () => {
    reader.close();
    server.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}
