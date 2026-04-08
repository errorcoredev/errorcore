
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ErrorPackageParts,
  PackageAssemblyResult,
  PackageAssemblyWorkerConfig,
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerRequest,
  PackageAssemblyWorkerResponse,
  ResolvedConfig
} from '../types';

interface WorkerLike {
  postMessage(message: PackageAssemblyWorkerRequest): void;
  on(event: 'message', listener: (message: PackageAssemblyWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface WorkerFactory {
  create(filename: string, workerData: PackageAssemblyWorkerData): WorkerLike;
}

interface PendingRequest {
  resolve: (result: PackageAssemblyResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  expectsResult: boolean;
}

interface WorkerThreadsModule {
  Worker: new (
    filename: string,
    options: { workerData: PackageAssemblyWorkerData }
  ) => WorkerLike;
}

function getWorkerThreads(): WorkerThreadsModule {
  return require('node:worker_threads') as WorkerThreadsModule;
}

function createWorkerConfig(config: ResolvedConfig): PackageAssemblyWorkerConfig {
  return {
    ...config,
    piiScrubber: undefined
  };
}

function resolveWorkerEntryPath(): string | null {
  const compiledPath = join(__dirname, 'package-assembly-worker.js');
  return existsSync(compiledPath) ? compiledPath : null;
}

export class PackageAssemblyDispatcher {
  private readonly workerFactory?: WorkerFactory;

  private readonly workerData: PackageAssemblyWorkerData;

  private worker: WorkerLike | null = null;

  private requestId = 0;

  private readonly pending = new Map<number, PendingRequest>();

  private available = false;

  private shuttingDown = false;

  public constructor(input: { config: ResolvedConfig; workerFactory?: WorkerFactory }) {
    this.workerFactory = input.workerFactory;
    this.workerData = {
      config: createWorkerConfig(input.config)
    };
    this.initializeWorker();
  }

  public isAvailable(): boolean {
    return this.available && this.worker !== null;
  }

  public assemble(
    parts: ErrorPackageParts,
    options?: { timeoutMs?: number }
  ): Promise<PackageAssemblyResult> {
    if (this.worker === null || !this.available) {
      return Promise.reject(new Error('Package assembly worker unavailable'));
    }

    const timeoutMs = options?.timeoutMs ?? 5000;
    const id = ++this.requestId;

    return new Promise<PackageAssemblyResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Package assembly worker timed out'));
      }, timeoutMs);
      timeout.unref();

      this.pending.set(id, { resolve, reject, timeout, expectsResult: true });
      this.worker?.postMessage({
        id,
        type: 'assemble',
        parts
      });
    });
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.shuttingDown = true;

    if (this.worker === null) {
      return;
    }

    const timeoutMs = options?.timeoutMs ?? 5000;
    const id = ++this.requestId;

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Package assembly worker shutdown timed out'));
        }, timeoutMs);
        timeout.unref();

        this.pending.set(id, {
          resolve: () => resolve(undefined),
          reject,
          timeout,
          expectsResult: false
        });
        this.worker?.postMessage({ id, type: 'shutdown' });
      }).catch(async () => {
        await this.worker?.terminate();
      }),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          void this.worker?.terminate().finally(() => resolve());
        }, timeoutMs);
        timeout.unref();
      })
    ]);

    this.available = false;
    this.worker = null;
  }

  private initializeWorker(): void {
    try {
      if (this.workerFactory !== undefined) {
        this.worker = this.workerFactory.create('virtual-package-assembly-worker', this.workerData);
      } else {
        const workerEntry = resolveWorkerEntryPath();

        if (workerEntry === null) {
          this.available = false;
          return;
        }

        const workerThreads = getWorkerThreads();
        this.worker = new workerThreads.Worker(workerEntry, {
          workerData: this.workerData
        });
      }

      this.worker.on('message', (message) => {
        const pending = this.pending.get(message.id);

        if (pending === undefined) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(message.id);

        if ('error' in message) {
          pending.reject(new Error(message.error));
          return;
        }

        if (pending.expectsResult && (!('result' in message) || message.result === undefined)) {
          pending.reject(new Error('Package assembly worker returned no result'));
          return;
        }

        pending.resolve(message.result as PackageAssemblyResult);
      });

      this.worker.on('error', (error) => {
        this.failPending(error);
        this.available = false;
        this.worker = null;
      });

      this.worker.on('exit', (code) => {
        if (!this.shuttingDown && code !== 0) {
          this.failPending(new Error(`Package assembly worker exited with code ${code}`));
        }

        this.available = false;
        this.worker = null;
      });

      this.available = true;
    } catch {
      this.available = false;
      this.worker = null;
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
