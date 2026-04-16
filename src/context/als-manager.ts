
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import type { RequestContext } from '../types';

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

  public constructor() {
    this.store = new AsyncLocalStorage<RequestContext>();
    this.pidPrefix = `${process.pid}-`;
  }

  public createRequestContext(req: {
    method: string;
    url: string;
    // Callers pass a fresh, request-scoped headers object that this context owns.
    headers: Record<string, string>;
    traceparent?: string;
  }): RequestContext {
    const requestId = this.pidPrefix + ++this.requestCounter;
    const parsed = parseTraceparent(req.traceparent);
    const traceId = parsed?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = parsed?.parentSpanId ?? null;

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
      traceId,
      spanId,
      parentSpanId
    };
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
