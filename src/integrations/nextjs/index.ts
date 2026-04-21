// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md
 * @purpose Node-side entry for `errorcore/nextjs`. Re-exports the core public
 *          API (with init() narrowed to void), plus withErrorcore (route
 *          handlers) and withServerAction (Server Actions). Mirror of edge.mts
 *          at the type level — both entries expose the same names so identical
 *          import statements work in route handlers targeting either runtime.
 * @dependencies src/index.ts, src/middleware/nextjs.ts, src/integrations/nextjs/server-action.ts
 */

import { init as coreInit } from '../../index';
import type { SDKConfig } from '../../types';

export function init(config?: Partial<SDKConfig>): void {
  coreInit(config);
}

export {
  captureError,
  trackState,
  withContext,
  flush,
  shutdown,
  getTraceparent,
} from '../../index';
export { withErrorcore } from '../../middleware/nextjs';
export { withServerAction } from './server-action';
export { withNextMiddleware } from './middleware';

export type { SDKConfig } from '../../types';
export type { NextLikeRequest, WithServerActionOptions } from './types';
