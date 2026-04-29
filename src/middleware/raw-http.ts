
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

export function wrapHandler<
  T extends (
    req: { method?: string; url?: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void }
  ) => void
>(handler: T, sdk?: SDKInstanceLike): T {
  return ((req, res) => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('wrapHandler()');
      handler(req, res);
      return;
    }

    if (res.finished === true || instance.als.getContext?.() !== undefined) {
      handler(req, res);
      return;
    }

    try {
      const ctx = instance.als.createRequestContext({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: filterHeaders(instance, req.headers),
        traceparent: req.headers['traceparent'] as string | undefined,
        tracestate: req.headers['tracestate'] as string | undefined
      });

      instance.requestTracker.add(ctx);
      res.on('finish', () => {
        instance.requestTracker.remove(ctx.requestId);
      });
      instance.als.runWithContext(ctx, () => {
        handler(req, res);
      });
    } catch {
      handler(req, res);
    }
  }) as T;
}
