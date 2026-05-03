
import type { IOEventSlot, RequestContext } from '../types';
import { isSdkInternalRequest } from './internal';
import { pushIOEvent, toDurationMs } from './utils';
import type { RecorderState } from '../sdk-diagnostics';
import { safeConsole } from '../debug-log';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface BodyCaptureLike {
  captureClientRequestBody(
    slot: IOEventSlot,
    seq: number,
    body: unknown,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): AsyncGenerator<unknown> | undefined;
}

// Symbol-keyed slot reference attached directly to the undici Request. The
// previous WeakMap<request, slot> lookup failed when message.request in
// undici:request:headers wasn't the same JS reference as in
// undici:request:create — a known undici-version-dependent pitfall. A
// Symbol property travels with the Request regardless of how the
// diagnostics_channel payload wraps it.
const UNDICI_SLOT_REF = Symbol.for('errorcore.undiciSlotRef');

// FIFO of pending fetch wrappers waiting for a slot to attach to. A fetch()
// call's synchronous prelude includes the dispatcher dispatch, so the
// queue is drained one-to-one with the diagnostics_channel slot creation.
// Documented caveat: this assumes no async work between fetch entry and
// dispatch — currently true for undici's fetch implementation. Direct
// undici.request() / client.request() calls bypass this queue and don't
// get response-body capture.
export const pendingFetchResolvers: Array<(slot: IOEventSlot) => void> = [];

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
  formatTraceparent(): string | null;
  formatOutboundTracestate?(): string | null;
}

interface HeaderFilterLike {
  filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
}

function getRequestRecord(request: unknown): Record<string, unknown> | null {
  return typeof request === 'object' && request !== null
    ? (request as Record<string, unknown>)
    : null;
}

function extractTarget(request: Record<string, unknown>): {
  method: string | null;
  target: string;
  url: string | null;
  requestHeaders: unknown;
} {
  const method = typeof request.method === 'string' ? request.method : null;
  const origin = typeof request.origin === 'string' ? request.origin : '';
  const path = typeof request.path === 'string' ? request.path : '';
  const url =
    typeof request.url === 'string'
      ? request.url
      : origin !== '' || path !== ''
        ? `${origin}${path}`
        : null;

  return {
    method,
    target: origin !== '' ? origin : url ?? 'undici',
    url,
    requestHeaders: request.headers
  };
}

export class UndiciRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly bodyCapture: BodyCaptureLike | undefined;

  // Fallback WeakMap kept for the rare case where the Request object refuses
  // Symbol property writes (frozen / Proxy-trapped). Primary lookup is the
  // UNDICI_SLOT_REF Symbol on the request itself.
  private readonly slots = new WeakMap<object, IOEventSlot>();

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    headerFilter: HeaderFilterLike;
    bodyCapture?: BodyCaptureLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.headerFilter = deps.headerFilter;
    this.bodyCapture = deps.bodyCapture;
  }

  public handleRequestCreate(message: { request: unknown }): void {
    try {
      const request = getRequestRecord(message.request);

      if (request === null) {
        return;
      }

      if (isSdkInternalRequest(request)) {
        return;
      }

      const context = this.als.getContext();

      if (context !== undefined) {
        const traceparent = this.als.formatTraceparent();
        try {
          if (traceparent !== null && typeof (request as any).addHeader === 'function') {
            (request as any).addHeader('traceparent', traceparent);
            // Module 21: emit ec=clk:<n> alongside traceparent.
            const tracestate = this.als.formatOutboundTracestate?.() ?? null;
            if (tracestate !== null && tracestate.length > 0) {
              (request as any).addHeader('tracestate', tracestate);
            }
          }
        } catch {
          // Undici request object might not support addHeader
        }
      }

      const extracted = extractTarget(request);
      const { slot, seq } = this.buffer.push({
        phase: 'active',
        startTime: process.hrtime.bigint(),
        endTime: null,
        durationMs: null,
        type: 'undici',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: extracted.target,
        method: extracted.method,
        url: extracted.url,
        statusCode: null,
        fd: null,
        requestHeaders: this.headerFilter.filterAndNormalizeHeaders(extracted.requestHeaders),
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error: null,
        aborted: false
      });

      pushIOEvent(context, slot);
      this.slots.set(message.request as object, slot);
      // Primary slot lookup: Symbol-keyed property survives across the
      // various ways undici may wrap or re-reference the request between
      // diagnostics events. The WeakMap above is the fallback path.
      try {
        (message.request as Record<symbol, unknown>)[UNDICI_SLOT_REF] = slot;
      } catch {
        // Request is frozen — ignore, fall back to WeakMap.
      }

      if (this.bodyCapture !== undefined) {
        // For AsyncIterable bodies (undici wraps fetch JSON bodies as
        // AsyncGenerators), captureClientRequestBody returns a tee'd
        // generator. Swap it onto the request so undici sends the tee'd
        // chunks instead of consuming the source twice.
        const replacement = this.bodyCapture.captureClientRequestBody(
          slot,
          seq,
          (request as { body?: unknown }).body,
          (oldBytes, newBytes) => {
            this.buffer.updatePayloadBytes(oldBytes, newBytes);
          }
        );
        if (replacement !== undefined) {
          (request as { body?: unknown }).body = replacement;
        }
      }

      // Notify any pending fetch wrappers that a slot is now available for
      // this dispatch. The fetch wrapper FIFO-pops the resolver and uses it
      // to attach the captured response body once the response settles. See
      // src/recording/fetch-wrapper.ts.
      const resolver = pendingFetchResolvers.shift();
      if (resolver !== undefined) {
        resolver(slot);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record undici request creation: ${messageText}`);
    }
  }

  public handleRequestHeaders(message: { request: unknown; response: unknown }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      const response = getRequestRecord(message.response);

      if (response === null) {
        return;
      }

      slot.statusCode =
        typeof response.statusCode === 'number' ? response.statusCode : null;
      slot.responseHeaders = this.headerFilter.filterAndNormalizeHeaders(
        response.headers
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record undici response headers: ${messageText}`);
    }
  }

  public handleRequestTrailers(message: { request: unknown; trailers: unknown }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      slot.endTime = process.hrtime.bigint();
      slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
      slot.phase = 'done';
      this.slots.delete(message.request as object);
      void message.trailers;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record undici request trailers: ${messageText}`);
    }
  }

  public handleRequestError(message: { request: unknown; error: Error }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      slot.error = {
        type: message.error.name,
        message: message.error.message
      };
      // AbortSignal.timeout(...) fires a TimeoutError that is semantically
      // an aborted request even though the SDK only flagged aborted=true
      // for explicit req.abort() calls. Treat both timeout-class and
      // undici's UND_ERR_ABORTED as aborted so the IO event surface
      // doesn't mislead engineers reading "aborted: false" on a request
      // that was clearly cut off.
      const errCode = (message.error as { code?: unknown }).code;
      if (
        message.error.name === 'TimeoutError' ||
        message.error.name === 'AbortError' ||
        errCode === 'UND_ERR_ABORTED'
      ) {
        slot.aborted = true;
      }
      slot.endTime = process.hrtime.bigint();
      slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
      slot.phase = 'done';
      this.slots.delete(message.request as object);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record undici request error: ${messageText}`);
    }
  }

  public shutdown(): void {
    return;
  }

  public getState(): RecorderState {
    return { state: 'ok' };
  }

  private getSlot(request: unknown): IOEventSlot | undefined {
    if (typeof request !== 'object' || request === null) {
      return undefined;
    }
    // Primary path: Symbol-keyed property. Falls back to WeakMap when the
    // Symbol wasn't writable (frozen request) or when the request object
    // here is a different reference than the one in handleRequestCreate.
    const symbolSlot = (request as Record<symbol, unknown>)[UNDICI_SLOT_REF];
    if (symbolSlot !== undefined && symbolSlot !== null) {
      return symbolSlot as IOEventSlot;
    }
    return this.slots.get(request);
  }
}
