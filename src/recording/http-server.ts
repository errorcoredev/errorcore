
import { channel } from 'node:diagnostics_channel';
import { Server } from 'node:http';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { IOEventSlot, RequestContext, ResolvedConfig } from '../types';
import { installOwnedWrapper } from './patches/patch-manager';
import { extractFd, pushIOEvent, toDurationMs } from './utils';
import type { RecorderState } from '../sdk-diagnostics';
import { safeConsole } from '../debug-log';
import { registerRequestCleanup } from '../context/request-tracker';
import { RequestContextCarrier } from '../context/request-context-carrier';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number, slot?: IOEventSlot): void;
  compactCompletedRequest?(
    requestId: string,
    compactSlot?: (slot: IOEventSlot) => void
  ): number;
  releaseCompletedRequest?(
    requestId: string,
    compactSlot?: (slot: IOEventSlot) => void
  ): number;
}

interface ALSManagerLike {
  createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    traceparent?: string;
    tracestate?: string;
  }): RequestContext;
  runWithContext<T>(ctx: RequestContext, fn: () => T): T;
  getContext(): RequestContext | undefined;
  getStore(): AsyncLocalStorage<RequestContext>;
  releaseRequestContext?(ctx: RequestContext): void;
  ensureTraceMaterialized?(ctx: RequestContext): void;
}

interface RequestTrackerLike {
  add(ctx: RequestContext): void;
  remove(requestId: string): void;
}

interface BodyCaptureLike {
  captureInboundRequest(
    req: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  releaseInboundRequest(req: IncomingMessage): void;
  releaseSlotBodies(slot: IOEventSlot): void;
  captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  materializeContextBody(context: RequestContext): void;
  materializeSlotBodies(slot: IOEventSlot): void;
}

interface PayloadSpoolLike {
  markRequestComplete(requestId: string): void;
  sweep(): void;
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, unknown>): Record<string, string>;
  filterResponseHeaders(response: ServerResponse): Record<string, string>;
}

interface ScrubberLike {
  scrubUrl(rawUrl: string): string;
}

interface RequestContextCarrierLike {
  get(request: unknown): RequestContext | undefined;
  set(request: unknown, context: RequestContext): void;
  getOrCreate(request: unknown, create: () => RequestContext): RequestContext;
  claimCleanupRegistration(request: unknown): boolean;
  delete(request: unknown): void;
}

interface BindStoreChannel {
  bindStore?: (
    store: AsyncLocalStorage<RequestContext>,
    transform: (message: { request?: IncomingMessage }) => RequestContext
  ) => void;
  unbindStore?: (store: AsyncLocalStorage<RequestContext>) => boolean;
}

const RESPONSE_FINALIZER = Symbol('errorcore.responseFinalizer');

const FINALIZED_REQUESTS = new WeakSet<IncomingMessage>();

type ResponseWithFinalizer = ServerResponse & {
  [RESPONSE_FINALIZER]?: RequestFinalizer;
  writableFinished?: boolean;
};

class RequestFinalizer {
  public buffer!: IOEventBufferLike;

  public slot!: IOEventSlot;

  public context!: RequestContext;

  public request!: IncomingMessage;

  public response!: ServerResponse;

  public requestTracker!: RequestTrackerLike;

  public als!: ALSManagerLike;

  public headerFilter!: HeaderFilterLike;

  public bodyCapture!: BodyCaptureLike;

  public requestContextCarrier!: RequestContextCarrierLike;

  public payloadSpool!: PayloadSpoolLike | null;

  public pool!: RequestFinalizer[];

  public finalized = false;

  public readonly updateInboundPayloadBytes = (oldBytes: number, newBytes: number): void => {
    this.buffer.updatePayloadBytes(oldBytes, newBytes, this.slot);
    this.context.bodyTruncated = this.slot.requestBodyTruncated;
  };

  public readonly updateOutboundPayloadBytes = (oldBytes: number, newBytes: number): void => {
    this.buffer.updatePayloadBytes(oldBytes, newBytes, this.slot);
  };

  public initialize(input: {
    buffer: IOEventBufferLike;
    slot: IOEventSlot;
    context: RequestContext;
    request: IncomingMessage;
    response: ServerResponse;
    requestTracker: RequestTrackerLike;
    als: ALSManagerLike;
    headerFilter: HeaderFilterLike;
    bodyCapture: BodyCaptureLike;
    requestContextCarrier: RequestContextCarrierLike;
    payloadSpool: PayloadSpoolLike | null;
    pool: RequestFinalizer[];
  }): this {
    this.buffer = input.buffer;
    this.slot = input.slot;
    this.context = input.context;
    this.request = input.request;
    this.response = input.response;
    this.requestTracker = input.requestTracker;
    this.als = input.als;
    this.headerFilter = input.headerFilter;
    this.bodyCapture = input.bodyCapture;
    this.requestContextCarrier = input.requestContextCarrier;
    this.payloadSpool = input.payloadSpool;
    this.pool = input.pool;
    this.finalized = false;
    return this;
  }

  public finalize(aborted: boolean): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.slot.aborted = aborted;
    this.slot.statusCode = this.response.statusCode ?? this.slot.statusCode;
    this.slot.responseHeaders = this.headerFilter.filterResponseHeaders(this.response);
    this.slot.endTime = process.hrtime.bigint();
    this.slot.durationMs = toDurationMs(this.slot.startTime, this.slot.endTime);
    this.slot.phase = 'done';
    this.context.body = this.slot.requestBody;
    this.context.bodyTruncated = this.slot.requestBodyTruncated;
    this.bodyCapture.releaseInboundRequest(this.request);
    const responseCompleted =
      (this.response as ResponseWithFinalizer).writableFinished === true ||
      (this.response as ResponseWithFinalizer).writableEnded === true;
    if ((this.slot.statusCode ?? 0) < 500 && (!aborted || responseCompleted)) {
      this.buffer.releaseCompletedRequest?.(
        this.context.requestId,
        (slot) => this.bodyCapture.releaseSlotBodies(slot)
      );
    }
    this.requestTracker.remove(this.context.requestId);
    this.payloadSpool?.markRequestComplete(this.context.requestId);
    this.payloadSpool?.sweep();
    this.requestContextCarrier.delete(this.request);
    this.als.releaseRequestContext?.(this.context);
    this.response.removeListener('close', handleResponseClose);
    delete (this.response as ResponseWithFinalizer)[RESPONSE_FINALIZER];
    const pool = this.pool;
    this.reset();
    pool.push(this);
  }

  private reset(): void {
    this.finalized = false;
    this.buffer = undefined as never;
    this.slot = undefined as never;
    this.context = undefined as never;
    this.request = undefined as never;
    this.response = undefined as never;
    this.requestTracker = undefined as never;
    this.als = undefined as never;
    this.headerFilter = undefined as never;
    this.bodyCapture = undefined as never;
    this.requestContextCarrier = undefined as never;
    this.payloadSpool = null;
    this.pool = undefined as never;
  }
}

function handleResponseClose(this: ServerResponse): void {
  const response = this as ResponseWithFinalizer;
  const finalizer = response[RESPONSE_FINALIZER];
  if (finalizer === undefined) {
    return;
  }
  const request = finalizer.request;
  if (FINALIZED_REQUESTS.has(request)) return;
  FINALIZED_REQUESTS.add(request);

  finalizer.finalize(
    !((response.writableFinished ?? false) || response.writableEnded)
  );
}

export class HttpServerRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly requestTracker: RequestTrackerLike;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly scrubber: ScrubberLike;

  private readonly config: ResolvedConfig;

  private readonly requestContextCarrier: RequestContextCarrierLike;

  private payloadSpool: PayloadSpoolLike | null;

  private readonly finalizerPool: RequestFinalizer[] = [];

  private readonly pushEventScratch = {} as Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>;

  private bindStoreSucceeded = false;

  private boundStore: AsyncLocalStorage<RequestContext> | null = null;

  private emitPatchRestore: (() => void) | null = null;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    requestTracker: RequestTrackerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
    scrubber: ScrubberLike;
    config: ResolvedConfig;
    payloadSpool?: PayloadSpoolLike | null;
    requestContextCarrier?: RequestContextCarrierLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.requestTracker = deps.requestTracker;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
    this.scrubber = deps.scrubber;
    this.config = deps.config;
    this.payloadSpool = deps.payloadSpool ?? null;
    this.requestContextCarrier = deps.requestContextCarrier ?? new RequestContextCarrier();
  }

  public applyPayloadSpool(payloadSpool: PayloadSpoolLike | null): void {
    this.payloadSpool = payloadSpool;
  }

  public install(): void {
    this.tryBindStore();
    // Always install the emit-patch. bindStore wraps channel subscribers
    // with store.run() during channel.publish(), but it does NOT set the
    // ALS for the downstream server.emit('request', req, res) call. As a
    // result, request handlers registered via server.on('request', ...)
    // (Next.js, Fastify, any framework that uses the event) run outside
    // our ALS scope when only bindStore is active. The emit-patch wraps
    // Server.prototype.emit('request') in als.runWithContext(), which is
    // the mechanism that makes the context available to those handlers.
    // bindStore and emit-patch use the same WeakMap<IncomingMessage,
    // RequestContext> backing store, so they return the same context for
    // the same request - no double-registration.
    this.installEmitPatch();
  }

  public handleRequestStart(message: {
    request: IncomingMessage;
    response: ServerResponse;
    socket?: Socket;
    server: Server;
  }): void {
    try {
      if (
        message.request === undefined ||
        message.response === undefined
      ) {
        return;
      }

      const request = message.request;
      const response = message.response;
      const socket = message.socket ?? request.socket;
      const context = this.als.getContext() ?? this.getOrCreateContext(request);

      this.requestTracker.add(context);

      const event = this.pushEventScratch;
      event.phase = 'active';
      event.startTime = context.startTime;
      event.endTime = null;
      event.durationMs = null;
      event.type = 'http-server';
      event.direction = 'inbound';
      event.requestId = context.requestId;
      event.contextLost = false;
      event.target = context.headers.host ?? 'http-server';
      event.method = context.method;
      event.url = context.url;
      event.statusCode = null;
      event.fd = socket === undefined ? null : extractFd(socket);
      event.requestHeaders = context.headers;
      event.responseHeaders = null;
      event.requestBody = null;
      event.responseBody = null;
      event.requestBodyTruncated = false;
      event.responseBodyTruncated = false;
      event.requestBodyOriginalSize = null;
      event.responseBodyOriginalSize = null;
      event.error = null;
      event.aborted = false;
      event.dbMeta = undefined;
      event.requestBodyDigest = null;
      event.responseBodyDigest = null;

      this.als.ensureTraceMaterialized?.(context);
      const { slot, seq } = this.buffer.push(event);

      pushIOEvent(context, slot, this.config.bufferSize);

      const finalizer = (this.finalizerPool.pop() ?? new RequestFinalizer()).initialize({
        buffer: this.buffer,
        slot,
        context,
        request,
        response,
        requestTracker: this.requestTracker,
        als: this.als,
        headerFilter: this.headerFilter,
        bodyCapture: this.bodyCapture,
        requestContextCarrier: this.requestContextCarrier,
        payloadSpool: this.payloadSpool,
        pool: this.finalizerPool
      });

      this.bodyCapture.captureInboundRequest(request, slot, seq, finalizer.updateInboundPayloadBytes);
      this.bodyCapture.captureOutboundResponse(
        response,
        slot,
        seq,
        finalizer.updateOutboundPayloadBytes
      );

      if (this.requestContextCarrier.claimCleanupRegistration(request)) {
        registerRequestCleanup({
          requestTracker: this.requestTracker,
          requestId: context.requestId,
          request,
          response,
          onResponseComplete: () => {
            if ((response.statusCode ?? 0) < 500) {
              this.buffer.releaseCompletedRequest?.(
                context.requestId,
                (entry) => this.bodyCapture.releaseSlotBodies(entry)
              );
            }
          }
        });
      }

      (response as ResponseWithFinalizer)[RESPONSE_FINALIZER] = finalizer;
      response.on('close', handleResponseClose);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record inbound HTTP request: ${messageText}`);
    }
  }

  public handleResponseFinish(message: unknown): void {
    try {
      const request = (message as { request?: IncomingMessage }).request;
      const response = (message as { response?: ServerResponse }).response;
      if (request === undefined || response === undefined) return;
      if (FINALIZED_REQUESTS.has(request)) return;

      const finalizer = (response as ResponseWithFinalizer)[RESPONSE_FINALIZER];
      if (finalizer === undefined) return;
      FINALIZED_REQUESTS.add(request);
      // Channel-driven finalization is never "aborted" - response.finish fires on clean lifecycle.
      finalizer.finalize(false);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to finalize response via channel: ${messageText}`);
    }
  }

  public shutdown(): void {
    if (this.boundStore !== null) {
      try {
        const requestStartChannel = channel(
          'http.server.request.start'
        ) as unknown as BindStoreChannel;
        requestStartChannel.unbindStore?.(this.boundStore);
      } catch {
        // Store unbinding is best-effort and must not interrupt SDK teardown.
      } finally {
        this.boundStore = null;
        this.bindStoreSucceeded = false;
      }
    }

    this.emitPatchRestore?.();
    this.emitPatchRestore = null;
  }

  public getState(): RecorderState {
    return { state: 'ok' };
  }

  public getBindStorePath(): 'bindStore' | 'emit-patch' {
    return this.bindStoreSucceeded ? 'bindStore' : 'emit-patch';
  }

  private tryBindStore(): void {
    if (this.boundStore !== null) {
      return;
    }

    // Emits errorcore:init so hosts can tell bindStore vs emit-patch instrumentation.
    try {
      const requestStartChannel = channel(
        'http.server.request.start'
      ) as unknown as BindStoreChannel;

      if (typeof requestStartChannel.bindStore === 'function') {
        const store = this.als.getStore();
        requestStartChannel.bindStore(store, (message) => {
          if (message.request === undefined) {
            return this.als.createRequestContext({
              method: 'UNKNOWN',
              url: 'unknown',
              headers: {}
            });
          }

          return this.getOrCreateContext(message.request);
        });
        this.boundStore = store;
        this.bindStoreSucceeded = true;
        process.emit('errorcore:init' as never, { path: 'bindStore' } as never);
      } else {
        process.emit(
          'errorcore:init' as never,
          { path: 'emit-patch', reason: 'bindStore not a function' } as never
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] bindStore unavailable, using emit patch (reason: ${reason})`);
      process.emit('errorcore:init' as never, { path: 'emit-patch', reason } as never);
    }
  }

  private installEmitPatch(): void {
    const recorder = this;
    const installation = installOwnedWrapper(Server.prototype, 'emit', (previousEmit) =>
      function ownedServerEmit(this: Server, eventName: string) {
        if (eventName !== 'request') {
          return Reflect.apply(previousEmit, this, arguments);
        }

        const request = arguments[1] as IncomingMessage | undefined;

        if (request === undefined) {
          return Reflect.apply(previousEmit, this, arguments);
        }

        const context = recorder.getOrCreateContext(request);

        return recorder.als.runWithContext(context, () =>
          Reflect.apply(previousEmit, this, arguments)
        );
      }
    );

    if (installation !== null) {
      this.emitPatchRestore = installation.restore;
    }
  }

  private getOrCreateContext(request: IncomingMessage): RequestContext {
    return this.requestContextCarrier.getOrCreate(request, () => {
      const rawHeaders = request.headers as Record<string, unknown>;
      const headers = this.getFilteredRequestHeaders(rawHeaders);
      return this.als.createRequestContext({
        method: request.method ?? 'UNKNOWN',
        url: this.scrubUrl(request.url ?? ''),
        headers,
        // W3C trace context (modules 06, 21): pull these BEFORE filtering so
        // the headerAllowlist doesn't strip them. ALSManager parses both.
        traceparent: typeof rawHeaders['traceparent'] === 'string'
          ? (rawHeaders['traceparent'] as string)
          : undefined,
        tracestate: typeof rawHeaders['tracestate'] === 'string'
          ? (rawHeaders['tracestate'] as string)
          : undefined
      });
    });
  }

  private scrubUrl(rawUrl: string): string {
    try {
      return this.scrubber.scrubUrl(rawUrl);
    } catch {
      return '';
    }
  }

  private getFilteredRequestHeaders(
    headers: Record<string, unknown>
  ): Record<string, string> {
    return this.headerFilter.filterHeaders(headers);
  }
}
