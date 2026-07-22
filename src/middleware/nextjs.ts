
import {
  filterHeaders,
  getModuleInstance,
  prepareForRequestStart,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
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

type MaybePromise<T> = T | Promise<T>;

async function captureAndFlush(
  instance: SDKInstanceLike,
  error: unknown
): Promise<void> {
  if (instance.captureError === undefined) {
    return;
  }

  try {
    instance.captureError(error);
  } catch {
    // Error capture must never affect the wrapped route.
  }

  // A Next.js route may be recycled or the process may be frozen before the
  // periodic delivery timer runs. Wait for error delivery before returning a
  // 5xx response or rethrowing so captured route failures are not stranded.
  try {
    await instance.flush?.();
  } catch {
    // Transport failures are handled by the SDK/DLQ path.
  }
}

export function withErrorcore<
  TReq extends NextLikeRequest,
  TCtx,
  TResult
>(
  handler: (req: TReq, ctx: TCtx) => MaybePromise<TResult>,
  sdk?: SDKInstanceLike
): (req: TReq, ctx: TCtx) => Promise<TResult> {
  return async (req, routeContext) => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('withErrorcore()');
      return handler(req, routeContext);
    }

    prepareForRequestStart(instance);

    if (instance.als.getContext?.() !== undefined) {
      // Nested context (e.g., HttpServerRecorder's emit-patch already set
      // ALS for this request, or this wrapper is re-entered by a parent
      // middleware). Do NOT create a sibling context - but DO still capture
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
          const err = new Error(`HTTP ${(result as unknown as { status: number }).status}`);
          err.name = 'ServerError';
          await captureAndFlush(instance, err);
        }
        return result;
      } catch (handlerError) {
        await captureAndFlush(instance, handlerError);
        throw handlerError;
      }
    }

    let context: import('../types').RequestContext;

    try {
      const headers: Record<string, string> = {};
      let traceparent: string | undefined;
      let tracestate: string | undefined;
      req.headers.forEach((value, key) => {
        headers[key] = value;
        if (key === 'traceparent') {
          traceparent = value;
        } else if (key === 'tracestate') {
          tracestate = value;
        }
      });

      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, headers),
        traceparent,
        tracestate
      });
    } catch {
      return handler(req, routeContext);
    }

    instance.requestTracker.add(context);

    let statusCode: unknown;
    try {
      return await instance.als.runWithContext(context, async () => {
        try {
          const result = await handler(req, routeContext);
          statusCode = (result as unknown as { status?: unknown } | null | undefined)?.status;

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
            const err = new Error(`HTTP ${(result as unknown as { status: number }).status}`);
            err.name = 'ServerError';
            await captureAndFlush(instance, err);
          }

          return result;
        } catch (handlerError) {
          // Capture inside runWithContext so als.getContext() returns the
          // request's context at capture time. Earlier this catch lived
          // outside runWithContext, which meant captured thrown errors
          // fell through to the ambient-events path - no ioTimeline filter
          // by requestId, no trace context, no state reads. [G2]
          await captureAndFlush(instance, handlerError);
          throw handlerError;
        }
      });
    } finally {
      releaseCompletedRequestIfSuccessful(instance, context, statusCode);
      instance.requestTracker.remove(context.requestId);
    }
  };
}
