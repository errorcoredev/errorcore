
import { timingSafeEqual } from 'node:crypto';

import { NdjsonReader } from './ndjson-reader';
import { renderHTML } from './frontend';
import type { Encryption } from '../security/encryption';

function isTimingSafeBearerMatch(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return false;
  }
  const presented = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}

function sameOriginAsRequest(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  const originHeader = c.req.header('origin');
  if (originHeader === undefined) {
    return false;
  }
  try {
    return new URL(c.req.url).origin === originHeader;
  } catch {
    return false;
  }
}

function loadHono(): { Hono: typeof import('hono').Hono; serve: typeof import('@hono/node-server').serve } {
  try {
    const { Hono } = require('hono') as typeof import('hono');
    const { serve } = require('@hono/node-server') as typeof import('@hono/node-server');
    return { Hono, serve };
  } catch {
    throw new Error(
      'The errorcore dashboard requires hono and @hono/node-server.\n' +
      'Install them with: npm install hono @hono/node-server'
    );
  }
}

export interface DashboardOptions {
  filePath: string;
  port: number;
  encryption: Encryption | null;
  token?: string;
  hostname?: string;
}

export function startDashboard(options: DashboardOptions): unknown {
  const { Hono, serve } = loadHono();
  const { filePath, port, encryption } = options;
  const token = options.token ?? process.env.EC_DASHBOARD_TOKEN;

  if (token !== undefined && token !== '' && !/^[a-zA-Z0-9_\-]+$/.test(token)) {
    throw new Error(
      'Dashboard token must contain only alphanumeric characters, hyphens, and underscores'
    );
  }

  if (token !== undefined && token !== '' && token.length < 16) {
    throw new Error(
      'Dashboard token must be at least 16 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
    );
  }

  const effectiveToken = token !== undefined && token !== '' ? token : undefined;

  const reader = new NdjsonReader(filePath, encryption);
  reader.watch();

  const app = new Hono();

  if (effectiveToken !== undefined) {
    app.use('/api/*', async (c, next) => {
      if (!isTimingSafeBearerMatch(c.req.header('authorization'), effectiveToken)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      await next();
    });
  }

  app.post('*', async (c, next) => {
    // Two-layer CSRF guard: a same-origin Origin header plus a custom
    // header. Browsers forbid cross-origin JS from setting the custom
    // header without a preflight, and the Origin check protects against
    // misconfigurations that allow the preflight.
    if (!sameOriginAsRequest(c)) {
      return c.json({ error: 'Origin not allowed' }, 403);
    }

    if (c.req.header('x-errorcore-action') !== 'true') {
      return c.json({ error: 'Missing X-ErrorCore-Action header' }, 403);
    }

    await next();
  });

  app.get('/', (c: any) => {
    return c.html(renderHTML(effectiveToken));
  });

  app.get('/api/errors', (c: any) => {
    const page = parseInt(c.req.query('page') ?? '1', 10) || 1;
    const limit = Math.min(parseInt(c.req.query('limit') ?? '25', 10) || 25, 100);
    const search = c.req.query('search') ?? undefined;
    const type = c.req.query('type') ?? undefined;
    const sort = (c.req.query('sort') as 'newest' | 'oldest') ?? 'newest';

    const result = reader.getAll({ page, limit, search, type, sort });
    return c.json(result);
  });

  app.get('/api/errors/:id', (c: any) => {
    const id = c.req.param('id') ?? '';
    const pkg = reader.getById(id);

    if (pkg === null) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json(pkg);
  });

  app.get('/api/stats', (c: any) => {
    return c.json(reader.getStats());
  });

  app.post('/api/refresh', (c: any) => {
    reader.refresh();
    return c.json({ ok: true });
  });

  app.get('/api/health', (c: any) => {
    return c.json({ status: 'ok' });
  });

  // Default to loopback. Remote binding requires the operator to pass
  // options.hostname explicitly. The previous behavior bound to 0.0.0.0
  // whenever a token was configured, which exposed the dashboard to any
  // reachable network on that interface. Now the operator declares intent
  // by passing the bind address.
  const hostname = options.hostname ?? '127.0.0.1';

  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && effectiveToken === undefined) {
    throw new Error(
      'Dashboard refuses to bind to a non-loopback hostname without a token. ' +
      'Set EC_DASHBOARD_TOKEN or pass token in options.'
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
