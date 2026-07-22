
import {
  createLazyRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

export function koaMiddleware(sdk?: SDKInstanceLike) {
  return async (
    ctx: {
      request: { method: string; url: string; headers: Record<string, unknown> };
      req?: unknown;
      res: { finished?: boolean; statusCode?: number; on(event: 'finish', listener: () => void): void };
    },
    next: () => Promise<unknown>
  ): Promise<unknown> => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('koaMiddleware()');
      return next();
    }

    prepareForRequestStart(instance);

    if (ctx.res.finished === true || instance.als.getContext?.() !== undefined) {
      return next();
    }

    const requestContext = createLazyRequestContext(instance, {
      method: ctx.request.method,
      url: ctx.request.url,
      headers: ctx.request.headers,
      lifecycle: {
        request: ctx.req,
        response: ctx.res
      }
    });

    if (requestContext === null) {
      return next();
    }

    return await instance.als.runWithContext(requestContext, () => next());
  };
}
