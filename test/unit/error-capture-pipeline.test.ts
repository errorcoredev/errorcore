import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Scrubber } from '../../src/pii/scrubber';
import { Encryption } from '../../src/security/encryption';
import { RateLimiter } from '../../src/security/rate-limiter';
import { ALSManager } from '../../src/context/als-manager';
import { RequestTracker } from '../../src/context/request-tracker';
import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import {
  buildPackageAssemblyResult,
  finalizePackageAssemblyResult,
  PackageBuilder
} from '../../src/capture/package-builder';
import { PackageAssemblyDispatcher } from '../../src/capture/package-assembly-dispatcher';
import { ProcessMetadata } from '../../src/capture/process-metadata';
import { ErrorCapturer } from '../../src/capture/error-capturer';
import { DeadLetterStore } from '../../src/transport/dead-letter-store';
import { TransportDispatcher } from '../../src/transport/transport';
import type {
  ErrorPackageParts,
  IOEventSlot,
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerRequest,
  PackageAssemblyWorkerResponse,
  RequestContext
} from '../../src/types';
import { SourceMapResolver } from '../../src/capture/source-map-resolver';
import { resolveTestConfig as resolveConfig } from '../helpers/test-config';

const require = createRequire(import.meta.url);
const nodeModule = require('node:module') as typeof import('node:module');
const fsModule = require('node:fs') as typeof import('node:fs');
const osModule = require('node:os') as typeof import('node:os');
const pathModule = require('node:path') as typeof import('node:path');
const originalRequire = nodeModule.prototype.require;
const noopBodyCapture = {
  materializeSlotBodies: () => undefined,
  materializeContextBody: () => undefined
};

function withMissingWorkerThreads<T>(run: () => Promise<T> | T): Promise<T> | T {
  nodeModule.prototype.require = function patchedRequire(
    this: NodeJS.Module,
    request: string
  ) {
    if (request === 'node:worker_threads') {
      throw new Error('worker_threads unavailable');
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function withWorkerThreadsMock<T>(
  workerFactory: () => {
    postMessage(message: unknown): void;
    on(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
    terminate(): Promise<number>;
  },
  run: () => Promise<T> | T
): Promise<T> | T {
  nodeModule.prototype.require = function patchedRequire(
    this: NodeJS.Module,
    request: string
  ) {
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

function createSlot(overrides: Partial<IOEventSlot> = {}): IOEventSlot {
  return {
    seq: 1,
    phase: 'done',
    startTime: 1n,
    endTime: 2n,
    durationMs: 0.001,
    type: 'http-server',
    direction: 'inbound',
    requestId: 'req-1',
    contextLost: false,
    target: 'service.local',
    method: 'GET',
    url: '/resource',
    statusCode: 500,
    fd: 10,
    requestHeaders: { host: 'service.local' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    estimatedBytes: 256,
    ...overrides
  };
}

function createContext(als: ALSManager, requestId: string): RequestContext {
  const context = als.createRequestContext({
    method: 'POST',
    url: '/login',
    headers: { host: 'service.local' }
  });

  context.requestId = requestId;
  return context;
}

function createTimeoutStubs() {
  // ProcessMetadata's event-loop-lag measurement now uses setInterval
  // (previously setTimeout recursively rescheduled itself). The stub
  // spies on both setInterval and clearInterval and exposes the
  // captured callbacks via `timers`.
  const timers: Array<{ id: NodeJS.Timeout; fn: () => void; unref: ReturnType<typeof vi.fn> }> =
    [];
  const setTimeoutSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((fn: TimerHandler) => {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;

      timers.push({ id: timer, fn: fn as () => void, unref });
      return timer;
    }) as typeof setInterval);
  const clearTimeoutSpy = vi
    .spyOn(globalThis, 'clearInterval')
    .mockImplementation(() => undefined as never);

  return { timers, setTimeoutSpy, clearTimeoutSpy };
}

function createPackageParts(
  context: RequestContext | undefined,
  overrides: Partial<ErrorPackageParts> = {}
): ErrorPackageParts {
  return {
    error: {
      type: 'Error',
      message: 'boom',
      stack: 'Error: boom',
      properties: {}
    },
    localVariables: null,
    requestContext:
      context === undefined
        ? undefined
        : {
            requestId: context.requestId,
            startTime: context.startTime,
            method: context.method,
            url: context.url,
            headers: { ...context.headers },
            body: context.body,
            bodyTruncated: context.bodyTruncated
          },
    ioTimeline: [],
    evictionLog: [],
    stateReads: context?.stateReads ?? [],
    concurrentRequests: [],
    processMetadata: {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      hostname: '',
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 1,
      activeRequests: 1,
      eventLoopLagMs: 0
    },
    timeAnchor: {
      wallClockMs: Date.now(),
      hrtimeNs: process.hrtime.bigint().toString()
    },
    codeVersion: {},
    environment: {},
    ioEventsDropped: 0,
    captureFailures: [],
    alsContextAvailable: context !== undefined,
    stateTrackingEnabled: context !== undefined,
    usedAmbientEvents: context === undefined,
    ...overrides
  };
}

async function flushMicrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

async function waitForSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createDeferredStdoutWrite() {
  const writes: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];

  vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      callbacks.push(callback ?? (() => undefined));
      return true;
    }) as typeof process.stdout.write
  );

  return {
    writes,
    pendingCount: () => callbacks.length,
    completeNext(error?: Error) {
      callbacks.shift()?.(error ?? null);
    }
  };
}

function createTempDeadLetterPath(): string {
  return pathModule.join(
    osModule.tmpdir(),
    `errorcore-dead-letter-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`
  );
}

class FakeWorker {
  private readonly messageListeners: Array<(message: PackageAssemblyWorkerResponse) => void> = [];

  private readonly errorListeners: Array<(error: Error) => void> = [];

  private readonly exitListeners: Array<(code: number) => void> = [];

  public constructor(
    private readonly handler: (
      message: PackageAssemblyWorkerRequest,
      workerData: PackageAssemblyWorkerData
    ) => PackageAssemblyWorkerResponse
  ,
    private readonly workerData: PackageAssemblyWorkerData
  ) {}

  public postMessage(message: PackageAssemblyWorkerRequest): void {
    queueMicrotask(() => {
      try {
        const response = this.handler(message, this.workerData);
        for (const listener of this.messageListeners) {
          listener(response);
        }

        if (message.type === 'shutdown') {
          for (const listener of this.exitListeners) {
            listener(0);
          }
        }
      } catch (error) {
        const workerError = error instanceof Error ? error : new Error(String(error));
        for (const listener of this.errorListeners) {
          listener(workerError);
        }
      }
    });
  }

  public on(
    event: 'message' | 'error' | 'exit',
    listener: ((message: PackageAssemblyWorkerResponse) => void) |
      ((error: Error) => void) |
      ((code: number) => void)
  ): this {
    if (event === 'message') {
      this.messageListeners.push(listener as (message: PackageAssemblyWorkerResponse) => void);
    } else if (event === 'error') {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.exitListeners.push(listener as (code: number) => void);
    }

    return this;
  }

  public async terminate(): Promise<number> {
    for (const listener of this.exitListeners) {
      listener(0);
    }

    return 0;
  }
}

afterEach(() => {
  nodeModule.prototype.require = originalRequire;
});

describe('ProcessMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GIT_SHA;
    delete process.env.npm_package_version;
  });

  it('collects and caches startup metadata using env-based git sha', () => {
    process.env.GIT_SHA = 'env-sha';
    process.env.npm_package_version = '1.2.3';

    const metadata = new ProcessMetadata(resolveConfig({}));
    const startup = metadata.getStartupMetadata();

    expect(startup).toMatchObject({
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    });
    expect(metadata.getCodeVersion()).toEqual({
      gitSha: 'env-sha',
      packageVersion: '1.2.3'
    });
  });

  it('reads git sha from .git/HEAD when env vars are absent', () => {
    const originalReadFileSync = fsModule.readFileSync;

    fsModule.readFileSync = vi.fn((filePath: string, ...rest: unknown[]) => {
      if (typeof filePath === 'string' && filePath.includes('.git')) {
        if (filePath.endsWith('HEAD')) {
          return 'ref: refs/heads/main\n';
        }
        return 'ref-file-sha\n';
      }
      return originalReadFileSync.call(fsModule, filePath, ...rest);
    }) as typeof fsModule.readFileSync;

    try {
      const metadata = new ProcessMetadata(resolveConfig({}));

      expect(metadata.getCodeVersion().gitSha).toBe('ref-file-sha');
    } finally {
      fsModule.readFileSync = originalReadFileSync;
    }
  });

  it('collects fresh runtime metadata and measures event loop lag', () => {
    const timers = createTimeoutStubs();
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValueOnce(500).mockReturnValueOnce(1000).mockReturnValueOnce(2004);

    const metadata = new ProcessMetadata(resolveConfig({}));

    metadata.startEventLoopLagMeasurement();
    timers.timers[0]?.fn();

    const runtime = metadata.getRuntimeMetadata();

    expect(runtime.memoryUsage.rss).toBeGreaterThan(0);
    expect(runtime.uptime).toBeGreaterThanOrEqual(0);
    expect(runtime.eventLoopLagMs).toBe(4);
    expect(timers.setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(timers.timers[0]?.unref).toHaveBeenCalledTimes(1);
  });

  it('shutdown stops lag measurement', () => {
    const timers = createTimeoutStubs();
    const metadata = new ProcessMetadata(resolveConfig({}));

    metadata.startEventLoopLagMeasurement();
    metadata.shutdown();

    expect(timers.clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PackageBuilder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a scrubbed package with accurate completeness flags', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-1');

    context.url = '/login?email=user@example.com&token=secret-token';
    context.body = Buffer.from('email=user@example.com');
    context.bodyTruncated = true;
    context.stateReads.push({
      container: 'cache',
      operation: 'get',
      key: 'user',
      value: { token: 'secret-token' },
      timestamp: 1n
    });

    const pkg = builder.build({
      error: {
        type: 'Error',
        message: 'password leaked',
        stack: 'Error: password leaked',
        properties: { password: 'secret' }
      },
      localVariables: [
        {
          functionName: 'handler',
          filePath: '/app/src/handler.js',
          lineNumber: 1,
          columnNumber: 1,
          locals: { apiKey: 'secret-key' }
        }
      ],
      requestContext: context,
      ioTimeline: [
        createSlot({
          url: '/resource?apiKey=sk-secret',
          requestBody: Buffer.from('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'),
          responseBodyTruncated: true
        })
      ],
      evictionLog: [],
      stateReads: context.stateReads,
      concurrentRequests: [
        {
          requestId: 'req-2',
          method: 'GET',
          url: '/health',
          startTime: '1'
        }
      ],
      processMetadata: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        hostname: '',
        uptime: 1,
        memoryUsage: {
          rss: 1,
          heapTotal: 1,
          heapUsed: 1,
          external: 1,
          arrayBuffers: 1
        },
        activeHandles: 1,
        activeRequests: 1,
        eventLoopLagMs: 0
      },
      timeAnchor: { wallClockMs: Date.now(), hrtimeNs: process.hrtime.bigint().toString() },
      codeVersion: { gitSha: 'sha', packageVersion: '1.0.0' },
      environment: { NODE_ENV: 'test' },
      ioEventsDropped: 3,
      captureFailures: [],
      alsContextAvailable: true,
      stateTrackingEnabled: true,
      usedAmbientEvents: false
    });

    expect(pkg.schemaVersion).toBe('1.0.0');
    expect(new Date(pkg.capturedAt).toISOString()).toBe(pkg.capturedAt);
    expect(pkg.error.properties.password).toBe('[REDACTED]');
    expect(pkg.localVariables?.[0]?.locals.apiKey).toBe('[REDACTED]');
    expect(pkg.request?.body).toEqual({
      _type: 'Buffer',
      encoding: 'base64',
      data: expect.any(String),
      length: Buffer.from('email=user@example.com').length
    });
    expect(pkg.request?.url).toBe('/login?email=%5BREDACTED%5D&token=%5BREDACTED%5D');
    expect(pkg.ioTimeline[0]?.url).toBe('/resource?apiKey=%5BREDACTED%5D');
    expect(pkg.completeness).toMatchObject({
      requestCaptured: true,
      requestBodyTruncated: true,
      ioTimelineCaptured: true,
      ioEventsDropped: 3,
      ioPayloadsTruncated: 1,
      alsContextAvailable: true,
      localVariablesCaptured: true,
      stateTrackingEnabled: true,
      stateReadsCaptured: true,
      piiScrubbed: true,
      encrypted: false
    });
  });

  it('progressively sheds oversized payloads to stay under the UTF-8 byte size limit', () => {
    const config = resolveConfig({
      serialization: { maxTotalPackageSize: 1100 }
    });
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const hugeBuffer = Buffer.alloc(4096, 'a');
    const unicodePayload = '漢🙂'.repeat(512);

    const pkg = builder.build({
      error: {
        type: 'Error',
        message: 'boom',
        stack: 'Error: boom',
        properties: { detail: '漢🙂漢🙂' }
      },
      localVariables: null,
      requestContext: undefined,
      ioTimeline: [
        createSlot({
          requestId: null,
          requestBody: hugeBuffer,
          responseBody: hugeBuffer
        })
      ],
      evictionLog: [],
      stateReads: [
        {
          container: 'cache',
          operation: 'get',
          key: 'key',
          value: { large: unicodePayload },
          timestamp: 1n
        }
      ],
      concurrentRequests: [],
      processMetadata: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        hostname: '',
        uptime: 1,
        memoryUsage: {
          rss: 1,
          heapTotal: 1,
          heapUsed: 1,
          external: 1,
          arrayBuffers: 1
        },
        activeHandles: 1,
        activeRequests: 1,
        eventLoopLagMs: 0
      },
      timeAnchor: { wallClockMs: Date.now(), hrtimeNs: process.hrtime.bigint().toString() },
      codeVersion: {},
      environment: {},
      ioEventsDropped: 0,
      captureFailures: [],
      alsContextAvailable: false,
      stateTrackingEnabled: false,
      usedAmbientEvents: true
    });

    expect(Buffer.byteLength(JSON.stringify(pkg), 'utf8')).toBeLessThanOrEqual(
      config.serialization.maxTotalPackageSize
    );
    expect(pkg.ioTimeline).toEqual([]);
    expect(pkg.stateReads).toEqual([]);
  });

  it('produces the same package and payload shape through the shared assembly helper', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-assembly');

    context.body = Buffer.from('hello');
    const parts = createPackageParts(context, {
      ioTimeline: [createSlot({ requestBody: Buffer.from('body') })]
    });

    const inlineResult = finalizePackageAssemblyResult({
      packageObject: builder.build(parts),
      config
    });
    const sharedResult = buildPackageAssemblyResult({
      parts,
      config
    });

    expect(sharedResult.packageObject).toMatchObject({
      ...inlineResult.packageObject,
      capturedAt: expect.any(String),
      request: inlineResult.packageObject.request
        ? {
            ...inlineResult.packageObject.request,
            receivedAt: expect.any(String)
          }
        : undefined
    });
    expect(JSON.parse(sharedResult.payload)).toMatchObject({
      ...JSON.parse(inlineResult.payload),
      capturedAt: expect.any(String),
      request: inlineResult.packageObject.request
        ? {
            ...JSON.parse(inlineResult.payload).request,
            receivedAt: expect.any(String)
          }
        : undefined
    });
  });

  it('assembles packages through the dispatcher worker contract and shuts down cleanly', async () => {
    const config = resolveConfig({});
    const dispatcher = new PackageAssemblyDispatcher({
      config,
      workerFactory: {
        create: (_filename, workerData) =>
          new FakeWorker((message, data) => {
            if (message.type === 'shutdown') {
              return { id: message.id };
            }

            return {
              id: message.id,
              result: buildPackageAssemblyResult({
                parts: message.parts,
                config: data.config
              })
            };
          }, workerData)
      }
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-dispatch');
    const parts = createPackageParts(context, {
      ioTimeline: [createSlot({ requestBody: Buffer.from('dispatch') })]
    });

    const result = await dispatcher.assemble(parts);

    expect(result.packageObject.request?.id).toBe('req-dispatch');
    expect(JSON.parse(result.payload)).toMatchObject({
      schemaVersion: '1.0.0'
    });

    await dispatcher.shutdown();
  });

  it('does not mark locals as truncated when capture exactly matches maxLocalsFrames', () => {
    const config = resolveConfig({ maxLocalsFrames: 2 });
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const parts = createPackageParts(undefined, {
      localVariables: [
        {
          functionName: 'first',
          filePath: '/app/src/first.js',
          lineNumber: 1,
          columnNumber: 1,
          locals: { value: 1 }
        },
        {
          functionName: 'second',
          filePath: '/app/src/second.js',
          lineNumber: 2,
          columnNumber: 1,
          locals: { value: 2 }
        }
      ]
    });

    const pkg = builder.build(parts);

    expect(pkg.completeness.localVariablesCaptured).toBe(true);
    expect(pkg.completeness.localVariablesTruncated).toBe(false);
  });

  it('marks locals as truncated when captured frames exceed maxLocalsFrames', () => {
    const config = resolveConfig({ maxLocalsFrames: 2 });
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const parts = createPackageParts(undefined, {
      localVariables: [
        {
          functionName: 'first',
          filePath: '/app/src/first.js',
          lineNumber: 1,
          columnNumber: 1,
          locals: { value: 1 }
        },
        {
          functionName: 'second',
          filePath: '/app/src/second.js',
          lineNumber: 2,
          columnNumber: 1,
          locals: { value: 2 }
        },
        {
          functionName: 'third',
          filePath: '/app/src/third.js',
          lineNumber: 3,
          columnNumber: 1,
          locals: { value: 3 }
        }
      ]
    });

    const pkg = builder.build(parts);

    expect(pkg.completeness.localVariablesCaptured).toBe(true);
    expect(pkg.completeness.localVariablesTruncated).toBe(true);
  });

  it('Layer 3: marks alignment=full when local frames ≤ rendered stack frames', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({ scrubber: new Scrubber(config), config });
    const parts = createPackageParts(undefined, {
      error: {
        type: 'Error',
        message: 'boom',
        stack: 'Error: boom\n    at handler (/app/src/handler.js:10:5)\n    at process (/app/src/server.js:1:1)',
        properties: {}
      },
      localVariables: [
        { functionName: 'handler', filePath: '/app/src/handler.js', lineNumber: 10, columnNumber: 5, locals: { x: 1 } }
      ]
    });

    const pkg = builder.build(parts);

    // 2 rendered frames, 1 local variable frame → no trimming
    expect(pkg.localVariables).toHaveLength(1);
    expect(pkg.completeness.localVariablesFrameAlignment).toBe('full');
  });

  it('Layer 3: trims locals to rendered frame count and marks alignment=prefix_only', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({ scrubber: new Scrubber(config), config });
    const parts = createPackageParts(undefined, {
      error: {
        type: 'Error',
        message: 'clipped',
        stack: 'Error: clipped\n    at outer (/app/src/handler.js:1:1)',
        properties: {}
      },
      localVariables: [
        { functionName: 'outer', filePath: '/app/src/handler.js', lineNumber: 1, columnNumber: 1, locals: { a: 1 } },
        { functionName: 'inner', filePath: '/app/src/inner.js', lineNumber: 2, columnNumber: 1, locals: { b: 2 } }
      ]
    });

    const pkg = builder.build(parts);

    // 1 rendered frame, 2 local frames → trim to 1
    expect(pkg.localVariables).toHaveLength(1);
    expect(pkg.localVariables?.[0]?.functionName).toBe('outer');
    expect(pkg.completeness.localVariablesFrameAlignment).toBe('prefix_only');
  });

  it('Layer 3: skips trimming when stack has no at-frames (zero rendered count)', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({ scrubber: new Scrubber(config), config });
    const parts = createPackageParts(undefined, {
      error: {
        type: 'Error',
        message: 'minimal',
        stack: 'Error: minimal',
        properties: {}
      },
      localVariables: [
        { functionName: 'fn', filePath: '/app/src/fn.js', lineNumber: 1, columnNumber: 1, locals: { z: 1 } }
      ]
    });

    const pkg = builder.build(parts);

    // 0 rendered frames → no trimming (safe fallback)
    expect(pkg.localVariables).toHaveLength(1);
    expect(pkg.completeness.localVariablesFrameAlignment).toBe('full');
  });
});

describe('G1 — Layer 3 alignment helpers', () => {
  it('localVariablesFrameAlignment is undefined when no locals captured', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({ scrubber: new Scrubber(config), config });
    const parts = createPackageParts(undefined, { localVariables: null });

    const pkg = builder.build(parts);

    expect(pkg.completeness.localVariablesFrameAlignment).toBeUndefined();
  });
});

describe('ErrorCapturer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a full package with context, locals, io events, encryption, and transport handoff', async () => {
    const config = resolveConfig({ encryptionKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' });
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-err');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const encryption = new Encryption('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const inspector = {
      getLocals: vi.fn(() => [
        {
          functionName: 'handler',
          filePath: '/app/src/handler.js',
          lineNumber: 10,
          columnNumber: 1,
          locals: { password: 'secret', value: 1 }
        }
      ]),
      getLocalsWithDiagnostics: vi.fn(() => ({
        frames: [
          {
            functionName: 'handler',
            filePath: '/app/src/handler.js',
            lineNumber: 10,
            columnNumber: 1,
            locals: { password: 'secret', value: 1 }
          }
        ],
        missReason: null
      }))
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: inspector as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption,
      bodyCapture: noopBodyCapture,
      config
    });

    context.body = Buffer.from('email=user@example.com');
    context.stateReads.push({
      container: 'cache',
      operation: 'get',
      key: 'user',
      value: { token: 'secret-token' },
      timestamp: 1n
    });
    tracker.add(context);
    buffer.push(
      createSlot({
        requestId: 'req-err',
        requestBody: Buffer.from('hello'),
        responseBody: Buffer.from('world'),
        estimatedBytes: 266
      })
    );

    const error = new Error('boom');
    (error as Error & { code?: string }).code = 'E_BANG';

    const pkg = als.runWithContext(context, () => capturer.capture(error));
    await flushMicrotasks();

    const sentPayload = transport.send.mock.calls[0]?.[0] as string;
    const decrypted = encryption.decrypt(JSON.parse(sentPayload) as {
      salt: string;
      iv: string;
      ciphertext: string;
      authTag: string;
    });

    expect(pkg).not.toBeNull();
    expect(pkg?.completeness.encrypted).toBe(true);
    expect(pkg?.integrity?.algorithm).toBe('HMAC-SHA256');
    expect(pkg?.request?.id).toBe('req-err');
    expect(pkg?.ioTimeline).toHaveLength(1);
    expect(pkg?.completeness.usedAmbientEvents).toBe(false);
    expect(pkg?.localVariables?.[0]?.locals.password).toBe('[REDACTED]');
    expect(pkg?.error.properties.code).toBe('E_BANG');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(decrypted)).toMatchObject({
      schemaVersion: '1.0.0',
      completeness: {
        encrypted: true
      }
    });

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('dispatches to worker assembly when dispatcher is available and returns null', async () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-worker');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(async (parts: ErrorPackageParts) =>
        buildPackageAssemblyResult({ parts, config })
      ),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-worker' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('worker')));

    expect(result).toBeNull();
    await flushMicrotasks();
    expect(dispatcher.assemble).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(1);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('falls back to inline assembly when worker assembly throws', async () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-fallback');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(async () => {
        throw new Error('worker boom');
      }),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-fallback' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = als.runWithContext(context, () => capturer.capture(new Error('fallback')));

    expect(result).toBeNull();
    await flushMicrotasks(10);
    expect(dispatcher.assemble).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(1);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('keeps inline assembly when a custom scrubber is configured', async () => {
    const config = resolveConfig({
      piiScrubber: (_key, value) => value
    });
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-inline');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-inline' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('inline')));
    await flushMicrotasks();

    expect(result).not.toBeNull();
    expect(dispatcher.assemble).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledTimes(1);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('shuts down the package assembly dispatcher when one is configured', async () => {
    const config = resolveConfig({});
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(async (parts: ErrorPackageParts) =>
        buildPackageAssemblyResult({ parts, config })
      ),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    await capturer.shutdown({ timeoutMs: 1 });

    expect(dispatcher.shutdown).toHaveBeenCalledTimes(1);
  });

  it('uses ambient events when ALS context is unavailable', () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const transport = {
      send: vi.fn()
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    buffer.push(createSlot({ requestId: null, target: 'ambient-1' }));
    buffer.push(createSlot({ requestId: null, target: 'ambient-2' }));

    const pkg = capturer.capture(new Error('ambient'));

    expect(pkg?.completeness.alsContextAvailable).toBe(false);
    expect(pkg?.completeness.usedAmbientEvents).toBe(true);
    expect(pkg?.request).toBeUndefined();
    expect(pkg?.ioTimeline.map((event) => event.target)).toEqual([
      'ambient-1',
      'ambient-2'
    ]);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('returns null when rate limited', () => {
    const config = resolveConfig({});
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 0, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    expect(capturer.capture(new Error('blocked'))).toBeNull();
  });

  it('persists transport failures through signed dead-letter payload envelopes', async () => {
    const deadLetterPath = createTempDeadLetterPath();
    const config = resolveConfig({
      encryptionKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      transport: { type: 'stdout' }
    });
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: config.encryptionKey as string,
      maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
      requireEncryptedPayload: true
    });
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker,
      processMetadata,
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: {
        send: vi.fn(async () => {
          throw new Error('collector offline');
        })
      },
      encryption: new Encryption(config.encryptionKey as string),
      bodyCapture: noopBodyCapture,
      config,
      deadLetterStore: store
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    capturer.capture(new Error('boom'));
    await flushMicrotasks(10);

    const fileContents = fsModule.readFileSync(deadLetterPath, 'utf8');
    const persisted = store.drain();

    expect(fileContents).not.toContain('collector offline');
    expect(persisted.entries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_transport_dispatch_failed]')
    );
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('collector offline');

    fsModule.rmSync(deadLetterPath, { force: true });
    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('persists main-thread file transport fallback failures through signed dead-letter payload envelopes', async () => {
    const deadLetterPath = createTempDeadLetterPath();
    const transportPath = pathModule.join(
      osModule.tmpdir(),
      `errorcore-main-thread-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'nested',
      'out.ndjson'
    );
    const config = resolveConfig({
      encryptionKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      transport: { type: 'file', path: transportPath }
    });
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: config.encryptionKey as string,
      maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
      requireEncryptedPayload: true
    });
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await withMissingWorkerThreads(async () => {
      const transport = new TransportDispatcher({
        config,
        encryption: new Encryption(config.encryptionKey as string)
      });
      const capturer = new ErrorCapturer({
        buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
        als: new ALSManager(),
        inspector: {
          getLocals: vi.fn(() => null),
          getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null }))
        } as never,
        rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
        requestTracker,
        processMetadata,
        packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
        transport,
        encryption: new Encryption(config.encryptionKey as string),
        bodyCapture: noopBodyCapture,
        config,
        deadLetterStore: store
      });

      capturer.capture(new Error('boom'));
      await flushMicrotasks(10);
      await transport.flush();
      await transport.shutdown();
    });

    const fileContents = fsModule.readFileSync(deadLetterPath, 'utf8');
    const persisted = store.drain();

    expect(fsModule.existsSync(transportPath)).toBe(false);
    expect(persisted.entries).toHaveLength(1);
    expect(fileContents).not.toContain('boom');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ErrorCore] File transport dropped payload:')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_transport_dispatch_failed]')
    );

    fsModule.rmSync(deadLetterPath, { force: true });
    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('does not dead-letter or duplicate delivery when worker-crash fallback succeeds', async () => {
    const deadLetterPath = createTempDeadLetterPath();
    const encryptionKey =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const config = resolveConfig({
      encryptionKey,
      transport: { type: 'stdout' }
    });
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: encryptionKey,
      maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
      requireEncryptedPayload: true
    });
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const stdout = createDeferredStdoutWrite();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    class CrashingWorker {
      private readonly listeners = new Map<
        'message' | 'error' | 'exit',
        Array<(...args: unknown[]) => void>
      >();

      public readonly postMessage = vi.fn((message: { id: number; type: string }) => {
        if (message.type === 'send') {
          this.emit('error', new Error('worker crashed'));
          return;
        }

        this.emit('message', { id: message.id });
      });

      public on(
        event: 'message' | 'error' | 'exit',
        listener: (...args: unknown[]) => void
      ): this {
        const current = this.listeners.get(event) ?? [];
        current.push(listener);
        this.listeners.set(event, current);
        return this;
      }

      public async terminate(): Promise<number> {
        return 1;
      }

      private emit(event: 'message' | 'error' | 'exit', ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    }

    await withWorkerThreadsMock(
      () => new CrashingWorker(),
      async () => {
        const transport = new TransportDispatcher({
          config,
          encryption: new Encryption(encryptionKey)
        });
        const capturer = new ErrorCapturer({
          buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
          als: new ALSManager(),
          inspector: {
            getLocals: vi.fn(() => null),
            getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null }))
          } as never,
          rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
          requestTracker,
          processMetadata,
          packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
          transport,
          encryption: new Encryption(encryptionKey),
          bodyCapture: noopBodyCapture,
          config,
          deadLetterStore: store
        });

        capturer.capture(new Error('boom'));
        await flushMicrotasks(10);
        await waitForSetImmediate();

        expect(stdout.pendingCount()).toBe(1);

        stdout.completeNext();

        await transport.flush();
        await transport.shutdown();
      }
    );

    expect(stdout.writes).toHaveLength(1);
    expect(store.drain().entries).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_transport_dispatch_failed]')
    );

    fsModule.rmSync(deadLetterPath, { force: true });
    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('dead-letters exactly once when worker-crash fallback also fails', async () => {
    const deadLetterPath = createTempDeadLetterPath();
    const encryptionKey =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const config = resolveConfig({
      encryptionKey,
      transport: { type: 'stdout' }
    });
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: encryptionKey,
      maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
      requireEncryptedPayload: true
    });
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const stdout = createDeferredStdoutWrite();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    class CrashingWorker {
      private readonly listeners = new Map<
        'message' | 'error' | 'exit',
        Array<(...args: unknown[]) => void>
      >();

      public readonly postMessage = vi.fn((message: { id: number; type: string }) => {
        if (message.type === 'send') {
          this.emit('error', new Error('worker crashed'));
          return;
        }

        this.emit('message', { id: message.id });
      });

      public on(
        event: 'message' | 'error' | 'exit',
        listener: (...args: unknown[]) => void
      ): this {
        const current = this.listeners.get(event) ?? [];
        current.push(listener);
        this.listeners.set(event, current);
        return this;
      }

      public async terminate(): Promise<number> {
        return 1;
      }

      private emit(event: 'message' | 'error' | 'exit', ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
          listener(...args);
        }
      }
    }

    await withWorkerThreadsMock(
      () => new CrashingWorker(),
      async () => {
        const transport = new TransportDispatcher({
          config,
          encryption: new Encryption(encryptionKey)
        });
        const capturer = new ErrorCapturer({
          buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
          als: new ALSManager(),
          inspector: {
            getLocals: vi.fn(() => null),
            getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null }))
          } as never,
          rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
          requestTracker,
          processMetadata,
          packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
          transport,
          encryption: new Encryption(encryptionKey),
          bodyCapture: noopBodyCapture,
          config,
          deadLetterStore: store
        });

        capturer.capture(new Error('boom'));
        await flushMicrotasks(10);
        await waitForSetImmediate();

        expect(stdout.pendingCount()).toBe(1);

        stdout.completeNext(new Error('stdout unavailable'));

        await flushMicrotasks(10);
        await transport.flush();
        await transport.shutdown();
      }
    );

    expect(stdout.writes).toHaveLength(1);
    expect(store.drain().entries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_transport_dispatch_failed]')
    );

    fsModule.rmSync(deadLetterPath, { force: true });
    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('stores only a minimal marker when capture itself fails', () => {
    const deadLetterPath = createTempDeadLetterPath();
    const config = resolveConfig({
      encryptionKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      transport: { type: 'stdout' }
    });
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: config.encryptionKey as string,
      maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
      requireEncryptedPayload: true
    });
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker,
      processMetadata,
      packageBuilder: {
        build: vi.fn(() => {
          throw new Error('stack with secret-token');
        })
      } as never,
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      deadLetterStore: store
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = capturer.capture(new Error('user-visible secret-token'));
    const fileContents = fsModule.readFileSync(deadLetterPath, 'utf8');
    const drained = store.drain();

    expect(result).toBeNull();
    expect(fileContents).not.toContain('user-visible secret-token');
    expect(fileContents).not.toContain('stack with secret-token');
    expect(drained.entries).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_capture_failed]')
    );
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('user-visible secret-token');

    fsModule.rmSync(deadLetterPath, { force: true });
    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('emits sanitized warning codes when worker fallback capture also fails', async () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-fallback-warning');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder: {
        build: vi.fn(() => {
          throw new Error('inline secret-token');
        })
      } as never,
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: {
        isAvailable: vi.fn(() => true),
        assemble: vi.fn(async () => {
          throw new Error('worker secret-token');
        }),
        shutdown: vi.fn(async () => undefined)
      }
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-fallback-warning' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('user secret-token')));

    expect(result).toBeNull();
    await flushMicrotasks(10);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_capture_fallback_failed]')
    );
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-token');

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('emits sanitized warning codes when dead-letter fallback storage fails', async () => {
    const config = resolveConfig({});
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker,
      processMetadata,
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: {
        send: vi.fn(async () => {
          throw new Error('collector secret-token');
        })
      },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      deadLetterStore: {
        appendPayloadSync: vi.fn(() => {
          throw new Error('disk secret-token');
        })
      } as never
    });

    capturer.capture(new Error('boom'));
    await flushMicrotasks(10);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_transport_dispatch_failed]')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[code=errorcore_dead_letter_write_failed]')
    );
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-token');

    requestTracker.shutdown();
    processMetadata.shutdown();
  });

  it('serializes the error cause chain and enforces the depth limit', () => {
    const config = resolveConfig({});
    const root = new Error('root');
    let current: Error = root;

    for (let index = 0; index < 7; index += 1) {
      const next = new Error(`cause-${index}`);

      (current as Error & { cause?: Error }).cause = next;
      current = next;
    }

    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    const pkg = capturer.capture(root);

    expect(pkg?.error.cause?.message).toBe('cause-0');
    expect(pkg?.error.cause?.cause?.cause?.cause?.cause?.cause).toEqual({
      type: 'Error',
      message: '[Cause chain depth limit]',
      stack: '',
      properties: {}
    });
  });

  it('includes ambientContext when ALS context is unavailable', () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    buffer.push(createSlot({ requestId: 'req-a', target: 'svc-1' }));
    buffer.push(createSlot({ requestId: 'req-b', target: 'svc-2' }));

    const pkg = capturer.capture(new Error('ambient'));

    expect(pkg?.ambientContext).toBeDefined();
    expect(pkg?.ambientContext?.retrievedCount).toBe(2);
    expect(pkg?.ambientContext?.distinctRequestIds.sort()).toEqual(['req-a', 'req-b']);
    expect(pkg?.ambientContext?.seqRange).toEqual({ min: 1, max: 2 });
    expect(pkg?.ambientContext?.seqGaps).toBe(0);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('includes eviction log in the package', () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 1, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    buffer.push(createSlot({ requestId: 'req-evicted', type: 'http-client', direction: 'outbound', target: 'api.example.com' }));
    buffer.push(createSlot({ requestId: 'req-live' }));

    const pkg = capturer.capture(new Error('eviction'));

    expect(pkg?.evictionLog).toHaveLength(1);
    expect(pkg?.evictionLog[0].seq).toBe(1);
    expect(pkg?.evictionLog[0].type).toBe('http-client');
    expect(pkg?.evictionLog[0].target).toBe('api.example.com');
    expect(typeof pkg?.evictionLog[0].startTime).toBe('string');
    expect(typeof pkg?.evictionLog[0].evictedAt).toBe('string');

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('includes timeAnchor in every package', () => {
    const config = resolveConfig({});
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    const pkg = capturer.capture(new Error('anchor'));

    expect(pkg?.timeAnchor).toBeDefined();
    expect(typeof pkg?.timeAnchor.wallClockMs).toBe('number');
    expect(typeof pkg?.timeAnchor.hrtimeNs).toBe('string');
    expect(pkg?.timeAnchor.wallClockMs).toBeGreaterThan(0);
  });

  it('includes rateLimiterDrops in completeness after drops', () => {
    const config = resolveConfig({});
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter,
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    capturer.capture(new Error('first'));
    now = 1100;
    capturer.capture(new Error('dropped-1'));
    now = 1200;
    capturer.capture(new Error('dropped-2'));

    now = 2100;

    const pkg = capturer.capture(new Error('after-drops'));

    expect(pkg?.completeness.rateLimiterDrops).toEqual({
      droppedCount: 2,
      firstDropMs: 1100,
      lastDropMs: 1200
    });
  });

  it('records inspector miss reason in captureFailures when locals capture is enabled', () => {
    const config = resolveConfig({ captureLocalVariables: true });
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: {
        getLocals: vi.fn(() => null),
        getLocalsWithDiagnostics: vi.fn(() => ({
          frames: null,
          missReason: 'cache_miss (pauses=0)'
        }))
      } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    const pkg = capturer.capture(new Error('miss'));

    expect(pkg?.completeness.captureFailures).toContain('locals: cache_miss (pauses=0)');
  });
});

describe('G3 — sourceMapResolution telemetry in completeness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes sourceMapResolution counts after a capture', () => {
    const config = resolveConfig({});
    const processMetadata = new ProcessMetadata(config);
    const requestTracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const sourceMapResolver = new SourceMapResolver();
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null), getLocalsWithDiagnostics: vi.fn(() => ({ frames: null, missReason: null })) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker,
      processMetadata,
      packageBuilder: new PackageBuilder({ scrubber: new Scrubber(config), config }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      sourceMapResolver
    });

    const error = new Error('src-map-telemetry-test');
    // Stack referencing a path that won't have a source map — triggers
    // a missing/not-found entry in the source map resolver.
    error.stack = 'Error: src-map-telemetry-test\n    at foo (/nonexistent/telemetry.js:10:5)';

    const pkg = capturer.capture(error);

    expect(pkg?.completeness.sourceMapResolution).toBeDefined();
    const sm = pkg!.completeness.sourceMapResolution!;
    expect(typeof sm.framesResolved).toBe('number');
    expect(typeof sm.framesUnresolved).toBe('number');
    expect(typeof sm.cacheHits).toBe('number');
    expect(typeof sm.cacheMisses).toBe('number');
    expect(typeof sm.missing).toBe('number');
    expect(typeof sm.corrupt).toBe('number');
    expect(typeof sm.evictions).toBe('number');
    // At least one field should be > 0 because the capture triggered resolution.
    const totalActivity = sm.framesResolved + sm.framesUnresolved + sm.cacheHits + sm.cacheMisses + sm.missing + sm.corrupt;
    expect(totalActivity).toBeGreaterThan(0);

    requestTracker.shutdown();
    processMetadata.shutdown();
  });
});
