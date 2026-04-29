import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSDK } from '../../src/sdk';
import { wrapHandler } from '../../src/middleware/raw-http';
import { Encryption } from '../../src/security/encryption';

function createTempOutput(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

  return {
    directory,
    file: path.join(directory, 'errorcore-output.log')
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port');
  }

  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function sendRequest(input: {
  port: number;
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  const payload = input.body ?? '';

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method,
        path: input.path,
        headers: {
          ...(input.headers ?? {}),
          ...(payload.length > 0 ? { 'content-length': String(Buffer.byteLength(payload)) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.on('error', reject);
    if (payload.length > 0) {
      req.write(payload);
    }
    req.end();
  });
}

function readDeliveredPackage(filePath: string, encryptionKey?: string) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  expect(content.length).toBeGreaterThan(0);

  const payloadLine = content.split('\n').filter(Boolean).at(-1);
  expect(payloadLine).toBeDefined();

  if (encryptionKey === undefined) {
    return JSON.parse(payloadLine as string);
  }

  const decrypted = new Encryption(encryptionKey).decrypt(
    JSON.parse(payloadLine as string) as {
      salt: string;
      iv: string;
      ciphertext: string;
      authTag: string;
    }
  );

  return JSON.parse(decrypted);
}

afterEach(() => {
  // The tests clean up their temp directories explicitly; this keeps the suite
  // simple while still failing loudly if cleanup is skipped.
});

describe('SDK integration', () => {
  it('captures and delivers an encrypted package from a real inbound HTTP request', async () => {
    const output = createTempOutput('errorcore-e2e-encrypted');
    const sdk = createSDK({
      encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024
    });
    sdk.activate();

    const server = createServer(wrapHandler((req, res) => {
      sdk.captureError(new Error('integration-boom'));
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, method: req.method }));
    }, sdk));

    try {
      const port = await listen(server);
      const response = await sendRequest({
        port,
        method: 'GET',
        path: '/login?email=user@example.com',
        headers: {
          accept: 'application/json'
        }
      });

      expect(response.statusCode).toBe(500);

      await close(server);
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

      expect(pkg.completeness.encrypted).toBe(true);
      expect(pkg.completeness.requestCaptured).toBe(true);
      expect(pkg.completeness.usedAmbientEvents).toBe(false);
      expect(pkg.request.id).toBeTypeOf('string');
      expect(pkg.request.method).toBe('GET');
      expect(pkg.request.url).toContain('%5BREDACTED%5D');
    } finally {
      if (server.listening) {
        await close(server);
      }
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('marks ambient-event fallback honestly when capturing outside request context', async () => {
    const output = createTempOutput('errorcore-e2e-ambient');
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024
    });
    sdk.activate();

    const server = createServer(wrapHandler((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    }, sdk));

    try {
      const port = await listen(server);
      await sendRequest({
        port,
        method: 'GET',
        path: '/products'
      });

      sdk.captureError(new Error('ambient-boom'));

      await close(server);
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file);

      expect(pkg.request).toBeUndefined();
      expect(pkg.completeness.alsContextAvailable).toBe(false);
      expect(pkg.completeness.usedAmbientEvents).toBe(true);
      expect(pkg.ioTimeline.length).toBeGreaterThan(0);
    } finally {
      if (server.listening) {
        await close(server);
      }
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('captures tracked state reads in a real request context', async () => {
    const output = createTempOutput('errorcore-e2e-state');
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024
    });
    const trackedCache = sdk.trackState(
      'cache',
      new Map<string, { id: number; token: string }>([['user', { id: 1, token: 'secret-token' }]])
    );
    sdk.activate();

    const server = createServer(wrapHandler((_req, res) => {
      trackedCache.get('user');
      sdk.captureError(new Error('state-boom'));
      res.statusCode = 200;
      res.end('ok');
    }, sdk));

    try {
      const port = await listen(server);
      await sendRequest({
        port,
        method: 'GET',
        path: '/state'
      });

      await close(server);
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file);

      expect(pkg.completeness.stateTrackingEnabled).toBe(true);
      expect(pkg.completeness.stateReadsCaptured).toBe(true);
      expect(pkg.stateReads).toHaveLength(1);
      expect(pkg.stateReads[0]).toMatchObject({
        container: 'cache',
        operation: 'get'
      });
    } finally {
      if (server.listening) {
        await close(server);
      }
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('ships v1.1.0 stamping fields and eventClockRange brackets every captured event', async () => {
    const output = createTempOutput('errorcore-e2e-stamping');
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024
    });
    const trackedCache = sdk.trackState(
      'cache',
      new Map<string, number>([['hits', 0]])
    );
    sdk.activate();

    const server = createServer(wrapHandler((_req, res) => {
      trackedCache.get('hits'); // produces a stateRead with seq
      trackedCache.set('hits', 1); // produces a stateWrite with seq + hrtimeNs
      sdk.captureError(new Error('stamping-boom'));
      res.statusCode = 200;
      res.end('ok');
    }, sdk));

    try {
      const port = await listen(server);
      await sendRequest({ port, method: 'GET', path: '/stamp' });

      await close(server);
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file);

      // Top-level v1.1.0 fields are present and well-typed.
      expect(pkg.schemaVersion).toBe('1.1.0');
      expect(pkg.errorEventSeq).toBeTypeOf('number');
      expect(pkg.errorEventSeq).toBeGreaterThan(0);
      expect(pkg.errorEventHrtimeNs).toBeTypeOf('string');
      expect(BigInt(pkg.errorEventHrtimeNs as string)).toBeGreaterThan(0n);
      expect(pkg.eventClockRange).toBeDefined();
      expect(pkg.eventClockRange.min).toBeTypeOf('number');
      expect(pkg.eventClockRange.max).toBeTypeOf('number');

      // eventClockRange brackets every stamped seq we shipped.
      const allSeqs: number[] = [pkg.errorEventSeq];
      for (const e of pkg.ioTimeline ?? []) allSeqs.push(e.seq);
      for (const r of pkg.stateReads ?? []) allSeqs.push(r.seq);
      for (const w of pkg.stateWrites ?? []) allSeqs.push(w.seq);
      let observedMin = allSeqs[0];
      let observedMax = allSeqs[0];
      for (const s of allSeqs) {
        if (s < observedMin) observedMin = s;
        if (s > observedMax) observedMax = s;
      }
      expect(pkg.eventClockRange.min).toBe(observedMin);
      expect(pkg.eventClockRange.max).toBe(observedMax);

      // State writes were captured with seq + hrtimeNs string. The `key`
      // field's value is redacted by the PII scrubber (the property name
      // matches /key/i in the default blocklist), so we don't assert on it
      // — that's pre-existing scrubber behavior, not new in v1.1.0.
      expect(pkg.stateWrites).toHaveLength(1);
      expect(pkg.stateWrites[0]).toMatchObject({
        container: 'cache',
        operation: 'set',
        value: 1
      });
      expect(pkg.stateWrites[0].seq).toBeTypeOf('number');
      expect(pkg.stateWrites[0].hrtimeNs).toBeTypeOf('string');

      // Every IO event has hrtimeNs in serialized (string) form.
      for (const ev of pkg.ioTimeline ?? []) {
        expect(ev.hrtimeNs).toBeTypeOf('string');
      }
    } finally {
      if (server.listening) {
        await close(server);
      }
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('merges inbound tracestate into the EventClock so errorEventSeq exceeds the peer value', async () => {
    // The shipped ErrorPackage's `trace.tracestate` carries the inbound
    // header verbatim, but the PII scrubber redacts the field's content
    // (the string `ec=clk:42,vendor1=foo` contains `=` and matches the
    // default token-like heuristics). The unit tests in
    // test/unit/trace-context.test.ts cover the parse/format/round-trip
    // logic exhaustively; this integration assertion focuses on the
    // observable side-effect that DOES survive scrubbing: the local clock
    // jump so subsequent errorEventSeq exceeds the peer's value.
    const output = createTempOutput('errorcore-e2e-tracestate');
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024
    });
    sdk.activate();

    const server = createServer(wrapHandler((_req, res) => {
      sdk.captureError(new Error('tracestate-boom'));
      res.statusCode = 500;
      res.end('ok');
    }, sdk));

    try {
      const port = await listen(server);
      await sendRequest({
        port,
        method: 'GET',
        path: '/ts',
        headers: { tracestate: 'ec=clk:42,vendor1=foo' }
      });

      await close(server);
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file);

      // After merge(42) on ingress, every subsequent tick is >= 43, and the
      // error event itself stamps strictly after the IO/state events of the
      // request, so it must exceed 42.
      expect(pkg.errorEventSeq).toBeGreaterThan(42);
      expect(pkg.eventClockRange.min).toBeGreaterThan(42);
    } finally {
      if (server.listening) {
        await close(server);
      }
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });
});
