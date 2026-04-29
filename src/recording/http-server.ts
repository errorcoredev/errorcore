
import { channel } from 'node:diagnostics_channel';
import { Server } from 'node:http';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { IOEventSlot, RequestContext, ResolvedConfig } from '../types';
import { installOwnedWrapper } from './patches/patch-manager';
import { extractFd, pushIOEvent, toDurationMs } from './utils';
import type { RecorderState } from '../sdk-diagnostics';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface ALSManagerLike {
  createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): RequestContext;
  runWithContext<T>(ctx: RequestContext, fn: () => T): T;
  getContext(): RequestContext | undefined;
  getStore(): AsyncLocalStorage<RequestContext>;
  releaseRequestContext?(ctx: RequestContext): void;
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
  captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  materializeContextBody(context: RequestContext): void;
  materializeSlotBodies(slot: IOEventSlot): void;
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, unknown>): Record<string, string>;
  filterResponseHeaders(response: ServerResponse): Record<string, string>;
}

interface ScrubberLike {
  scrubUrl(rawUrl: string): string;
}

interface BindStoreChannel {
  bindStore?: (
    store: AsyncLocalStorage<RequestContext>,
    transform: (message: { request?: IncomingMessage }) => RequestContext
  ) => void;
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

  public requestContexts!: WeakMap<object, RequestContext>;

  public pool!: RequestFinalizer[];

  public finalized = false;

  public readonly updateInboundPayloadBytes = (oldBytes: number, newBytes: number): void => {
    this.buffer.updatePayloadBytes(oldBytes, newBytes);
    this.context.bodyTruncated = this.slot.requestBodyTruncated;
  };

  public readonly updateOutboundPayloadBytes = (oldBytes: number, newBytes: number): void => {
    this.buffer.updatePayloadBytes(oldBytes, newBytes);
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
    requestContexts: WeakMap<object, RequestContext>;
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
    this.requestContexts = input.requestContexts;
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
    this.requestTracker.remove(this.context.requestId);
    this.requestContexts.delete(this.request);
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
    this.requestContexts = undefined as never;
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

  private readonly requestContexts = new WeakMap<object, RequestContext>();

  private readonly finalizerPool: RequestFinalizer[] = [];

  private readonly pushEventScratch = {} as Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>;

  private bindStoreSucceeded = false;

  private emitPatchRestore: (() => void) | null = null;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    requestTracker: RequestTrackerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
    scrubber: ScrubberLike;
    config: ResolvedConfig;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.requestTracker = deps.requestTracker;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
    this.scrubber = deps.scrubber;
    this.config = deps.config;
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
    // the same request — no double-registration.
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
        requestContexts: this.requestContexts,
        pool: this.finalizerPool
      });

      this.bodyCapture.captureInboundRequest(request, slot, seq, finalizer.updateInboundPayloadBytes);
      this.bodyCapture.captureOutboundResponse(
        response,
        slot,
        seq,
        finalizer.updateOutboundPayloadBytes
      );

      (response as ResponseWithFinalizer)[RESPONSE_FINALIZER] = finalizer;
      response.on('close', handleResponseClose);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Failed to record inbound HTTP request: ${messageText}`);
    }
  }

  public handleResponseFinish(message: unknown): void {
    try {
      const request = (message as { request?: IncomingMessage }).request;
      const response = (message as { response?: ServerResponse }).response;
      if (request === undefined || response === undefined) return;
      if (FINALIZED_REQUESTS.has(request)) return;
      FINALIZED_REQUESTS.add(request);

      const finalizer = (response as ResponseWithFinalizer)[RESPONSE_FINALIZER];
      if (finalizer === undefined) return;
      // Channel-driven finalization is never "aborted" — response.finish/created fire on clean lifecycle.
      finalizer.finalize(false);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Failed to finalize response via channel: ${messageText}`);
    }
  }

  public shutdown(): void {
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
    // Emits errorcore:init so hosts can tell bindStore vs emit-patch instrumentation.
    try {
      const requestStartChannel = channel(
        'http.server.request.start'
      ) as unknown as BindStoreChannel;

      if (typeof requestStartChannel.bindStore === 'function') {
        requestStartChannel.bindStore(this.als.getStore(), (message) => {
          if (message.request === undefined) {
            return this.als.createRequestContext({
              method: 'UNKNOWN',
              url: 'unknown',
              headers: {}
            });
          }

          return this.getOrCreateContext(message.request);
        });
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
      console.warn(`[ErrorCore] bindStore unavailable, using emit patch (reason: ${reason})`);
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
    const existing = this.requestContexts.get(request);

    if (existing !== undefined) {
      return existing;
    }

    const headers = this.getFilteredRequestHeaders(request.headers as Record<string, unknown>);
    const context = this.als.createRequestContext({
      method: request.method ?? 'UNKNOWN',
      url: request.url ?? '',
      headers
    });

    this.requestContexts.set(request, context);
    return context;
  }

  private getFilteredRequestHeaders(
    headers: Record<string, unknown>
  ): Record<string, string> {
    return this.headerFilter.filterHeaders(headers);
  }
}
