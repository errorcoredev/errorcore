import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = 32000 + (process.pid % 10000);
const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-sink-test-'));
let server;

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return { response, text, body: text.length === 0 ? null : JSON.parse(text) };
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const result = await request('/healthz');
      if (result.response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('sentry sink test server did not start');
}

describe('sentry sink server', () => {
  before(async () => {
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        BENCH_RESULTS_DIR: resultsDir
      },
      stdio: 'ignore'
    });
    await waitForServer();
  });

  after(async () => {
    server?.kill('SIGTERM');
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  it('keeps transport envelopes out of the default events response', async () => {
    await request('/control/reset', { method: 'POST', body: {} });
    await request('/before-send', {
      method: 'POST',
      body: {
        scenarioId: 'S-test',
        serviceName: 'svc',
        framework: 'express',
        event: { exception: { values: [{ type: 'Error', value: 'boom' }] } }
      }
    });
    await request('/envelope', {
      method: 'POST',
      body: {
        scenarioId: 'S-test',
        serviceName: 'svc',
        framework: 'express',
        envelope: { large: 'x'.repeat(1_000_000) }
      }
    });

    const result = await request('/events?scenarioId=S-test');

    assert.equal(result.response.status, 200);
    assert.equal(result.body.events.length, 1);
    assert.ok(result.text.length < 50_000, `response was ${result.text.length} bytes`);
    assert.equal(result.body.envelopeCount, 1);
    assert.equal(result.body.envelopes, undefined);
  });
});
