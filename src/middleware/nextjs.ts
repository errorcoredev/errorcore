
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

    let context: import('../types').RequestContext;

    try {
      const headers: Record<string, string> = {};
      let traceparent: string | undefined;
      req.headers.forEach((value, key) => {
        headers[key] = value;
        if (key === 'traceparent') {
          traceparent = value;
        }
      });

      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, headers),
        traceparent
      });
    } catch {
      return handler(req, routeContext);
    }

    instance.requestTracker.add(context);

    try {
      return await instance.als.runWithContext(context, async () => {
        const result = await handler(req, routeContext);

        if (
          instance.captureError !== undefined &&
          result != null &&
          typeof (result as any).status === 'number' &&
          (result as any).status >= 500
        ) {
          try {
            let message = `HTTP ${(result as any).status}`;
            if (typeof (result as any).clone === 'function') {
              try {
                const body = await (result as any).clone().json();
                if (body != null && typeof body.error === 'string') {
                  message = body.error;
                }
              } catch {}
            }
            const err = new Error(message);
            err.name = 'ServerError';
            instance.captureError(err);
          } catch {}
        }

        return result;
      });
    } catch (handlerError) {
      if (instance.captureError !== undefined && handlerError instanceof Error) {
        try { instance.captureError(handlerError); } catch {}
      }
      throw handlerError;
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
