
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RequestContext } from '../types';

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
  }): RequestContext {
    const requestId = this.pidPrefix + ++this.requestCounter;

    return {
      requestId,
      startTime: process.hrtime.bigint(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: null,
      bodyTruncated: false,
      ioEvents: [],
      stateReads: []
    };
  }

  public releaseRequestContext(_context: RequestContext): void {}

  public runWithContext<T>(ctx: RequestContext, fn: () => T): T {
    return this.store.run(ctx, fn);
  }

  public getContext(): RequestContext | undefined {
    return this.store.getStore();
  }

  public getRequestId(): string | undefined {
    return this.getContext()?.requestId;
  }

  public getStore(): AsyncLocalStorage<RequestContext> {
    return this.store;
  }
}
