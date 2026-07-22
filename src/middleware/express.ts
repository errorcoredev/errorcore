
import {
  claimRequestCleanupRegistration,
  createLazyRequestContext,
  getCarriedRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

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
    const ctx = carriedContext ?? createLazyRequestContext(instance, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      lifecycle: carriedContext === undefined
        ? {
            request: req,
            response: res,
            carryRequest: req,
            claimCleanup: () => claimRequestCleanupRegistration(instance, req)
          }
        : undefined
    });

    if (ctx === null) {
      next();
      return;
    }

    instance.als.runWithContext(ctx, () => {
      next();
    });
  };
}
