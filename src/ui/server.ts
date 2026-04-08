
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';

import { NdjsonReader } from './ndjson-reader';
import { renderHTML } from './frontend';
import type { Encryption } from '../security/encryption';

export interface DashboardOptions {
  filePath: string;
  port: number;
  encryption: Encryption | null;
}

export function startDashboard(options: DashboardOptions): ReturnType<typeof serve> {
  const { filePath, port, encryption } = options;
  const reader = new NdjsonReader(filePath, encryption);
  reader.watch();

  const app = new Hono();

  app.get('/', (c: Context) => {
    return c.html(renderHTML());
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

  const server = serve({ fetch: app.fetch, port }, (info: { port: number }) => {
    console.log(`\n  ErrorCore Dashboard running at http://localhost:${info.port}\n`);
  });

  const shutdown = () => {
    reader.close();
    server.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}
