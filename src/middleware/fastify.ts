
import {
  claimRequestCleanupRegistration,
  filterHeaders,
  getCarriedRequestContext,
  getModuleInstance,
  prepareForRequestStart,
  releaseCompletedRequestIfSuccessful,
  resolveLiveSDK,
  setCarriedRequestContext,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';

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
      const ctx = carriedContext ?? (() => {
        try {
          return instance.als.createRequestContext({
            method: request.raw.method,
            url: request.raw.url,
            headers: filterHeaders(instance, request.raw.headers),
            traceparent: request.raw.headers['traceparent'] as string | undefined,
            tracestate: request.raw.headers['tracestate'] as string | undefined
          });
        } catch {
          return null;
        }
      })();

      if (ctx === null) {
        next();
        return;
      }

      if (carriedContext === undefined) {
        setCarriedRequestContext(instance, request.raw, ctx);
      }

      const shouldRegisterCleanup = claimRequestCleanupRegistration(instance, request.raw);
      if (shouldRegisterCleanup) {
        try {
          instance.requestTracker.add(ctx);
          registerRequestCleanup({
            requestTracker: instance.requestTracker,
            requestId: ctx.requestId,
            request: request.raw,
            response: reply.raw,
            onResponseComplete: () => {
              releaseCompletedRequestIfSuccessful(instance, ctx, reply.raw.statusCode);
            }
          });
        } catch {
        }
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
