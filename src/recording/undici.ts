
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
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
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

  private readonly slots = new WeakMap<object, IOEventSlot>();

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    headerFilter: HeaderFilterLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.headerFilter = deps.headerFilter;
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
        const traceparent = `00-${context.traceId}-${context.spanId}-01`;
        try {
          if (typeof (request as any).addHeader === 'function') {
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
      const { slot } = this.buffer.push({
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
    return typeof request === 'object' && request !== null
      ? this.slots.get(request)
      : undefined;
  }
}
