import { timingSafeEqual } from 'node:crypto';
import http = require('node:http');

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

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestUrl(req: http.IncomingMessage): URL {
  const host = getHeader(req, 'host') ?? '127.0.0.1';
  return new URL(req.url ?? '/', `http://${host}`);
}

function sameOriginAsRequest(req: http.IncomingMessage): boolean {
  const originHeader = getHeader(req, 'origin');
  if (originHeader === undefined) {
    return false;
  }
  try {
    return requestUrl(req).origin === originHeader;
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

export interface DashboardOptions {
  filePath: string;
  port: number;
  encryption: Encryption | null;
  token?: string;
  hostname?: string;
}

export function startDashboard(options: DashboardOptions): http.Server {
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
      'Generate one with: node -e "process.stdout.write(require(\'crypto\').randomBytes(24).toString(\'base64url\') + \'\\n\')"'
    );
  }

  const effectiveToken = token !== undefined && token !== '' ? token : undefined;
  const reader = new NdjsonReader(filePath, encryption);
  reader.watch();

  const server = http.createServer((req, res) => {
    try {
      const url = requestUrl(req);
      const method = req.method ?? 'GET';

      if (url.pathname.startsWith('/api/') && effectiveToken !== undefined) {
        if (!isTimingSafeBearerMatch(getHeader(req, 'authorization'), effectiveToken)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      if (method === 'POST') {
        if (!sameOriginAsRequest(req)) {
          sendJson(res, 403, { error: 'Origin not allowed' });
          return;
        }

        if (getHeader(req, 'x-errorcore-action') !== 'true') {
          sendJson(res, 403, { error: 'Missing X-ErrorCore-Action header' });
          return;
        }
      }

      if (method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderHTML(effectiveToken));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/errors') {
        const page = parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10) || 25, 100);
        const search = url.searchParams.get('search') ?? undefined;
        const type = url.searchParams.get('type') ?? undefined;
        const fingerprint = url.searchParams.get('fingerprint') ?? undefined;
        const sort = (url.searchParams.get('sort') as 'newest' | 'oldest' | null) ?? 'newest';

        sendJson(res, 200, reader.getAll({ page, limit, search, type, fingerprint, sort }));
        return;
      }

      const detailMatch = /^\/api\/errors\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && detailMatch !== null) {
        const pkg = reader.getById(decodeURIComponent(detailMatch[1]!));
        if (pkg === null) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        sendJson(res, 200, pkg);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/stats') {
        sendJson(res, 200, reader.getStats());
        return;
      }

      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/refresh') {
        reader.refresh();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  const hostname = options.hostname ?? '127.0.0.1';

  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && effectiveToken === undefined) {
    throw new Error(
      'Dashboard refuses to bind to a non-loopback hostname without a token. ' +
      'Set EC_DASHBOARD_TOKEN or pass token in options.'
    );
  }

  server.on('close', () => {
    reader.close();
  });

  server.listen(port, hostname, () => {
    const address = server.address();
    const actualPort =
      address !== null && typeof address !== 'string' ? address.port : port;
    process.stdout.write(`\n  ErrorCore Dashboard running at http://${hostname}:${actualPort}\n`);
  });

  const shutdown = () => {
    reader.close();
    server.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}
