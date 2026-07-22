// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
//
// Smoke test: `errorcore/nextjs` resolves to the Edge stub (dist/integrations/
// nextjs/edge.mjs) when Node is invoked with --conditions=edge-light. All
// operations should be no-ops; none should throw. Run:
//
//   node --conditions=edge-light smoke-edge.mjs

import * as errorcore from 'errorcore/nextjs';

const required = [
  'init', 'captureError', 'trackState', 'withContext', 'flush', 'shutdown',
  'getTraceparent', 'withErrorcore', 'withServerAction',
];

for (const name of required) {
  if (typeof errorcore[name] !== 'function') {
    throw new Error(`errorcore/nextjs.${name} should be a function, got ${typeof errorcore[name]}`);
  }
}

// init() in the Edge stub is a no-op — must not throw on any config shape.
errorcore.init({ transport: { type: 'stdout' } });
errorcore.captureError(new Error('ignored in edge stub'));

const wrappedHandler = errorcore.withErrorcore(async (_req, _ctx) => ({ status: 200 }));
const wrappedAction = errorcore.withServerAction(async (x) => x + 1);

const r = await wrappedHandler(
  { method: 'GET', url: '/smoke', headers: { forEach() {} } },
  {},
);
if (r.status !== 200) throw new Error(`unexpected status: ${r.status}`);

const v = await wrappedAction(41);
if (v !== 42) throw new Error(`unexpected action result: ${v}`);

if (errorcore.withContext(() => 'inside') !== 'inside') {
  throw new Error('withContext stub should return fn() result');
}

if (errorcore.getTraceparent() !== null) {
  throw new Error('getTraceparent() in edge stub should return null');
}

await errorcore.flush();
await errorcore.shutdown();

console.log('[smoke-edge] OK — resolved to Edge stub via conditions=edge-light');
