// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md
 * @purpose Edge-runtime no-op stub for `errorcore/nextjs`. Exposes the same
 *          named symbols as the Node entry so identical import statements
 *          work in route handlers under either runtime. All operations are
 *          no-ops; withErrorcore and withServerAction return their handler
 *          unwrapped.
 *
 *          INVARIANT: This file MUST have zero runtime imports outside its
 *          directory. Type-only imports (`import type ...`) are elided at
 *          emit time and do not count. Verified post-build by
 *          scripts/verify-edge-stub.js.
 *
 *          Emit: Compiled from edge.mts to edge.mjs (ESM) regardless of the
 *          package `type` field. Next.js Edge runtime requires ESM.
 * @dependencies none at runtime
 */

import type { SDKConfig } from '../../types';
import type { NextLikeRequest, WithServerActionOptions } from './types';

export function init(_config?: Partial<SDKConfig>): void {
  // no-op under Edge runtime
}

export function captureError(_error: Error): void {
  // no-op
}

export function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
  _name: string,
  container: T,
): T {
  return container;
}

export function withContext<T>(fn: () => T): T {
  return fn();
}

export async function flush(): Promise<void> {
  return;
}

export async function shutdown(): Promise<void> {
  return;
}

export function getTraceparent(): string | null {
  return null;
}

export function withErrorcore<TReq extends NextLikeRequest, TCtx, TResult>(
  handler: (req: TReq, ctx: TCtx) => Promise<TResult>,
  _sdk?: unknown,
): (req: TReq, ctx: TCtx) => Promise<TResult> {
  return handler;
}

export function withServerAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  _options?: WithServerActionOptions,
  _sdk?: unknown,
): (...args: TArgs) => Promise<TResult> {
  return action;
}

export type { SDKConfig } from '../../types';
export type { NextLikeRequest, WithServerActionOptions } from './types';
