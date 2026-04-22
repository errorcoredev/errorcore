
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
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
      warnIfUninitialized('withErrorcore()');
      return handler(req, routeContext);
    }

    if (instance.als.getContext?.() !== undefined) {
      // Nested context (e.g., HttpServerRecorder's emit-patch already set
      // ALS for this request, or this wrapper is re-entered by a parent
      // middleware). Do NOT create a sibling context — but DO still capture
      // thrown errors and status-code rejections. Without this, every error
      // from handlers running under an existing context would silently fall
      // through without being captured. [G2]
      try {
        const result = await handler(req, routeContext);
        if (
          instance.captureError !== undefined &&
          result != null &&
          typeof (result as unknown as { status?: unknown }).status === 'number' &&
          (result as unknown as { status: number }).status >= 500
        ) {
          try {
            const err = new Error(`HTTP ${(result as unknown as { status: number }).status}`);
            err.name = 'ServerError';
            instance.captureError(err);
          } catch {}
        }
        return result;
      } catch (handlerError) {
        if (instance.captureError !== undefined && handlerError instanceof Error) {
          try { instance.captureError(handlerError); } catch {}
        }
        throw handlerError;
      }
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
        try {
          const result = await handler(req, routeContext);

          if (
            instance.captureError !== undefined &&
            result != null &&
            typeof (result as unknown as { status?: unknown }).status === 'number' &&
            (result as unknown as { status: number }).status >= 500
          ) {
            // We used to call (result as Response).clone().json() to pick
            // an error message out of the body. That path interacted badly
            // with streaming responses and with framework internals that
            // had already consumed the clone. The status code alone is
            // enough signal; a real message will come from an exception.
            try {
              const err = new Error(`HTTP ${(result as unknown as { status: number }).status}`);
              err.name = 'ServerError';
              instance.captureError(err);
            } catch {}
          }

          return result;
        } catch (handlerError) {
          // Capture inside runWithContext so als.getContext() returns the
          // request's context at capture time. Pre-0.2.0 this catch lived
          // outside runWithContext, which meant captured thrown errors
          // fell through to the ambient-events path — no ioTimeline filter
          // by requestId, no trace context, no state reads. [G2]
          if (instance.captureError !== undefined && handlerError instanceof Error) {
            try { instance.captureError(handlerError); } catch {}
          }
          throw handlerError;
        }
      });
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
