import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ERRORCORE_INTERNAL, SDK_INTERNAL_REQUESTS } from '../../src/recording/http-client';
import { isInternalCallActive } from '../../src/recording/internal';
import { HttpTransport } from '../../src/transport/http-transport';
import { FileTransport } from '../../src/transport/file-transport';
import { StdoutTransport } from '../../src/transport/stdout-transport';
import { TransportDispatcher } from '../../src/transport/transport';
import { resolveTestConfig } from '../helpers/test-config';

const nodeRequire = createRequire(import.meta.url);
const Module = nodeRequire('node:module') as typeof import('node:module');
const fs = nodeRequire('node:fs') as typeof import('node:fs');
const path = nodeRequire('node:path') as typeof import('node:path');
const os = nodeRequire('node:os') as typeof import('node:os');
const httpsModule = nodeRequire('node:https') as typeof import('node:https');
const httpModule = nodeRequire('node:http') as typeof import('node:http');
const originalRequire = Module.prototype.require;

class MockWorker extends EventEmitter {
  public readonly postMessage = vi.fn((message: { id: number; type: string }) => {
    this.emit('message', { id: message.id });
  });

  public readonly terminate = vi.fn(async () => 1);
}

function withWorkerThreadsMock<T>(
  workerFactory: () => MockWorker,
  run: () => Promise<T> | T
): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:worker_threads') {
      return {
        Worker: class {
          public constructor() {
            return workerFactory();
          }
        }
      };
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function withMissingWorkerThreads<T>(run: () => Promise<T> | T): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:worker_threads') {
      throw new Error('worker_threads unavailable');
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function createMockRequest(options: {
  statuses: number[];
  timeoutBehavior?: 'trigger' | 'none';
}) {
  const response = new EventEmitter() as EventEmitter & { statusCode?: number };
  let callCount = 0;

  return vi.fn((requestOptions: unknown, callback: (response: typeof response) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };

    request.write = vi.fn();
    request.destroy = vi.fn((error?: Error) => {
      if (error !== undefined) {
        request.emit('error', error);
      }
    });
    request.setTimeout = vi.fn((_: number, handler: () => void) => {
      if (options.timeoutBehavior === 'trigger') {
        handler();
      }
      return request;
    });
    request.end = vi.fn(() => {
      response.statusCode = options.statuses[Math.min(callCount, options.statuses.length - 1)];
      callCount += 1;
      callback(response);
      response.emit('data', Buffer.from('ok'));
      response.emit('end');
    });

    return request;
  });
}

function createErroringMockRequest(
  errors: Array<Error & { code?: string }>
) {
  let callCount = 0;

  return vi.fn((_requestOptions: unknown, _callback: (response: EventEmitter) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };

    request.write = vi.fn();
    request.destroy = vi.fn((error?: Error) => {
      if (error !== undefined) {
        request.emit('error', error);
      }
    });
    request.setTimeout = vi.fn(() => request);
    request.end = vi.fn(() => {
      const error = errors[Math.min(callCount, errors.length - 1)];
      callCount += 1;
      request.emit('error', error);
    });

    return request;
  });
}

function createDeferredStdoutWrite() {
  const writes: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(
      ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        callbacks.push(callback ?? (() => undefined));
        return true;
      }) as typeof process.stdout.write
    );

  return {
    writeSpy,
    writes,
    pendingCount: () => callbacks.length,
    completeNext(error?: Error) {
      callbacks.shift()?.(error ?? null);
    }
  };
}

async function waitForSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('HttpTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('sends payloads with the correct HTTPS headers', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect',
      authorization: 'Bearer secret-key'
    });

    await transport.send('{"ok":true}');

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'https:',
      hostname: 'example.com',
      path: '/collect',
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        Authorization: 'Bearer secret-key'
      }
    });
  });

  it('marks HTTP transport requests as SDK-internal during creation', async () => {
    const requestSpy = vi.fn((requestOptions: unknown, callback: (response: EventEmitter) => void) => {
      expect(isInternalCallActive()).toBe(true);

      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        [ERRORCORE_INTERNAL]?: boolean;
      };

      request.write = vi.fn();
      request.destroy = vi.fn();
      request.setTimeout = vi.fn(() => request);
      request.end = vi.fn(() => {
        response.statusCode = 200;
        callback(response);
        response.emit('end');
      });

      void requestOptions;
      return request;
    });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect'
    });

    await transport.send('payload');

    const request = requestSpy.mock.results[0]?.value as { [ERRORCORE_INTERNAL]?: boolean };

    expect(request[ERRORCORE_INTERNAL]).toBe(true);
    expect(SDK_INTERNAL_REQUESTS.has(request as object)).toBe(true);
  });

  it('retries on failure and succeeds on a later attempt', async () => {
    const requestSpy = createMockRequest({ statuses: [500, 500, 200] });
    const delaySpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect'
    });

    await transport.send('payload');

    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(delaySpy).toHaveBeenCalled();
  });

  it('handles request timeouts', async () => {
    const requestSpy = createMockRequest({ statuses: [200], timeoutBehavior: 'trigger' });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const transport = new HttpTransport({
      url: 'https://example.com/collect'
    });

    await expect(transport.send('payload')).rejects.toThrow('HTTP transport timeout');

    const request = requestSpy.mock.results[0]?.value as { destroy: ReturnType<typeof vi.fn> };
    expect(request.destroy).toHaveBeenCalled();
  });

  it('rejects insecure HTTP URLs by default', () => {
    expect(
      () =>
        new HttpTransport({
          url: 'http://example.com/collect'
        })
    ).toThrow('HTTP transport requires an https:// URL');
  });

  it('allows insecure HTTP when explicitly enabled', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpModule.request = requestSpy as typeof httpModule.request;

    const transport = new HttpTransport({
      url: 'http://example.com/collect',
      allowPlainHttpTransport: true
    });

    await transport.send('payload');

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('(a) throws at init if URL is http:// and allowPlainHttpTransport is false', () => {
    expect(
      () => new HttpTransport({ url: 'http://insecure.example.com/v1' })
    ).toThrow('https://');
  });

  it('(b) does not throw at init if URL is https://', () => {
    expect(
      () => new HttpTransport({ url: 'https://secure.example.com/v1' })
    ).not.toThrow();
  });

  it('(c) does not throw at init if URL is http:// and allowPlainHttpTransport is true', () => {
    expect(
      () =>
        new HttpTransport({
          url: 'http://insecure.example.com/v1',
          allowPlainHttpTransport: true
        })
    ).not.toThrow();
  });

  it('(d) retries exactly 3 times with delays of approximately 200, 600, 1800 ms before throwing', async () => {
    const requestSpy = createMockRequest({ statuses: [500, 500, 500] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const capturedDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number) => {
      if (typeof ms === 'number' && ms > 0) {
        capturedDelays.push(ms);
      }
      if (typeof fn === 'function') fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const transport = new HttpTransport({ url: 'https://example.com/collect' });

    await expect(transport.send('payload')).rejects.toThrow('HTTP 500');

    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(capturedDelays).toEqual([200, 600]);

    globalThis.setTimeout = originalSetTimeout;
  });

  it('(e) throws after max retries so the caller can fall through to dead-letter', async () => {
    const requestSpy = createMockRequest({ statuses: [502, 502, 502] });
    httpsModule.request = requestSpy as typeof httpsModule.request;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const transport = new HttpTransport({ url: 'https://example.com/collect' });

    await expect(transport.send('payload')).rejects.toThrow();
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the socket errors with a non-transient code like EACCES', async () => {
    // Regression: the previous filter treated ANY error.code as retryable
    // except a small TLS blocklist. EACCES and other local errors were
    // retried up to 3x for no benefit. The fix narrows retry to a
    // transient-network allowlist.
    const attempt: Array<EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn> }> = [];
    const requestSpy = vi.fn(() => {
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      request.end = vi.fn(() => {
        const eaccess = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        setImmediate(() => request.emit('error', eaccess));
      });
      request.destroy = vi.fn();
      request.setTimeout = vi.fn(() => request);
      attempt.push(request);
      return request;
    });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({ url: 'https://example.com/collect' });

    await expect(transport.send('payload')).rejects.toThrow();
    // Exactly one attempt: EACCES is not retryable.
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('(f) appends a newline to every payload', async () => {
    const writtenBodies: Buffer[] = [];
    const requestSpy = vi.fn((_opts: unknown, callback: (res: EventEmitter & { statusCode?: number }) => void) => {
      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn((data: Buffer) => { writtenBodies.push(data); });
      request.destroy = vi.fn();
      request.setTimeout = vi.fn(() => request);
      request.end = vi.fn(() => {
        response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from('ok'));
        response.emit('end');
      });
      return request;
    });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({ url: 'https://example.com/collect' });
    await transport.send('{"test":true}');

    expect(writtenBodies.length).toBe(1);
    expect(writtenBodies[0].toString()).toMatch(/\n$/);
  });

  it('(g) sets content-type to application/x-ndjson', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({ url: 'https://example.com/collect' });
    await transport.send('payload');

    const options = requestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = options.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-ndjson');
  });

  it('(h) sets Authorization header when authorization config is provided', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect',
      authorization: 'Bearer my-token'
    });
    await transport.send('payload');

    const options = requestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-token');
  });

  it('(i) does not set Authorization header when authorization is undefined', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({ url: 'https://example.com/collect' });
    await transport.send('payload');

    const options = requestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('(j) keeps TLS verification enabled unless invalid certificates are explicitly allowed', async () => {
    const secureRequestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = secureRequestSpy as typeof httpsModule.request;

    const secureTransport = new HttpTransport({ url: 'https://example.com/collect' });
    await secureTransport.send('payload');

    const secureOptions = secureRequestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(secureOptions.rejectUnauthorized).toBe(true);

    const plainHttpRequestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = plainHttpRequestSpy as typeof httpsModule.request;

    // allowPlainHttpTransport permits http:// collectors but must not affect
    // certificate validation on https:// collectors.
    const plainHttpTransport = new HttpTransport({
      url: 'https://example.com/collect',
      allowPlainHttpTransport: true
    });
    await plainHttpTransport.send('payload');

    const plainHttpOptions = plainHttpRequestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(plainHttpOptions.rejectUnauthorized).toBe(true);

    const invalidCertRequestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = invalidCertRequestSpy as typeof httpsModule.request;

    const invalidCertTransport = new HttpTransport({
      url: 'https://example.com/collect',
      allowInvalidCollectorCertificates: true
    });
    await invalidCertTransport.send('payload');

    const invalidCertOptions = invalidCertRequestSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(invalidCertOptions.rejectUnauthorized).toBe(false);
  });

  it('warns once per process when HTTPS certificate validation is disabled', () => {
    delete (globalThis as Record<string, unknown>)[
      '__errorcoreInvalidCollectorCertificatesWarningEmitted'
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    new HttpTransport({
      url: 'https://example.com/collect',
      allowInvalidCollectorCertificates: true
    });
    new HttpTransport({
      url: 'https://another.example.com/collect',
      allowInvalidCollectorCertificates: true
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ErrorCore] HTTPS collector certificate validation is disabled; use allowInvalidCollectorCertificates only for local development.'
    );

    delete (globalThis as Record<string, unknown>)[
      '__errorcoreInvalidCollectorCertificatesWarningEmitted'
    ];
  });

  it('does not warn when invalid-certificate mode is configured for plain HTTP', () => {
    delete (globalThis as Record<string, unknown>)[
      '__errorcoreInvalidCollectorCertificatesWarningEmitted'
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    new HttpTransport({
      url: 'http://example.com/collect',
      allowPlainHttpTransport: true,
      allowInvalidCollectorCertificates: true
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not retry permanent HTTP failures', async () => {
    const requestSpy = createMockRequest({ statuses: [401, 401, 401] });
    httpsModule.request = requestSpy as typeof httpsModule.request;
    const delaySpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const transport = new HttpTransport({ url: 'https://example.com/collect' });

    await expect(transport.send('payload')).rejects.toThrow('HTTP 401');
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(delaySpy).not.toHaveBeenCalled();
  });

  it.each([
    ['CERT_HAS_EXPIRED', 'expired cert'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed cert'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'alt-name mismatch']
  ])(
    'does not retry permanent TLS trust failures (%s)',
    async (code, message) => {
      const requestSpy = createErroringMockRequest([
        Object.assign(new Error(message), { code })
      ]);
      httpsModule.request = requestSpy as typeof httpsModule.request;
      const delaySpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(((fn: TimerHandler) => {
          if (typeof fn === 'function') {
            fn();
          }

          return { unref: vi.fn() } as unknown as NodeJS.Timeout;
        }) as typeof setTimeout);

      const transport = new HttpTransport({ url: 'https://example.com/collect' });

      let thrown: (Error & { code?: string }) | undefined;
      try {
        await transport.send('payload');
      } catch (error) {
        thrown = error as Error & { code?: string };
      }

      expect(thrown).toBeDefined();
      expect(thrown?.message).toBe(message);
      expect(thrown?.code).toBe(code);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(delaySpy).not.toHaveBeenCalled();
    }
  );
});

describe('FileTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('appends JSON lines to a file', async () => {
    const filePath = path.join(os.tmpdir(), `errorcore-transport-${Date.now()}.log`);
    const transport = new FileTransport({ path: filePath });

    await transport.send('{"a":1}');
    await transport.send('{"b":2}');

    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toBe('{"a":1}\n{"b":2}\n');
    fs.rmSync(filePath, { force: true });
  });

  it('rotates the file when it exceeds the size limit', async () => {
    const filePath = path.join(os.tmpdir(), `errorcore-rotate-${Date.now()}.log`);

    fs.writeFileSync(filePath, 'x'.repeat(32));

    const transport = new FileTransport({ path: filePath, maxSizeBytes: 8 });

    await transport.send('payload');

    const files = fs
      .readdirSync(path.dirname(filePath))
      .filter((entry) => entry.startsWith(path.basename(filePath)));

    expect(files.some((entry) => entry.endsWith('.bak'))).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('payload\n');

    for (const file of files) {
      fs.rmSync(path.join(path.dirname(filePath), file), { force: true });
    }
  });

  it('sendSync writes synchronously', () => {
    const filePath = path.join(os.tmpdir(), `errorcore-sync-${Date.now()}.log`);
    const transport = new FileTransport({ path: filePath });

    transport.sendSync('sync-payload');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('sync-payload\n');
    fs.rmSync(filePath, { force: true });
  });

  it('rejects async send when the target path cannot be created', async () => {
    const filePath = path.join(
      os.tmpdir(),
      `errorcore-missing-${Date.now()}`,
      'nested',
      'errorcore.log'
    );
    const transport = new FileTransport({ path: filePath });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(transport.send('payload')).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ErrorCore] File transport dropped payload:')
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('StdoutTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('writes payloads to stdout and sendSync to stdout synchronously', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);
    const writeSync = vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    const transport = new StdoutTransport();

    await transport.send('payload');
    transport.sendSync('sync-payload');

    expect(stdoutWrite).toHaveBeenCalled();
    expect(writeSync).toHaveBeenCalledWith(1, 'sync-payload\n');
  });
});

describe('TransportDispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('uses worker send/flush/shutdown lifecycle when worker creation succeeds', async () => {
    const worker = new MockWorker();

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      await dispatcher.send('payload');
      await dispatcher.flush();
      await dispatcher.shutdown();
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    expect(worker.postMessage.mock.calls.map((call) => call[0].type)).toEqual([
      'send',
      'flush',
      'shutdown'
    ]);
  });

  it('falls back to main-thread dispatch when worker threads are unavailable', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      await dispatcher.send('payload');
      await dispatcher.flush();
    });

    expect(stdoutWrite).toHaveBeenCalled();
  });

  it('rejects send when main-thread fallback transport fails', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(
      ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(new Error('stdout unavailable'));
        return false;
      }) as typeof process.stdout.write
    );

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      await expect(dispatcher.send('payload')).rejects.toThrow('stdout unavailable');
    });
  });

  it('rejects send when main-thread fallback file transport fails', async () => {
    const filePath = path.join(
      os.tmpdir(),
      `errorcore-main-thread-missing-${Date.now()}`,
      'nested',
      'errorcore.log'
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig({
          transport: { type: 'file', path: filePath }
        }),
        encryption: null
      });

      await expect(dispatcher.send('payload')).rejects.toThrow();
      await dispatcher.shutdown();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ErrorCore] File transport dropped payload:')
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('forces worker termination on shutdown timeout', async () => {
    class HangingWorker extends MockWorker {
      public override postMessage = vi.fn();
    }

    const worker = new HangingWorker();
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: TimerHandler) => {
        fn();
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      await dispatcher.shutdown({ timeoutMs: 1 });
    });

    expect(timeoutSpy).toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects in-flight sends when the worker crashes and fallback delivery fails', async () => {
    class CrashingWorker extends MockWorker {
      public override postMessage = vi.fn(() => {
        this.emit('error', new Error('worker crashed'));
      });
    }

    const worker = new CrashingWorker();
    const stdout = createDeferredStdoutWrite();

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      const sendPromise = dispatcher.send('payload');

      await waitForSetImmediate();
      expect(stdout.pendingCount()).toBe(1);

      stdout.completeNext(new Error('stdout unavailable'));

      await expect(sendPromise).rejects.toThrow('stdout unavailable');
    });

    expect(stdout.writes).toEqual(['payload\n']);
  });

  it('resolves in-flight payloads via fallback when the worker crashes', async () => {
    class DelayedCrashWorker extends MockWorker {
      private messages: Array<{ id: number; type: string }> = [];

      public override postMessage = vi.fn((message: { id: number; type: string }) => {
        this.messages.push(message);
        if (this.messages.length === 2) {
          this.emit('error', new Error('worker crashed'));
        }
      });
    }

    const worker = new DelayedCrashWorker();
    const receivedPayloads: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      receivedPayloads.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      callback?.(null);
      return true;
    }) as typeof process.stdout.write);

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      const p1 = dispatcher.send('payload-one');
      const p2 = dispatcher.send('payload-two');

      await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);
      await dispatcher.flush();
    });

    const allOutput = receivedPayloads.join('');
    expect(allOutput).toContain('payload-one');
    expect(allOutput).toContain('payload-two');
  });

  it('waits for migrated fallback sends before resolving a pending flush after worker crash', async () => {
    class FlushCrashingWorker extends MockWorker {
      public override postMessage = vi.fn((message: { id: number; type: string }) => {
        if (message.type === 'flush') {
          this.emit('error', new Error('worker crashed'));
        }
      });
    }

    const worker = new FlushCrashingWorker();
    const stdout = createDeferredStdoutWrite();

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });
      const sendPromise = dispatcher.send('payload');
      const flushPromise = dispatcher.flush();
      let flushResolved = false;

      void flushPromise.then(() => {
        flushResolved = true;
      });

      await waitForSetImmediate();
      expect(flushResolved).toBe(false);
      expect(stdout.pendingCount()).toBe(1);

      stdout.completeNext();

      await expect(sendPromise).resolves.toBeUndefined();
      await expect(flushPromise).resolves.toBeUndefined();
      expect(flushResolved).toBe(true);
    });
  });

  it('waits for an active fallback send before resolving flush', async () => {
    const stdout = createDeferredStdoutWrite();

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });
      const sendPromise = dispatcher.send('payload');

      await waitForSetImmediate();
      expect(stdout.pendingCount()).toBe(1);

      const flushPromise = dispatcher.flush();
      let flushResolved = false;

      void flushPromise.then(() => {
        flushResolved = true;
      });

      await Promise.resolve();
      expect(flushResolved).toBe(false);

      stdout.completeNext();

      await expect(sendPromise).resolves.toBeUndefined();
      await expect(flushPromise).resolves.toBeUndefined();
    });
  });

  it('waits for migrated fallback sends before resolving a pending shutdown after worker crash', async () => {
    class ShutdownCrashingWorker extends MockWorker {
      public override postMessage = vi.fn((message: { id: number; type: string }) => {
        if (message.type === 'shutdown') {
          this.emit('error', new Error('worker crashed'));
        }
      });
    }

    const worker = new ShutdownCrashingWorker();
    const stdout = createDeferredStdoutWrite();

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });
      const sendPromise = dispatcher.send('payload');
      const shutdownPromise = dispatcher.shutdown();
      let shutdownResolved = false;

      void shutdownPromise.then(() => {
        shutdownResolved = true;
      });

      await waitForSetImmediate();
      expect(shutdownResolved).toBe(false);
      expect(stdout.pendingCount()).toBe(1);

      stdout.completeNext();

      await expect(sendPromise).resolves.toBeUndefined();
      await expect(shutdownPromise).resolves.toBeUndefined();
    });
  });

  it('waits for an active fallback send before resolving shutdown', async () => {
    const stdout = createDeferredStdoutWrite();

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });
      const sendPromise = dispatcher.send('payload');

      await waitForSetImmediate();
      expect(stdout.pendingCount()).toBe(1);

      const shutdownPromise = dispatcher.shutdown();
      let shutdownResolved = false;

      void shutdownPromise.then(() => {
        shutdownResolved = true;
      });

      await Promise.resolve();
      expect(shutdownResolved).toBe(false);

      stdout.completeNext();

      await expect(sendPromise).resolves.toBeUndefined();
      await expect(shutdownPromise).resolves.toBeUndefined();
    });
  });

  it('falls back to main-thread dispatch after a worker error', async () => {
    class ErroringWorker extends MockWorker {
      private sentCount = 0;

      public override postMessage = vi.fn((message: { id: number; type: string }) => {
        this.sentCount += 1;
        this.emit('message', { id: message.id });

        if (this.sentCount === 1) {
          this.emit('error', new Error('worker crashed'));
        }
      });
    }

    const worker = new ErroringWorker();
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveTestConfig(),
        encryption: null
      });

      await dispatcher.send('first');
      await dispatcher.send('second');
      await dispatcher.flush();
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).toHaveBeenCalled();
  });
});

describe('DeadLetterStore', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { DeadLetterStore } = await import('../../src/transport/dead-letter-store');

  function tmpPath(): string {
    return path.join(os.tmpdir(), `errorcore-dl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends and drains payloads', () => {
    const filePath = tmpPath();
    const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

    store.appendPayloadSync('{"test":1}');
    store.appendPayloadSync('{"test":2}');

    expect(store.hasPending()).toBe(true);

    const payloads = store.drain();

    expect(payloads.entries.map((entry) => entry.payload)).toEqual([
      '{"test":1}',
      '{"test":2}'
    ]);

    store.clear();
    expect(store.hasPending()).toBe(false);
  });

  it('returns empty array from drain when no file exists', () => {
    const store = new DeadLetterStore(tmpPath(), { integrityKey: 'test-secret' });

    expect(store.drain()).toEqual({ entries: [], lineCount: 0 });
    expect(store.hasPending()).toBe(false);
  });

  it('clear removes the file', () => {
    const filePath = tmpPath();
    const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

    store.appendPayloadSync('payload');
    store.clear();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects malformed or tampered dead-letter entries', () => {
    const filePath = tmpPath();
    const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

    store.appendPayloadSync('{"safe":true}');
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        kind: 'payload',
        storedAt: new Date().toISOString(),
        payload: '{"forged":true}',
        mac: 'invalid'
      }) + '\n'
    );

    expect(store.drain().entries.map((entry) => entry.payload)).toEqual(['{"safe":true}']);

    store.clear();
  });

  it('rejects plaintext dead-letter entries when encrypted storage is required', () => {
    const filePath = tmpPath();
    const store = new DeadLetterStore(filePath, {
      integrityKey: 'test-secret',
      requireEncryptedPayload: true
    });

    store.appendPayloadSync('{"not":"encrypted"}');

    expect(store.drain().entries).toEqual([]);

    store.clear();
  });

  it('drops payloads whose UTF-8 byte size exceeds the configured dead-letter limit', () => {
    const filePath = tmpPath();
    const store = new DeadLetterStore(filePath, {
      integrityKey: 'test-secret',
      maxPayloadBytes: 4
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.appendPayloadSync('🙂🙂');

    expect(store.drain().entries).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ErrorCore] Dead-letter payload exceeds maximum size; dropping payload'
    );
  });

  it('rejects replay of signed dead-letter entries that exceed the UTF-8 byte limit', () => {
    const filePath = tmpPath();
    const writer = new DeadLetterStore(filePath, {
      integrityKey: 'test-secret',
      maxPayloadBytes: 64
    });
    const reader = new DeadLetterStore(filePath, {
      integrityKey: 'test-secret',
      maxPayloadBytes: 4
    });

    writer.appendPayloadSync('🙂🙂');

    expect(reader.drain().entries).toEqual([]);

    writer.clear();
  });

  describe('getPendingCount', () => {
    it('returns 0 on a fresh store with no backing file', () => {
      const store = new DeadLetterStore(tmpPath(), { integrityKey: 'test-secret' });

      expect(store.getPendingCount()).toBe(0);
    });

    it('increments on successful appendPayloadSync', () => {
      const filePath = tmpPath();
      const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

      store.appendPayloadSync('{"a":1}');
      store.appendPayloadSync('{"a":2}');
      store.appendPayloadSync('{"a":3}');

      expect(store.getPendingCount()).toBe(3);

      store.clear();
    });

    it('does not count failure markers as pending payloads', () => {
      const filePath = tmpPath();
      const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

      store.appendPayloadSync('{"p":1}');
      store.appendFailureMarkerSync('capture_failed');
      store.appendFailureMarkerSync('capture_failed');

      expect(store.getPendingCount()).toBe(1);

      store.clear();
    });

    it('returns 0 after clear()', () => {
      const filePath = tmpPath();
      const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

      store.appendPayloadSync('{"p":1}');
      store.appendPayloadSync('{"p":2}');

      expect(store.getPendingCount()).toBe(2);

      store.clear();

      expect(store.getPendingCount()).toBe(0);
    });

    it('reflects the surviving line count after clearSent drains a prefix', () => {
      const filePath = tmpPath();
      const store = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

      store.appendPayloadSync('{"p":1}');
      store.appendPayloadSync('{"p":2}');
      store.appendPayloadSync('{"p":3}');

      expect(store.getPendingCount()).toBe(3);

      store.clearSent(2);

      expect(store.getPendingCount()).toBe(1);

      store.clear();
    });

    it('lazy-initializes by scanning an existing file from a previous process', () => {
      const filePath = tmpPath();
      const writer = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });
      writer.appendPayloadSync('{"a":1}');
      writer.appendPayloadSync('{"a":2}');

      const reader = new DeadLetterStore(filePath, { integrityKey: 'test-secret' });

      expect(reader.getPendingCount()).toBe(2);

      reader.clear();
    });
  });
});
