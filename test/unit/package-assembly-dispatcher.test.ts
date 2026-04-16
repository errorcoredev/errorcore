import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ErrorPackageParts,
  PackageAssemblyResult,
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerResponse
} from '../../src/types';
import { resolveTestConfig } from '../helpers/test-config';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync)
  };
});

import { existsSync } from 'node:fs';
import { PackageAssemblyDispatcher } from '../../src/capture/package-assembly-dispatcher';

const mockedExistsSync = vi.mocked(existsSync);

class MockWorker extends EventEmitter {
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn(async () => 1);
}

interface WorkerFactory {
  create(filename: string, workerData: PackageAssemblyWorkerData): MockWorker;
}

function createMockFactory(worker: MockWorker): WorkerFactory {
  return { create: vi.fn(() => worker) };
}

function createStubParts(): ErrorPackageParts {
  return {
    error: {
      type: 'Error',
      message: 'test error',
      stack: 'Error: test error\n    at test',
      properties: {}
    },
    localVariables: null,
    ioTimeline: [],
    evictionLog: [],
    stateReads: [],
    concurrentRequests: [],
    processMetadata: {
      pid: 1,
      ppid: 0,
      title: 'node',
      argv: [],
      execPath: '/usr/bin/node',
      nodeVersion: '20.0.0',
      platform: 'linux',
      arch: 'x64',
      memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      uptime: 0,
      cwd: '/'
    },
    timeAnchor: { wallTime: Date.now(), hrTime: 0n },
    codeVersion: {},
    environment: {},
    ioEventsDropped: 0,
    captureFailures: [],
    alsContextAvailable: false,
    stateTrackingEnabled: false,
    usedAmbientEvents: false
  } as unknown as ErrorPackageParts;
}

const assemblyResult: PackageAssemblyResult = {
  packageObject: {} as PackageAssemblyResult['packageObject'],
  payload: '{"test":true}'
};

describe('PackageAssemblyDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('with workerFactory', () => {
    it('isAvailable returns true after construction', () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();

      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      expect(dispatcher.isAvailable()).toBe(true);
      expect(factory.create).toHaveBeenCalledWith(
        'virtual-package-assembly-worker',
        expect.objectContaining({ config: expect.any(Object) })
      );
    });

    it('assemble resolves when the worker responds with a result', async () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      worker.postMessage.mockImplementation((message: { id: number }) => {
        const response: PackageAssemblyWorkerResponse = {
          id: message.id,
          result: assemblyResult
        };
        process.nextTick(() => worker.emit('message', response));
      });

      const result = await dispatcher.assemble(createStubParts());
      expect(result).toEqual(assemblyResult);
    });

    it('assemble rejects when the worker responds with an error', async () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      worker.postMessage.mockImplementation((message: { id: number }) => {
        const response: PackageAssemblyWorkerResponse = {
          id: message.id,
          error: 'assembly failed'
        };
        process.nextTick(() => worker.emit('message', response));
      });

      await expect(dispatcher.assemble(createStubParts())).rejects.toThrow('assembly failed');
    });

    it('assemble rejects when the worker responds with no result', async () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      worker.postMessage.mockImplementation((message: { id: number }) => {
        const response: PackageAssemblyWorkerResponse = { id: message.id };
        process.nextTick(() => worker.emit('message', response));
      });

      await expect(dispatcher.assemble(createStubParts())).rejects.toThrow(
        'Package assembly worker returned no result'
      );
    });

    it('assemble rejects after timeout', async () => {
      vi.useFakeTimers();

      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      const promise = dispatcher.assemble(createStubParts(), { timeoutMs: 100 });

      vi.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow('Package assembly worker timed out');
    });

    it('worker error event rejects all pending requests and marks unavailable', async () => {
      vi.useFakeTimers();

      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      const promise1 = dispatcher.assemble(createStubParts(), { timeoutMs: 10000 });
      const promise2 = dispatcher.assemble(createStubParts(), { timeoutMs: 10000 });

      const workerError = new Error('worker crashed');
      worker.emit('error', workerError);

      await expect(promise1).rejects.toThrow('worker crashed');
      await expect(promise2).rejects.toThrow('worker crashed');
      expect(dispatcher.isAvailable()).toBe(false);
    });

    it('worker exit with non-zero code rejects pending requests', async () => {
      vi.useFakeTimers();

      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      const promise = dispatcher.assemble(createStubParts(), { timeoutMs: 10000 });

      worker.emit('exit', 1);

      await expect(promise).rejects.toThrow('Package assembly worker exited with code 1');
      expect(dispatcher.isAvailable()).toBe(false);
    });

    it('worker exit with code 0 during shutdown does not reject', async () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      worker.postMessage.mockImplementation((message: { id: number; type: string }) => {
        if (message.type === 'shutdown') {
          const response: PackageAssemblyWorkerResponse = { id: message.id };
          process.nextTick(() => {
            worker.emit('message', response);
            worker.emit('exit', 0);
          });
        }
      });

      await dispatcher.shutdown();
      expect(dispatcher.isAvailable()).toBe(false);
    });

    it('rejects in-flight assemble promises when the worker exits cleanly during shutdown', async () => {
      // Regression: the previous exit handler gated rejection on
      // !shuttingDown && code !== 0. If shutdown began while an assemble
      // was still in flight, and the worker exited with code 0, the
      // assemble promise hung forever. The fix: always reject pending
      // requests on exit.
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      // Swallow the 'assemble' message so the promise stays pending.
      worker.postMessage.mockImplementation((message: { id: number; type: string }) => {
        if (message.type === 'shutdown') {
          process.nextTick(() => {
            worker.emit('message', { id: message.id });
            worker.emit('exit', 0);
          });
        }
      });

      const inflight = dispatcher.assemble(createStubParts(), { timeoutMs: 10000 });
      await dispatcher.shutdown();

      await expect(inflight).rejects.toThrow(/Package assembly worker exited with code 0/);
    });

    describe('shutdown', () => {
      it('sends a shutdown message to the worker', async () => {
        const worker = new MockWorker();
        const factory = createMockFactory(worker);
        const config = resolveTestConfig();
        const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

        worker.postMessage.mockImplementation((message: { id: number; type: string }) => {
          if (message.type === 'shutdown') {
            process.nextTick(() => {
              worker.emit('message', { id: message.id });
              worker.emit('exit', 0);
            });
          }
        });

        await dispatcher.shutdown();

        expect(worker.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'shutdown' })
        );
        expect(dispatcher.isAvailable()).toBe(false);
      });

      it('terminates the worker on shutdown timeout', async () => {
        vi.useFakeTimers();

        const worker = new MockWorker();
        const factory = createMockFactory(worker);
        const config = resolveTestConfig();
        const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

        // Worker never responds to shutdown message
        const shutdownPromise = dispatcher.shutdown({ timeoutMs: 100 });

        vi.advanceTimersByTime(100);

        await shutdownPromise;

        expect(worker.terminate).toHaveBeenCalled();
        expect(dispatcher.isAvailable()).toBe(false);
      });

      it('is a no-op when worker is already null', async () => {
        const worker = new MockWorker();
        const factory = createMockFactory(worker);
        const config = resolveTestConfig();
        const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

        // Force the worker to become null via error event
        worker.emit('error', new Error('force null'));

        expect(dispatcher.isAvailable()).toBe(false);
        await dispatcher.shutdown();
        // Should complete without error
      });
    });
  });

  describe('without workerFactory', () => {
    it('is unavailable when worker file does not exist', () => {
      mockedExistsSync.mockReturnValue(false);

      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config });

      expect(dispatcher.isAvailable()).toBe(false);
    });
  });

  describe('assemble when unavailable', () => {
    it('rejects immediately if worker is not available', async () => {
      const worker = new MockWorker();
      const factory = createMockFactory(worker);
      const config = resolveTestConfig();
      const dispatcher = new PackageAssemblyDispatcher({ config, workerFactory: factory });

      // Force unavailable via error
      worker.emit('error', new Error('crash'));

      await expect(dispatcher.assemble(createStubParts())).rejects.toThrow(
        'Package assembly worker unavailable'
      );
    });
  });
});
