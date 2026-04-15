
import {
  filterHeaders,
  getModuleInstance,
  type SDKInstanceLike
} from './common';

export function expressMiddleware(sdk?: SDKInstanceLike) {
  return (
    req: { method: string; url: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void },
    next: () => void
  ): void => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive() || res.finished === true) {
      next();
      return;
    }

    try {
      if (instance.als.getContext?.() !== undefined) {
        next();
        return;
      }

      const ctx = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, req.headers),
        traceparent: req.headers['traceparent'] as string | undefined
      });

      instance.requestTracker.add(ctx);
      res.on('finish', () => {
        instance.requestTracker.remove(ctx.requestId);
      });
      instance.als.runWithContext(ctx, () => {
        next();
      });
    } catch {
      next();
    }
  };
}
