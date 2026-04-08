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
});
