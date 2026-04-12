
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

    // SDK setup — if this fails, fall back to bare handler.
    let context: { requestId: string };

    try {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });

      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, headers)
      });
    } catch {
      return handler(req, routeContext);
    }

    instance.requestTracker.add(context);

    try {
      return await instance.als.runWithContext(context, async () => {
        const result = await handler(req, routeContext);

        // Auto-capture when the handler returns a 5xx response.
        // The ALS context is still active here, so the captured error
        // will be associated with the current request.
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
              } catch {
                // Body not JSON-parseable; use status code message
              }
            }
            const err = new Error(message);
            err.name = 'ServerError';
            instance.captureError(err);
          } catch {
            // Never break the response for capture failures
          }
        }

        return result;
      });
    } catch (handlerError) {
      // Handler threw — V8 already paused at the throw site, so locals
      // are in the inspector cache. Capture with full request context
      // (ALS is still active inside runWithContext) before re-throwing.
      if (instance.captureError !== undefined && handlerError instanceof Error) {
        try { instance.captureError(handlerError); } catch {}
      }
      throw handlerError;
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
