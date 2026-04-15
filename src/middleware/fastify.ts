
import {
  filterHeaders,
  getModuleInstance,
  type SDKInstanceLike
} from './common';

export function fastifyPlugin(sdk?: SDKInstanceLike) {
  return (
    fastify: {
      addHook(
        name: 'onRequest',
        handler: (
          request: { raw: { method: string; url: string; headers: Record<string, unknown> } },
          reply: { raw: { finished?: boolean; on(event: 'finish', listener: () => void): void } },
          done: () => void
        ) => void
      ): void;
    },
    _options: unknown,
    done: () => void
  ): void => {
    fastify.addHook('onRequest', (request, reply, next) => {
      const instance = sdk ?? getModuleInstance();

      if (
        instance === null ||
        !instance.isActive() ||
        reply.raw.finished === true ||
        instance.als.getContext?.() !== undefined
      ) {
        next();
        return;
      }

      try {
        const ctx = instance.als.createRequestContext({
          method: request.raw.method,
          url: request.raw.url,
          headers: filterHeaders(instance, request.raw.headers),
          traceparent: request.raw.headers['traceparent'] as string | undefined
        });

        instance.requestTracker.add(ctx);
        reply.raw.on('finish', () => {
          instance.requestTracker.remove(ctx.requestId);
        });
        instance.als.runWithContext(ctx, () => {
          next();
        });
      } catch {
        next();
      }
    });

    done();
  };
}
