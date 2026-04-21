// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md §7 (C1 middleware wrapper)
 * @purpose `withNextMiddleware` — wraps Next.js middleware (edge or Node),
 *          starts an ALS request context, captures thrown errors, and
 *          optionally captures non-2xx responses based on
 *          `config.captureMiddlewareStatusCodes`.
 * @dependencies src/middleware/common.ts
 */

import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike,
} from '../../middleware/common';

import type { NextRequestLike, ResponseLike } from './types';

/** Subset of SDKInstanceLike that withNextMiddleware actually uses. */
interface MiddlewareSDKLike extends SDKInstanceLike {
  config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' };
}

function shouldCapture(
  config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' },
  status: number,
): boolean {
  const setting = config.captureMiddlewareStatusCodes;
  if (setting === 'none') return false;
  if (setting === 'all') return status < 200 || status > 299;
  return (setting as number[]).includes(status);
}

export function withNextMiddleware<TReq extends NextRequestLike, TResult>(
  middleware: (req: TReq) => Promise<TResult>,
  sdk?: MiddlewareSDKLike,
): (req: TReq) => Promise<TResult> {
  return async (req: TReq): Promise<TResult> => {
    const instance = (sdk as MiddlewareSDKLike | null | undefined) ?? getModuleInstance() as MiddlewareSDKLike | null;

    if (instance === null || instance === undefined || !instance.isActive()) {
      warnIfUninitialized('withNextMiddleware()');
      return middleware(req);
    }

    // Reuse existing ALS context if we are nested inside another wrapper.
    if (instance.als.getContext?.() !== undefined) {
      return middleware(req);
    }

    // Collect headers from the request.
    const rawHeaders: Record<string, string> = {};
    let traceparent: string | undefined;
    req.headers.forEach((value, key) => {
      rawHeaders[key] = value;
      if (key === 'traceparent') {
        traceparent = value;
      }
    });

    let context: import('../../types').RequestContext;
    try {
      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, rawHeaders),
        traceparent,
      });
    } catch {
      return middleware(req);
    }

    instance.requestTracker.add(context);

    try {
      return await instance.als.runWithContext(context, async () => {
        let result: TResult;
        try {
          result = await middleware(req);
        } catch (middlewareError) {
          if (instance.captureError !== undefined && middlewareError instanceof Error) {
            try { instance.captureError(middlewareError); } catch {}
          }
          throw middlewareError;
        }

        // Optionally capture non-2xx responses.
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
      });
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
