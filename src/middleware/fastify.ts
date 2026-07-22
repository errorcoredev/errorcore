
import {
  claimRequestCleanupRegistration,
  createLazyRequestContext,
  getCarriedRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

export function fastifyPlugin(sdk?: SDKInstanceLike) {
  return (
    fastify: {
      addHook(
        name: 'onRequest',
        handler: (
          request: { raw: { method: string; url: string; headers: Record<string, unknown> } },
          reply: { raw: { finished?: boolean; statusCode?: number; on(event: 'finish', listener: () => void): void } },
          done: () => void
        ) => void
      ): void;
    },
    _options: unknown,
    done: () => void
  ): void => {
    fastify.addHook('onRequest', (request, reply, next) => {
      const instance = resolveLiveSDK(sdk ?? getModuleInstance());

      if (instance === null || !instance.isActive()) {
        warnIfUninitialized('fastifyPlugin()');
        next();
        return;
      }

      prepareForRequestStart(instance);

      if (reply.raw.finished === true || instance.als.getContext?.() !== undefined) {
        next();
        return;
      }

      const carriedContext = getCarriedRequestContext(instance, request.raw);
      const ctx = carriedContext ?? createLazyRequestContext(instance, {
        method: request.raw.method,
        url: request.raw.url,
        headers: request.raw.headers,
        lifecycle: carriedContext === undefined
          ? {
              request: request.raw,
              response: reply.raw,
              carryRequest: request.raw,
              claimCleanup: () => claimRequestCleanupRegistration(instance, request.raw)
            }
          : undefined
      });

      if (ctx === null) {
        next();
        return;
      }

      if (typeof instance.als.enterWithContext === 'function') {
        instance.als.enterWithContext(ctx);
        next();
        return;
      }

      instance.als.runWithContext(ctx, () => {
        next();
      });
    });

    done();
  };
}
