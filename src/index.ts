// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md

import * as path from 'node:path';
import type { SDKConfig } from './types';
import { SDKInstance, createSDK } from './sdk';
import { resetMiddlewareWarning } from './middleware/common';

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
const CAPTURE_WARNING_KEY = Symbol.for('errorcore.capture.warned');

let initializing = false;

function getGlobalInstance(): SDKInstance | null {
  return (globalThis as Record<symbol, SDKInstance | null>)[INSTANCE_KEY] ?? null;
}

function setGlobalInstance(instance: SDKInstance | null): void {
  (globalThis as Record<symbol, SDKInstance | null>)[INSTANCE_KEY] = instance;
}

function getCaptureWarningEmitted(): boolean {
  return (globalThis as Record<symbol, boolean>)[CAPTURE_WARNING_KEY] === true;
}

function setCaptureWarningEmitted(value: boolean): void {
  (globalThis as Record<symbol, boolean>)[CAPTURE_WARNING_KEY] = value;
}

function tryLoadConfigFile(): Partial<SDKConfig> | undefined {
  try {
    const configPath = path.join(process.cwd(), 'errorcore.config.js');
    return require(configPath) as Partial<SDKConfig>;
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Initialize the errorcore SDK.
 *
 * When called without arguments, attempts to load `errorcore.config.js` from the
 * current working directory. If no config file is found, uses smart defaults:
 * - `transport: { type: 'stdout' }` in non-production environments
 * - `allowUnencrypted: true` in non-production environments
 *
 * @example
 * // Minimal — zero config in development
 * require('errorcore').init();
 *
 * @example
 * // With explicit config
 * require('errorcore').init({
 *   transport: { type: 'http', url: 'https://collector.example.com/v1/errors' },
 *   encryptionKey: process.env.ERRORCORE_ENCRYPTION_KEY,
 * });
 */
export function init(config?: Partial<SDKConfig>): SDKInstance {
  if (initializing) {
    throw new Error('SDK initialization already in progress');
  }

  const existing = getGlobalInstance();

  if (existing !== null) {
    if (!existing.isActive()) {
      setGlobalInstance(null);
    } else {
      console.warn(
        '[errorcore] init() called while SDK is already active. Returning existing instance.'
      );
      return existing;
    }
  }

  initializing = true;

  try {
    const resolvedConfig = config ?? tryLoadConfigFile() ?? {};
    const nextInstance = createSDK(resolvedConfig);
    setGlobalInstance(nextInstance);

    try {
      nextInstance.activate();
    } catch (error) {
      setGlobalInstance(null);
      void nextInstance.shutdown().catch(() => undefined);
      throw error;
    }

    return nextInstance;
  } finally {
    initializing = false;
  }
}

export function captureError(error: Error): void {
  const instance = getGlobalInstance();

  if (instance === null) {
    if (!getCaptureWarningEmitted()) {
      setCaptureWarningEmitted(true);
      console.warn(
        '[errorcore] captureError() called before init(). Errors are not being captured. ' +
        'Call errorcore.init() at the top of your application entry point.'
      );
    }
    return;
  }

  instance.captureError(error);
}

export function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
  name: string,
  container: T
): T {
  const instance = getGlobalInstance();

  if (instance === null) {
    console.warn(
      '[errorcore] trackState() called before init(). Returning unproxied container.'
    );
    return container;
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
  setCaptureWarningEmitted(false);
  initializing = false;
  resetMiddlewareWarning();
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
