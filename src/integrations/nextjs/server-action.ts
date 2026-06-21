// Copyright 2026 ErrorCore Dev - PolyForm Small Business 1.0.0 - see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md
 * @purpose Server Action wrapper for Next.js App Router. Starts an ALS
 *          request context, registers the invocation in the request tracker,
 *          captures and re-throws errors. Unlike wrapServerless, does NOT
 *          flush per invocation - Server Actions fire frequently (often many
 *          per render) and a per-call flush would dominate latency.
 * @dependencies src/middleware/common.ts
 */

import {
  getModuleInstance,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike,
} from '../../middleware/common';
import type { WithServerActionOptions } from './types';

type MaybePromise<T> = T | Promise<T>;

async function runActionWithCapture<TArgs extends unknown[], TResult>(
  instance: SDKInstanceLike,
  action: (...args: TArgs) => MaybePromise<TResult>,
  args: TArgs,
): Promise<TResult> {
  try {
    return await action(...args);
  } catch (error) {
    if (instance.captureError !== undefined) {
      try { instance.captureError(error); } catch {}
    }
    throw error;
  }
}

export function withServerAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => MaybePromise<TResult>,
  options?: WithServerActionOptions,
  sdk?: SDKInstanceLike,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('withServerAction()');
      return action(...args);
    }

    if (instance.als.getContext?.() !== undefined) {
      return runActionWithCapture(instance, action, args);
    }

    let context: import('../../types').RequestContext;
    try {
      const actionName = options?.name ?? action.name ?? 'action';
      context = instance.als.createRequestContext({
        method: 'ACTION',
        url: `action/${actionName === '' ? 'action' : actionName}`,
        headers: {},
      });
    } catch {
      return action(...args);
    }

    instance.requestTracker.add(context);
    try {
      return await instance.als.runWithContext(context, async () =>
        runActionWithCapture(instance, action, args)
      );
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
