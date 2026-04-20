// Copyright 2026 ErrorCore Dev — PolyForm Small Business 1.0.0 — see LICENSE.md
//
// Verifies that dist/integrations/nextjs/edge.mjs has zero runtime imports
// outside its own directory. Type-only imports are elided at emit time so
// they never appear here. A violation means someone added a `import … from
// '../../foo'` or a bare `import 'next/server'` to edge.mts — which would
// pull Node-only code into the Edge bundle and break Next.js Edge builds.
//
// Run: node scripts/verify-edge-stub.js  (or `npm run verify:edge-stub`)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const edgeFile = path.resolve(__dirname, '..', 'dist', 'integrations', 'nextjs', 'edge.mjs');

if (!fs.existsSync(edgeFile)) {
  console.error(`[verify-edge-stub] MISSING ${edgeFile} — did you run \`npm run build\`?`);
  process.exit(1);
}

const source = fs.readFileSync(edgeFile, 'utf8');

const violations = [];
const importRegex = /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
let match;
while ((match = importRegex.exec(source)) !== null) {
  const spec = match[1];
  if (spec.startsWith('./')) {
    continue;
  }
  violations.push(spec);
}

if (violations.length > 0) {
  console.error('[verify-edge-stub] edge.mjs has forbidden runtime imports:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  console.error('');
  console.error('The Edge stub MUST be self-contained. Every symbol it needs must be');
  console.error('defined locally or imported type-only (which is elided at emit). If');
  console.error('you added a real dependency, the Edge bundle will pull Node-only code.');
  process.exit(1);
}

console.log('[verify-edge-stub] OK — edge.mjs has no external runtime imports.');
