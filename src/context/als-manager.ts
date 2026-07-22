import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { EventClock } from './event-clock';
import { parseTracestate, formatTracestate } from './tracestate';
import type {
  IOEventSlot,
  RequestContext,
  ResolvedConfig,
  StateRead,
  StateWrite,
  TraceHeaders
} from '../types';

const DEFAULT_VENDOR_KEY = 'ec';
const ENTROPY_POOL_BYTES = 4096;

// W3C Trace Context section 3.2.2.3 says the all-zero trace-id and parent-id
// values are invalid sentinels and the traceparent MUST be dropped. The
// regex check alone accepts them, so we compare the literal here.
const TRACE_ID_ALL_ZERO = '00000000000000000000000000000000';
const PARENT_SPAN_ID_ALL_ZERO = '0000000000000000';

type HeaderFilter = (headers: unknown) => Record<string, string>;

export interface RequestContextMaterializationResult {
  cleanupAfterCapture?: () => void;
}

export type RequestContextMaterializationHook = (
  context: RequestContext
) => RequestContextMaterializationResult | void;

function defaultHeaderFilter(headers: unknown): Record<string, string> {
  if (typeof headers === 'object' && headers !== null) {
    return headers as Record<string, string>;
  }

  return {};
}

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
  // forbidden by section 3.2.2.1. Anything else is treated as a
  // possibly-future version we attempt to parse using the version-00 layout.
  if (!version || !/^[0-9a-f]{2}$/.test(version) || version === 'ff') return null;
  if (version === '00' && parts.length !== 4) return null;

  // trace-id: 32 lowercase hex chars, not all-zero.
  if (!traceId || traceId.length !== 32 || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (traceId === TRACE_ID_ALL_ZERO) return null;

  // parent-id: 16 lowercase hex chars, not all-zero.
  if (!parentSpanId || parentSpanId.length !== 16 || !/^[0-9a-f]{16}$/.test(parentSpanId)) {
    return null;
  }
  if (parentSpanId === PARENT_SPAN_ID_ALL_ZERO) return null;

  // trace-flags: exactly 2 lowercase hex chars. Preserve the whole byte
  // so unknown bits round-trip on egress.
  if (!flags || !/^[0-9a-f]{2}$/.test(flags)) return null;
  const traceFlags = parseInt(flags, 16);

  return { traceId, parentSpanId, traceFlags };
}

interface MaterializedTrace {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: number;
  inboundTracestate: string | undefined;
  inheritedTracestate: string[] | undefined;
  isEntrySpan: boolean;
}

interface LazyContextDeps {
  requestId: string;
  method: string;
  url: string;
  headers: unknown;
  traceparent?: string;
  tracestate?: string;
  headerFilter: HeaderFilter;
  eventClock: EventClock;
  vendorKey: string;
  generateTraceId: () => string;
  generateSpanId: () => string;
}

class LazyRequestContext implements RequestContext {
  public requestId: string;

  public readonly startTime: bigint;

  public method: string;

  public url: string;

  public body: string | Buffer | null = null;

  public bodyTruncated = false;

  public completenessOverflow?: { stateWritesDropped: number };

  private rawHeaders: unknown;

  private readonly headerFilter: HeaderFilter;

  private filteredHeaders: Record<string, string> | undefined;

  private readonly rawTraceparent: string | undefined;

  private readonly rawTracestate: string | undefined;

  private readonly eventClock: EventClock;

  private readonly vendorKey: string;

  private readonly generateTraceId: () => string;

  private readonly generateSpanId: () => string;

  private materializedTrace: MaterializedTrace | undefined;

  private ioEventsValue: IOEventSlot[] | undefined;

  private stateReadsValue: StateRead[] | undefined;

  private stateWritesValue: StateWrite[] | undefined;

  private materialized = false;

  private materializationHook: RequestContextMaterializationHook | undefined;

  private materializationHookInvoked = false;

  private cleanupAfterCapture: (() => void) | undefined;

  public constructor(deps: LazyContextDeps) {
    this.requestId = deps.requestId;
    this.startTime = process.hrtime.bigint();
    this.method = deps.method;
    this.url = deps.url;
    this.rawHeaders = deps.headers;
    this.rawTraceparent = deps.traceparent;
    this.rawTracestate = deps.tracestate;
    this.headerFilter = deps.headerFilter;
    this.eventClock = deps.eventClock;
    this.vendorKey = deps.vendorKey;
    this.generateTraceId = deps.generateTraceId;
    this.generateSpanId = deps.generateSpanId;
  }

  public get headers(): Record<string, string> {
    this.markMaterialized();
    if (this.filteredHeaders === undefined) {
      this.filteredHeaders = this.headerFilter(this.rawHeaders);
    }
    return this.filteredHeaders;
  }

  public set headers(headers: Record<string, string>) {
    this.markMaterialized();
    this.rawHeaders = headers;
    this.filteredHeaders = headers;
  }

  public get ioEvents(): IOEventSlot[] {
    this.markMaterialized();
    this.ioEventsValue ??= [];
    return this.ioEventsValue;
  }

  public set ioEvents(events: IOEventSlot[]) {
    this.markMaterialized();
    this.ioEventsValue = events;
  }

  public get stateReads(): StateRead[] {
    this.markMaterialized();
    this.stateReadsValue ??= [];
    return this.stateReadsValue;
  }

  public set stateReads(reads: StateRead[]) {
    this.markMaterialized();
    this.stateReadsValue = reads;
  }

  public get stateWrites(): StateWrite[] {
    this.markMaterialized();
    this.stateWritesValue ??= [];
    return this.stateWritesValue;
  }

  public set stateWrites(writes: StateWrite[]) {
    this.markMaterialized();
    this.stateWritesValue = writes;
  }

  public get inboundTracestate(): string | undefined {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.inboundTracestate;
  }

  public set inboundTracestate(value: string | undefined) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.inboundTracestate = value;
    }
  }

  public get inheritedTracestate(): string[] | undefined {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.inheritedTracestate;
  }

  public set inheritedTracestate(value: string[] | undefined) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.inheritedTracestate = value;
    }
  }

  public get traceId(): string {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.traceId ?? '';
  }

  public set traceId(value: string) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.traceId = value;
    }
  }

  public get spanId(): string {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.spanId ?? '';
  }

  public set spanId(value: string) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.spanId = value;
    }
  }

  public get parentSpanId(): string | null {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.parentSpanId ?? null;
  }

  public set parentSpanId(value: string | null) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.parentSpanId = value;
    }
  }

  public get traceFlags(): number {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.traceFlags ?? 0x01;
  }

  public set traceFlags(value: number) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined) {
      this.materializedTrace.traceFlags = value;
    }
  }

  public get isEntrySpan(): boolean | undefined {
    this.ensureTraceMaterialized();
    return this.materializedTrace?.isEntrySpan;
  }

  public set isEntrySpan(value: boolean | undefined) {
    this.ensureTraceMaterialized();
    if (this.materializedTrace !== undefined && value !== undefined) {
      this.materializedTrace.isEntrySpan = value;
    }
  }

  public attachMaterializationHook(hook: RequestContextMaterializationHook): void {
    this.materializationHook = hook;
    if (this.materialized) {
      this.invokeMaterializationHook();
    }
  }

  public isMaterialized(): boolean {
    return this.materialized;
  }

  public ensureMaterialized(): void {
    this.markMaterialized();
  }

  public ensureTraceMaterialized(): void {
    this.markMaterialized();
    if (this.materializedTrace !== undefined) {
      return;
    }

    const parsed = parseTraceparent(this.rawTraceparent);
    const acceptedTracestate = parsed !== null ? this.rawTracestate : undefined;
    const parsedTracestate = parseTracestate(acceptedTracestate, this.vendorKey);

    // EventClock invariant: inbound tracestate clock merge must happen
    // before any request-local sequence is consumed. This is the single
    // trace materialization gate for lazy request contexts.
    if (parsedTracestate.receivedSeq !== null) {
      this.eventClock.merge(parsedTracestate.receivedSeq);
    }

    const inheritedTracestate =
      parsedTracestate.inheritedEntries.length > 0
        ? parsedTracestate.inheritedEntries
        : undefined;

    this.materializedTrace = {
      traceId: parsed?.traceId ?? this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId: parsed?.parentSpanId ?? null,
      traceFlags: parsed?.traceFlags ?? 0x01,
      inboundTracestate: acceptedTracestate,
      inheritedTracestate,
      isEntrySpan: parsed === null
    };
  }

  public runPostCaptureCleanup(): void {
    const cleanup = this.cleanupAfterCapture;
    this.cleanupAfterCapture = undefined;
    cleanup?.();
  }

  private markMaterialized(): void {
    if (!this.materialized) {
      this.materialized = true;
    }
    this.invokeMaterializationHook();
  }

  private invokeMaterializationHook(): void {
    if (this.materializationHookInvoked || this.materializationHook === undefined) {
      return;
    }

    this.materializationHookInvoked = true;
    try {
      const result = this.materializationHook(this);
      this.cleanupAfterCapture = result?.cleanupAfterCapture;
    } catch {
      // Request context materialization must never break user code.
    }
  }
}

export class ALSManager {
  private readonly store: AsyncLocalStorage<RequestContext>;

  private requestCounter = 0;

  private readonly pidPrefix: string;

  private readonly eventClock: EventClock;

  private readonly vendorKey: string;

  private headerFilter: HeaderFilter;

  private entropyPool = Buffer.alloc(0);

  private entropyOffset = 0;

  public constructor(deps: {
    eventClock?: EventClock;
    config?: Pick<ResolvedConfig, 'traceContext'>;
    headerFilter?: HeaderFilter;
  } = {}) {
    this.store = new AsyncLocalStorage<RequestContext>();
    this.pidPrefix = `${process.pid}-`;
    // EventClock + config are optional for test ergonomics; the SDK
    // composition root passes both explicitly.
    this.eventClock = deps.eventClock ?? new EventClock();
    this.vendorKey = deps.config?.traceContext?.vendorKey ?? DEFAULT_VENDOR_KEY;
    this.headerFilter = deps.headerFilter ?? defaultHeaderFilter;
  }

  public setHeaderFilter(filter: HeaderFilter): void {
    this.headerFilter = filter;
  }

  public createRequestContext(req: {
    method: string;
    url: string;
    // Callers pass a request-scoped headers object. It is filtered lazily
    // so middleware can stay on the ALS-only hot path until capture/trace use.
    headers: unknown;
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

    return new LazyRequestContext({
      requestId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      traceparent: req.traceparent,
      tracestate: req.tracestate,
      headerFilter: (headers) => this.headerFilter(headers),
      eventClock: this.eventClock,
      vendorKey: this.vendorKey,
      generateTraceId: () => this.generateTraceId(),
      generateSpanId: () => this.generateSpanId()
    });
  }

  public attachRequestContextMaterializationHook(
    ctx: RequestContext,
    hook: RequestContextMaterializationHook
  ): void {
    if (ctx instanceof LazyRequestContext) {
      ctx.attachMaterializationHook(hook);
    } else {
      hook(ctx);
    }
  }

  public isRequestContextMaterialized(ctx: RequestContext): boolean {
    return ctx instanceof LazyRequestContext ? ctx.isMaterialized() : true;
  }

  public ensureRequestContextMaterialized(ctx: RequestContext): void {
    if (ctx instanceof LazyRequestContext) {
      ctx.ensureMaterialized();
    }
  }

  public ensureTraceMaterialized(ctx: RequestContext): void {
    if (ctx instanceof LazyRequestContext) {
      ctx.ensureTraceMaterialized();
    }
  }

  public runPostCaptureCleanup(ctx: RequestContext): void {
    if (ctx instanceof LazyRequestContext) {
      ctx.runPostCaptureCleanup();
    }
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
    this.ensureTraceMaterialized(ctx);
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
    // We keep a regression test that would catch a future change to this guarantee.
    return this.store.run(ctx, fn);
  }

  public enterWithContext(ctx: RequestContext): void {
    this.store.enterWith(ctx);
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
    this.ensureTraceMaterialized(ctx);
    // W3C section 3.2.2.4: render as 2 lowercase hex chars. ctx.traceFlags is
    // the byte we observed on inbound (or 0x01 when we originated).
    const flagsHex = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0');
    return `00-${ctx.traceId}-${ctx.spanId}-${flagsHex}`;
  }

  public getTraceHeaders(): TraceHeaders | null {
    const traceparent = this.formatTraceparent();
    if (traceparent === null) {
      return null;
    }

    const tracestate = this.formatOutboundTracestate();
    return {
      traceparent,
      ...(tracestate === null || tracestate.length === 0 ? {} : { tracestate })
    };
  }

  public getStore(): AsyncLocalStorage<RequestContext> {
    return this.store;
  }

  public shutdown(): void {
    this.store.disable();
  }

  private generateTraceId(): string {
    return this.generateNonZeroHex(16, TRACE_ID_ALL_ZERO);
  }

  private generateSpanId(): string {
    return this.generateNonZeroHex(8, PARENT_SPAN_ID_ALL_ZERO);
  }

  private generateNonZeroHex(byteLength: number, allZero: string): string {
    for (;;) {
      const hex = this.readEntropy(byteLength);
      if (hex !== allZero) {
        return hex;
      }
    }
  }

  private readEntropy(byteLength: number): string {
    if (this.entropyPool.length - this.entropyOffset < byteLength) {
      this.entropyPool = randomBytes(ENTROPY_POOL_BYTES);
      this.entropyOffset = 0;
    }

    const start = this.entropyOffset;
    this.entropyOffset += byteLength;
    return this.entropyPool.subarray(start, start + byteLength).toString('hex');
  }
}
