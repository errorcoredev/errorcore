
import { STANDARD_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import { createDebug } from '../debug';
import type { Encryption } from '../security/encryption';
import type { RateLimiter } from '../security/rate-limiter';
import type { ALSManager } from '../context/als-manager';
import { EventClock } from '../context/event-clock';
import type { HealthMetrics } from '../health/health-metrics';
import { HTTP_TRANSPORT_TIMEOUT_MESSAGE } from '../transport/http-transport';

const debug = createDebug('capturer');
import type { RequestTracker } from '../context/request-tracker';
import type { InspectorManager, LocalsWithDiagnostics } from './inspector-manager';
import { finalizePackageAssemblyResult } from './package-builder';
import { computeFingerprint } from './fingerprint';
import type { PackageBuilder } from './package-builder';
import type { ProcessMetadata } from './process-metadata';
import type { DeadLetterStore } from '../transport/dead-letter-store';
import type { SourceMapResolver } from './source-map-resolver';
import type {
  AmbientEventContext,
  ErrorInfo,
  EvictionRecord,
  ErrorPackage,
  ErrorPackageParts,
  ErrorPackageRequestContextData,
  InternalWarning,
  InternalWarningCode,
  IOEventSlot,
  PackageAssemblyResult,
  RequestContext,
  ResolvedConfig,
  TimeAnchor
} from '../types';

interface IOEventBufferLike {
  filterByRequestId(requestId: string): IOEventSlot[];
  getRecent(count: number): IOEventSlot[];
  getRecentWithContext(count: number): { events: IOEventSlot[]; context: AmbientEventContext };
  getOverflowCount(): number;
  getEvictionLog(): EvictionRecord[];
}

interface TransportLike {
  send(payload: string): Promise<void> | void;
}

interface BodyCaptureLike {
  materializeSlotBodies(slot: IOEventSlot): void;
  materializeContextBody(context: RequestContext): void;
}

interface PackageAssemblyDispatcherLike {
  isAvailable(): boolean;
  assemble(
    parts: ErrorPackageParts,
    options?: { timeoutMs?: number }
  ): Promise<PackageAssemblyResult>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

interface StateTrackerStatusLike {
  isTrackingEnabled(): boolean;
}

export interface CaptureDeliveryDiagnostics {
  sent: number;
  deadLettered: number;
  dropped: number;
}

// Matches Node's ErrnoException codes that indicate the disk refused to
// accept the write. Used to split generic write failures from
// out-of-space conditions so operators can route them differently.
const DISK_FULL_ERRNO_CODES = new Set<string>(['ENOSPC', 'EDQUOT']);

function classifyDlqWriteErrno(err: unknown): 'disk_full' | 'dead_letter_write_failed' {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && DISK_FULL_ERRNO_CODES.has(code)
    ? 'disk_full'
    : 'dead_letter_write_failed';
}

function emitSafeWarning(
  config: ResolvedConfig,
  warning: InternalWarning & { code: InternalWarningCode }
): void {
  // Preserve the human-readable console output so existing log-scraping
  // and tests don't regress. The structured callback is the new channel.
  console.warn(`[ErrorCore] ${warning.message}`);

  if (config.onInternalWarning !== undefined) {
    try {
      config.onInternalWarning(warning);
    } catch {
      // onInternalWarning must never crash the host.
    }
  }
}

function extractCustomProperties(error: Error): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
      continue;
    }

    try {
      properties[key] = (error as unknown as Record<string, unknown>)[key];
    } catch (propertyError) {
      properties[key] =
        propertyError instanceof Error
          ? `[Serialization error: ${propertyError.message}]`
          : '[Serialization error]';
    }
  }

  return properties;
}

function serializeError(
  error: Error,
  resolver: SourceMapResolver | null,
  depth = 0
): ErrorInfo {
  if (depth > 5) {
    return {
      type: 'Error',
      message: '[Cause chain depth limit]',
      stack: '',
      properties: {}
    };
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  const rawStack = error.stack || '';
  let resolvedStack = rawStack;
  let rawStackField: string | undefined;

  if (resolver !== null && rawStack.length > 0) {
    try {
      resolvedStack = resolver.resolveStack(rawStack);

      if (resolvedStack !== rawStack) {
        rawStackField = rawStack;
      }
    } catch {
      resolvedStack = rawStack;
    }
  }

  return {
    type: error.constructor?.name || 'Error',
    message: error.message || '',
    stack: resolvedStack,
    rawStack: rawStackField,
    cause: cause instanceof Error ? serializeError(cause, resolver, depth + 1) : undefined,
    properties: cloneAndLimit(extractCustomProperties(error), STANDARD_LIMITS) as Record<
      string,
      unknown
    >
  };
}

export class ErrorCapturer {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManager;

  private readonly inspector: InspectorManager;

  private readonly rateLimiter: RateLimiter;

  private readonly requestTracker: RequestTracker;

  private readonly processMetadata: ProcessMetadata;

  private readonly packageBuilder: PackageBuilder;

  private readonly transport: TransportLike;

  private readonly encryption: Encryption | null;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly config: ResolvedConfig;

  private readonly packageAssemblyDispatcher: PackageAssemblyDispatcherLike | null;

  private readonly stateTrackerStatus: StateTrackerStatusLike | null;

  private readonly deadLetterStore: DeadLetterStore | null;

  private readonly sourceMapResolver: SourceMapResolver | null;

  private readonly watchdog: { notifyErrorCaptured(error: Error): void } | null;

  private readonly healthMetrics: HealthMetrics | null;

  private readonly eventClock: EventClock;

  private readonly pendingTransportDispatches = new Set<Promise<void>>();

  private readonly deliveryDiagnostics: CaptureDeliveryDiagnostics = {
    sent: 0,
    deadLettered: 0,
    dropped: 0
  };

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManager;
    inspector: InspectorManager;
    rateLimiter: RateLimiter;
    requestTracker: RequestTracker;
    processMetadata: ProcessMetadata;
    packageBuilder: PackageBuilder;
    transport: TransportLike;
    encryption?: Encryption | null;
    bodyCapture: BodyCaptureLike;
    config: ResolvedConfig;
    eventClock?: EventClock;
    packageAssemblyDispatcher?: PackageAssemblyDispatcherLike | null;
    stateTrackerStatus?: StateTrackerStatusLike | null;
    deadLetterStore?: DeadLetterStore | null;
    sourceMapResolver?: SourceMapResolver | null;
    watchdog?: { notifyErrorCaptured(error: Error): void } | null;
    healthMetrics?: HealthMetrics | null;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.inspector = deps.inspector;
    this.rateLimiter = deps.rateLimiter;
    this.requestTracker = deps.requestTracker;
    this.processMetadata = deps.processMetadata;
    this.packageBuilder = deps.packageBuilder;
    this.transport = deps.transport;
    this.encryption = deps.encryption ?? null;
    this.bodyCapture = deps.bodyCapture;
    this.config = deps.config;
    // EventClock is optional for test ergonomics; the SDK composition root
    // always passes one shared instance (module 19 contract).
    this.eventClock = deps.eventClock ?? new EventClock();
    this.packageAssemblyDispatcher = deps.packageAssemblyDispatcher ?? null;
    this.stateTrackerStatus = deps.stateTrackerStatus ?? null;
    this.deadLetterStore = deps.deadLetterStore ?? null;
    this.sourceMapResolver = deps.sourceMapResolver ?? null;
    this.watchdog = deps.watchdog ?? null;
    this.healthMetrics = deps.healthMetrics ?? null;
  }

  public capture(error: Error, _options?: { isUncaught?: boolean }): ErrorPackage | null {
    const captureFailures: string[] = [];
    // Stamp the error event at function entry — module 20 contract. Captured
    // BEFORE the rate-limit check so the seq is consumed and observable as a
    // gap downstream even when the capture itself is dropped.
    const errorEventSeq = this.eventClock.tick();
    const errorEventHrtimeNs = process.hrtime.bigint();

    try {
      debug(`capture() called for ${error.name}: ${error.message}`);
      if (!this.rateLimiter.tryAcquire()) {
        debug('capture() rate-limited, dropping');
        this.healthMetrics?.recordDroppedRateLimited();
        emitSafeWarning(this.config, {
          code: 'rate_limited',
          message: `Rate limit exceeded (${this.config.rateLimitPerMinute} per ${this.config.rateLimitWindowMs}ms); error dropped.`
        });
        return null;
      }

      const rateLimiterDrops = this.rateLimiter.getAndResetDropSummary() ?? undefined;

      const serializedError = serializeError(error, this.sourceMapResolver);
      const sourceMapTelemetry = this.sourceMapResolver?.consumeTelemetry();
      const localsResult = this.safeGetLocals(error, captureFailures);
      const context = this.safeGetContext(captureFailures);
      const usedAmbientEvents = context === undefined;

      let ioTimeline: IOEventSlot[];
      let ambientContext: AmbientEventContext | undefined;

      if (context === undefined) {
        const result = this.buffer.getRecentWithContext(20);
        ioTimeline = result.events;
        ambientContext = result.context;
      } else {
        ioTimeline = this.buffer.filterByRequestId(context.requestId);
      }

      if (context !== undefined) {
        this.bodyCapture.materializeContextBody(context);
      }
      for (const event of ioTimeline) {
        this.bodyCapture.materializeSlotBodies(event);
      }
      const stateReads = context?.stateReads ?? [];
      const stateWrites = context?.stateWrites ?? [];
      const concurrentRequests = this.requestTracker.getSummaries();
      const stateTrackingEnabled =
        stateReads.length > 0 || this.stateTrackerStatus?.isTrackingEnabled() === true;
      const fingerprint = computeFingerprint(error, localsResult.frames ?? []);
      const parts: ErrorPackageParts = {
        errorEventSeq,
        errorEventHrtimeNs,
        error: {
          type: serializedError.type,
          message: serializedError.message,
          stack: serializedError.stack,
          rawStack: serializedError.rawStack,
          cause: serializedError.cause,
          properties: serializedError.properties
        },
        localVariables: localsResult.frames,
        localVariablesCaptureLayer: localsResult.captureLayer,
        localVariablesDegradation: localsResult.degradation,
        fingerprint,
        requestContext: this.toRequestContextData(context),
        ioTimeline,
        evictionLog: this.buffer.getEvictionLog(),
        ambientContext,
        stateReads,
        stateWrites,
        completenessOverflow: context?.completenessOverflow,
        concurrentRequests,
        processMetadata: this.processMetadata.getMergedMetadata(),
        timeAnchor: this.processMetadata.getTimeAnchor(),
        codeVersion: this.processMetadata.getCodeVersion(),
        environment: this.processMetadata.getEnvironment(),
        ioEventsDropped: this.buffer.getOverflowCount(),
        captureFailures,
        alsContextAvailable: context !== undefined,
        stateTrackingEnabled,
        usedAmbientEvents,
        rateLimiterDrops,
        traceContext: context ? {
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: context.parentSpanId,
          // Module 21: carry the INBOUND tracestate verbatim. The egress
          // version we emit on outbound HTTP is built fresh from the live
          // EventClock; that's not what the package records. Read from
          // RequestContext.inboundTracestate (set by ALSManager) — the
          // request's `headers` map has been filtered through the
          // headerAllowlist by the time it reaches the recorder, so it
          // does not retain `tracestate` by default.
          tracestate: context.inboundTracestate
        } : undefined,
        sourceMapResolution: sourceMapTelemetry
      };

      this.watchdog?.notifyErrorCaptured(error);

      if (
        this.packageAssemblyDispatcher !== null &&
        this.packageAssemblyDispatcher.isAvailable() &&
        !_options?.isUncaught &&
        this.config.piiScrubber === undefined
      ) {
        const promise = this.dispatchPackageAssembly(parts);
        this.pendingTransportDispatches.add(promise);
        promise.finally(() => this.pendingTransportDispatches.delete(promise));
        return null;
      }

      return this.captureInline(parts);
    } catch (captureError) {
      // Include name + truncated message rather than just the constructor
      // name. The previous behavior gave operators no way to distinguish,
      // for example, a RangeError from out-of-memory vs. a TypeError from
      // a bad scrubber return type.
      const detail =
        captureError instanceof Error
          ? `${captureError.name}: ${captureError.message.slice(0, 200)}`
          : 'unknown';
      emitSafeWarning(this.config, {
        code: 'capture_failed',
        message: `Error capture failed: ${detail} [code=errorcore_capture_failed]. If this recurs, check onInternalWarning for details.`,
        cause: captureError,
        context: { stage: 'primary', detail }
      });
      this.healthMetrics?.recordDroppedCaptureFailed();

      if (this.deadLetterStore !== null) {
        try {
          this.deadLetterStore.appendFailureMarkerSync('capture_failed');
        } catch {
        }
      }

      return null;
    }
  }

  private safeGetLocals(
    error: Error,
    captureFailures: string[]
  ): Pick<LocalsWithDiagnostics, 'frames' | 'captureLayer' | 'degradation'> {
    try {
      const result = this.inspector.getLocalsWithDiagnostics(error);

      if (result.frames === null && result.missReason !== null) {
        captureFailures.push(`locals: ${result.missReason}`);
      }

      return {
        frames: result.frames,
        captureLayer: result.captureLayer,
        degradation: result.degradation
      };
    } catch (inspectorError) {
      const message =
        inspectorError instanceof Error ? inspectorError.message : String(inspectorError);

      captureFailures.push(`locals: ${message}`);
      return { frames: null };
    }
  }

  private safeGetContext(captureFailures: string[]): RequestContext | undefined {
    try {
      return this.als.getContext();
    } catch (alsError) {
      const message = alsError instanceof Error ? alsError.message : String(alsError);

      captureFailures.push(`als: ${message}`);
      return undefined;
    }
  }

  public async flush(): Promise<void> {
    if (this.pendingTransportDispatches.size > 0) {
      await Promise.allSettled([...this.pendingTransportDispatches]);
    }
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.packageAssemblyDispatcher !== null) {
      await this.packageAssemblyDispatcher.shutdown(options);
    }

    if (this.pendingTransportDispatches.size > 0) {
      await Promise.allSettled([...this.pendingTransportDispatches]);
    }
  }

  public getDiagnostics(): CaptureDeliveryDiagnostics {
    const snapshot = { ...this.deliveryDiagnostics };
    this.deliveryDiagnostics.sent = 0;
    this.deliveryDiagnostics.deadLettered = 0;
    this.deliveryDiagnostics.dropped = 0;
    return snapshot;
  }

  public getPendingTransportCount(): number {
    return this.pendingTransportDispatches.size;
  }

  private toRequestContextData(
    context: RequestContext | undefined
  ): ErrorPackageRequestContextData | undefined {
    if (context === undefined) {
      return undefined;
    }

    return {
      requestId: context.requestId,
      startTime: context.startTime,
      method: context.method,
      url: context.url,
      headers: { ...context.headers },
      body: context.body,
      bodyTruncated: context.bodyTruncated
    };
  }

  private captureInline(parts: ErrorPackageParts): ErrorPackage {
    const { packageObject, payload } = finalizePackageAssemblyResult({
      packageObject: this.packageBuilder.build(parts),
      config: this.config,
      encryption: this.encryption
    });
    this.dispatchTransport(payload);
    return packageObject;
  }

  private async dispatchPackageAssembly(parts: ErrorPackageParts): Promise<void> {
    try {
      const result = await this.packageAssemblyDispatcher?.assemble(parts);

      if (result === undefined) {
        throw new Error('Package assembly worker returned no result');
      }

      this.dispatchTransport(result.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parts.captureFailures.push(`package-worker: ${message}`);

      try {
        this.captureInline(parts);
      } catch (fallbackError) {
        emitSafeWarning(this.config, {
          code: 'capture_failed',
          message: 'Error capture fallback failed [code=errorcore_capture_fallback_failed]. Both the worker and inline capture paths failed.',
          cause: fallbackError,
          context: { stage: 'fallback' }
        });
      }
    }
  }

  private dispatchTransport(payload: string): void {
    this.healthMetrics?.recordCaptured();
    const start = Date.now();

    let sendPromise = Promise.resolve()
      .then(() => this.transport.send(payload))
      .then(() => {
        this.deliveryDiagnostics.sent += 1;
        this.healthMetrics?.recordFlushLatency(Date.now() - start);
      })
      .catch((transportError) => {
        const reason =
          transportError instanceof Error
            ? transportError.message
            : String(transportError);

        const isTimeout =
          transportError instanceof Error &&
          transportError.message === HTTP_TRANSPORT_TIMEOUT_MESSAGE;
        // Console-safe message — do NOT interpolate the transport error
        // text here because it can legitimately contain authorization
        // fragments or user-supplied URLs (see
        // test/unit/error-capture-pipeline "emits sanitized warning
        // codes"). The raw reason is still delivered to
        // onInternalWarning via `context.reason` and `cause`.
        emitSafeWarning(this.config, {
          code: isTimeout ? 'transport_timeout' : 'transport_failed',
          message: isTimeout
            ? 'Transport timeout [code=errorcore_transport_timeout]. Payload dead-lettered (if configured). Check collector connectivity.'
            : 'Transport dispatch failed [code=errorcore_transport_dispatch_failed]. Payload dead-lettered (if configured). Check collector connectivity.',
          cause: transportError,
          context: { reason }
        });
        this.healthMetrics?.recordFlushLatency(Date.now() - start);
        this.healthMetrics?.recordTransportFailure(reason, Date.now());

        if (this.deadLetterStore !== null) {
          try {
            const stored = this.deadLetterStore.appendPayloadSync(payload);
            if (stored) {
              this.deliveryDiagnostics.deadLettered += 1;
            } else {
              // DLQ declined the write (size cap / oversized payload).
              // The store has already emitted its own `dead_letter_full`
              // warning via the onInternalWarning hook wired at SDK
              // construction — don't double-emit here.
              this.deliveryDiagnostics.dropped += 1;
              this.healthMetrics?.recordDroppedDlqWriteFailed();
            }
          } catch (dlError) {
            const code = classifyDlqWriteErrno(dlError);
            emitSafeWarning(this.config, {
              code,
              // Console message is sanitized (errno only; no raw
              // exception text). Structured details on the callback.
              message:
                code === 'disk_full'
                  ? 'Dead-letter store write failed: out of disk space [code=errorcore_disk_full]. Check disk capacity at deadLetterPath.'
                  : 'Dead-letter store write failed [code=errorcore_dead_letter_write_failed]. Check disk space and permissions at deadLetterPath.',
              cause: dlError,
              context: {
                errno: (dlError as NodeJS.ErrnoException | null)?.code
              }
            });
            this.deliveryDiagnostics.dropped += 1;
            this.healthMetrics?.recordDroppedDlqWriteFailed();
          }
        } else {
          // No DLQ configured — the payload is gone. Same health bucket
          // as a DLQ write failure because both mean "no durable place
          // to park this for retry."
          this.deliveryDiagnostics.dropped += 1;
          this.healthMetrics?.recordDroppedDlqWriteFailed();
        }
      })
      .finally(() => {
        this.pendingTransportDispatches.delete(sendPromise);
      });

    this.pendingTransportDispatches.add(sendPromise);
  }
}
