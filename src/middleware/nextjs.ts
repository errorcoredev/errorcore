
import {
  filterHeaders,
  getModuleInstance,
  type SDKInstanceLike
} from './common';

interface NextLikeRequest {
  method: string;
  url: string;
  headers: {
    forEach(callback: (value: string, key: string) => void): void;
  };
}

export function withErrorcore<
  TReq extends NextLikeRequest,
  TCtx,
  TResult
>(
  handler: (req: TReq, ctx: TCtx) => Promise<TResult>,
  sdk?: SDKInstanceLike
): (req: TReq, ctx: TCtx) => Promise<TResult> {
  return async (req, routeContext) => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      return handler(req, routeContext);
    }

    if (instance.als.getContext?.() !== undefined) {
      return handler(req, routeContext);
    }

    try {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, headers)
      });

      instance.requestTracker.add(context);

      try {
        return await instance.als.runWithContext(context, () =>
          handler(req, routeContext)
        );
      } finally {
        instance.requestTracker.remove(context.requestId);
      }
    } catch {
      return handler(req, routeContext);
    }
  };
}
