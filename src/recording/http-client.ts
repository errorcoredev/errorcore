
import type { IncomingMessage, ClientRequest } from 'node:http';

import type { IOEventSlot, RequestContext } from '../types';
import {
  ERRORCORE_INTERNAL,
  SDK_INTERNAL_REQUESTS,
  isSdkInternalRequest
} from './internal';
import { extractFd, pushIOEvent, toDurationMs } from './utils';
import type { RecorderState } from '../sdk-diagnostics';
import { safeConsole } from '../debug-log';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
  formatTraceparent(): string | null;
  formatOutboundTracestate?(): string | null;
  getTraceHeaders?(): { traceparent: string; tracestate?: string } | null;
}

interface BodyCaptureLike {
  captureClientRequest(
    req: ClientRequest,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  captureClientResponse(
    res: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
}

interface HeaderFilterLike {
  filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
}

function getRequestHeaders(request: ClientRequest): Record<string, unknown> | undefined {
  const getHeaders = request as unknown as {
    getHeaders?: () => Record<string, unknown>;
  };

  return getHeaders.getHeaders?.();
}

function buildTarget(request: ClientRequest): {
  target: string;
  method: string | null;
  url: string | null;
} {
  const requestRecord = request as unknown as Record<string, unknown>;
  const method = typeof requestRecord.method === 'string' ? requestRecord.method : null;
  const protocolValue =
    typeof requestRecord.protocol === 'string'
      ? requestRecord.protocol
      : typeof (requestRecord.agent as { protocol?: unknown } | undefined)?.protocol ===
          'string'
        ? ((requestRecord.agent as { protocol: string }).protocol)
        : 'http:';
  const protocol = protocolValue.endsWith(':') ? protocolValue : `${protocolValue}:`;
  const host =
    typeof requestRecord.host === 'string'
      ? requestRecord.host
      : typeof request.getHeader === 'function'
        ? (request.getHeader('host') as string | undefined) ?? 'unknown'
        : 'unknown';
  const port =
    typeof requestRecord.port === 'number'
      ? requestRecord.port
      : typeof requestRecord.port === 'string'
        ? requestRecord.port
        : '';
  const path = typeof requestRecord.path === 'string' ? requestRecord.path : '';
  const hostWithPort =
    port === '' || host.includes(':') ? host : `${host}:${String(port)}`;
  const url = `${protocol}//${hostWithPort}${path}`;

  return {
    target: `${protocol}//${hostWithPort}`,
    method,
    url
  };
}

export { ERRORCORE_INTERNAL, SDK_INTERNAL_REQUESTS };

export class HttpClientRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly headerFilter: HeaderFilterLike;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
  }

  public handleRequestStart(message: { request: ClientRequest }): void {
    try {
      if (message.request === undefined) {
        return;
      }

      if (isSdkInternalRequest(message.request)) {
        return;
      }

      const request = message.request;
      const context = this.als.getContext();
      const target = buildTarget(request);

      if (context !== undefined) {
        const traceHeaders = this.als.getTraceHeaders?.() ?? (() => {
          const traceparent = this.als.formatTraceparent();
          if (traceparent === null) return null;
          const tracestate = this.als.formatOutboundTracestate?.() ?? null;
          return {
            traceparent,
            ...(tracestate === null || tracestate.length === 0 ? {} : { tracestate })
          };
        })();
        try {
          if (traceHeaders !== null) {
            request.setHeader('traceparent', traceHeaders.traceparent);
          }
          if (traceHeaders?.tracestate !== undefined) {
            request.setHeader('tracestate', traceHeaders.tracestate);
          }
        } catch {
          // Request might already be sent or header immutable
        }
      }

      const { slot, seq } = this.buffer.push({
        phase: 'active',
        startTime: process.hrtime.bigint(),
        endTime: null,
        durationMs: null,
        type: 'http-client',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: target.target,
        method: target.method,
        url: target.url,
        statusCode: null,
        fd: extractFd((request as unknown as { socket?: unknown }).socket),
        requestHeaders: this.headerFilter.filterAndNormalizeHeaders(getRequestHeaders(request)),
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

      this.bodyCapture.captureClientRequest(request, slot, seq, (oldBytes, newBytes) => {
        this.buffer.updatePayloadBytes(oldBytes, newBytes);
      });

      let finalized = false;
      const finalize = (input?: { aborted?: boolean; error?: Error }): void => {
        if (finalized) {
          return;
        }

        finalized = true;
        slot.aborted = input?.aborted ?? false;
        slot.error =
          input?.error === undefined
            ? slot.error
            : { type: input.error.name, message: input.error.message };
        slot.endTime = process.hrtime.bigint();
        slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
        slot.phase = 'done';
      };

      request.on('response', (response) => {
        slot.statusCode = response.statusCode ?? null;
        slot.responseHeaders = this.headerFilter.filterAndNormalizeHeaders(
          response.headers as Record<string, unknown>
        );
        this.bodyCapture.captureClientResponse(response, slot, seq, (oldBytes, newBytes) => {
          this.buffer.updatePayloadBytes(oldBytes, newBytes);
        });
        response.on('end', () => {
          finalize();
        });
      });

      request.on('error', (error) => {
        finalize(error instanceof Error ? { error } : undefined);
      });

      request.on('abort', () => {
        finalize({ aborted: true });
      });

      request.on('close', () => {
        if (!finalized && slot.statusCode === null) {
          finalize({ aborted: true });
        }
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Failed to record outbound HTTP request: ${messageText}`);
    }
  }

  public shutdown(): void {
    return;
  }

  public getState(): RecorderState {
    return { state: 'ok' };
  }
}
