// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
//
// Smoke test: the Node entry of errorcore/nextjs resolves and exposes the
// expected public API. Run from this directory: `node smoke-node.cjs`.

'use strict';

const errorcore = require('errorcore/nextjs');

function assertFn(name) {
  if (typeof errorcore[name] !== 'function') {
    throw new Error(`errorcore/nextjs.${name} should be a function, got ${typeof errorcore[name]}`);
  }
}

for (const name of [
  'init', 'captureError', 'trackState', 'withContext', 'flush', 'shutdown',
  'getTraceparent', 'withErrorcore', 'withServerAction',
]) {
  assertFn(name);
}

errorcore.init({ transport: { type: 'stdout' }, allowUnencrypted: true });

const wrappedHandler = errorcore.withErrorcore(async (_req, _ctx) => ({ status: 200 }));
const wrappedAction = errorcore.withServerAction(async (x) => x + 1, { name: 'smoke' });

(async () => {
  const r = await wrappedHandler(
    { method: 'GET', url: '/smoke', headers: { forEach() {} } },
    {},
  );
  if (r.status !== 200) throw new Error(`unexpected status: ${r.status}`);

  const v = await wrappedAction(41);
  if (v !== 42) throw new Error(`unexpected action result: ${v}`);

  await errorcore.shutdown();
  console.log('[smoke-node] OK');
  process.exit(0);
})().catch((err) => {
  console.error('[smoke-node] FAIL:', err);
  process.exit(1);
});
