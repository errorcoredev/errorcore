
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { EventClock } from './event-clock';
import { parseTracestate, formatTracestate } from './tracestate';
import type { RequestContext, ResolvedConfig } from '../types';

const DEFAULT_VENDOR_KEY = 'ec';

// W3C Trace Context §3.2.2.3 says the all-zero trace-id and parent-id
// values are invalid sentinels and the traceparent MUST be dropped. The
// regex check alone accepts them, so we compare the literal here.
const TRACE_ID_ALL_ZERO = '00000000000000000000000000000000';
const PARENT_SPAN_ID_ALL_ZERO = '0000000000000000';

function parseTraceparent(header: string | undefined): {
  traceId: string;
  parentSpanId: string;
  traceFlags: number;
} | null {
  if (!header) return null;
  const parts = header.split('-');
  // W3C version 00 has exactly 4 parts. Future versions MAY append more
  // fields after trace-flags, so accept >= 4 and ignore the tail.
  if (parts.length < 4) return null;

  const version = parts[0];
  const traceId = parts[1];
  const parentSpanId = parts[2];
  const flags = parts[3];

  // Version: exactly 2 lowercase hex chars, and 'ff' is reserved as
  // forbidden by §3.2.2.1. Anything else is treated as a possibly-future
  // version we attempt to parse using the version-00 layout.
  if (!version || !/^[0-9a-f]{2}$/.test(version) || version === 'ff') return null;

  // trace-id: 32 lowercase hex chars, not all-zero.
  if (!traceId || traceId.length !== 32 || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (traceId === TRACE_ID_ALL_ZERO) return null;

  // parent-id: 16 lowercase hex chars, not all-zero.
  if (!parentSpanId || parentSpanId.length !== 16 || !/^[0-9a-f]{16}$/.test(parentSpanId)) return null;
  if (parentSpanId === PARENT_SPAN_ID_ALL_ZERO) return null;

  // trace-flags: exactly 2 lowercase hex chars. Preserve the whole byte
  // so unknown bits round-trip on egress (W3C §3.2.2.4 says implementers
  // SHOULD propagate flags they do not understand).
  if (!flags || !/^[0-9a-f]{2}$/.test(flags)) return null;
  const traceFlags = parseInt(flags, 16);

  return { traceId, parentSpanId, traceFlags };
}

function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export class ALSManager {
  private readonly store: AsyncLocalStorage<RequestContext>;

  private requestCounter = 0;

  private readonly pidPrefix: string;

  private readonly eventClock: EventClock;

  private readonly vendorKey: string;

  public constructor(deps: {
    eventClock?: EventClock;
    config?: Pick<ResolvedConfig, 'traceContext'>;
  } = {}) {
    this.store = new AsyncLocalStorage<RequestContext>();
    this.pidPrefix = `${process.pid}-`;
    // EventClock + config are optional for test ergonomics; the SDK
    // composition root passes both explicitly.
    this.eventClock = deps.eventClock ?? new EventClock();
    this.vendorKey = deps.config?.traceContext?.vendorKey ?? DEFAULT_VENDOR_KEY;
  }

  public createRequestContext(req: {
    method: string;
    url: string;
    // Callers pass a fresh, request-scoped headers object that this context owns.
    headers: Record<string, string>;
    traceparent?: string;
    tracestate?: string;
  }): RequestContext {
    // Wrap at Number.MAX_SAFE_INTEGER so the counter never produces a
    // non-integer id. In practice a process would have to sustain
    // millions of requests per second for weeks to reach this bound;
    // the wrap is defensive, not operational.
    if (this.requestCounter >= Number.MAX_SAFE_INTEGER) {
      this.requestCounter = 0;
    }
    const requestId = this.pidPrefix + ++this.requestCounter;
    const parsed = parseTraceparent(req.traceparent);
    const traceId = parsed?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = parsed?.parentSpanId ?? null;
    // Honor an inbound flag byte. When we are originating the trace
    // (no parsed traceparent), default to 0x01 (sampled) so error
    // monitoring captures even on un-sampled traces. The full byte is
    // preserved on egress so unknown flag bits propagate.
    const traceFlags = parsed?.traceFlags ?? 0x01;

    // W3C tracestate ingest (module 21): merge any peer clock value before
    // any seq is consumed in this request, so subsequent stamps within this
    // request are guaranteed to exceed the peer's clk:<n>.
    const parsedTs = parseTracestate(req.tracestate, this.vendorKey);
    if (parsedTs.receivedSeq !== null) {
      this.eventClock.merge(parsedTs.receivedSeq);
    }
    const inheritedTracestate =
      parsedTs.inheritedEntries.length > 0 ? parsedTs.inheritedEntries : undefined;

    return {
      requestId,
      startTime: process.hrtime.bigint(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: null,
      bodyTruncated: false,
      ioEvents: [],
      stateReads: [],
      stateWrites: [],
      // Stored verbatim for echo into ErrorPackage.trace.tracestate. Stays
      // separate from `inheritedTracestate`, which has our own-vendor entry
      // stripped for clean re-emission.
      inboundTracestate: req.tracestate,
      inheritedTracestate,
      traceId,
      spanId,
      parentSpanId,
      traceFlags,
      // True when we originated the trace (no inbound traceparent
      // header). Surfaced into ErrorPackage.trace.isEntrySpan so a
      // multi-service reconstruction agent can distinguish gateway
      // entry-spans from "lost-parent" spans where an upstream capture
      // is missing.
      isEntrySpan: parsed === null
    };
  }

  /**
   * Build the outbound `tracestate` value for the current ALS context. Returns
   * null if there is no active context (recorders skip header injection in
   * that case). The returned string carries our entry leftmost (most recent)
   * followed by inherited vendor entries, capped to W3C limits.
   */
  public formatOutboundTracestate(): string | null {
    const ctx = this.getContext();
    if (ctx === undefined) return null;
    return formatTracestate(
      this.eventClock.current(),
      ctx.inheritedTracestate,
      this.vendorKey
    );
  }

  public releaseRequestContext(_context: RequestContext): void {}

  public runWithContext<T>(ctx: RequestContext, fn: () => T): T {
    // AsyncLocalStorage.run unwinds the store on throw and on normal return.
    // No try/finally is needed here: when fn throws, Node's async_hooks
    // infrastructure restores the outer store before the throw propagates.
    // See https://nodejs.org/api/async_context.html#asynclocalstoragerunstore-callback-args
    // We keep a regression test (test/unit/als-throw-unwind.test.ts) that
    // would catch a future change to this guarantee.
    return this.store.run(ctx, fn);
  }

  public getContext(): RequestContext | undefined {
    return this.store.getStore();
  }

  public getRequestId(): string | undefined {
    return this.getContext()?.requestId;
  }

  public formatTraceparent(): string | null {
    const ctx = this.getContext();
    if (!ctx) return null;
    // W3C §3.2.2.4: render as 2 lowercase hex chars. ctx.traceFlags is
    // the byte we observed on inbound (or 0x01 when we originated).
    const flagsHex = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0');
    return `00-${ctx.traceId}-${ctx.spanId}-${flagsHex}`;
  }

  public getStore(): AsyncLocalStorage<RequestContext> {
    return this.store;
  }
}
