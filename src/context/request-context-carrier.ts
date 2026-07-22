import type { RequestContext } from '../types';

function isWeakMapKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export class RequestContextCarrier {
  private readonly contexts = new WeakMap<object, RequestContext>();

  private readonly cleanupRegistrations = new WeakSet<object>();

  public get(request: unknown): RequestContext | undefined {
    return isWeakMapKey(request) ? this.contexts.get(request) : undefined;
  }

  public set(request: unknown, context: RequestContext): void {
    if (isWeakMapKey(request)) {
      this.contexts.set(request, context);
    }
  }

  public getOrCreate(request: unknown, create: () => RequestContext): RequestContext {
    const existing = this.get(request);
    if (existing !== undefined) {
      return existing;
    }

    const context = create();
    this.set(request, context);
    return context;
  }

  public claimCleanupRegistration(request: unknown): boolean {
    if (!isWeakMapKey(request)) {
      return true;
    }

    if (this.cleanupRegistrations.has(request)) {
      return false;
    }

    this.cleanupRegistrations.add(request);
    return true;
  }

  public delete(request: unknown): void {
    if (isWeakMapKey(request)) {
      this.contexts.delete(request);
      this.cleanupRegistrations.delete(request);
    }
  }
}
