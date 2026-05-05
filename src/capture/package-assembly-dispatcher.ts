
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ErrorPackageParts,
  PackageAssemblyResult,
  PackageAssemblyEncryptionConfig,
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

  // Bound at 2**31 - 1 so the counter never collides with a 53-bit
  // safe-integer edge. nextRequestId() wraps before issuing and skips
  // any id still live in pending; under normal load pending holds at
  // most a few dozen entries so the linear probe is O(1) in practice.
  private static readonly REQUEST_ID_MAX = 0x7fffffff;

  private nextRequestId(): number {
    // Try up to pending.size + 1 candidates; that bounds the probe.
    for (let probe = 0; probe <= this.pending.size; probe += 1) {
      this.requestId += 1;
      if (this.requestId > PackageAssemblyDispatcher.REQUEST_ID_MAX) {
        this.requestId = 1;
      }
      if (!this.pending.has(this.requestId)) {
        return this.requestId;
      }
    }
    // Pathological: every probed id is live. Take a new slot at the
    // top of the counter and accept the collision risk.
    throw new Error('Package assembly worker has too many in-flight requests');
  }

  private readonly pending = new Map<number, PendingRequest>();

  private available = false;

  private shuttingDown = false;

  public constructor(input: {
    config: ResolvedConfig;
    encryption?: PackageAssemblyEncryptionConfig;
    workerFactory?: WorkerFactory;
  }) {
    this.workerFactory = input.workerFactory;
    this.workerData = {
      config: createWorkerConfig(input.config),
      ...(input.encryption === undefined ? {} : { encryption: input.encryption })
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
    const id = this.nextRequestId();

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
    const id = this.nextRequestId();

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
        // Validate message shape before touching pending. A malformed
        // message with missing/non-numeric id would otherwise call
        // pending.get(undefined) and miss silently, hiding the bug.
        if (
          typeof message !== 'object' ||
          message === null ||
          typeof (message as { id?: unknown }).id !== 'number'
        ) {
          return;
        }
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
        // Always reject in-flight requests on exit. The previous code
        // only rejected when !shuttingDown && code !== 0, which left
        // pending promises hanging forever if the worker exited with
        // code 0 during shutdown while requests were still in flight.
        if (this.pending.size > 0) {
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
