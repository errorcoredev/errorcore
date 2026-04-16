
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

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
            raw: { res: { finished?: boolean; on(event: 'finish', listener: () => void): void } };
          },
          h: { continue: symbol }
        ) => symbol
      ): void;
    },
    options: { sdk?: SDKInstanceLike }
  ): void {
    server.ext('onRequest', (request, h) => {
      const instance = options.sdk ?? getModuleInstance();

      if (instance === null || !instance.isActive()) {
        warnIfUninitialized('hapiPlugin');
        return h.continue;
      }

      if (request.raw.res.finished === true || instance.als.getContext?.() !== undefined) {
        return h.continue;
      }

      try {
        const ctx = instance.als.createRequestContext({
          method: request.method.toUpperCase(),
          url: request.url.pathname,
          headers: filterHeaders(instance, request.headers),
          traceparent: request.headers['traceparent'] as string | undefined
        });

        instance.requestTracker.add(ctx);
        request.raw.res.on('finish', () => {
          instance.requestTracker.remove(ctx.requestId);
        });
        return instance.als.runWithContext(ctx, () => h.continue);
      } catch {
        return h.continue;
      }
    });
  }
};
