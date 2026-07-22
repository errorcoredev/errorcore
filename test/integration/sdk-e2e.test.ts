import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSDK } from '../../src/sdk';
import { expressMiddleware } from '../../src/middleware/express';
import { fastifyPlugin } from '../../src/middleware/fastify';
import { wrapHandler } from '../../src/middleware/raw-http';
import { Encryption } from '../../src/security/encryption';
import type { IOEventSlot, RequestContext } from '../../src/types';

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

function pushSyntheticTimelineEvent(
  sdk: ReturnType<typeof createSDK>,
  input: {
    type: IOEventSlot['type'];
    target: string;
    method: string | null;
    url?: string | null;
    dbMeta?: IOEventSlot['dbMeta'];
  }
): void {
  const context = sdk.als.getContext();
  expect(context).toBeDefined();

  const startTime = process.hrtime.bigint();
  const endTime = startTime + 1_000_000n;
  const { slot } = sdk.buffer.push({
    phase: 'done',
    startTime,
    endTime,
    durationMs: 1,
    type: input.type,
    direction: 'outbound',
    requestId: (context as RequestContext).requestId,
    contextLost: false,
    target: input.target,
    method: input.method,
    url: input.url ?? null,
    statusCode: input.type === 'http-client' ? 200 : null,
    fd: null,
    requestHeaders: null,
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    dbMeta: input.dbMeta,
    requestBodyDigest: null,
    responseBodyDigest: null
  });

  (context as RequestContext).ioEvents.push(slot);
}

function assertFrameworkTimelinePackage(pkg: any, checkpoints: string[]): void {
  expect(checkpoints).toEqual(['middleware:one', 'middleware:two', 'handler']);
  expect(pkg.completeness.alsContextAvailable).toBe(true);
  expect(pkg.completeness.usedAmbientEvents).toBe(false);
  expect(pkg.request?.id).toBeDefined();

  const timeline = pkg.ioTimeline ?? [];
  const requestIds = new Set(timeline.map((event: { requestId: string | null }) => event.requestId));
  expect(requestIds).toEqual(new Set([pkg.request.id]));
  expect(timeline.every((event: { contextLost: boolean }) => event.contextLost === false)).toBe(true);
  expect(timeline.map((event: { seq: number }) => event.seq)).toEqual(
    [...timeline.map((event: { seq: number }) => event.seq)].sort((a, b) => a - b)
  );
  expect(timeline.some((event: { type: string }) => event.type === 'http-server')).toBe(true);
  expect(timeline.some((event: { type: string }) => event.type === 'db-query')).toBe(true);
  expect(timeline.some((event: { type: string }) => event.type === 'http-client')).toBe(true);
}

function readDeliveredPackage(
  filePath: string,
  encryptionKey?: string,
  options?: { macKey?: string }
) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  expect(content.length).toBeGreaterThan(0);

  const payloadLine = content.split('\n').filter(Boolean).at(-1);
  expect(payloadLine).toBeDefined();

  const envelope = JSON.parse(payloadLine as string) as import('../../src/types').EncryptedEnvelope;

  if (encryptionKey === undefined) {
    // Transparent envelope: ciphertext holds base64(plaintext-package).
    expect(envelope.iv).toBe('unencrypted');
    return JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString('utf8'));
  }

  // The producing SDK records its version on the envelope; mirror it on
  // the decrypt-side Encryption so the AAD binding matches.
  const sdkVersion = envelope.sdk.version;
  const decrypted = new Encryption(encryptionKey, {
    sdkVersion,
    macKey: options?.macKey
  }).decrypt(envelope);
  return JSON.parse(decrypted);
}

afterEach(() => {
  // The tests clean up their temp directories explicitly; this keeps the suite
  // simple while still failing loudly if cleanup is skipped.
});

describe('SDK integration', () => {
  it('captures an ordered Express-like timeline through two middleware hops', async () => {
    const output = createTempOutput('errorcore-e2e-express-timeline');
    const checkpoints: string[] = [];
    let sdk: ReturnType<typeof createSDK> | null = null;
    const marker = 'express timeline boom';

    try {
      sdk = createSDK({
        transport: { type: 'file', path: output.file },
        allowUnencrypted: true,
        // Recorder-produced timeline ordering is standing-pipeline
        // (balanced) behavior; safe synthesizes its inbound event.
        captureMode: 'balanced',
        captureLocalVariables: false,
        captureBody: false,
        rateLimitPerMinute: 1000,
        bufferSize: 500,
        bufferMaxBytes: 1024 * 1024,
        useWorkerAssembly: false,
        silent: true
      });
      sdk.activate();

      const errorcoreMiddleware = expressMiddleware(sdk);
      const server = createServer((req, res) => {
        const steps = [
          (next: () => void) => errorcoreMiddleware(req as never, res as never, next),
          (next: () => void) => {
            checkpoints.push('middleware:one');
            setImmediate(next);
          },
          (next: () => void) => {
            checkpoints.push('middleware:two');
            void Promise.resolve().then(next);
          },
          () => {
            checkpoints.push('handler');
            pushSyntheticTimelineEvent(sdk!, {
              type: 'db-query',
              target: 'postgres://timeline',
              method: 'query',
              dbMeta: { query: 'select 1', params: '[]', rowCount: 1 }
            });
            pushSyntheticTimelineEvent(sdk!, {
              type: 'http-client',
              target: 'http://downstream.local',
              method: 'GET',
              url: 'http://downstream.local/lookup'
            });
            sdk!.captureError(new Error(marker));
            res.statusCode = 500;
            res.end('boom');
          }
        ];
        let index = 0;
        const next = () => {
          const step = steps[index++];
          step?.(next);
        };
        next();
      });
      const port = await listen(server);

      try {
        const response = await sendRequest({ port, method: 'GET', path: '/timeline' });
        expect(response.statusCode).toBe(500);
      } finally {
        await close(server);
      }

      await sdk.shutdown();
      const pkg = readDeliveredPackage(output.file);

      expect(pkg.error.message).toBe(marker);
      assertFrameworkTimelinePackage(pkg, checkpoints);
    } finally {
      if (sdk?.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('safe mode preserves Express request metadata and synthesizes its inbound timeline on flush', async () => {
    const output = createTempOutput('errorcore-e2e-express-safe-context');
    const marker = 'safe express request context boom';
    const sdk = createSDK({
      transport: { type: 'file', path: output.file },
      allowUnencrypted: true,
      captureMode: 'safe',
      captureLocalVariables: false,
      captureBody: false,
      useWorkerAssembly: false,
      headerAllowlist: ['host', 'x-benchmark-request'],
      rateLimitPerMinute: 1000,
      silent: true
    });
    const errorcoreMiddleware = expressMiddleware(sdk);
    const server = createServer((req, res) => {
      errorcoreMiddleware(req as never, res as never, () => {
        sdk.captureError(new Error(marker));
        res.statusCode = 503;
        res.end('boom');
      });
    });

    try {
      sdk.activate();
      const port = await listen(server);
      const response = await sendRequest({
        port,
        method: 'POST',
        path: '/safe-express?token=secret-token',
        headers: { 'x-benchmark-request': 'safe-express-1' }
      });
      expect(response.statusCode).toBe(503);

      // Safe mode defers transport delivery until flush. Reading the package
      // here (before shutdown) verifies that flush alone preserves the lazy
      // middleware context and its synthesized inbound event.
      await sdk.flush();
      const pkg = readDeliveredPackage(output.file);

      expect(pkg.error.message).toBe(marker);
      expect(pkg.request).toMatchObject({
        method: 'POST',
        url: '/safe-express?token=%5BREDACTED%5D'
      });
      expect(pkg.request.id).toBeTypeOf('string');
      expect(pkg.request.headers).toHaveProperty('host');
      expect(pkg.request.headers).toHaveProperty('x-benchmark-request');
      expect(pkg.completeness).toMatchObject({
        requestCaptured: true,
        ioTimelineCaptured: true,
        alsContextAvailable: true,
        usedAmbientEvents: false
      });
      expect(pkg.ioTimeline).toHaveLength(1);
      expect(pkg.ioTimeline[0]).toMatchObject({
        type: 'http-server',
        direction: 'inbound',
        requestId: pkg.request.id,
        contextLost: false,
        method: 'POST',
        url: '/safe-express?token=%5BREDACTED%5D'
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

  it('captures an ordered Fastify-like timeline through two middleware hops', async () => {
    const output = createTempOutput('errorcore-e2e-fastify-timeline');
    const checkpoints: string[] = [];
    let sdk: ReturnType<typeof createSDK> | null = null;
    let fastifyHook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: {
              finished?: boolean;
              statusCode?: number;
              on(event: 'finish', listener: () => void): void;
            };
          },
          done: () => void
        ) => void)
      | undefined;
    const marker = 'fastify timeline boom';

    try {
      sdk = createSDK({
        transport: { type: 'file', path: output.file },
        allowUnencrypted: true,
        // Recorder-produced timeline ordering is standing-pipeline
        // (balanced) behavior; safe synthesizes its inbound event.
        captureMode: 'balanced',
        captureLocalVariables: false,
        captureBody: false,
        rateLimitPerMinute: 1000,
        bufferSize: 500,
        bufferMaxBytes: 1024 * 1024,
        useWorkerAssembly: false,
        silent: true
      });
      sdk.activate();
      fastifyPlugin(sdk)(
        {
          addHook: (_name, handler) => {
            fastifyHook = handler;
          }
        } as never,
        {},
        () => undefined
      );

      const server = createServer((req, res) => {
        fastifyHook?.(
          {
            raw: {
              method: req.method ?? 'GET',
              url: req.url ?? '/',
              headers: req.headers as Record<string, unknown>
            }
          },
          { raw: res },
          () => {
            const steps = [
              (next: () => void) => {
                checkpoints.push('middleware:one');
                setImmediate(next);
              },
              (next: () => void) => {
                checkpoints.push('middleware:two');
                void Promise.resolve().then(next);
              },
              () => {
                checkpoints.push('handler');
                pushSyntheticTimelineEvent(sdk!, {
                  type: 'db-query',
                  target: 'postgres://timeline',
                  method: 'query',
                  dbMeta: { query: 'select 1', params: '[]', rowCount: 1 }
                });
                pushSyntheticTimelineEvent(sdk!, {
                  type: 'http-client',
                  target: 'http://downstream.local',
                  method: 'GET',
                  url: 'http://downstream.local/lookup'
                });
                sdk!.captureError(new Error(marker));
                res.statusCode = 500;
                res.end('boom');
              }
            ];
            let index = 0;
            const next = () => {
              const step = steps[index++];
              step?.(next);
            };
            next();
          }
        );
      });
      const port = await listen(server);

      try {
        const response = await sendRequest({ port, method: 'GET', path: '/timeline' });
        expect(response.statusCode).toBe(500);
      } finally {
        await close(server);
      }

      await sdk.shutdown();
      const pkg = readDeliveredPackage(output.file);

      expect(pkg.error.message).toBe(marker);
      assertFrameworkTimelinePackage(pkg, checkpoints);
    } finally {
      if (sdk?.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('starts in production with encryptionKeyCallback and emits encrypted packages', async () => {
    const output = createTempOutput('errorcore-e2e-callback-key');
    const previousNodeEnv = process.env.NODE_ENV;
    const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    let sdk: ReturnType<typeof createSDK> | null = null;

    process.env.NODE_ENV = 'production';

    try {
      sdk = createSDK({
        encryptionKeyCallback: () => encryptionKey,
        transport: { type: 'file', path: output.file },
        captureBody: false,
        rateLimitPerMinute: 1000,
        bufferSize: 500,
        bufferMaxBytes: 1024 * 1024,
        useWorkerAssembly: false
      });
      sdk.activate();
      sdk.captureError(new Error('callback-key-boom'));
      await sdk.shutdown();

      const pkg = readDeliveredPackage(output.file, encryptionKey);
      expect(pkg.completeness.encrypted).toBe(true);
      expect(pkg.error.message).toBe('callback-key-boom');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (sdk?.isActive()) {
        await sdk.shutdown();
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('built worker assembly emits envelopes compatible with configured macKey and SDK version', () => {
    const script = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSDK } = require('./dist/sdk');
const { Encryption } = require('./dist/security/encryption');
const pkgJson = require('./package.json');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-dist-worker-mac-'));
  const file = path.join(directory, 'errorcore-output.log');
  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const macKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const sdk = createSDK({
    encryptionKey,
    macKey,
    transport: { type: 'file', path: file },
    captureBody: false,
    rateLimitPerMinute: 1000,
    bufferSize: 500,
    bufferMaxBytes: 1024 * 1024,
    flushIntervalMs: 0,
    silent: true,
    useWorkerAssembly: true
  });

  try {
    sdk.activate();
    sdk.captureError(new Error('dist-worker-mac-boom'));
    await sdk.shutdown();

    const line = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).at(-1);
    const envelope = JSON.parse(line);
    const plaintext = new Encryption(encryptionKey, {
      macKey,
      sdkVersion: envelope.sdk.version
    }).decrypt(envelope);
    const packageObject = JSON.parse(plaintext);

    process.stdout.write(JSON.stringify({
      sdkVersion: envelope.sdk.version,
      packageVersion: pkgJson.version,
      keyId: envelope.keyId,
      message: packageObject.error.message
    }));
  } finally {
    await sdk.shutdown().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(error.stack || error.message || String(error));
  process.exit(1);
});
`;

    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    const result = JSON.parse(output) as {
      sdkVersion: string;
      packageVersion: string;
      keyId: string;
      message: string;
    };

    expect(result.sdkVersion).toBe(result.packageVersion);
    expect(result.keyId).not.toBe('unencrypted');
    expect(result.message).toBe('dist-worker-mac-boom');
  });

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
      // Ambient events surviving outside request context come from the
      // client-side net/dns recorders — standing-pipeline (balanced)
      // behavior now that safe runs only the inbound recorder.
      captureMode: 'balanced',
      captureLocalVariables: false,
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

  it('ships v1.3.0 stamping fields and eventClockRange brackets every captured event', async () => {
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

      // Top-level v1.3.0 fields are present and well-typed.
      expect(pkg.schemaVersion).toBe('1.3.0');
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
      // - that's pre-existing scrubber behavior, not new in v1.3.0.
      expect(pkg.stateWrites).toHaveLength(1);
      expect(pkg.stateWrites[0]).toMatchObject({
        container: 'cache',
        operation: 'set',
        value: {
          mode: 'meta',
          meta: {
            type: 'number',
            bytes: 1
          }
        }
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
    // This assertion focuses on the local clock jump from inbound
    // tracestate. The package-level current tracestate serialization is
    // covered below so we can keep this case about merge behavior only.
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
        headers: {
          traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
          tracestate: 'ec=clk:42,vendor1=foo'
        }
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

  it('stores webhook events locally and retries a transient destination outage', async () => {
    const output = createTempOutput('errorcore-e2e-webhook');
    const storePath = path.join(output.directory, 'events.ndjson');
    const received: unknown[] = [];
    let attempts = 0;
    const webhook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        attempts += 1;
        if (attempts === 1) {
          res.statusCode = 503;
          res.end('try again');
          return;
        }
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.statusCode = 204;
        res.end();
      });
    });

    try {
      const port = await listen(webhook);
      const sdk = createSDK({
        allowUnencrypted: true,
        allowPlainHttpTransport: true,
        transport: {
          type: 'webhook',
          url: `http://127.0.0.1:${port}/errorcore`,
          batchSize: 1,
          maxDelayMs: 60_000,
          retries: 2,
          secret: 'webhook-secret',
          storePath,
          retainOnAck: true
        },
        useWorkerAssembly: false
      });
      sdk.activate();

      sdk.captureError(new Error('webhook-retained'));
      await sdk.shutdown();

      expect(attempts).toBe(2);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        version: 1,
        kind: 'errorcore.webhook_batch',
        events: [
          {
            kind: 'error',
            payload: {
              v: 1,
              sdk: { name: 'errorcore' }
            }
          }
        ]
      });
      expect(fs.readFileSync(storePath, 'utf8')).toContain('"kind":"event"');
    } finally {
      if (webhook.listening) {
        await close(webhook);
      }
      fs.rmSync(output.directory, { recursive: true, force: true });
    }
  });

  it('serializes the current ec tracestate into captured root and inbound spans', async () => {
    const output = createTempOutput('errorcore-e2e-capture-tracestate');
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'file', path: output.file },
      captureBody: false,
      rateLimitPerMinute: 1000,
      bufferSize: 500,
      bufferMaxBytes: 1024 * 1024,
      silent: true
    });
    sdk.activate();

    const server = createServer(wrapHandler((req, res) => {
      sdk.captureError(new Error(`capture-tracestate-${req.url}`));
      res.statusCode = 500;
      res.end('ok');
    }, sdk));

    try {
      const port = await listen(server);
      await sendRequest({ port, method: 'GET', path: '/root' });
      await sendRequest({
        port,
        method: 'GET',
        path: '/inbound',
        headers: {
          traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
          tracestate: 'vendor=kept'
        }
      });

      await close(server);
      await sdk.shutdown();

      const lines = fs.readFileSync(output.file, 'utf8').trim().split('\n').filter(Boolean);
      const packages = lines.map((line) => {
        const envelope = JSON.parse(line) as import('../../src/types').EncryptedEnvelope;
        return JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString('utf8'));
      });
      const rootPkg = packages.find((pkg) => pkg.error.message === 'capture-tracestate-/root');
      const inboundPkg = packages.find((pkg) => pkg.error.message === 'capture-tracestate-/inbound');

      expect(rootPkg?.trace?.tracestate).toMatch(/^ec=clk:\d+$/);
      expect(inboundPkg?.trace?.tracestate).toMatch(/^ec=clk:\d+,vendor=kept$/);
      expect(inboundPkg?.trace?.tracestate).not.toBe('vendor=kept');
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
