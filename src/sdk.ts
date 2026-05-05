
import { resolveConfig } from './config';
import { setLogLevel, safeConsole } from './debug-log';
import {
  detectBundler,
  isNextJsNodeRuntime,
  formatStartupLine,
  formatWarnGuidance,
  type RecorderState
} from './sdk-diagnostics';
import { IOEventBuffer } from './buffer/io-event-buffer';
import { ALSManager } from './context/als-manager';
import { EventClock } from './context/event-clock';
import { RequestTracker } from './context/request-tracker';
import { HeaderFilter } from './pii/header-filter';
import { Scrubber } from './pii/scrubber';
import { RateLimiter } from './security/rate-limiter';
import { Encryption } from './security/encryption';
import {
  createEncryptionFromAssemblyConfig,
  createPackageAssemblyEncryptionConfig
} from './security/encryption-runtime';
import { ProcessMetadata } from './capture/process-metadata';
import { InspectorManager } from './capture/inspector-manager';
import { BodyCapture } from './recording/body-capture';
import { StateTracker } from './state/state-tracker';
import { HttpServerRecorder } from './recording/http-server';
import { HttpClientRecorder } from './recording/http-client';
import { UndiciRecorder } from './recording/undici';
import { installFetchWrapper } from './recording/fetch-wrapper';
import { NetDnsRecorder } from './recording/net-dns';
import { PatchManager } from './recording/patches/patch-manager';
import { ChannelSubscriber } from './recording/channel-subscriber';
import { PackageBuilder } from './capture/package-builder';
import { TransportDispatcher } from './transport/transport';
import { parseEnvelopeMetadata } from './transport/payload';
import {
  DeadLetterStore,
  createHmacVerifier,
  type IntegrityVerifier
} from './transport/dead-letter-store';
import { ErrorCapturer } from './capture/error-capturer';
import { PackageAssemblyDispatcher } from './capture/package-assembly-dispatcher';
import { SourceMapResolver } from './capture/source-map-resolver';
import { WatchdogManager } from './middleware/watchdog';
import { HealthMetrics } from './health/health-metrics';
import type { HealthSnapshot } from './health/types';
import type {
  RequestContext,
  ResolvedConfig,
  SDKConfig,
  TraceContextInput,
  TraceHeaders,
  TransportConfig
} from './types';

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

function deriveDeadLetterVerifier(
  encryption: Encryption | null,
  config: ResolvedConfig,
  transportAuthorization: string | undefined
): IntegrityVerifier | null {
  if (encryption !== null) {
    // The Encryption instance carries the multi-key chain; wrap it.
    return {
      sign: (payload) => encryption.sign(payload),
      verifyKeyIndex: (payload, mac) => {
        const r = encryption.verify(payload, mac);
        return r.ok ? r.keyIndex : null;
      }
    };
  }
  // Fallback path: no encryption configured, but transport auth or
  // string key may still be available. Single-key HMAC, no rotation
  // chain (rotation only applies to encryptionKey).
  const fallback = config.encryptionKey ?? transportAuthorization;
  if (fallback === undefined) return null;
  return createHmacVerifier(fallback);
}

interface DeadLetterHealthState {
  enabled: boolean;
  signed: boolean;
  reason: 'configured' | 'not_configured' | 'unsigned';
}

function normalizeCallbackEncryptionKey(value: string | Buffer): string {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      throw new Error('encryptionKeyCallback must return a 32-byte Buffer or 64-character hex string');
    }
    return value.toString('hex');
  }

  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('encryptionKeyCallback must return a 32-byte Buffer or 64-character hex string');
  }

  return value;
}

function resolveEncryptionKeyCallback(config: ResolvedConfig): ResolvedConfig {
  if (config.encryptionKey !== undefined || config.encryptionKeyCallback === undefined) {
    return config;
  }

  const resolved = config.encryptionKeyCallback();
  if (
    typeof resolved === 'object' &&
    resolved !== null &&
    typeof (resolved as unknown as Promise<unknown>).then === 'function'
  ) {
    throw new Error(
      'encryptionKeyCallback returned a Promise, but createSDK()/init() are synchronous. Resolve the key before calling createSDK(), or use a synchronous callback.'
    );
  }

  return {
    ...config,
    encryptionKey: normalizeCallbackEncryptionKey(resolved as string | Buffer)
  };
}

export class SDKInstance {
  private state: SDKState = 'created';

  private fatalExitInProgress = false;

  private shutdownPromise: Promise<void> | null = null;

  private readonly timers: Array<NodeJS.Timeout | NodeJS.Timer> = [];

  private readonly processListeners: ProcessListenerEntry[] = [];

  private readonly httpServerRecorder: HttpServerRecorder;

  private readonly httpClientRecorder: HttpClientRecorder;

  private readonly undiciRecorder: UndiciRecorder;

  private readonly netDnsRecorder: NetDnsRecorder;

  private fetchWrapperUninstall: (() => void) | null = null;

  private readonly bodyCapture: BodyCapture;

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

  private readonly watchdog: WatchdogManager | null;

  private readonly healthMetrics: HealthMetrics;

  private readonly deadLetterHealth: DeadLetterHealthState;

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
    bodyCapture: BodyCapture;
    deadLetterStore: DeadLetterStore | null;
    watchdog: WatchdogManager | null;
    healthMetrics: HealthMetrics;
    deadLetterHealth: DeadLetterHealthState;
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
    this.bodyCapture = input.bodyCapture;
    this.deadLetterStore = input.deadLetterStore;
    this.watchdog = input.watchdog;
    this.healthMetrics = input.healthMetrics;
    this.deadLetterHealth = input.deadLetterHealth;
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

    this.httpServerRecorder.install();
    this.channelSubscriber.subscribeAll();
    // Install the global fetch wrapper for outbound response-body capture.
    // No-op when captureResponseBodies is disabled, when fetch isn't a
    // function, or when the wrapper is already installed in this process.
    const fetchHandle = installFetchWrapper({
      bodyCapture: this.bodyCapture,
      buffer: this.buffer,
      headerFilter: this.headerFilter,
      captureResponseBodies: this.config.captureResponseBodies
    });
    this.fetchWrapperUninstall = fetchHandle.uninstall;
    this.patchManager.installAll();
    this.registerProcessHandlers();

    // Eagerly warm the V8 inspector so the first error in the process
    // actually triggers Debugger.paused. Without this, the inspector is
    // lazily initialized on the first getLocals() call — by which time
    // the exception has already propagated past any pause-on-exceptions
    // handler, so Layer 1 tag installation never runs and the ring buffer
    // stays empty for that first error.
    if (this.config.captureLocalVariables) {
      this.inspector.ensureDebuggerActive();
    }

    if (!this.config.serverless) {
      this.processMetadata.startEventLoopLagMeasurement();
    }

    // In serverless mode, deadLetterStore is null (deadLetterPath is undefined),
    // so drainDeadLetters() is already a no-op.
    this.drainDeadLetters();

    if (this.config.flushIntervalMs > 0) {
      const flushTimer = setInterval(() => {
        this.emitDiagnosticsIfNeeded();
        void this.transport.flush().catch(() => undefined);
      }, this.config.flushIntervalMs);
      flushTimer.unref();
      this.timers.push(flushTimer);
    }

    this.state = 'active';

    if (!this.config.silent) {
      this.emitStartupDiagnostic();
    }
  }

  private emitStartupDiagnostic(): void {
    const recorders: Record<string, RecorderState> = {
      'http-server': this.httpServerRecorder.getState(),
      'http-client': this.httpClientRecorder.getState(),
      'undici': this.undiciRecorder.getState(),
      'net': this.netDnsRecorder.getState(),
      'dns': this.netDnsRecorder.getState(),
      ...this.patchManager.getRecorderStates(),
    };
    // Load version lazily; require('../package.json') depends on the dist layout
    let version = 'unknown';
    try {
      version = (require('../package.json') as { version?: string }).version ?? 'unknown';
    } catch {
      // package.json may not be reachable from some bundlers; fall through
    }
    const line = formatStartupLine({
      version,
      nodeVersion: process.versions.node,
      recorders,
    });
    // Startup diagnostic is gated by `silent` only (already short-circuited
    // above when silent is true) -- bypass the logLevel gate so the
    // documented one-line summary always prints when the user hasn't opted
    // out via silent: true.
    console.log(line);
    const isNextJs = isNextJsNodeRuntime();
    for (const [name, state] of Object.entries(recorders)) {
      const guidance = formatWarnGuidance(name, state, { isNextJs });
      if (guidance !== null) console.log(guidance);
    }
    if (detectBundler() === 'unknown') {
      const dbNames = ['pg', 'mongodb', 'mysql2', 'ioredis'];
      const anyDbOk = dbNames.some((n) => recorders[n]?.state === 'ok');
      if (anyDbOk) {
        console.log(
          "[errorcore]   info: Bundler auto-detection covers webpack only. If DB events don't appear, pass drivers: { pg: require('pg'), ... } to init()."
        );
      }
    }
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
      safeConsole.warn(
        `[ErrorCore] Dead-letter store contains ${entries.length} payloads; ` +
        `draining only ${max} on startup. Run \`errorcore drain\` to flush the rest.`
      );
    }
    const batch = entries.slice(0, max);

    let processedLineCount = 0;
    const sendAll = async () => {
      for (const entry of batch) {
        try {
          await this.transport.send({
            serialized: entry.payload,
            envelope: parseEnvelopeMetadata(entry.payload)
          });
          processedLineCount = entry.lineNumber;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          safeConsole.warn(
            `[ErrorCore] Dead-letter retry failed after line ${processedLineCount}/${lineCount}: ${message}`
          );
          break;
        }
      }

      if (processedLineCount > 0) {
        // If we successfully sent every entry in the batch AND the batch
        // covered every valid entry drain() returned, clear the whole
        // file by its line count. That also removes any interleaved lines
        // that drain() skipped as invalid/unsigned, which would otherwise
        // accumulate. Otherwise clear only up through the last line we
        // actually sent.
        const drainedEverything =
          processedLineCount === batch[batch.length - 1]?.lineNumber &&
          batch.length === entries.length;
        this.deadLetterStore!.clearSent(
          drainedEverything ? lineCount : processedLineCount
        );
      }
    };

    void sendAll().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Dead-letter drain failed: ${message}`);
    });
  }

  public captureError(error: Error): void {
    // Allow capture during the active phase and during the shutting-down
    // phase. During shutdown the transport is still up and the capturer
    // can still enqueue; this prevents a silent drop of the final error
    // batch that arrives while a SIGTERM-triggered flush is running.
    if (this.state !== 'active' && this.state !== 'shutting_down') {
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

    return this.als.runWithContext(context, fn);
  }

  public withTraceContext<T>(input: TraceContextInput, fn: () => T): T {
    if (this.als.getContext() !== undefined) {
      return fn();
    }

    const context = this.als.createRequestContext({
      method: input.method ?? 'INTERNAL',
      url: input.url ?? 'withTraceContext',
      headers: input.headers ?? {},
      traceparent: input.traceparent,
      tracestate: input.tracestate
    });

    return this.als.runWithContext(context, fn);
  }

  public getTraceHeaders(): TraceHeaders | null {
    return this.als.getTraceHeaders();
  }

  public async flush(): Promise<void> {
    // flush() is called from user code (typically in graceful shutdown
    // paths) and from the shutdown sequence itself. Allow it during the
    // shutting-down phase so in-flight captures still reach the transport.
    if (this.state !== 'active' && this.state !== 'shutting_down') {
      return;
    }

    await this.errorCapturer.flush();
    await this.transport.flush();
  }

  public isActive(): boolean {
    return this.state === 'active';
  }

  public getWatchdog(): WatchdogManager | null {
    return this.watchdog;
  }

  /**
   * Returns a point-in-time snapshot of the SDK's self-observability
   * state. Safe to call from any SDK state, including before activate()
   * and after shutdown(). Never throws.
   *
   * Counters (captured, dropped, droppedBreakdown.*, transportFailures)
   * are monotonic since init(). Operators scrape this on an interval
   * and compute rates by differencing — matching the Prometheus counter
   * convention.
   *
   * Typical use:
   *   app.get('/healthz', (_, res) => res.json(errorcore.getHealth()));
   */
  public getHealth(): HealthSnapshot {
    const breakdown = this.healthMetrics.getDroppedBreakdown();
    const lastFailure = this.healthMetrics.getLastFailure();
    const bufferStats = this.buffer.getStats();

    return {
      captured: this.healthMetrics.getCaptured(),
      dropped:
        breakdown.rateLimited +
        breakdown.captureFailed +
        breakdown.deadLetterWriteFailed,
      droppedBreakdown: breakdown,
      transportFailures: this.healthMetrics.getTransportFailures(),
      transportQueueDepth: this.errorCapturer.getPendingTransportCount(),
      deadLetterDepth: this.deadLetterStore?.getPendingCount() ?? 0,
      deadLetter: this.deadLetterHealth,
      ioBufferDepth: bufferStats.slotCount,
      flushLatencyP50: this.healthMetrics.getLatencyPercentile(0.5),
      flushLatencyP99: this.healthMetrics.getLatencyPercentile(0.99),
      lastFailureReason: lastFailure.reason,
      lastFailureAt: lastFailure.at
    };
  }

  public async shutdown(): Promise<void> {
    if (this.state === 'shutdown') {
      return;
    }

    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }

    this.state = 'shutting_down';
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    try {
      this.channelSubscriber.unsubscribeAll();
      if (this.fetchWrapperUninstall !== null) {
        this.fetchWrapperUninstall();
        this.fetchWrapperUninstall = null;
      }
      this.patchManager.unwrapAll();
      this.httpServerRecorder.shutdown();
      this.httpClientRecorder.shutdown();
      this.undiciRecorder.shutdown();
      this.netDnsRecorder.shutdown();
      this.inspector.shutdown();
      this.processMetadata.shutdown();
      this.requestTracker.shutdown();
      await this.watchdog?.shutdown();

      for (const timer of this.timers) {
        clearTimeout(timer as NodeJS.Timeout);
      }

      await this.errorCapturer.shutdown({ timeoutMs: 5000 });
      await this.transport.flush();
      await this.transport.shutdown({ timeoutMs: 5000 });
      this.buffer.clear();
    } finally {
      for (const listener of this.processListeners) {
        process.removeListener(listener.event, listener.handler);
      }

      this.processListeners.length = 0;
      this.state = 'shutdown';
      this.fatalExitInProgress = false;
    }
  }

  private emitDiagnosticsIfNeeded(): void {
    if (this.config.onInternalWarning === undefined) {
      return;
    }

    const diagnostics = this.errorCapturer.getDiagnostics();

    if (diagnostics.dropped > 0) {
      try {
        this.config.onInternalWarning({
          code: 'EC_PAYLOADS_DROPPED',
          message: `${diagnostics.dropped} error package(s) could not be delivered or dead-lettered`,
          context: { count: diagnostics.dropped }
        });
      } catch {
        // onInternalWarning must never crash the host.
      }
    }

    if (diagnostics.deadLettered > 0) {
      try {
        this.config.onInternalWarning({
          code: 'EC_PAYLOADS_DEAD_LETTERED',
          message: `${diagnostics.deadLettered} error package(s) stored in dead-letter queue for retry`,
          context: { count: diagnostics.deadLettered }
        });
      } catch {
        // onInternalWarning must never crash the host.
      }
    }
  }

  public enableAutoShutdown(): void {
    if (this.config.serverless) {
      return;
    }

    const sigtermHandler = async () => {
      try { await this.shutdown(); } finally { process.kill(process.pid, 'SIGTERM'); }
    };
    const sigintHandler = async () => {
      try { await this.shutdown(); } finally { process.kill(process.pid, 'SIGINT'); }
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

    // Snapshot listener count before registering so we know if the SDK is
    // the only handler. If it is, emit a process warning after capture so
    // Node's default unhandledRejection behavior is preserved.
    const preExistingRejectionListenerCount = process.listenerCount('unhandledRejection');

    const unhandledRejectionHandler = (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));

      this.errorCapturer.capture(error);

      // If the SDK is the only unhandledRejection listener, emit a warning
      // so Node's default behavior (log + future termination) is preserved.
      const currentCount = process.listenerCount('unhandledRejection');
      if (currentCount === preExistingRejectionListenerCount + 1) {
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(
          `Unhandled promise rejection captured by ErrorCore: ${message}`,
          'UnhandledPromiseRejectionWarning'
        );
      }
    };

    process.on('unhandledRejection', unhandledRejectionHandler);
    this.processListeners.push({ event: 'unhandledRejection', handler: unhandledRejectionHandler });

    if (!this.config.serverless) {
      // Snapshot the uncaughtException listener count so we know, at fire
      // time, whether the SDK is the only listener. If the host app has its
      // own uncaughtException handler we must NOT force process.exit: Node
      // only exits by default when nobody is listening, and the host may
      // intentionally keep the process alive.
      const preExistingUncaughtListenerCount = process.listenerCount('uncaughtException');

      const uncaughtExceptionHandler = (error: Error) => {
        if (this.fatalExitInProgress) {
          return;
        }

        this.fatalExitInProgress = true;
        this.errorCapturer.capture(error, { isUncaught: true });

        const currentCount = process.listenerCount('uncaughtException');
        const sdkIsOnlyListener = currentCount === preExistingUncaughtListenerCount + 1;

        if (!sdkIsOnlyListener) {
          // Host has its own handler. Let it decide. We have already
          // captured the error above.
          return;
        }

        // No host handler. Node would otherwise terminate the process
        // after our listener returns; we mirror that with a bounded-time
        // shutdown so the transport gets a chance to flush.
        const exitNow = () => {
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
      // beforeExit fires synchronously, but Node continues running the
      // event loop if a listener schedules new async work. Returning the
      // shutdown promise from an async listener keeps the loop alive long
      // enough for flush to complete before exit.
      const beforeExitHandler = async (): Promise<void> => {
        await this.shutdown().catch(() => undefined);
      };

      process.on('uncaughtException', uncaughtExceptionHandler);
      process.on('beforeExit', beforeExitHandler);

      this.processListeners.push({ event: 'uncaughtException', handler: uncaughtExceptionHandler });
      this.processListeners.push({ event: 'beforeExit', handler: beforeExitHandler });
    }
  }
}

export function createSDK(userConfig: Partial<SDKConfig> = {}): SDKInstance {
  const config = resolveEncryptionKeyCallback(resolveConfig(userConfig));
  setLogLevel(config.logLevel);
  const transportAuthorization = getTransportAuthorization(userConfig.transport);
  const eventClock = new EventClock();
  const buffer = new IOEventBuffer({
    capacity: config.bufferSize,
    maxBytes: config.bufferMaxBytes,
    eventClock
  });
  const als = new ALSManager({ eventClock, config });
  const headerFilter = new HeaderFilter(config);
  const scrubber = new Scrubber(config);
  const rateLimiter = new RateLimiter({
    maxCaptures: config.rateLimitPerMinute,
    windowMs: config.rateLimitWindowMs
  });
  const packageAssemblyEncryption = createPackageAssemblyEncryptionConfig(config);
  const encryption = createEncryptionFromAssemblyConfig(packageAssemblyEncryption);
  const processMetadata = new ProcessMetadata(config);
  const inspector = new InspectorManager(config, {
    getRequestId: () => als.getRequestId(),
    eventClock
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
  const stateTracker = new StateTracker({ als, eventClock, config });
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
    headerFilter,
    bodyCapture
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
  const deadLetterVerifier = deriveDeadLetterVerifier(
    encryption,
    config,
    transportAuthorization
  );
  const deadLetterStore =
    config.deadLetterPath !== undefined
      ? deadLetterVerifier === null
        ? null
        : new DeadLetterStore(config.deadLetterPath, {
            verifier: deadLetterVerifier,
            maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
            requireEncryptedPayload: config.encryptionKey !== undefined,
            onInternalWarning: config.onInternalWarning === undefined
              ? undefined
              : (warning) => {
                  try {
                    config.onInternalWarning!(warning);
                  } catch {
                    // onInternalWarning must never crash the host.
                  }
                }
          })
      : null;

  if (config.deadLetterPath !== undefined && deadLetterVerifier === null) {
    // Design note: Disable automatic dead-letter replay when no stable secret
    // is configured because unsigned disk content cannot be trusted safely.
    safeConsole.warn(
      '[ErrorCore] Dead-letter persistence is disabled because no encryptionKey or HTTP authorization secret is configured.'
    );
    try {
      config.onInternalWarning?.({
        code: 'EC_DLQ_DISABLED',
        message: 'Dead-letter persistence is disabled because no stable signing secret is configured.',
        context: { reason: 'unsigned' }
      });
    } catch {
    }
  }
  const deadLetterHealth: DeadLetterHealthState =
    config.deadLetterPath === undefined
      ? { enabled: false, signed: false, reason: 'not_configured' }
      : deadLetterStore === null
        ? { enabled: false, signed: false, reason: 'unsigned' }
        : { enabled: true, signed: true, reason: 'configured' };
  const sourceMapResolver = config.resolveSourceMaps
    ? new SourceMapResolver({
        sourceMapSyncThresholdBytes: config.sourceMapSyncThresholdBytes
      })
    : null;

  // Pre-populate the source map cache so the first error capture doesn't
  // block the event loop with synchronous file I/O for common app files.
  if (sourceMapResolver !== null) {
    sourceMapResolver.warmCache();
  }
  const packageAssemblyDispatcher = config.useWorkerAssembly
    ? new PackageAssemblyDispatcher({ config, encryption: packageAssemblyEncryption })
    : null;
  let watchdog: WatchdogManager | null = null;
  if (config.serverless && config.transport.type === 'http') {
    watchdog = new WatchdogManager(config, transportAuthorization);
    watchdog.start();
  }

  const healthMetrics = new HealthMetrics();

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
    eventClock,
    packageAssemblyDispatcher,
    stateTrackerStatus: stateTracker,
    deadLetterStore,
    sourceMapResolver,
    watchdog,
    healthMetrics
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
    bodyCapture,
    deadLetterStore,
    watchdog,
    healthMetrics,
    deadLetterHealth
  });
}
