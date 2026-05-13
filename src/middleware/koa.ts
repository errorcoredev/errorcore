
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';

export function koaMiddleware(sdk?: SDKInstanceLike) {
  return async (
    ctx: {
      request: { method: string; url: string; headers: Record<string, unknown> };
      req?: unknown;
      res: { finished?: boolean; on(event: 'finish', listener: () => void): void };
    },
    next: () => Promise<unknown>
  ): Promise<unknown> => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('koaMiddleware()');
      return next();
    }

    if (ctx.res.finished === true || instance.als.getContext?.() !== undefined) {
      return next();
    }

    const requestContext = (() => {
      try {
        return instance.als.createRequestContext({
          method: ctx.request.method,
          url: ctx.request.url,
          headers: filterHeaders(instance, ctx.request.headers),
          traceparent: ctx.request.headers['traceparent'] as string | undefined,
          tracestate: ctx.request.headers['tracestate'] as string | undefined
        });
      } catch {
        return null;
      }
    })();

    if (requestContext === null) {
      return next();
    }

    try {
      instance.requestTracker.add(requestContext);
      registerRequestCleanup({
        requestTracker: instance.requestTracker,
        requestId: requestContext.requestId,
        request: ctx.req,
        response: ctx.res
      });
    } catch {
      return next();
    }

    return await instance.als.runWithContext(requestContext, () => next());
  };
}
