
import type { SDKConfig } from './types';
import { SDKInstance, createSDK } from './sdk';

let instance: SDKInstance | null = null;

export function init(config?: Partial<SDKConfig>): SDKInstance {
  if (instance !== null) {
    if (!instance.isActive()) {
      instance = null;
    } else {
      throw new Error('SDK already initialized. Call shutdown() first.');
    }
  }

  const nextInstance = createSDK(config ?? {});
  instance = nextInstance;

  try {
    nextInstance.activate();
  } catch (error) {
    instance = null;
    void nextInstance.shutdown().catch(() => undefined);
    throw error;
  }

  return nextInstance;
}

export function captureError(error: Error): void {
  instance?.captureError(error);
}

export function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
  name: string,
  container: T
): T {
  if (instance === null) {
    throw new Error('SDK is not initialized');
  }

  return instance.trackState(name, container);
}

export function withContext<T>(fn: () => T): T {
  if (instance === null) {
    return fn();
  }

  return instance.withContext(fn);
}

export async function shutdown(): Promise<void> {
  if (instance === null) {
    return;
  }

  await instance.shutdown();
  instance = null;
}

export { createSDK };
export { expressMiddleware } from './middleware/express';
export { fastifyPlugin } from './middleware/fastify';
export { koaMiddleware } from './middleware/koa';
export { hapiPlugin } from './middleware/hapi';
export { wrapHandler } from './middleware/raw-http';

export type { SDKConfig, ErrorPackage, Completeness, ResolvedConfig } from './types';
export type { SDKInstance } from './sdk';

/**
 * @internal
 * Intended for internal middleware use only. Do not call `.shutdown()` on the
 * returned instance — use the module-level `shutdown()` export instead, which
 * correctly resets the singleton so that `init()` can be called again.
 */
export function getModuleInstance(): SDKInstance | null {
  return instance;
}
