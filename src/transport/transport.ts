
import type { ResolvedConfig } from '../types';
import type { Encryption } from '../security/encryption';
import { createDebug } from '../debug';
import { FileTransport } from './file-transport';
import { HttpTransport } from './http-transport';
import { StdoutTransport } from './stdout-transport';

const debug = createDebug('transport');

function isWebpackBundled(): boolean {
  try {
    return typeof __webpack_require__ !== 'undefined';
  } catch {
    return false;
  }
}

declare const __webpack_require__: unknown;

interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (
    filename: string,
    options: { eval: true; workerData: unknown }
  ) => WorkerLike;
}

interface SyncCapableTransport extends Transport {
  sendSync?(payload: string): void;
}

interface PendingRequest {
  type: 'send' | 'flush' | 'shutdown';
  payload?: string | Buffer;
  shutdownOptions?: { timeoutMs?: number };
  resolve: () => void;
  reject: (error: Error) => void;
}

interface QueueItem {
  payload: string | Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
}

function getWorkerThreads(): WorkerThreadsModule {
  return require('node:worker_threads') as WorkerThreadsModule;
}

function createWorkerConfig(config: ResolvedConfig): {
  transport:
    | { type: 'stdout' }
    | {
        type: 'file';
        path: string;
        maxSizeBytes?: number;
        maxBackups?: number;
      };
} {
  if (config.transport.type === 'stdout') {
    return {
      transport: { type: 'stdout' }
    };
  }

  if (config.transport.type === 'file') {
    return {
      transport: {
        type: 'file',
        path: config.transport.path,
        ...(config.transport.maxSizeBytes === undefined
          ? {}
          : { maxSizeBytes: config.transport.maxSizeBytes }),
        ...(config.transport.maxBackups === undefined
          ? {}
          : { maxBackups: config.transport.maxBackups })
      }
    };
  }

  throw new Error('HTTP transport runs on the main thread');
}

function createWorkerSource(): string {
  return `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const nodePath = require('node:path');

function cleanupOldBackups(filePath, maxBackups) {
  try {
    const dir = nodePath.dirname(filePath);
    const base = nodePath.basename(filePath);
    const prefix = base + '.';
    const suffix = '.bak';
    const files = fs.readdirSync(dir);
    const backups = files
      .filter(function(f) { return f.startsWith(prefix) && f.endsWith(suffix); })
      .sort()
      .reverse();
    for (var i = maxBackups; i < backups.length; i++) {
      try { fs.unlinkSync(nodePath.join(dir, backups[i])); } catch(e) {}
    }
  } catch(e) {}
}

function createTransport(config) {
  if (config.transport.type === 'stdout') {
    return {
      async send(payload) {
        await new Promise((resolve, reject) => {
          process.stdout.write(
            Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\\n')]) : payload + '\\n',
            (error) => error ? reject(error) : resolve()
          );
        });
      },
      async flush() {},
      async shutdown() {}
    };
  }

  if (config.transport.type === 'file') {
    const filePath = config.transport.path;
    const maxSizeBytes = config.transport.maxSizeBytes ?? 100 * 1024 * 1024;
    const maxBackups = config.transport.maxBackups ?? 5;

    return {
      async send(payload) {
        const stats = await new Promise((resolve) => {
          fs.stat(filePath, (error, value) => resolve(error ? null : value));
        });

        if (stats && stats.size > maxSizeBytes) {
          await new Promise((resolve, reject) => {
            fs.rename(filePath, filePath + '.' + Date.now() + '.bak', (error) => error ? reject(error) : resolve());
          });
          cleanupOldBackups(filePath, maxBackups);
        }

        await new Promise((resolve, reject) => {
          fs.appendFile(
            filePath,
            Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\\n')]) : payload + '\\n',
            (error) => error ? reject(error) : resolve()
          );
        });
      },
      async flush() {},
      async shutdown() {}
    };
  }

  throw new Error('HTTP transport is not supported in local-only mode');
}

const transport = createTransport(workerData.config);

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'send') {
      await transport.send(message.payload);
      parentPort.postMessage({ id: message.id });
      return;
    }

    if (message.type === 'flush') {
      await transport.flush();
      parentPort.postMessage({ id: message.id });
      return;
    }

    if (message.type === 'shutdown') {
      await transport.shutdown();
      parentPort.postMessage({ id: message.id });
      parentPort.close();
      return;
    }
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;
}

function createTransport(
  config: ResolvedConfig,
  transportAuthorization?: string
): SyncCapableTransport {
  if (config.transport.type === 'stdout') {
    return new StdoutTransport();
  }

  if (config.transport.type === 'file') {
    return new FileTransport(config.transport);
  }

  if (config.transport.type === 'http') {
    return new HttpTransport({
      url: config.transport.url,
      authorization: transportAuthorization,
      timeoutMs: config.transport.timeoutMs,
      allowPlainHttpTransport: config.allowPlainHttpTransport,
      allowInvalidCollectorCertificates: config.allowInvalidCollectorCertificates
    });
  }

  throw new Error(`Unsupported transport type: ${(config.transport as { type: string }).type}`);
}

/**
 * Transport behavioral contract.
 *
 * send():     Resolves when the payload has been accepted by the transport layer.
 *             For file: data written to OS buffer. For HTTP: 2xx received.
 *             MUST reject on failure so the caller can attempt dead-letter.
 *
 * flush():    Resolves when ALL previously sent payloads are durably stored.
 *             For file: fsync completed. For HTTP: all in-flight requests resolved.
 *             For stdout: no-op is acceptable (stdout is line-buffered).
 *             MUST NOT resolve until prior data is durable.
 *
 * shutdown(): Resolves when transport resources (sockets, file handles) are released.
 *             Implementations should implicitly flush before releasing.
 */
export interface Transport {
  send(payload: string | Buffer): Promise<void>;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

const MAX_FALLBACK_QUEUE_SIZE = 1000;
const MAX_FALLBACK_FLUSH_RESOLVERS = 100;

export class TransportDispatcher implements Transport {
  private readonly config: ResolvedConfig;

  private readonly encryption: Encryption | null;

  private readonly transportAuthorization: string | undefined;

  private worker: WorkerLike | null = null;

  private requestId = 0;

  private readonly pending = new Map<number, PendingRequest>();

  private fallbackTransport: SyncCapableTransport | null = null;

  private fallbackQueue: QueueItem[] = [];

  private fallbackFlushResolvers: Array<() => void> = [];

  private fallbackScheduled = false;

  private fallbackActive = false;

  private fallbackShutdownPromise: Promise<void> | null = null;

  private shuttingDown = false;

  public constructor(input: {
    config: ResolvedConfig;
    encryption: Encryption | null;
    transportAuthorization?: string;
  }) {
    this.config = input.config;
    this.encryption = input.encryption;
    this.transportAuthorization = input.transportAuthorization;
    this.initializeWorker();
  }

  public async send(payload: string | Buffer): Promise<void> {
    debug(`send() called, worker=${this.worker !== null ? 'active' : 'null'}`);

    if (this.worker !== null) {
      return this.dispatchToWorker('send', payload);
    }

    return this.enqueueFallback(payload);
  }

  public async flush(): Promise<void> {
    if (this.worker !== null) {
      return this.dispatchToWorker('flush');
    }

    await this.flushFallback();
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.shuttingDown = true;

    if (this.worker === null) {
      await this.performFallbackShutdown(options);
      return;
    }

    const timeoutMs = options?.timeoutMs ?? 5000;

    await Promise.race([
      this.dispatchToWorker('shutdown', undefined, options),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          void this.worker?.terminate().finally(() => resolve());
        }, timeoutMs);

        timeout.unref();
      })
    ]);
  }

  public sendSync(payload: string): void {
    const transport =
      this.fallbackTransport ??
      createTransport(this.config, this.transportAuthorization);

    transport.sendSync?.(payload);
    void this.encryption;
  }

  private initializeWorker(): void {
    if (this.config.serverless) {
      debug('Serverless mode, skipping worker thread');
      this.fallbackToMainThread();
      return;
    }

    if (this.config.transport.type === 'http') {
      debug('HTTP transport runs on main thread, skipping worker');
      this.fallbackToMainThread();
      return;
    }

    if (isWebpackBundled()) {
      debug('Webpack environment detected, skipping worker threads (eval:true is unreliable in bundlers)');
      console.warn('[ErrorCore] Bundled environment detected — using main-thread transport (worker threads disabled).');
      this.fallbackToMainThread();
      return;
    }

    try {
      const workerThreads = getWorkerThreads();
      const worker = new workerThreads.Worker(createWorkerSource(), {
        eval: true,
        workerData: {
          config: createWorkerConfig(this.config)
        }
      });

      worker.on('message', (message) => {
        const response = message as { id: number; error?: string };
        const pending = this.pending.get(response.id);

        if (pending === undefined) {
          return;
        }

        this.pending.delete(response.id);

        if (response.error !== undefined) {
          pending.reject(new Error(response.error));
          return;
        }

        pending.resolve();
      });

      worker.on('error', () => {
        this.fallbackToMainThread(new Error('Transport worker failed'));
      });

      worker.on('exit', (code) => {
        if (!this.shuttingDown && code !== 0) {
          this.fallbackToMainThread(new Error(`Transport worker exited with code ${code}`));
        }
      });

      debug('Worker thread initialized successfully');
      this.worker = worker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug(`Worker init failed, falling back to main thread: ${message}`);
      console.warn(`[ErrorCore] Worker thread init failed, using main-thread transport: ${message}`);
      this.fallbackToMainThread();
    }
  }

  private fallbackToMainThread(error?: Error): void {
    this.worker = null;

    try {
      this.ensureFallbackTransport();
    } catch (fallbackError) {
      this.rejectPending(
        fallbackError instanceof Error
          ? fallbackError
          : new Error(String(fallbackError))
      );
      return;
    }

    const pending = [...this.pending.values()];
    this.pending.clear();

    if (pending.length === 0) {
      return;
    }

    const shutdownOperations: PendingRequest[] = [];

    for (const operation of pending) {
      if (operation.type === 'send' && operation.payload !== undefined) {
        this.fallbackQueue.push({
          payload: operation.payload,
          resolve: operation.resolve,
          reject: operation.reject
        });
        continue;
      }

      if (operation.type === 'flush') {
        this.fallbackFlushResolvers.push(operation.resolve);
        continue;
      }

      if (operation.type === 'shutdown') {
        shutdownOperations.push(operation);
        continue;
      }

      operation.reject(error ?? new Error('Transport worker became unavailable'));
    }

    if (this.fallbackQueue.length > 0) {
      this.scheduleFallbackProcessing();
    } else {
      this.resolveFallbackWaitersIfIdle();
    }

    for (const operation of shutdownOperations) {
      void this.performFallbackShutdown(operation.shutdownOptions).then(
        operation.resolve,
        (shutdownError) => {
          operation.reject(
            shutdownError instanceof Error
              ? shutdownError
              : new Error(String(shutdownError))
          );
        }
      );
    }
  }

  private dispatchToWorker(
    type: 'send' | 'flush' | 'shutdown',
    payload?: string | Buffer,
    shutdownOptions?: { timeoutMs?: number }
  ): Promise<void> {
    if (this.worker === null) {
      return type === 'send' && payload !== undefined
        ? this.enqueueFallback(payload)
        : type === 'shutdown'
          ? this.performFallbackShutdown(shutdownOptions)
          : this.flushFallback();
    }

    const id = ++this.requestId;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        type,
        ...(payload === undefined ? {} : { payload }),
        ...(shutdownOptions === undefined ? {} : { shutdownOptions }),
        resolve,
        reject
      });

      try {
        this.worker?.postMessage({ id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private enqueueFallback(payload: string | Buffer): Promise<void> {
    this.ensureFallbackTransport();

    return new Promise<void>((resolve, reject) => {
      // Drop the oldest queued item to stay within bounds. This preserves
      // the most recent errors which are more likely to be actionable.
      if (this.fallbackQueue.length >= MAX_FALLBACK_QUEUE_SIZE) {
        const evicted = this.fallbackQueue.shift();
        evicted?.reject(new Error('Transport fallback queue overflow; oldest payload evicted'));
      }

      this.fallbackQueue.push({ payload, resolve, reject });
      this.scheduleFallbackProcessing();
    });
  }

  private scheduleFallbackProcessing(): void {
    if (this.fallbackScheduled || this.fallbackActive) {
      return;
    }

    this.fallbackScheduled = true;

    setImmediate(() => {
      void this.processFallbackQueue();
    });
  }

  private async processFallbackQueue(): Promise<void> {
    this.fallbackScheduled = false;

    while (this.fallbackQueue.length > 0) {
      const item = this.fallbackQueue.shift();

      if (item === undefined) {
        continue;
      }

      try {
        this.fallbackActive = true;
        await this.fallbackTransport?.send(item.payload);
        item.resolve();
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.fallbackActive = false;
      }
    }

    this.resolveFallbackWaitersIfIdle();
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private ensureFallbackTransport(): SyncCapableTransport {
    if (this.fallbackTransport === null) {
      this.fallbackTransport = createTransport(
        this.config,
        this.transportAuthorization
      );
    }

    return this.fallbackTransport;
  }

  private isFallbackIdle(): boolean {
    return !this.fallbackScheduled && !this.fallbackActive && this.fallbackQueue.length === 0;
  }

  private async flushFallback(): Promise<void> {
    if (this.isFallbackIdle()) {
      return;
    }

    if (this.fallbackFlushResolvers.length >= MAX_FALLBACK_FLUSH_RESOLVERS) {
      throw new Error('Too many concurrent flush() calls; transport may be stalled');
    }

    await new Promise<void>((resolve) => {
      this.fallbackFlushResolvers.push(resolve);
    });
  }

  private resolveFallbackWaitersIfIdle(): void {
    if (!this.isFallbackIdle()) {
      return;
    }

    while (this.fallbackFlushResolvers.length > 0) {
      this.fallbackFlushResolvers.shift()?.();
    }
  }

  private performFallbackShutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.fallbackShutdownPromise !== null) {
      return this.fallbackShutdownPromise;
    }

    this.ensureFallbackTransport();
    this.fallbackShutdownPromise = (async () => {
      await this.flushFallback();
      await this.fallbackTransport?.shutdown(options);
    })();

    return this.fallbackShutdownPromise;
  }
}
