# tmp-nextjs-smoke

Smoke validation for the `errorcore/nextjs` subpath. Not part of the
published package — the `files` array in the root `package.json` only
includes `dist/`, `bin/`, and `config-template/`, so `tmp-*` is excluded
from the npm tarball.

## Purpose

Prove two things before a release:

1. The `errorcore/nextjs` subpath resolves correctly from a real consumer
   (Node conditions).
2. The Edge runtime condition (`edge-light`) correctly maps to the ESM stub
   at `dist/integrations/nextjs/edge.mjs` — not to the Node entry.

## Setup

From the repo root:

```bash
npm run build
cd tmp-nextjs-smoke
npm install
```

The `npm install` packs the parent package (`file:..`) and installs it as a
dependency. The parent's `files` array limits what's packed to `dist/`,
`bin/`, and `config-template/`.

## Run

```bash
# Node resolution (default conditions). Should print "[smoke-node] OK".
node smoke-node.cjs

# Edge resolution. The --conditions=edge-light flag tells Node to pick the
# edge-light branch of the exports map. Should print "[smoke-edge] OK".
node --conditions=edge-light smoke-edge.mjs
```

## What this does NOT verify

A real `next build` against an App Router application. For full runtime
validation, integrate the library into a scratch Next.js project and run
`next build` + exercise a route handler and a Server Action.

This smoke only proves that:

- The exports map resolves correctly for both runtimes.
- Neither entry throws on load.
- The Edge stub is ESM (Next.js Edge rejects CJS) — verified indirectly
  because `import` of a CJS file with the conditions flag would not give
  us named exports on the module namespace object.
