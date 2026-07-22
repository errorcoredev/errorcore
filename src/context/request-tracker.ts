
import type { RequestContext, RequestSummary } from '../types';
import { safeConsole } from '../debug-log';

interface RequestTrackerConfig {
  maxConcurrent: number;
  ttlMs: number;
  onRemove?: (context: RequestContext) => void;
}

interface RequestCleanupTarget {
  on?: unknown;
  once?: unknown;
}

interface RequestCleanupConfig {
  requestTracker: {
    remove(requestId: string): void;
  };
  requestId: string;
  request?: unknown;
  response?: unknown;
  onCleanup?: () => void;
  onResponseComplete?: () => void;
}

export function registerRequestCleanup(config: RequestCleanupConfig): void {
  let cleaned = false;
  let responseCompleted = false;

  const cleanup = () => {
    if (cleaned) {
      return;
    }

    cleaned = true;
    config.requestTracker.remove(config.requestId);
    config.onCleanup?.();
  };

  const responseCleanup = () => {
    if (!responseCompleted) {
      responseCompleted = true;
      config.onResponseComplete?.();
    }
    cleanup();
  };

  registerCleanupEvent(config.response, 'finish', responseCleanup);
  registerCleanupEvent(config.response, 'close', responseCleanup);
  registerCleanupEvent(config.request, 'aborted', cleanup);
  registerCleanupEvent(config.request, 'close', cleanup);
}

function registerCleanupEvent(
  target: unknown,
  event: string,
  cleanup: () => void
): void {
  if (target == null || typeof target !== 'object') {
    return;
  }

  const emitter = target as RequestCleanupTarget;
  if (typeof emitter.once === 'function') {
    (emitter.once as (event: string, listener: () => void) => void).call(
      target,
      event,
      cleanup
    );
    return;
  }

  if (typeof emitter.on === 'function') {
    (emitter.on as (event: string, listener: () => void) => void).call(
      target,
      event,
      cleanup
    );
  }
}

export class RequestTracker {
  private readonly maxConcurrent: number;

  private readonly ttlMs: number;

  private readonly onRemove: ((context: RequestContext) => void) | null;

  private readonly contexts = new Map<string, RequestContext>();

  private capacityWarningActive = false;

  private readonly sweepTimer: NodeJS.Timeout;

  public constructor(config: RequestTrackerConfig) {
    this.maxConcurrent = config.maxConcurrent;
    this.ttlMs = config.ttlMs ?? 300000;
    this.onRemove = config.onRemove ?? null;
    this.sweepTimer = setInterval(() => {
      this.sweepExpired();
    }, 60000);
    this.sweepTimer.unref();
  }

  public add(ctx: RequestContext): void {
    if (this.contexts.size >= this.maxConcurrent) {
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        safeConsole.debug('[ErrorCore] RequestTracker at capacity; dropping tracked request');
      }
      return;
    }

    this.contexts.set(ctx.requestId, ctx);
  }

  public remove(requestId: string): void {
    const context = this.contexts.get(requestId);
    this.contexts.delete(requestId);
    if (context !== undefined) {
      this.onRemove?.(context);
    }
    this.resetCapacityWarningIfAvailable();
  }

  public getAll(): RequestContext[] {
    return [...this.contexts.values()];
  }

  public getSummaries(): RequestSummary[] {
    const summaries = new Array<RequestSummary>(this.contexts.size);
    let index = 0;

    for (const ctx of this.contexts.values()) {
      summaries[index] = {
        requestId: ctx.requestId,
        method: ctx.method,
        url: ctx.url,
        startTime: ctx.startTime.toString()
      };
      index += 1;
    }

    return summaries;
  }

  public getCount(): number {
    return this.contexts.size;
  }

  public shutdown(): void {
    clearInterval(this.sweepTimer);
    this.contexts.clear();
    this.capacityWarningActive = false;
  }

  private sweepExpired(): void {
    const now = process.hrtime.bigint();
    const ttlNs = BigInt(this.ttlMs) * 1000000n;

    for (const [requestId, context] of this.contexts.entries()) {
      if (now - context.startTime > ttlNs) {
        this.contexts.delete(requestId);
        this.onRemove?.(context);
      }
    }

    this.resetCapacityWarningIfAvailable();
  }

  private resetCapacityWarningIfAvailable(): void {
    if (this.contexts.size < this.maxConcurrent) {
      this.capacityWarningActive = false;
    }
  }
}
