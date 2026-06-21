import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = 33000 + (process.pid % 10000);
const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsnag-sink-test-'));
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
  throw new Error('bugsnag sink test server did not start');
}

describe('bugsnag sink server', () => {
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

  it('stores each BugSnag notify event and supports failure injection', async () => {
    await request('/control/reset', { method: 'POST', body: {} });
    const failed = await request('/control/fail', { method: 'POST', body: { enabled: true } });
    assert.equal(failed.response.status, 200);

    const rejected = await request('/notify', {
      method: 'POST',
      body: { events: [{ exceptions: [{ errorClass: 'Error', message: 'blocked' }] }] }
    });
    assert.equal(rejected.response.status, 503);

    await request('/control/fail', { method: 'POST', body: { enabled: false } });
    const accepted = await request('/notify', {
      method: 'POST',
      body: {
        events: [
          {
            exceptions: [{ errorClass: 'TypeError', message: 'boom' }],
            metaData: { benchmark: { scenarioId: 'S-test', serviceName: 'svc', framework: 'express' } }
          }
        ]
      }
    });
    assert.equal(accepted.response.status, 200);

    const result = await request('/events?scenarioId=S-test');
    assert.equal(result.body.events.length, 1);
    assert.equal(result.body.events[0].event.exceptions[0].message, 'boom');
  });
});
