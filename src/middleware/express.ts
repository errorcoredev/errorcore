
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';

export function expressMiddleware(sdk?: SDKInstanceLike) {
  return (
    req: { method: string; url: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void },
    next: () => void
  ): void => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('expressMiddleware()');
      next();
      return;
    }

    if (res.finished === true) {
      next();
      return;
    }

    if (instance.als.getContext?.() !== undefined) {
      next();
      return;
    }

    const ctx = (() => {
      try {
        return instance.als.createRequestContext({
          method: req.method,
          url: req.url,
          headers: filterHeaders(instance, req.headers),
          traceparent: req.headers['traceparent'] as string | undefined,
          tracestate: req.headers['tracestate'] as string | undefined
        });
      } catch {
        return null;
      }
    })();

    if (ctx === null) {
      next();
      return;
    }

    try {
      instance.requestTracker.add(ctx);
      registerRequestCleanup({
        requestTracker: instance.requestTracker,
        requestId: ctx.requestId,
        request: req,
        response: res
      });
    } catch {
      next();
      return;
    }

    instance.als.runWithContext(ctx, () => {
      next();
    });
  };
}
