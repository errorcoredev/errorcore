
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { EventClock } from './event-clock';
import { parseTracestate, formatTracestate } from './tracestate';
import type { RequestContext, ResolvedConfig } from '../types';

const DEFAULT_VENDOR_KEY = 'ec';

function parseTraceparent(header: string | undefined): {
  traceId: string;
  parentSpanId: string;
} | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length < 4) return null;
  const traceId = parts[1];
  const parentSpanId = parts[2];
  if (!traceId || traceId.length !== 32 || !parentSpanId || parentSpanId.length !== 16) return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId };
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
      parentSpanId
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
    return `00-${ctx.traceId}-${ctx.spanId}-01`;
  }

  public getStore(): AsyncLocalStorage<RequestContext> {
    return this.store;
  }
}
