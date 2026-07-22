
import { safeConsole } from './debug-log';
import {
  detectBundler,
  isNextJsNodeRuntime,
  formatStartupLine,
  formatWarnGuidance,
  type RecorderState
} from './sdk-diagnostics';
import { IOEventBuffer } from './buffer/io-event-buffer';
import { ALSManager } from './context/als-manager';
import { RequestTracker } from './context/request-tracker';
import { RequestContextCarrier } from './context/request-context-carrier';
import { HeaderFilter } from './pii/header-filter';
import { ProcessMetadata } from './capture/process-metadata';
import { InspectorManager } from './capture/inspector-manager';
import { BodyCapture } from './recording/body-capture';
import { PayloadSpool } from './spool/payload-spool';
import { StateTracker } from './state/state-tracker';
import { HttpServerRecorder } from './recording/http-server';
import { HttpClientRecorder } from './recording/http-client';
import { UndiciRecorder } from './recording/undici';
import {
  installFetchWrapper,
  type FetchWrapperHandle
} from './recording/fetch-wrapper';
import { NetDnsRecorder } from './recording/net-dns';
import { PatchManager } from './recording/patches/patch-manager';
import { ChannelSubscriber } from './recording/channel-subscriber';
import { TransportDispatcher } from './transport/transport';
import { parseEnvelopeMetadata } from './transport/payload';
import { DeadLetterStore } from './transport/dead-letter-store';
import { ErrorCapturer } from './capture/error-capturer';
import { normalizeThrown } from './capture/normalize-thrown';
import { PackageAssemblyController } from './capture/package-assembly-controller';
import { SourceMapResolver } from './capture/source-map-resolver';
import { WatchdogManager } from './middleware/watchdog';
import { HealthMetrics } from './health/health-metrics';
import type { HealthSnapshot } from './health/types';
import { CaptureModeController, type SDKLifecycleState } from './capture-mode-controller';
import { createSDKComposition } from './sdk-factory';
import type {
  DeadLetterHealthState,
  ProcessListenerEntry,
  SDKInstanceInput
} from './sdk-instance-input';
import type {
  CaptureErrorOptions,
  CaptureMode,
  ModeState,
  ModeSwitchResult,
  RequestContext,
  ResolvedConfig,
  SDKConfig,
  TraceContextInput,
  TraceHeaders
} from './types';

function disabledRecorderState(): RecorderState {
  return { state: 'skip', reason: 'disabled' };
}

export class SDKInstance {
  private state: SDKLifecycleState = 'created';

  private captureAdmissionOpen = true;

  private fatalExitInProgress = false;

  private shutdownPromise: Promise<void> | null = null;

  private readonly timers: Array<NodeJS.Timeout | NodeJS.Timer> = [];

  private flushTimer: NodeJS.Timeout | null = null;

  private readonly modeProcessListeners: ProcessListenerEntry[] = [];

  private readonly autoShutdownListeners: ProcessListenerEntry[] = [];

  private readonly httpServerRecorder: HttpServerRecorder;

  private readonly httpClientRecorder: HttpClientRecorder;

  private readonly undiciRecorder: UndiciRecorder;

  private readonly netDnsRecorder: NetDnsRecorder;

  private fetchWrapperHandle: FetchWrapperHandle | null = null;

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

  private readonly requestContextCarrier: RequestContextCarrier;

  private payloadSpool: PayloadSpool | null;

  private sourceMapResolver: SourceMapResolver | null;

  private readonly packageAssemblyController: PackageAssemblyController;

  private readonly modeController: CaptureModeController;

  public constructor(input: SDKInstanceInput) {
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
    this.requestContextCarrier = input.requestContextCarrier;
    this.payloadSpool = input.payloadSpool;
    this.sourceMapResolver = input.sourceMapResolver;
    this.packageAssemblyController = new PackageAssemblyController({
      config: this.config,
      errorCapturer: this.errorCapturer,
      dispatcher: input.packageAssemblyDispatcher,
      encryption: input.packageAssemblyEncryption,
      workerAllowed: input.packageAssemblyWorkerAllowed
    });
    this.modeController = new CaptureModeController(this.config, {
      getLifecycleState: () => this.state,
      setHttpServerRecorderEnabled: (enabled) => {
        if (enabled) this.httpServerRecorder.install();
        else this.httpServerRecorder.shutdown();
      },
      updateChannelSubscriptions: (recorders) => {
        this.channelSubscriber.subscribeAll({
          httpServer: recorders.httpServer,
          httpClient: recorders.httpClient,
          undici: recorders.undici,
          netDns: recorders.netDns
        });
      },
      setFetchRecorderEnabled: (enabled, modeState) => {
        if (enabled) {
          this.ensureFetchWrapperInstalled(modeState);
        } else if (this.fetchWrapperHandle !== null) {
          this.fetchWrapperHandle.uninstall();
          this.fetchWrapperHandle = null;
        }
      },
      setNetDnsRecorderEnabled: (enabled) => {
        if (enabled) this.netDnsRecorder.install();
        else this.netDnsRecorder.shutdown();
      },
      setDatabaseRecordersEnabled: (enabled) => {
        if (enabled) this.patchManager.installAll();
        else this.patchManager.unwrapAll();
      },
      setProcessHandlersEnabled: (enabled) => {
        if (enabled) this.registerProcessHandlers();
        else this.unregisterProcessHandlers();
      },
      setEventLoopLagMonitorEnabled: (enabled) => {
        if (enabled) this.processMetadata.startEventLoopLagMeasurement();
        else this.processMetadata.shutdown();
      },
      applyResolvedConfig: (modeState) => this.applyModeStateToConfig(modeState),
      applyRuntimeResources: (modeState) => this.applyRuntimeResources(modeState),
      applyInspectorModeState: (modeState) => this.inspector.applyModeState?.(modeState),
      setLocalVariablesCaptureEnabled: (enabled) => {
        if (enabled) this.inspector.ensureDebuggerActive();
        else this.inspector.disarmDebugger?.();
      },
      flushBeforeTimerRestart: () => this.flush(),
      restartFlushTimer: () => this.restartFlushTimer(),
      rearmAfterAdaptiveGuard: () => this.inspector.rearmAfterAdaptiveGuard()
    });
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
        '  node -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\') + \'\\n\')"'
      );
    }

    const modeState = this.modeController.getModeState();
    if (modeState.recorders.httpServer) {
      this.httpServerRecorder.install();
    }

    if (
      modeState.recorders.httpServer ||
      modeState.recorders.httpClient ||
      modeState.recorders.undici ||
      modeState.recorders.netDns
    ) {
      this.channelSubscriber.subscribeAll({
        httpServer: modeState.recorders.httpServer,
        httpClient: modeState.recorders.httpClient,
        undici: modeState.recorders.undici,
        netDns: modeState.recorders.netDns
      });
    }

    if (modeState.recorders.fetch) {
      this.ensureFetchWrapperInstalled();
    }

    if (modeState.recorders.netDns) {
      this.netDnsRecorder.install();
    }

    if (modeState.recorders.database) {
      this.patchManager.installAll();
    }

    if (modeState.recorders.processHandlers) {
      this.registerProcessHandlers();
    }

    // Eagerly warm the V8 inspector so the first error in the process
    // actually triggers Debugger.paused. Without this, the inspector is
    // lazily initialized on the first getLocals() call - by which time
    // the exception has already propagated past any pause-on-exceptions
    // handler, so Layer 1 tag installation never runs and the ring buffer
    // stays empty for that first error.
    if (
      modeState.captureLocalVariables &&
      modeState.localVariablesMode !== 'none'
    ) {
      this.inspector.ensureDebuggerActive();
    }

    if (!this.config.serverless && modeState.capabilities.eventLoopLagMonitor) {
      this.processMetadata.startEventLoopLagMeasurement();
    }

    // In serverless mode, deadLetterStore is null (deadLetterPath is undefined),
    // so drainDeadLetters() is already a no-op.
    if (modeState.recorders.transport) {
      this.drainDeadLetters();
    }

    this.restartFlushTimer();

    this.state = 'active';
    this.modeController.activate();

    if (!this.config.silent) {
      this.emitStartupDiagnostic();
    }
  }

  private emitStartupDiagnostic(): void {
    const recorders: Record<string, RecorderState> = {
      'http-server': this.config.recorders.httpServer
        ? this.httpServerRecorder.getState()
        : disabledRecorderState(),
      'http-client': this.config.recorders.httpClient
        ? this.httpClientRecorder.getState()
        : disabledRecorderState(),
      'undici': this.config.recorders.undici
        ? this.undiciRecorder.getState()
        : disabledRecorderState(),
      'net': this.config.recorders.netDns
        ? this.netDnsRecorder.getState()
        : disabledRecorderState(),
      'dns': this.config.recorders.netDns
        ? this.netDnsRecorder.getState()
        : disabledRecorderState(),
      ...(this.config.recorders.database
        ? this.patchManager.getRecorderStates()
        : {
            pg: disabledRecorderState(),
            mysql2: disabledRecorderState(),
            ioredis: disabledRecorderState(),
            mongodb: disabledRecorderState()
          }),
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
    safeConsole.alwaysInfo(line);
    const isNextJs = isNextJsNodeRuntime();
    for (const [name, state] of Object.entries(recorders)) {
      const guidance = formatWarnGuidance(name, state, { isNextJs });
      if (guidance !== null) safeConsole.alwaysInfo(guidance);
    }
    if (detectBundler() === 'unknown') {
      const dbNames = ['pg', 'mongodb', 'mysql2', 'ioredis'];
      const anyDbOk = dbNames.some((n) => recorders[n]?.state === 'ok');
      if (anyDbOk) {
        safeConsole.alwaysInfo(
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

  private restartFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      const index = this.timers.indexOf(this.flushTimer);
      if (index >= 0) {
        this.timers.splice(index, 1);
      }
      this.flushTimer = null;
    }

    const modeState = this.modeController.getModeState();
    if (!modeState.recorders.transport || modeState.flushIntervalMs <= 0) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.emitDiagnosticsIfNeeded();
      void this.flush().catch(() => undefined);
    }, modeState.flushIntervalMs);
    this.flushTimer.unref();
    this.timers.push(this.flushTimer);
  }

  private ensurePayloadSpool(): PayloadSpool {
    if (this.payloadSpool !== null) {
      return this.payloadSpool;
    }

    this.payloadSpool = new PayloadSpool({
      globalMaxBytes: this.config.payloadSpool.globalMaxBytes,
      perRequestMaxBytes: this.config.payloadSpool.perRequestMaxBytes,
      perBlobMaxBytes: this.config.payloadSpool.perBlobMaxBytes,
      previewBytes: this.config.payloadSpool.previewBytes,
      completedTtlMs: this.config.payloadSpool.completedTtlMs,
      getTransportQueueDepth: () => this.errorCapturer.getPendingTransportCount(),
      onWarning: (warning) => {
        if (warning.code === 'EC_PAYLOAD_SPOOL_PRESSURE') {
          this.healthMetrics.recordPayloadSpoolPressure();
        } else if (warning.code === 'EC_PAYLOAD_SPOOL_PREVIEW') {
          this.healthMetrics.recordPayloadSpoolPreviewFallback();
        } else if (warning.code === 'EC_PAYLOAD_SPOOL_DROPPED') {
          this.healthMetrics.recordPayloadSpoolDrop();
        }

        try {
          this.config.onInternalWarning?.(warning);
        } catch {
          // onInternalWarning must never crash the host.
        }
      }
    });

    this.errorCapturer.setPayloadSpool(this.payloadSpool);
    return this.payloadSpool;
  }

  private ensureSourceMapResolver(): SourceMapResolver {
    if (this.sourceMapResolver !== null) {
      return this.sourceMapResolver;
    }

    this.sourceMapResolver = new SourceMapResolver({
      sourceMapSyncThresholdBytes: this.config.sourceMapSyncThresholdBytes
    });
    this.sourceMapResolver.warmCache();
    this.errorCapturer.setSourceMapResolver(this.sourceMapResolver);
    return this.sourceMapResolver;
  }

  private async applyRuntimeResources(next: ModeState): Promise<void> {
    const activePayloadSpool = next.payloadSpool.enabled ? this.ensurePayloadSpool() : null;
    if (next.resolveSourceMaps) {
      this.ensureSourceMapResolver();
    }

    // postMessage() happens synchronously before this promise yields. Apply
    // the remaining in-process policy as one synchronous block so captures
    // admitted while the worker ACK is pending cannot observe a new ModeState
    // with stale body/spool resources. Worker-port FIFO still orders the
    // config update ahead of any newly admitted worker assembly.
    const packageAssemblyUpdate = this.packageAssemblyController.applyModeState(next);

    this.bodyCapture.applyModeState?.(next, activePayloadSpool);
    this.httpServerRecorder.applyPayloadSpool(activePayloadSpool);
    this.errorCapturer.setPayloadSpool(this.payloadSpool);
    this.errorCapturer.setSourceMapResolver(this.sourceMapResolver);
    await packageAssemblyUpdate;
  }

  public handleAdmittedCapture(modeAtCapture: ModeState): void {
    this.modeController.handleAdmittedCapture(modeAtCapture);
  }

  public getModeState(): ModeState {
    return this.modeController.getModeState();
  }

  public getCaptureMode(): CaptureMode {
    return this.modeController.getCaptureMode();
  }

  public setCaptureMode(mode: CaptureMode): Promise<ModeSwitchResult> {
    return this.modeController.setCaptureMode(mode);
  }

  private applyModeStateToConfig(next: ModeState): void {
    const mutable = this.config as ResolvedConfig;
    mutable.captureMode = next.captureMode;
    mutable.localVariablesMode = next.localVariablesMode;
    mutable.capabilities = next.capabilities;
    mutable.recorders = next.recorders;
    mutable.modeState = next;
    mutable.captureLocalVariables = next.captureLocalVariables;
    mutable.localsGuard = next.localsGuard;
    mutable.captureDbBindParams = next.captureDbBindParams;
    mutable.captureRequestBodies = next.captureRequestBodies;
    mutable.captureResponseBodies = next.captureResponseBodies;
    mutable.captureBody = next.captureBody;
    mutable.captureBodyDigest = next.captureBodyDigest;
    mutable.payloadSpool = next.payloadSpool;
    mutable.maxLocalsCollectionsPerSecond = next.maxLocalsCollectionsPerSecond;
    mutable.maxCachedLocals = next.maxCachedLocals;
    mutable.maxLocalsFrames = next.maxLocalsFrames;
    mutable.useWorkerAssembly = next.useWorkerAssembly;
    mutable.flushIntervalMs = next.flushIntervalMs;
    mutable.resolveSourceMaps = next.resolveSourceMaps;
  }

  public captureError(error: unknown, options?: CaptureErrorOptions): void {
    // Allow capture during the active phase and during the shutting-down
    // phase. During shutdown the transport is still up and the capturer
    // can still enqueue; this prevents a silent drop of the final error
    // batch that arrives while a SIGTERM-triggered flush is running.
    if (
      this.state !== 'active' &&
      (this.state !== 'shutting_down' || !this.captureAdmissionOpen)
    ) {
      return;
    }

    this.errorCapturer.capture(normalizeThrown(error, this.config), options);
  }

  public getRequestContextForRequest(request: object): RequestContext | undefined {
    return this.requestContextCarrier.get(request);
  }

  public setRequestContextForRequest(request: object, context: RequestContext): void {
    this.requestContextCarrier.set(request, context);
  }

  public claimRequestCleanupForRequest(request: object): boolean {
    return this.requestContextCarrier.claimCleanupRegistration(request);
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

  public prepareForRequestStart(): void {
    const modeState = this.modeController.getModeState();
    if (modeState.recorders.fetch) {
      this.ensureFetchWrapperInstalled(modeState);
    }

    if (
      !modeState.captureLocalVariables ||
      modeState.localVariablesMode === 'none'
    ) {
      return;
    }

    if (this.inspector.isDebuggerActive()) {
      return;
    }

    try {
      this.inspector.ensureDebuggerActive();
    } catch {
      // Local-variable capture is best-effort and must not affect request handling.
    }
  }

  public releaseCompletedRequestContext(
    context: RequestContext,
    clearContext = false
  ): void {
    for (const slot of context.ioEvents) {
      this.buffer.compactDetachedSlot(
        slot,
        (entry) => this.bodyCapture.releaseSlotBodies(entry)
      );
    }
    this.buffer.releaseCompletedRequest(
      context.requestId,
      (slot) => this.bodyCapture.releaseSlotBodies(slot)
    );

    if (clearContext) {
      context.ioEvents.length = 0;
      context.stateReads.length = 0;
      context.stateWrites.length = 0;
      context.body = null;
      context.bodyTruncated = false;
      context.headers = {};
      context.completenessOverflow = undefined;
    }
  }

  private ensureFetchWrapperInstalled(modeState: ModeState = this.modeController.getModeState()): void {
    // Frameworks such as Next.js can replace globalThis.fetch after SDK init.
    // Re-checking at request entry lets the wrapper follow the live fetch. If
    // another wrapper retained our old function, deactivate it before adding
    // one outer wrapper so the buried copy becomes a dependency-free pass-through.
    if (this.fetchWrapperHandle !== null) {
      this.fetchWrapperHandle.updateCaptureResponseBodies(
        modeState.captureResponseBodies
      );
      if (this.fetchWrapperHandle.isCurrent()) {
        return;
      }

      this.fetchWrapperHandle.uninstall();
      this.fetchWrapperHandle = null;
    }

    const fetchHandle = installFetchWrapper({
      als: this.als,
      bodyCapture: this.bodyCapture,
      buffer: this.buffer,
      headerFilter: this.headerFilter,
      captureResponseBodies: modeState.captureResponseBodies
    });

    if (fetchHandle.state.state === 'ok') {
      this.fetchWrapperHandle = fetchHandle;
    }
  }

  /**
   * Returns a point-in-time snapshot of the SDK's self-observability
   * state. Safe to call from any SDK state, including before activate()
   * and after shutdown(). Never throws.
   *
   * Counters (captured, dropped, droppedBreakdown.*, transportFailures,
   * payloadSpool.*)
   * are monotonic since init(). Operators scrape this on an interval
   * and compute rates by differencing - matching the Prometheus counter
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
      captureMode: this.modeController.getCaptureMode(),
      adaptive: this.modeController.getAdaptiveHealth(),
      captured: this.healthMetrics.getCaptured(),
      dropped:
        breakdown.rateLimited +
        breakdown.captureFailed +
        breakdown.deadLetterWriteFailed,
      droppedBreakdown: breakdown,
      transportFailures: this.healthMetrics.getTransportFailures(),
      payloadSpool: this.healthMetrics.getPayloadSpoolBreakdown(),
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
      await this.modeController.shutdown();
      this.channelSubscriber.unsubscribeAll();
      if (this.fetchWrapperHandle !== null) {
        this.fetchWrapperHandle.uninstall();
        this.fetchWrapperHandle = null;
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
      this.als.shutdown();

      for (const timer of this.timers) {
        clearTimeout(timer as NodeJS.Timeout);
      }
      await this.packageAssemblyController.shutdown();
      // Captures remain admissible during early teardown while transports and
      // the inline assembler are usable. Close admission synchronously before
      // the final capturer drain so no new deferred package can land behind it.
      this.captureAdmissionOpen = false;
      await this.errorCapturer.shutdown({ timeoutMs: 5000 });
      if (this.config.recorders.transport) {
        await this.transport.flush();
        await this.transport.shutdown({ timeoutMs: 5000 });
      }
      this.buffer.clear();
    } finally {
      for (const listener of [...this.modeProcessListeners, ...this.autoShutdownListeners]) {
        process.removeListener(listener.event, listener.handler);
      }

      this.modeProcessListeners.length = 0;
      this.autoShutdownListeners.length = 0;
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
    this.autoShutdownListeners.push({ event: 'SIGTERM', handler: sigtermHandler, once: true });
    this.autoShutdownListeners.push({ event: 'SIGINT', handler: sigintHandler, once: true });
  }

  private unregisterProcessHandlers(): void {
    for (const listener of this.modeProcessListeners) {
      process.removeListener(listener.event, listener.handler);
    }
    this.modeProcessListeners.length = 0;
  }

  private registerProcessHandlers(): void {
    this.unregisterProcessHandlers();

    // Snapshot listener count before registering so we know if the SDK is
    // the only handler. If it is, emit a process warning after capture so
    // Node's default unhandledRejection behavior is preserved.
    const preExistingRejectionListenerCount = process.listenerCount('unhandledRejection');

    const unhandledRejectionHandler = (reason: unknown) => {
      const error = normalizeThrown(reason, this.config);

      try {
        this.errorCapturer.capture(error);
      } catch {
        // SDK capture failures must never change host rejection behavior.
      }

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
    this.modeProcessListeners.push({ event: 'unhandledRejection', handler: unhandledRejectionHandler });

    if (!this.config.serverless) {
      // Snapshot the uncaughtException listener count so we know, at fire
      // time, whether the SDK is the only listener. If the host app has its
      // own uncaughtException handler we must NOT force process.exit: Node
      // only exits by default when nobody is listening, and the host may
      // intentionally keep the process alive.
      const preExistingUncaughtListenerCount = process.listenerCount('uncaughtException');

      const uncaughtExceptionHandler = (thrown: unknown) => {
        if (this.fatalExitInProgress) {
          return;
        }

        this.fatalExitInProgress = true;
        const error = normalizeThrown(thrown, this.config);
        try {
          this.errorCapturer.capture(error, { isUncaught: true });
        } catch {
          // Preserve host uncaughtException behavior even if ErrorCore fails.
        }

        const currentOtherListenerCount = process
          .listeners('uncaughtException')
          .filter((listener) => listener !== uncaughtExceptionHandler).length;
        const hasHostUncaughtListener =
          preExistingUncaughtListenerCount > 0 || currentOtherListenerCount > 0;

        if (hasHostUncaughtListener) {
          // Host has its own handler. Let it decide. We have already
          // captured the error above.
          this.fatalExitInProgress = false;
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

      this.modeProcessListeners.push({ event: 'uncaughtException', handler: uncaughtExceptionHandler });
      this.modeProcessListeners.push({ event: 'beforeExit', handler: beforeExitHandler });
    }
  }
}

export function createSDK(userConfig: Partial<SDKConfig> = {}): SDKInstance {
  return createSDKComposition(userConfig, (input) => new SDKInstance(input));
}
