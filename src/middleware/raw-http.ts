
import {
  filterHeaders,
  getModuleInstance,
  prepareForRequestStart,
  resolveLiveSDK,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';
import { registerRequestCleanup } from '../context/request-tracker';

export function wrapHandler<
  T extends (
    req: { method?: string; url?: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void }
  ) => void
>(handler: T, sdk?: SDKInstanceLike): T {
  return ((req, res) => {
    const instance = resolveLiveSDK(sdk ?? getModuleInstance());

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('wrapHandler()');
      handler(req, res);
      return;
    }

    prepareForRequestStart(instance);

    if (res.finished === true || instance.als.getContext?.() !== undefined) {
      handler(req, res);
      return;
    }

    const ctx = (() => {
      try {
        return instance.als.createRequestContext({
          method: req.method ?? 'GET',
          url: req.url ?? '',
          headers: filterHeaders(instance, req.headers),
          traceparent: req.headers['traceparent'] as string | undefined,
          tracestate: req.headers['tracestate'] as string | undefined
        });
      } catch {
        return null;
      }
    })();

    if (ctx === null) {
      handler(req, res);
      return;
    }

    try {
      instance.requestTracker.add(ctx);
      registerRequestCleanup({
        requestTracker: instance.requestTracker,
        requestId: ctx.requestId,
        request: req,
        response: res
      });
    } catch {
      handler(req, res);
      return;
    }

    instance.als.runWithContext(ctx, () => {
      handler(req, res);
    });
  }) as T;
}
