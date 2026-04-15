// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md

import type { SDKConfig } from './types';
import { SDKInstance, createSDK } from './sdk';

/**
 * Global singleton storage using Symbol.for() to survive webpack chunk boundaries.
 *
 * Problem: webpack/Next.js bundles errorcore into separate chunks (instrumentation.js
 * and each route.js), each with its own module scope. A module-scope `let instance`
 * would be null in route chunks even after init() is called in instrumentation.
 *
 * Solution: Symbol.for() uses the global symbol registry, which is shared across all
 * webpack chunks in the same process. This is the same pattern used by OpenTelemetry,
 * Prisma, and other SDKs that need cross-chunk singleton identity.
 */
const INSTANCE_KEY = Symbol.for('errorcore.sdk.instance');

function getGlobalInstance(): SDKInstance | null {
  return (globalThis as Record<symbol, SDKInstance | null>)[INSTANCE_KEY] ?? null;
}

function setGlobalInstance(instance: SDKInstance | null): void {
  (globalThis as Record<symbol, SDKInstance | null>)[INSTANCE_KEY] = instance;
}

export function init(config?: Partial<SDKConfig>): SDKInstance {
  const existing = getGlobalInstance();

  if (existing !== null) {
    if (!existing.isActive()) {
      setGlobalInstance(null);
    } else {
      throw new Error('SDK already initialized. Call shutdown() first.');
    }
  }

  const nextInstance = createSDK(config ?? {});
  setGlobalInstance(nextInstance);

  try {
    nextInstance.activate();
  } catch (error) {
    setGlobalInstance(null);
    void nextInstance.shutdown().catch(() => undefined);
    throw error;
  }

  return nextInstance;
}

export function captureError(error: Error): void {
  getGlobalInstance()?.captureError(error);
}

export function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
  name: string,
  container: T
): T {
  const instance = getGlobalInstance();

  if (instance === null) {
    throw new Error('SDK is not initialized');
  }

  return instance.trackState(name, container);
}

export function withContext<T>(fn: () => T): T {
  const instance = getGlobalInstance();

  if (instance === null) {
    return fn();
  }

  return instance.withContext(fn);
}

export async function flush(): Promise<void> {
  const instance = getGlobalInstance();

  if (instance === null) {
    return;
  }

  await instance.flush();
}

export async function shutdown(): Promise<void> {
  const instance = getGlobalInstance();

  if (instance === null) {
    return;
  }

  await instance.shutdown();
  setGlobalInstance(null);
}

export { createSDK };
export { expressMiddleware } from './middleware/express';
export { fastifyPlugin } from './middleware/fastify';
export { koaMiddleware } from './middleware/koa';
export { hapiPlugin } from './middleware/hapi';
export { wrapHandler } from './middleware/raw-http';
export { withErrorcore } from './middleware/nextjs';
export { wrapLambda, wrapServerless } from './middleware/lambda';

export type { SDKConfig, ErrorPackage, Completeness, ResolvedConfig } from './types';
export type { SDKInstance } from './sdk';
export type { LambdaContext } from './middleware/lambda';

/**
 * @internal
 * Intended for internal middleware use only. Do not call `.shutdown()` on the
 * returned instance — use the module-level `shutdown()` export instead, which
 * correctly resets the singleton so that `init()` can be called again.
 */
export function getModuleInstance(): SDKInstance | null {
  return getGlobalInstance();
}

export function getTraceparent(): string | null {
  return getGlobalInstance()?.als.formatTraceparent() ?? null;
}
