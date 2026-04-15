
import {
  filterHeaders,
  getModuleInstance,
  type SDKInstanceLike
} from './common';

export function koaMiddleware(sdk?: SDKInstanceLike) {
  return async (
    ctx: {
      request: { method: string; url: string; headers: Record<string, unknown> };
      res: { finished?: boolean; on(event: 'finish', listener: () => void): void };
    },
    next: () => Promise<unknown>
  ): Promise<unknown> => {
    const instance = sdk ?? getModuleInstance();

    if (
      instance === null ||
      !instance.isActive() ||
      ctx.res.finished === true ||
      instance.als.getContext?.() !== undefined
    ) {
      return next();
    }

    try {
      const requestContext = instance.als.createRequestContext({
        method: ctx.request.method,
        url: ctx.request.url,
        headers: filterHeaders(instance, ctx.request.headers),
        traceparent: ctx.request.headers['traceparent'] as string | undefined
      });

      instance.requestTracker.add(requestContext);
      ctx.res.on('finish', () => {
        instance.requestTracker.remove(requestContext.requestId);
      });

      return await instance.als.runWithContext(requestContext, () => next());
    } catch {
      return next();
    }
  };
}
