
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
import {
  AWS_ACCESS_KEY_REGEX,
  BASIC_AUTH_REGEX,
  BEARER_REGEX,
  CREDIT_CARD_REGEX,
  EMAIL_REGEX,
  GENERIC_SK_KEY_REGEX,
  GITHUB_TOKEN_REGEX,
  JWT_REGEX,
  PHONE_REGEX,
  SENSITIVE_KEY_EXACT_MATCHES,
  SENSITIVE_KEY_REGEX,
  SSN_REGEX,
  STRIPE_KEY_REGEX,
  isValidLuhn
} from '../pii/patterns';

const REDACTED = '[REDACTED]';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number, slot?: IOEventSlot): void;
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

function replacePattern(value: string, pattern: RegExp): string {
  return value.replace(pattern, REDACTED);
}

function replaceCreditCards(value: string): string {
  return value.replace(CREDIT_CARD_REGEX, (match) =>
    isValidLuhn(match) ? REDACTED : match
  );
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchesSensitiveQueryKey(key: string): boolean {
  const normalizedKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();

  if (SENSITIVE_KEY_EXACT_MATCHES.has(normalizedKey)) {
    return true;
  }

  return SENSITIVE_KEY_REGEX.test(normalizedKey);
}

function scrubQueryValue(key: string, value: string): string {
  if (matchesSensitiveQueryKey(key)) {
    return REDACTED;
  }

  let scrubbed = value;
  scrubbed = replacePattern(scrubbed, EMAIL_REGEX);
  scrubbed = replaceCreditCards(scrubbed);
  scrubbed = replacePattern(scrubbed, SSN_REGEX);
  scrubbed = replacePattern(scrubbed, JWT_REGEX);
  scrubbed = replacePattern(scrubbed, BEARER_REGEX);
  scrubbed = replacePattern(scrubbed, BASIC_AUTH_REGEX);
  scrubbed = replacePattern(scrubbed, AWS_ACCESS_KEY_REGEX);
  scrubbed = replacePattern(scrubbed, GITHUB_TOKEN_REGEX);
  scrubbed = replacePattern(scrubbed, STRIPE_KEY_REGEX);
  scrubbed = replacePattern(scrubbed, GENERIC_SK_KEY_REGEX);
  scrubbed = replacePattern(scrubbed, PHONE_REGEX);
  return scrubbed;
}

function scrubUrl(rawUrl: string): string {
  if (rawUrl === '' || !rawUrl.includes('?')) {
    return rawUrl;
  }

  try {
    const hashIndex = rawUrl.indexOf('#');
    const hash = hashIndex === -1 ? '' : rawUrl.slice(hashIndex);
    const beforeHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
    const queryIndex = beforeHash.indexOf('?');

    if (queryIndex === -1) {
      return rawUrl;
    }

    const prefix = beforeHash.slice(0, queryIndex);
    const rawQuery = beforeHash.slice(queryIndex + 1);
    const rawSegments = rawQuery.split('&');
    const scrubbedSegments = new Array<string>(rawSegments.length);
    let changed = false;

    for (let index = 0; index < rawSegments.length; index += 1) {
      const segment = rawSegments[index];

      if (segment === '') {
        scrubbedSegments[index] = segment;
        continue;
      }

      const equalsIndex = segment.indexOf('=');
      const rawKey = equalsIndex === -1 ? segment : segment.slice(0, equalsIndex);
      const rawValue = equalsIndex === -1 ? '' : segment.slice(equalsIndex + 1);
      const key = decodeQueryComponent(rawKey);
      const value = decodeQueryComponent(rawValue);
      const scrubbedValue = scrubQueryValue(key, value);

      if (scrubbedValue === value) {
        scrubbedSegments[index] = segment;
        continue;
      }

      changed = true;
      scrubbedSegments[index] = `${encodeURIComponent(key)}=${encodeURIComponent(scrubbedValue)}`;
    }

    if (!changed) {
      return rawUrl;
    }

    return `${prefix}?${scrubbedSegments.join('&')}${hash}`;
  } catch {
    return `${rawUrl.slice(0, rawUrl.indexOf('?'))}?${encodeURIComponent(REDACTED)}`;
  }
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
    url: scrubUrl(url)
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
        this.buffer.updatePayloadBytes(oldBytes, newBytes, slot);
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
          this.buffer.updatePayloadBytes(oldBytes, newBytes, slot);
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
