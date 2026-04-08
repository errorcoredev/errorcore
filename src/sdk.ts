
import { resolveConfig } from './config';
import { IOEventBuffer } from './buffer/io-event-buffer';
import { ALSManager } from './context/als-manager';
import { RequestTracker } from './context/request-tracker';
import { HeaderFilter } from './pii/header-filter';
import { Scrubber } from './pii/scrubber';
import { RateLimiter } from './security/rate-limiter';
import { Encryption } from './security/encryption';
import { ProcessMetadata } from './capture/process-metadata';
import { InspectorManager } from './capture/inspector-manager';
import { BodyCapture } from './recording/body-capture';
import { StateTracker } from './state/state-tracker';
import { HttpServerRecorder } from './recording/http-server';
import { HttpClientRecorder } from './recording/http-client';
import { UndiciRecorder } from './recording/undici';
import { NetDnsRecorder } from './recording/net-dns';
import { PatchManager } from './recording/patches/patch-manager';
import { ChannelSubscriber } from './recording/channel-subscriber';
import { PackageBuilder } from './capture/package-builder';
import { TransportDispatcher } from './transport/transport';
import { DeadLetterStore } from './transport/dead-letter-store';
import { ErrorCapturer } from './capture/error-capturer';
import { PackageAssemblyDispatcher } from './capture/package-assembly-dispatcher';
import { SourceMapResolver } from './capture/source-map-resolver';
import type { RequestContext, ResolvedConfig, SDKConfig, TransportConfig } from './types';

type SDKState = 'created' | 'active' | 'shutting_down' | 'shutdown';

interface ProcessListenerEntry {
  event: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection' | 'beforeExit' | 'exit';
  handler: (...args: any[]) => void;
  once?: boolean;
}

function getTransportAuthorization(
  transport: TransportConfig | undefined
): string | undefined {
  return transport?.type === 'http' ? transport.authorization : undefined;
}

function deriveDeadLetterIntegrityKey(
  config: ResolvedConfig,
  transportAuthorization: string | undefined
): string | null {
  if (config.encryptionKey !== undefined) {
    return config.encryptionKey;
  }

  if (transportAuthorization !== undefined) {
    return transportAuthorization;
  }

  return null;
}

export class SDKInstance {
  private state: SDKState = 'created';

  private fatalExitInProgress = false;

  private readonly timers: Array<NodeJS.Timeout | NodeJS.Timer> = [];

  private readonly processListeners: ProcessListenerEntry[] = [];

  private readonly httpServerRecorder: HttpServerRecorder;

  private readonly httpClientRecorder: HttpClientRecorder;

  private readonly undiciRecorder: UndiciRecorder;

  private readonly netDnsRecorder: NetDnsRecorder;

  readonly config: ResolvedConfig;

  readonly buffer: IOEventBuffer;

  readonly als: ALSManager;

  readonly requestTracker: RequestTracker;

  readonly headerFilter: HeaderFilter;

  readonly inspector: InspectorManager;

  readonly channelSubscriber: ChannelSubscriber;

  readonly patchManager: PatchManager;

  readonly stateTracker: StateTracker;

  readonly errorCapturer: ErrorCapturer;

  readonly transport: TransportDispatcher;

  readonly processMetadata: ProcessMetadata;

  private readonly deadLetterStore: DeadLetterStore | null;

  public constructor(input: {
    config: ResolvedConfig;
    buffer: IOEventBuffer;
    als: ALSManager;
    requestTracker: RequestTracker;
    headerFilter: HeaderFilter;
    inspector: InspectorManager;
    channelSubscriber: ChannelSubscriber;
    patchManager: PatchManager;
    stateTracker: StateTracker;
    errorCapturer: ErrorCapturer;
    transport: TransportDispatcher;
    processMetadata: ProcessMetadata;
    httpServerRecorder: HttpServerRecorder;
    httpClientRecorder: HttpClientRecorder;
    undiciRecorder: UndiciRecorder;
    netDnsRecorder: NetDnsRecorder;
    deadLetterStore: DeadLetterStore | null;
  }) {
    this.config = input.config;
    this.buffer = input.buffer;
    this.als = input.als;
    this.requestTracker = input.requestTracker;
    this.headerFilter = input.headerFilter;
    this.inspector = input.inspector;
    this.channelSubscriber = input.channelSubscriber;
    this.patchManager = input.patchManager;
    this.stateTracker = input.stateTracker;
    this.errorCapturer = input.errorCapturer;
    this.transport = input.transport;
    this.processMetadata = input.processMetadata;
    this.httpServerRecorder = input.httpServerRecorder;
    this.httpClientRecorder = input.httpClientRecorder;
    this.undiciRecorder = input.undiciRecorder;
    this.netDnsRecorder = input.netDnsRecorder;
    this.deadLetterStore = input.deadLetterStore;
  }

  public activate(): void {
    if (this.state !== 'created') {
      return;
    }

    if (!this.config.encryptionKey && !this.config.allowUnencrypted) {
      throw new Error(
        'ErrorCore requires an encryptionKey for encrypted error packages.\n\n' +
        'For local development, add to your config:\n' +
        '  allowUnencrypted: true\n\n' +
        'For production, generate a key:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }

    this.processMetadata.collectStartupMetadata();
    this.httpServerRecorder.install();
    this.channelSubscriber.subscribeAll();
    this.patchManager.installAll();
    this.registerProcessHandlers();
    this.processMetadata.startEventLoopLagMeasurement();
    this.drainDeadLetters();

    if (this.config.flushIntervalMs > 0) {
      const flushTimer = setInterval(() => {
        void this.transport.flush().catch(() => undefined);
      }, this.config.flushIntervalMs);
      flushTimer.unref();
      this.timers.push(flushTimer);
    }

    this.state = 'active';
  }

  private drainDeadLetters(): void {
    if (this.deadLetterStore === null || !this.deadLetterStore.hasPending()) {
      return;
    }

    const { entries, lineCount } = this.deadLetterStore.drain();
    if (entries.length === 0) {
      if (lineCount > 0) {
        this.deadLetterStore.clearSent(lineCount);
      }
      return;
    }

    const max = this.config.maxDrainOnStartup;
    if (entries.length > max) {
      console.warn(
        `[ErrorCore] Dead-letter store contains ${entries.length} payloads; ` +
        `draining only ${max} on startup. Run \`errorcore drain\` to flush the rest.`
      );
    }
    const batch = entries.slice(0, max);

    let processedLineCount = 0;
    const sendAll = async () => {
      for (const entry of batch) {
        try {
          await this.transport.send(entry.payload);
          processedLineCount = entry.lineNumber;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[ErrorCore] Dead-letter retry failed after line ${processedLineCount}/${lineCount}: ${message}`
          );
          break;
        }
      }

      if (processedLineCount > 0) {
        this.deadLetterStore!.clearSent(
          processedLineCount === batch[batch.length - 1]?.lineNumber &&
            batch.length === entries.length
            ? lineCount
            : processedLineCount
        );
      }
    };

    void sendAll().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Dead-letter drain failed: ${message}`);
    });
  }

  public captureError(error: Error): void {
    if (this.state !== 'active') {
      return;
    }

    this.errorCapturer.capture(error);
  }

  public trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
    name: string,
    container: T
  ): T {
    if (this.state === 'shutdown') {
      throw new Error('SDK is shut down');
    }

    return this.stateTracker.track(name, container);
  }

  public withContext<T>(fn: () => T): T {
    if (this.als.getContext() !== undefined) {
      return fn();
    }

    const context = this.als.createRequestContext({
      method: 'INTERNAL',
      url: 'withContext',
      headers: {}
    });

    return this.als.runWithContext(context as RequestContext, fn);
  }

  public async flush(): Promise<void> {
    if (this.state !== 'active') {
      return;
    }

    await this.errorCapturer.shutdown({ timeoutMs: 5000 });
    await this.transport.flush();
  }

  public isActive(): boolean {
    return this.state === 'active';
  }

  public async shutdown(): Promise<void> {
    if (this.state === 'shutdown' || this.state === 'shutting_down') {
      return;
    }

    this.state = 'shutting_down';

    this.channelSubscriber.unsubscribeAll();
    this.patchManager.unwrapAll();
    this.httpServerRecorder.shutdown();
    this.httpClientRecorder.shutdown();
    this.undiciRecorder.shutdown();
    this.netDnsRecorder.shutdown();
    this.inspector.shutdown();
    this.processMetadata.shutdown();
    this.requestTracker.shutdown();

    for (const timer of this.timers) {
      clearTimeout(timer as NodeJS.Timeout);
    }

    await this.errorCapturer.shutdown({ timeoutMs: 5000 });
    await this.transport.flush();
    await this.transport.shutdown({ timeoutMs: 5000 });
    this.buffer.clear();

    for (const listener of this.processListeners) {
      process.removeListener(listener.event, listener.handler);
    }

    this.processListeners.length = 0;
    this.state = 'shutdown';
    this.fatalExitInProgress = false;
  }

  public enableAutoShutdown(): void {
    const sigtermHandler = async () => {
      await this.shutdown();
      process.kill(process.pid, 'SIGTERM');
    };
    const sigintHandler = async () => {
      await this.shutdown();
      process.kill(process.pid, 'SIGINT');
    };

    process.once('SIGTERM', sigtermHandler);
    process.once('SIGINT', sigintHandler);
    this.processListeners.push({ event: 'SIGTERM', handler: sigtermHandler, once: true });
    this.processListeners.push({ event: 'SIGINT', handler: sigintHandler, once: true });
  }

  private registerProcessHandlers(): void {
    for (const listener of this.processListeners) {
      process.removeListener(listener.event, listener.handler);
    }

    this.processListeners.length = 0;

    const uncaughtExceptionHandler = (error: Error) => {
      if (this.fatalExitInProgress) {
        return;
      }

      this.fatalExitInProgress = true;
      this.errorCapturer.capture(error, { isUncaught: true });
      // Transport delivery is not guaranteed within uncaughtExceptionExitDelayMs;
      // increase it for slow collectors.
      const exitNow = () => {
        // process.exit() is intentional here. This handler is only
        // registered for uncaughtException and unhandledRejection where
        // continued execution is unsafe. ESLint: no-process-exit disable
        // is acceptable in this specific callsite.
        process.exit(1);
      };
      const exitTimer = setTimeout(exitNow, this.config.uncaughtExceptionExitDelayMs);
      exitTimer.unref();

      void this.shutdown()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(exitTimer);
          exitNow();
        });
    };
    const unhandledRejectionHandler = (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));

      this.errorCapturer.capture(error);
    };
    const beforeExitHandler = () => {
      void this.shutdown();
    };

    process.on('uncaughtException', uncaughtExceptionHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);
    process.on('beforeExit', beforeExitHandler);

    this.processListeners.push({ event: 'uncaughtException', handler: uncaughtExceptionHandler });
    this.processListeners.push({ event: 'unhandledRejection', handler: unhandledRejectionHandler });
    this.processListeners.push({ event: 'beforeExit', handler: beforeExitHandler });
  }
}

export function createSDK(userConfig: Partial<SDKConfig> = {}): SDKInstance {
  const config = resolveConfig(userConfig);
  const transportAuthorization = getTransportAuthorization(userConfig.transport);
  const buffer = new IOEventBuffer({
    capacity: config.bufferSize,
    maxBytes: config.bufferMaxBytes
  });
  const als = new ALSManager();
  const headerFilter = new HeaderFilter(config);
  const scrubber = new Scrubber(config);
  const rateLimiter = new RateLimiter({
    maxCaptures: config.rateLimitPerMinute,
    windowMs: config.rateLimitWindowMs
  });
  const encryption = config.encryptionKey ? new Encryption(config.encryptionKey) : null;
  const processMetadata = new ProcessMetadata(config);
  const inspector = new InspectorManager(config, {
    getRequestId: () => als.getRequestId()
  });
  const requestTracker = new RequestTracker({
    maxConcurrent: config.maxConcurrentRequests,
    ttlMs: 300000
  });
  const bodyCapture = new BodyCapture({
    maxPayloadSize: config.maxPayloadSize,
    captureRequestBodies: config.captureRequestBodies,
    captureResponseBodies: config.captureResponseBodies,
    captureBodyDigest: config.captureBodyDigest,
    bodyCaptureContentTypes: config.bodyCaptureContentTypes,
    scrubber
  });
  const stateTracker = new StateTracker({ als });
  const httpServerRecorder = new HttpServerRecorder({
    buffer,
    als,
    requestTracker,
    bodyCapture,
    headerFilter,
    scrubber,
    config
  });
  const httpClientRecorder = new HttpClientRecorder({
    buffer,
    als,
    bodyCapture,
    headerFilter
  });
  const undiciRecorder = new UndiciRecorder({
    buffer,
    als,
    headerFilter
  });
  const netDnsRecorder = new NetDnsRecorder({
    buffer,
    als
  });
  const patchManager = new PatchManager({ buffer, als, config });
  const channelSubscriber = new ChannelSubscriber({
    httpServer: httpServerRecorder,
    httpClient: httpClientRecorder,
    undiciRecorder,
    netDns: netDnsRecorder
  });
  const packageBuilder = new PackageBuilder({ scrubber, config });
  const transport = new TransportDispatcher({
    config,
    encryption,
    transportAuthorization
  });
  const deadLetterIntegrityKey = deriveDeadLetterIntegrityKey(
    config,
    transportAuthorization
  );
  const deadLetterStore =
    config.deadLetterPath !== undefined
      ? deadLetterIntegrityKey === null
        ? null
        : new DeadLetterStore(config.deadLetterPath, {
            integrityKey: deadLetterIntegrityKey,
            maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
            requireEncryptedPayload: config.encryptionKey !== undefined
          })
      : null;

  if (config.deadLetterPath !== undefined && deadLetterIntegrityKey === null) {
    // FIX ASSUMPTION: Disable automatic dead-letter replay when no stable secret
    // is configured because unsigned disk content cannot be trusted safely.
    console.warn(
      '[ErrorCore] Dead-letter persistence is disabled because no encryptionKey or HTTP authorization secret is configured.'
    );
  }
  const sourceMapResolver = config.resolveSourceMaps
    ? new SourceMapResolver()
    : null;
  const packageAssemblyDispatcher = config.useWorkerAssembly
    ? new PackageAssemblyDispatcher({ config })
    : null;
  const errorCapturer = new ErrorCapturer({
    buffer,
    als,
    inspector,
    rateLimiter,
    requestTracker,
    processMetadata,
    packageBuilder,
    transport,
    encryption,
    bodyCapture,
    config,
    packageAssemblyDispatcher,
    stateTrackerStatus: stateTracker,
    deadLetterStore,
    sourceMapResolver
  });

  return new SDKInstance({
    config,
    buffer,
    als,
    requestTracker,
    headerFilter,
    inspector,
    channelSubscriber,
    patchManager,
    stateTracker,
    errorCapturer,
    transport,
    processMetadata,
    httpServerRecorder,
    httpClientRecorder,
    undiciRecorder,
    netDnsRecorder,
    deadLetterStore
  });
}
