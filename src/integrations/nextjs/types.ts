// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md
 * @purpose Shared public type surface for `errorcore/nextjs`. Imported
 *          type-only by both the Node entry and the Edge stub so they remain
 *          type-identical. Type-only imports are elided at emit time, so the
 *          Edge stub retains its zero-runtime-import invariant.
 * @dependencies src/types.ts (type-only)
 */

export interface NextLikeRequest {
  method: string;
  url: string;
  headers: { forEach(callback: (value: string, key: string) => void): void };
}

export interface WithServerActionOptions {
  name?: string;
}
