import {
  filterHeaders,
  getModuleInstance,
  prepareForRequestStart,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

type HonoNext = () => Promise<void>;

interface HonoRequestLike {
  method: string;
  url: string;
  raw?: {
    headers?: Headers;
  };
  header?(): Record<string, string> | undefined;
}

interface HonoContextLike {
  req: HonoRequestLike;
  res?: {
    status?: number;
  };
}

function headersFromContext(ctx: HonoContextLike): Record<string, unknown> {
  const rawHeaders = ctx.req.raw?.headers;
  if (rawHeaders !== undefined && typeof rawHeaders.forEach === 'function') {
    const headers: Record<string, string> = {};
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  try {
    return ctx.req.header?.() ?? {};
  } catch {
    return {};
  }
}

function statusFromContext(ctx: HonoContextLike): number | undefined {
  const status = ctx.res?.status;
  return typeof status === 'number' ? status : undefined;
}

export function honoMiddleware(sdk?: SDKInstanceLike) {
  return async (ctx: HonoContextLike, next: HonoNext): Promise<void> => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('honoMiddleware()');
      await next();
      return;
    }

    prepareForRequestStart(instance);

    if (instance.als.getContext?.() !== undefined) {
      await next();
      return;
    }

    const headers = headersFromContext(ctx);
    const requestContext = (() => {
      try {
        return instance.als.createRequestContext({
          method: ctx.req.method,
          url: ctx.req.url,
          headers: filterHeaders(instance, headers),
          traceparent: headers.traceparent as string | undefined,
          tracestate: headers.tracestate as string | undefined
        });
      } catch {
        return null;
      }
    })();

    if (requestContext === null) {
      await next();
      return;
    }

    instance.requestTracker.add(requestContext);

    let statusCodeForCleanup: unknown;
    try {
      await instance.als.runWithContext(requestContext, () => next());
      statusCodeForCleanup = statusFromContext(ctx);
    } catch (error) {
      statusCodeForCleanup = 500;
      if (instance.captureError !== undefined) {
        try {
          instance.captureError(error);
        } catch {
        }
      }
      throw error;
    } finally {
      releaseCompletedRequestIfSuccessful(instance, requestContext, statusCodeForCleanup);
      instance.requestTracker.remove(requestContext.requestId);
    }
  };
}
