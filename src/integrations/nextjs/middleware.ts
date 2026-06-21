// Copyright 2026 ErrorCore Dev - PolyForm Small Business 1.0.0 - see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md §7 (C1 middleware wrapper)
 * @purpose `withNextMiddleware` - wraps Next.js middleware (edge or Node),
 *          starts an ALS request context, captures thrown errors, and
 *          optionally captures non-2xx responses based on
 *          `config.captureMiddlewareStatusCodes`.
 * @dependencies src/middleware/common.ts
 */

import {
  filterHeaders,
  getModuleInstance,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike,
} from '../../middleware/common';

import type { NextRequestLike, ResponseLike } from './types';

interface MiddlewareSDKLike extends SDKInstanceLike {
  config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' };
}

type MaybePromise<T> = T | Promise<T>;

function shouldCapture(
  config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' },
  status: number,
): boolean {
  const setting = config.captureMiddlewareStatusCodes;
  if (setting === 'none') return false;
  if (setting === 'all') return status < 200 || status > 299;
  return (setting as number[]).includes(status);
}

async function runMiddlewareWithCapture<TReq extends NextRequestLike, TResult>(
  instance: MiddlewareSDKLike,
  req: TReq,
  middleware: (req: TReq) => MaybePromise<TResult>,
): Promise<TResult> {
  let result: TResult;
  try {
    result = await middleware(req);
  } catch (middlewareError) {
    if (instance.captureError !== undefined) {
      try { instance.captureError(middlewareError); } catch {}
    }
    throw middlewareError;
  }

  if (
    result != null &&
    instance.captureError !== undefined &&
    typeof (result as unknown as ResponseLike).status === 'number'
  ) {
    const status = (result as unknown as ResponseLike).status;
    if (shouldCapture(instance.config, status)) {
      try {
        const err = new Error(`HTTP ${status}`);
        err.name = 'MiddlewareRejection';
        instance.captureError(err);
      } catch {}
    }
  }

  return result;
}

export function withNextMiddleware<TReq extends NextRequestLike, TResult>(
  middleware: (req: TReq) => MaybePromise<TResult>,
  sdk?: MiddlewareSDKLike,
): (req: TReq) => Promise<TResult> {
  return async (req: TReq): Promise<TResult> => {
    const instance = resolveLiveSDK(
      (sdk as MiddlewareSDKLike | null | undefined) ?? getModuleInstance()
    ) as MiddlewareSDKLike | null;

    if (instance === null || instance === undefined || !instance.isActive()) {
      warnIfUninitialized('withNextMiddleware()');
      return middleware(req);
    }

    // Reuse existing ALS context if we are nested inside another wrapper.
    if (instance.als.getContext?.() !== undefined) {
      return runMiddlewareWithCapture(instance, req, middleware);
    }

    const rawHeaders: Record<string, string> = {};
    let traceparent: string | undefined;
    let tracestate: string | undefined;
    req.headers.forEach((value, key) => {
      rawHeaders[key] = value;
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'traceparent') {
        traceparent = value;
      } else if (normalizedKey === 'tracestate') {
        tracestate = value;
      }
    });

    let context: import('../../types').RequestContext;
    try {
      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, rawHeaders),
        traceparent,
        tracestate,
      });
    } catch {
      return middleware(req);
    }

    instance.requestTracker.add(context);

    let statusCode: unknown;
    try {
      return await instance.als.runWithContext(context, async () => {
        const result = await runMiddlewareWithCapture(instance, req, middleware);
        statusCode = (result as unknown as ResponseLike | null | undefined)?.status;
        return result;
      });
    } finally {
      releaseCompletedRequestIfSuccessful(instance, context, statusCode);
      instance.requestTracker.remove(context.requestId);
    }
  };
}
