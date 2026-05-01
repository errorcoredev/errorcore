import { afterEach, describe, expect, it, test, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createSDK } from '../../src/sdk';
import { DeadLetterStore } from '../../src/transport/dead-letter-store';
import type { InternalWarning } from '../../src/types';

// 64-char uniformly distributed hex — satisfies the entropy check.
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface CapturedWarning {
  code: string;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

function makeRecorder(): {
  warnings: CapturedWarning[];
  record: (w: InternalWarning) => void;
} {
  const warnings: CapturedWarning[] = [];
  return {
    warnings,
    record: (w) => {
      warnings.push({
        code: w.code,
        message: w.message,
        cause: w.cause,
        context: w.context
      });
    }
  };
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `backpressure-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function listenHttp(server: http.Server): Promise<number> {
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

async function closeHttp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function listenTcpTarpit(): Promise<{
  server: net.Server;
  port: number;
  sockets: Set<net.Socket>;
}> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Accept the connection and deliberately never write a response.
    // Track the socket so the test can forcibly destroy it at teardown
    // — otherwise `server.close()` hangs waiting for the connection to
    // drain.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      /* swallow client-side closes */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Tarpit did not bind to a TCP port');
  }
  return { server, port: address.port, sockets };
}

async function closeTcp(server: net.Server, sockets?: Set<net.Socket>): Promise<void> {
  if (sockets !== undefined) {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('backpressure contract', () => {
  // ---------- row 1: transport slow but up → no warning ----------
  it('row 1: transport succeeds after retries, no warning fires', async () => {
    const dir = makeTempDir('slow-but-up');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    let attempts = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      attempts += 1;
      if (attempts < 3) {
        res.statusCode = 503;
        res.end('busy');
      } else {
        res.statusCode = 200;
        res.end('ok');
      }
    });

    try {
      const port = await listenHttp(server);
      const sdk = createSDK({
        transport: {
          type: 'http',
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 500
        },
        allowUnencrypted: true,
        allowPlainHttpTransport: true,
        deadLetterPath: dlqPath,
        rateLimitPerMinute: 1000,
        onInternalWarning: record,
        serverless: true
      });
      sdk.activate();

      expect(() => sdk.captureError(new Error('slow-but-up'))).not.toThrow();
      await sdk.flush();
      await sdk.shutdown();

      expect(warnings.find((w) => w.code === 'transport_failed' || w.code === 'transport_timeout')).toBeUndefined();
      expect(attempts).toBeGreaterThanOrEqual(3);
    } finally {
      await closeHttp(server);
      cleanupTempDir(dir);
    }
  }, 20_000);

  // ---------- row 2: transport down → transport_failed ----------
  it('row 2: transport failure fires transport_failed and dead-letters', async () => {
    const dir = makeTempDir('transport-down');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    // Reserve a port by opening and immediately closing a listener. The
    // kernel will briefly remember the port as unavailable / no listener
    // there, so the HTTP transport gets ECONNREFUSED.
    const tmpServer = net.createServer();
    const reservedPort: number = await new Promise((resolve) => {
      tmpServer.listen(0, '127.0.0.1', () => {
        const address = tmpServer.address();
        if (typeof address !== 'object' || address === null) {
          throw new Error('reserved port bind failed');
        }
        resolve(address.port);
      });
    });
    await closeTcp(tmpServer);

    try {
      const sdk = createSDK({
        transport: {
          type: 'http',
          url: `http://127.0.0.1:${reservedPort}/`,
          timeoutMs: 200
        },
        encryptionKey: TEST_ENCRYPTION_KEY,
        allowPlainHttpTransport: true,
        deadLetterPath: dlqPath,
        rateLimitPerMinute: 1000,
        onInternalWarning: record,
        serverless: true
      });
      sdk.activate();

      expect(() => sdk.captureError(new Error('transport-down'))).not.toThrow();
      await sdk.flush();
      await sdk.shutdown();

      const transportWarning = warnings.find((w) => w.code === 'transport_failed');
      expect(transportWarning).toBeDefined();
      expect(transportWarning?.cause).toMatchObject({
        name: expect.any(String),
        message: expect.any(String),
      });
      // Dead-letter file should contain the payload (DLQ accepted).
      expect(fs.existsSync(dlqPath)).toBe(true);
      const dlqContents = fs.readFileSync(dlqPath, 'utf8');
      expect(dlqContents.length).toBeGreaterThan(0);
    } finally {
      cleanupTempDir(dir);
    }
  }, 20_000);

  // ---------- transport_timeout (auxiliary) ----------
  it('transport timeout fires transport_timeout code', async () => {
    const dir = makeTempDir('transport-timeout');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();
    const { server: tarpit, port, sockets } = await listenTcpTarpit();

    try {
      const sdk = createSDK({
        transport: {
          type: 'http',
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 100
        },
        allowUnencrypted: true,
        allowPlainHttpTransport: true,
        deadLetterPath: dlqPath,
        rateLimitPerMinute: 1000,
        onInternalWarning: record,
        serverless: true
      });
      sdk.activate();

      expect(() => sdk.captureError(new Error('tarpit'))).not.toThrow();
      await sdk.flush();
      await sdk.shutdown();

      const timeout = warnings.find((w) => w.code === 'transport_timeout');
      expect(timeout).toBeDefined();
      expect(timeout?.cause).toMatchObject({
        name: expect.any(String),
        message: expect.stringContaining('HTTP transport timeout'),
      });
    } finally {
      await closeTcp(tarpit, sockets);
      cleanupTempDir(dir);
    }
  }, 20_000);

  // ---------- row 3a: DLQ disk full (ENOSPC) → disk_full ----------
  it('row 3a: DLQ write with ENOSPC fires disk_full', () => {
    const dir = makeTempDir('dlq-enospc');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    const store = new DeadLetterStore(dlqPath, {
      integrityKey: 'x'.repeat(32),
      onInternalWarning: record
    });

    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });

    try {
      const ok = store.appendPayloadSync('{"payload":"hello"}');
      expect(ok).toBe(false);
      const diskFull = warnings.find((w) => w.code === 'disk_full');
      expect(diskFull).toBeDefined();
      expect((diskFull?.cause as NodeJS.ErrnoException).code).toBe('ENOSPC');
      expect(diskFull?.context?.errno).toBe('ENOSPC');

      // SDK usability: with spy removed, a subsequent append succeeds.
      spy.mockRestore();
      const ok2 = store.appendPayloadSync('{"payload":"world"}');
      expect(ok2).toBe(true);
    } finally {
      spy.mockRestore();
      cleanupTempDir(dir);
    }
  });

  // ---------- row 3b: DLQ other errno (EACCES) → dead_letter_write_failed ----------
  it('row 3b: DLQ write with EACCES fires dead_letter_write_failed', () => {
    const dir = makeTempDir('dlq-eacces');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    const store = new DeadLetterStore(dlqPath, {
      integrityKey: 'x'.repeat(32),
      onInternalWarning: record
    });

    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    try {
      const ok = store.appendPayloadSync('{"payload":"hello"}');
      expect(ok).toBe(false);
      const writeFailed = warnings.find((w) => w.code === 'dead_letter_write_failed');
      expect(writeFailed).toBeDefined();
      expect((writeFailed?.cause as NodeJS.ErrnoException).code).toBe('EACCES');

      spy.mockRestore();
      const ok2 = store.appendPayloadSync('{"payload":"world"}');
      expect(ok2).toBe(true);
    } finally {
      spy.mockRestore();
      cleanupTempDir(dir);
    }
  });

  // ---------- row 4: DLQ at size cap → dead_letter_full ----------
  it('row 4: DLQ at size cap fires dead_letter_full', () => {
    const dir = makeTempDir('dlq-size-cap');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    // Small cap so a single well-formed envelope fills it.
    const store = new DeadLetterStore(dlqPath, {
      integrityKey: 'x'.repeat(32),
      maxSizeBytes: 512,
      onInternalWarning: record
    });

    // First append fits.
    expect(store.appendPayloadSync('{"p":"' + 'a'.repeat(400) + '"}')).toBe(true);

    // Second append trips the size cap.
    const ok = store.appendPayloadSync('{"p":"second"}');
    expect(ok).toBe(false);

    const cap = warnings.find((w) => w.code === 'dead_letter_full');
    expect(cap).toBeDefined();
    expect(cap?.context?.reason).toBe('size_cap');

    cleanupTempDir(dir);
  });

  // ---------- DLQ oversized payload (auxiliary) → dead_letter_full ----------
  it('DLQ oversized payload fires dead_letter_full', () => {
    const dir = makeTempDir('dlq-oversized');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const { warnings, record } = makeRecorder();

    const store = new DeadLetterStore(dlqPath, {
      integrityKey: 'x'.repeat(32),
      maxPayloadBytes: 100,
      onInternalWarning: record
    });

    const big = 'x'.repeat(500);
    const ok = store.appendPayloadSync(big);
    expect(ok).toBe(false);

    const oversized = warnings.find(
      (w) => w.code === 'dead_letter_full' && w.context?.reason === 'oversized_payload'
    );
    expect(oversized).toBeDefined();

    // Subsequent small payload succeeds.
    const ok2 = store.appendPayloadSync('tiny');
    expect(ok2).toBe(true);

    cleanupTempDir(dir);
  });

  // ---------- row 5: invalid encryption key → throws, no callback ----------
  it('row 5: invalid encryption key throws at createSDK; callback does not fire', () => {
    const { warnings, record } = makeRecorder();

    // Length invalid.
    expect(() =>
      createSDK({
        transport: { type: 'stdout' },
        encryptionKey: 'deadbeef',
        onInternalWarning: record
      })
    ).toThrow(/encryptionKey must be a 64-character hex string/);

    // Entropy invalid.
    expect(() =>
      createSDK({
        transport: { type: 'stdout' },
        encryptionKey: '0'.repeat(64),
        onInternalWarning: record
      })
    ).toThrow(/insufficient character diversity/);

    // Documented behavior: the callback does not fire because the SDK
    // is never constructed — see docs/BACKPRESSURE.md.
    expect(warnings).toHaveLength(0);
  });

  // ---------- row 6: rate limit hit → rate_limited ----------
  it('row 6: rate limit hit fires rate_limited and recovers after window', async () => {
    const dir = makeTempDir('rate-limit');
    const dlqPath = path.join(dir, 'dlq.ndjson');
    const outPath = path.join(dir, 'out.log');
    const { warnings, record } = makeRecorder();

    const sdk = createSDK({
      transport: { type: 'file', path: outPath },
      allowUnencrypted: true,
      deadLetterPath: dlqPath,
      rateLimitPerMinute: 1,
      rateLimitWindowMs: 1000,
      onInternalWarning: record,
      serverless: true
    });
    sdk.activate();

    try {
      expect(() => sdk.captureError(new Error('first'))).not.toThrow();
      expect(() => sdk.captureError(new Error('second'))).not.toThrow();

      const rateLimited = warnings.find((w) => w.code === 'rate_limited');
      expect(rateLimited).toBeDefined();
      expect(rateLimited?.message).toContain('Rate limit');

      // Clear the window so a follow-up capture succeeds.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      warnings.length = 0;
      expect(() => sdk.captureError(new Error('third'))).not.toThrow();
      expect(warnings.find((w) => w.code === 'rate_limited')).toBeUndefined();
    } finally {
      await sdk.flush();
      await sdk.shutdown();
      cleanupTempDir(dir);
    }
  }, 20_000);

  // ---------- auxiliary: real-fs skip on Windows ----------
  test.skipIf(process.platform === 'win32')(
    'real-fs readonly directory produces a DLQ warning',
    () => {
      const dir = makeTempDir('dlq-readonly');
      const dlqDir = path.join(dir, 'ro-sub');
      fs.mkdirSync(dlqDir, { mode: 0o500 });
      // Path inside a directory without write permission. On POSIX
      // systems this produces EACCES; we don't assert disk_full vs
      // dead_letter_write_failed specifically because some filesystems
      // surface other codes (EROFS on read-only mounts). What we
      // require is that SOME backpressure code fires and the caller
      // does not throw.
      const dlqPath = path.join(dlqDir, 'dlq.ndjson');
      const { warnings, record } = makeRecorder();

      const store = new DeadLetterStore(dlqPath, {
        integrityKey: 'x'.repeat(32),
        onInternalWarning: record
      });

      const ok = store.appendPayloadSync('{"payload":"hi"}');
      expect(ok).toBe(false);
      expect(
        warnings.some(
          (w) => w.code === 'dead_letter_write_failed' || w.code === 'disk_full'
        )
      ).toBe(true);

      // Restore permissions so cleanup succeeds.
      fs.chmodSync(dlqDir, 0o700);
      cleanupTempDir(dir);
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});
