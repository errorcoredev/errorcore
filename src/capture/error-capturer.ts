
import { STANDARD_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import { createDebug } from '../debug';
import type { Encryption } from '../security/encryption';
import type { RateLimiter } from '../security/rate-limiter';
import type { ALSManager } from '../context/als-manager';

const debug = createDebug('capturer');
import type { RequestTracker } from '../context/request-tracker';
import type { InspectorManager, LocalsWithDiagnostics } from './inspector-manager';
import { finalizePackageAssemblyResult } from './package-builder';
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

type ErrorCapturerWarningCode =
  | 'capture_failed'
  | 'capture_fallback_failed'
  | 'transport_dispatch_failed'
  | 'dead_letter_write_failed';

function emitSafeWarning(code: ErrorCapturerWarningCode, detail?: string): void {
  const suffix = detail ? `: ${detail}` : '';
  switch (code) {
    case 'capture_failed':
      console.warn(`[ErrorCore] Error capture failed${suffix} [code=errorcore_capture_failed]. If this recurs, check onInternalWarning for details.`);
      return;
    case 'capture_fallback_failed':
      console.warn(`[ErrorCore] Error capture fallback failed${suffix} [code=errorcore_capture_fallback_failed]. Both the worker and inline capture paths failed.`);
      return;
    case 'transport_dispatch_failed':
      console.warn(`[ErrorCore] Transport dispatch failed${suffix} [code=errorcore_transport_dispatch_failed]. Payload dead-lettered (if configured). Check collector connectivity.`);
      return;
    case 'dead_letter_write_failed':
      console.warn(`[ErrorCore] Dead-letter store write failed${suffix} [code=errorcore_dead_letter_write_failed]. Check disk space and permissions at deadLetterPath.`);
      return;
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
    packageAssemblyDispatcher?: PackageAssemblyDispatcherLike | null;
    stateTrackerStatus?: StateTrackerStatusLike | null;
    deadLetterStore?: DeadLetterStore | null;
    sourceMapResolver?: SourceMapResolver | null;
    watchdog?: { notifyErrorCaptured(error: Error): void } | null;
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
    this.packageAssemblyDispatcher = deps.packageAssemblyDispatcher ?? null;
    this.stateTrackerStatus = deps.stateTrackerStatus ?? null;
    this.deadLetterStore = deps.deadLetterStore ?? null;
    this.sourceMapResolver = deps.sourceMapResolver ?? null;
    this.watchdog = deps.watchdog ?? null;
  }

  public capture(error: Error, _options?: { isUncaught?: boolean }): ErrorPackage | null {
    const captureFailures: string[] = [];

    try {
      debug(`capture() called for ${error.name}: ${error.message}`);
      if (!this.rateLimiter.tryAcquire()) {
        debug('capture() rate-limited, dropping');
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
      const concurrentRequests = this.requestTracker.getSummaries();
      const stateTrackingEnabled =
        stateReads.length > 0 || this.stateTrackerStatus?.isTrackingEnabled() === true;
      const parts: ErrorPackageParts = {
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
        requestContext: this.toRequestContextData(context),
        ioTimeline,
        evictionLog: this.buffer.getEvictionLog(),
        ambientContext,
        stateReads,
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
          parentSpanId: context.parentSpanId
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
      emitSafeWarning('capture_failed', detail);

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
        void fallbackError;
        emitSafeWarning('capture_fallback_failed');
      }
    }
  }

  private dispatchTransport(payload: string): void {
    let sendPromise = Promise.resolve()
      .then(() => this.transport.send(payload))
      .then(() => {
        this.deliveryDiagnostics.sent += 1;
      })
      .catch((transportError) => {
        void transportError;
        emitSafeWarning('transport_dispatch_failed');

        if (this.deadLetterStore !== null) {
          try {
            const stored = this.deadLetterStore.appendPayloadSync(payload);
            if (stored) {
              this.deliveryDiagnostics.deadLettered += 1;
            } else {
              this.deliveryDiagnostics.dropped += 1;
            }
          } catch (dlError) {
            void dlError;
            emitSafeWarning('dead_letter_write_failed');
            this.deliveryDiagnostics.dropped += 1;
          }
        } else {
          this.deliveryDiagnostics.dropped += 1;
        }
      })
      .finally(() => {
        this.pendingTransportDispatches.delete(sendPromise);
      });

    this.pendingTransportDispatches.add(sendPromise);
  }
}
