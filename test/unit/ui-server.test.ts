import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { startDashboard } from '../../src/ui/server';

function freshFile(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-ui-'));
  return path.join(tmp, 'errors.ndjson');
}

type ServerLike = { close: () => void; address: () => AddressInfo | string | null };

async function startOnEphemeralPort(opts: Parameters<typeof startDashboard>[0]): Promise<{
  server: ServerLike;
  port: number;
}> {
  const started = startDashboard(opts) as ServerLike;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const address = started.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Dashboard server did not bind to a port');
  }
  return { server: started, port: address.port };
}

describe('UI dashboard server', () => {
  const started: ServerLike[] = [];
  const paths: string[] = [];

  afterEach(() => {
    while (started.length > 0) {
      try { started.pop()?.close(); } catch { /* ignore */ }
    }
    for (const p of paths) {
      try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    paths.length = 0;
  });

  it('defaults to 127.0.0.1 even when a token is configured', async () => {
    const filePath = freshFile();
    paths.push(filePath);
    const { server, port } = await startOnEphemeralPort({
      filePath,
      port: 0,
      encryption: null,
      token: 'a-valid-dashboard-token-0123'
    });
    started.push(server);

    // Reach the server on loopback.
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: 'Bearer a-valid-dashboard-token-0123' }
    });
    expect(response.status).toBe(200);
  });

  it('refuses to bind to a non-loopback hostname without a token', async () => {
    const filePath = freshFile();
    paths.push(filePath);
    expect(() =>
      startDashboard({
        filePath,
        port: 0,
        encryption: null,
        hostname: '0.0.0.0'
      })
    ).toThrow(/refuses to bind to a non-loopback hostname without a token/);
  });

  it('accepts the correct bearer and rejects the wrong one without timing-leak via string compare', async () => {
    const filePath = freshFile();
    paths.push(filePath);
    const expected = 'a-valid-dashboard-token-0123';
    const { server, port } = await startOnEphemeralPort({
      filePath,
      port: 0,
      encryption: null,
      token: expected
    });
    started.push(server);

    const ok = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${expected}` }
    });
    expect(ok.status).toBe(200);

    // Wrong token, same length: must still be rejected.
    const wrongSameLen = expected.slice(0, -1) + 'X';
    const bad = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${wrongSameLen}` }
    });
    expect(bad.status).toBe(401);

    // Different-length token: must be rejected without throwing inside
    // timingSafeEqual (the implementation must length-check first).
    const badShort = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: 'Bearer short' }
    });
    expect(badShort.status).toBe(401);

    // Missing authorization header: rejected.
    const missing = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(missing.status).toBe(401);
  });

  it('rejects POST requests with a cross-origin Origin header', async () => {
    const filePath = freshFile();
    paths.push(filePath);
    const { server, port } = await startOnEphemeralPort({
      filePath,
      port: 0,
      encryption: null
    });
    started.push(server);

    // Correct custom header, wrong Origin.
    const rejected = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: {
        'x-errorcore-action': 'true',
        origin: 'http://evil.example.com'
      }
    });
    expect(rejected.status).toBe(403);

    // Correct custom header, missing Origin.
    const missingOrigin = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { 'x-errorcore-action': 'true' }
    });
    expect(missingOrigin.status).toBe(403);

    // Correct Origin and custom header.
    const allowed = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: {
        'x-errorcore-action': 'true',
        origin: `http://127.0.0.1:${port}`
      }
    });
    expect(allowed.status).toBe(200);
  });
});
