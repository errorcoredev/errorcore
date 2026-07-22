
import {
  createLazyRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';
import type { RequestContext } from '../types';

function enterPersistentContext(
  instance: SDKInstanceLike,
  ctx: RequestContext
): (() => void) | undefined {
  const alsWithStore = instance.als as SDKInstanceLike['als'] & {
    getStore?: () => {
      enterWith(context: RequestContext | undefined): void;
    };
  };
  const store = alsWithStore.getStore?.();

  if (store === undefined) {
    return undefined;
  }

  const previous = instance.als.getContext?.();
  store.enterWith(ctx);

  return () => {
    if (instance.als.getContext?.()?.requestId === ctx.requestId) {
      store.enterWith(previous);
    }
  };
}

export const hapiPlugin = {
  name: 'errorcore',
  register(
    server: {
      ext(
        name: 'onRequest',
        handler: (
          request: {
            method: string;
            url: { pathname: string };
            headers: Record<string, unknown>;
            raw: {
              req?: unknown;
              res: { finished?: boolean; statusCode?: number; on(event: 'finish', listener: () => void): void };
            };
          },
          h: { continue: symbol }
        ) => symbol
      ): void;
    },
    options: { sdk?: SDKInstanceLike }
  ): void {
    server.ext('onRequest', (request, h) => {
      const instance = resolveLiveSDK(options.sdk ?? getModuleInstance());

      if (instance === null || !instance.isActive()) {
        warnIfUninitialized('hapiPlugin');
        return h.continue;
      }

      prepareForRequestStart(instance);

      if (request.raw.res.finished === true || instance.als.getContext?.() !== undefined) {
        return h.continue;
      }

      let restoreContext: (() => void) | undefined;
      const ctx = createLazyRequestContext(instance, {
        method: request.method.toUpperCase(),
        url: request.url.pathname,
        headers: request.headers,
        lifecycle: {
          request: request.raw.req,
          response: request.raw.res,
          autoCleanup: false
        }
      });

      if (ctx === null) {
        return h.continue;
      }

      try {
        restoreContext = enterPersistentContext(instance, ctx);
      } catch {
        restoreContext?.();
        return h.continue;
      }

      if (restoreContext !== undefined) {
        registerRequestCleanup({
          requestTracker: instance.requestTracker,
          requestId: ctx.requestId,
          request: request.raw.req,
          response: request.raw.res,
          onCleanup: () => restoreContext?.(),
          onResponseComplete: () => {
            if (instance.als.isRequestContextMaterialized?.(ctx) !== false) {
              releaseCompletedRequestIfSuccessful(
                instance,
                ctx,
                request.raw.res.statusCode
              );
            }
          }
        });
        return h.continue;
      }

      return instance.als.runWithContext(ctx, () => h.continue);
    });
  }
};
