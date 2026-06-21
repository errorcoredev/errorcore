
import {
  claimRequestCleanupRegistration,
  filterHeaders,
  getCarriedRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
  setCarriedRequestContext,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';

export function expressMiddleware(sdk?: SDKInstanceLike) {
  return (
    req: { method: string; url: string; headers: Record<string, unknown> },
    res: { finished?: boolean; statusCode?: number; on(event: 'finish', listener: () => void): void },
  next: () => void
  ): void => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('expressMiddleware()');
      next();
      return;
    }

    prepareForRequestStart(instance);

    if (res.finished === true) {
      next();
      return;
    }

    if (instance.als.getContext?.() !== undefined) {
      next();
      return;
    }

    const carriedContext = getCarriedRequestContext(instance, req);
    const ctx = carriedContext ?? (() => {
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

    if (carriedContext === undefined) {
      setCarriedRequestContext(instance, req, ctx);
    }

    const shouldRegisterCleanup = claimRequestCleanupRegistration(instance, req);
    if (shouldRegisterCleanup) {
      try {
        instance.requestTracker.add(ctx);
        registerRequestCleanup({
          requestTracker: instance.requestTracker,
          requestId: ctx.requestId,
          request: req,
          response: res,
          onResponseComplete: () => {
            releaseCompletedRequestIfSuccessful(instance, ctx, res.statusCode);
          }
        });
      } catch {
      }
    }

    instance.als.runWithContext(ctx, () => {
      next();
    });
  };
}
