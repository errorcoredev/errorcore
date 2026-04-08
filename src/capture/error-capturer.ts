
import { STANDARD_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import type { Encryption } from '../security/encryption';
import type { RateLimiter } from '../security/rate-limiter';
import type { ALSManager } from '../context/als-manager';
import type { RequestTracker } from '../context/request-tracker';
import type { InspectorManager } from './inspector-manager';
import { finalizePackageAssemblyResult } from './package-builder';
import type { PackageBuilder } from './package-builder';
import type { ProcessMetadata } from './process-metadata';
import type { DeadLetterStore } from '../transport/dead-letter-store';
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

type ErrorCapturerWarningCode =
  | 'capture_failed'
  | 'capture_fallback_failed'
  | 'transport_dispatch_failed'
  | 'dead_letter_write_failed';

function emitSafeWarning(code: ErrorCapturerWarningCode): void {
  switch (code) {
    case 'capture_failed':
      console.warn('[ErrorCore] Error capture failed [code=errorcore_capture_failed]');
      return;
    case 'capture_fallback_failed':
      console.warn('[ErrorCore] Error capture fallback failed [code=errorcore_capture_fallback_failed]');
      return;
    case 'transport_dispatch_failed':
      console.warn('[ErrorCore] Transport dispatch failed [code=errorcore_transport_dispatch_failed]');
      return;
    case 'dead_letter_write_failed':
      console.warn('[ErrorCore] Dead-letter store write failed [code=errorcore_dead_letter_write_failed]');
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

function serializeError(error: Error, depth = 0): ErrorInfo {
  if (depth > 5) {
    return {
      type: 'Error',
      message: '[Cause chain depth limit]',
      stack: '',
      properties: {}
    };
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  return {
    type: error.constructor?.name || 'Error',
    message: error.message || '',
    stack: error.stack || '',
    cause: cause instanceof Error ? serializeError(cause, depth + 1) : undefined,
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

  private readonly pendingTransportDispatches = new Set<Promise<void>>();

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
  }

  public capture(error: Error, _options?: { isUncaught?: boolean }): ErrorPackage | null {
    const captureFailures: string[] = [];

    try {
      if (!this.rateLimiter.tryAcquire()) {
        return null;
      }

      const rateLimiterDrops = this.rateLimiter.getAndResetDropSummary() ?? undefined;

      const serializedError = serializeError(error);
      const locals = this.safeGetLocals(error, captureFailures);
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
          cause: serializedError.cause,
          properties: serializedError.properties
        },
        localVariables: locals,
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
        rateLimiterDrops
      };

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
      void captureError;
      emitSafeWarning('capture_failed');

      if (this.deadLetterStore !== null) {
        try {
          this.deadLetterStore.appendFailureMarkerSync('capture_failed');
        } catch {
        }
      }

      return null;
    }
  }

  private safeGetLocals(error: Error, captureFailures: string[]) {
    try {
      const result = this.inspector.getLocalsWithDiagnostics(error);

      if (result.frames === null && result.missReason !== null) {
        captureFailures.push(`locals: ${result.missReason}`);
      }

      return result.frames;
    } catch (inspectorError) {
      const message =
        inspectorError instanceof Error ? inspectorError.message : String(inspectorError);

      captureFailures.push(`locals: ${message}`);
      return null;
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

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.packageAssemblyDispatcher !== null) {
      await this.packageAssemblyDispatcher.shutdown(options);
    }

    if (this.pendingTransportDispatches.size > 0) {
      await Promise.allSettled([...this.pendingTransportDispatches]);
    }
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
      .catch((transportError) => {
        void transportError;
        emitSafeWarning('transport_dispatch_failed');

        if (this.deadLetterStore !== null) {
          try {
            this.deadLetterStore.appendPayloadSync(payload);
          } catch (dlError) {
            void dlError;
            emitSafeWarning('dead_letter_write_failed');
          }
        }
      })
      .finally(() => {
        this.pendingTransportDispatches.delete(sendPromise);
      });

    this.pendingTransportDispatches.add(sendPromise);
  }
}
