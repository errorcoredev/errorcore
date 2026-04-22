# Module 17: Next.js Integration

> **Spec status:** LOCKED
> **Source files:** `src/integrations/nextjs/index.ts`, `src/integrations/nextjs/edge.mts`, `src/integrations/nextjs/server-action.ts`, `src/integrations/nextjs/types.ts`
> **Dependencies:** Module 15 (middleware), Module 16 (SDK composition)
> **Build order position:** 17 (after core is complete)

---

## Module Contract Header

```typescript
/**
 * @module 17-nextjs-integration
 * @spec spec/17-nextjs-integration.md
 * @dependencies src/index.ts, src/middleware/nextjs.ts, src/middleware/common.ts
 */
```

---

## Purpose

Provide a first-class Next.js integration exposed as the subpath export
`errorcore/nextjs`. The subpath pairs the existing `withErrorcore` route
handler wrapper with a new `withServerAction` wrapper and an Edge-runtime
no-op stub, so the same import statement works in route handlers targeting
either the Node or Edge runtime.

Users import from the subpath; the bundler picks the correct entry via the
`exports` map's runtime conditions (`edge-light`, `workerd`, `browser` for
Edge; `require`/`import`/`default` for Node). No runtime `NEXT_RUNTIME`
check is required in library code.

---

## Scope

- `errorcore/nextjs` subpath Node entry (re-exports core API + middleware).
- `errorcore/nextjs` Edge stub (no-op implementations, emitted as ESM).
- `withServerAction(action, options?, sdk?)` — App Router Server Action wrapper.
- Shared public type surface imported type-only by both entries so they
  remain type-identical.
- Post-build verification script (`scripts/verify-edge-stub.js`) asserting
  the Edge stub has zero external runtime imports.

---

## Non-Goals

- No `withErrorcoreConfig` helper for `next.config.js`. Overlaps with the
  P2.1 webpack optional-DB-driver warning follow-up; shipped as a separate
  task when P2.1 lands.
- No `register()` helper for `instrumentation.ts`. Unneeded — the Edge
  stub's `init()` is already a no-op, so users call `init()`
  unconditionally and the exports map handles runtime selection.
- No change to the top-level `errorcore` entry. Existing consumers who
  import `withErrorcore` from `errorcore` continue to work unchanged.
- Not a dual ESM/CJS build of the whole package. Only the Edge stub is
  ESM (`edge.mts` → `edge.mjs`) because Next.js Edge rejects CJS.

---

## Dependencies

- Module 15 (middleware): the Node entry re-exports `withErrorcore` from
  `src/middleware/nextjs.ts`. `withServerAction` reuses the shared helpers
  in `src/middleware/common.ts` (`getModuleInstance`, `warnIfUninitialized`,
  `SDKInstanceLike`).
- Module 16 (SDK composition): the Node entry re-exports the public facade
  functions (`init`, `captureError`, `trackState`, `withContext`, `flush`,
  `shutdown`, `getTraceparent`) from `src/index.ts`.

---

## Node.js APIs Used

### Node entry (`src/integrations/nextjs/index.ts`)

None directly. Transitively imports everything that `src/index.ts` imports
(ALS, worker_threads, async_hooks) — so it must only be loaded under the
Node runtime.

### Edge stub (`src/integrations/nextjs/edge.mts`)

None. Type-only imports are elided at emit time. The compiled `edge.mjs`
has zero runtime imports outside its directory (enforced by
`scripts/verify-edge-stub.js`).

### withServerAction (`src/integrations/nextjs/server-action.ts`)

Transitively uses `node:async_hooks` (via ALS). Node-runtime only.

---

## Data Structures

### NextLikeRequest (structural)

```typescript
export interface NextLikeRequest {
  method: string;
  url: string;
  headers: { forEach(callback: (value: string, key: string) => void): void };
}
```

### WithServerActionOptions

```typescript
export interface WithServerActionOptions {
  name?: string;
}
```

### Public API on `errorcore/nextjs`

```typescript
function init(config?: Partial<SDKConfig>): void;
function captureError(error: Error): void;
function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(name: string, container: T): T;
function withContext<T>(fn: () => T): T;
function flush(): Promise<void>;
function shutdown(): Promise<void>;
function getTraceparent(): string | null;
function withErrorcore<TReq extends NextLikeRequest, TCtx, TResult>(
  handler: (req: TReq, ctx: TCtx) => Promise<TResult>,
  sdk?: SDKInstanceLike,
): (req: TReq, ctx: TCtx) => Promise<TResult>;
function withServerAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options?: WithServerActionOptions,
  sdk?: SDKInstanceLike,
): (...args: TArgs) => Promise<TResult>;
```

Note: `init()` returns `void` on the subpath (narrower than the top-level
`errorcore` facade, which returns `SDKInstance`). This keeps the Edge
stub's contract honest — the stub cannot return a real `SDKInstance`.
Users who need the instance import from the top-level `errorcore`.

---

## Implementation Notes

### Why the Edge stub emits as `.mjs`

Next.js's Edge runtime rejects CJS modules. The package as a whole is
`"type": "commonjs"`, so every `.ts` file compiles to CJS. The Edge stub
must be ESM, so it lives as `.mts` — TypeScript's Node16 module mode emits
`.mts` as `.mjs` (ESM) regardless of the package `type` field. This is the
only per-file format override in the build; the rest of the package stays
CJS.

### Why `withServerAction` does not delegate to `wrapServerless`

`wrapServerless` (from `src/middleware/lambda.ts`) calls
`await instance.flush?.()` in its `finally` block. That's correct for
Lambda: one invocation per cold/warm start, flush before container
pause. Server Actions, by contrast, can fire many times per render —
parallel actions, nested form submissions. A per-invocation flush would
dominate latency.

`withServerAction` mirrors `withErrorcore`'s pattern instead: start an ALS
context, register in the request tracker, run the action, capture + rethrow
on error, remove from tracker in `finally`. No flush. The regression guard
lives in `test/unit/integrations/nextjs/server-action.test.ts`.

### Early return on existing context

Both `withErrorcore` and `withServerAction` check
`instance.als.getContext?.() !== undefined` before creating a new context.
When a Server Action is invoked from inside a route handler (common for
forms that submit an Action from a Server Component render), we want the
action to participate in the parent request's context rather than creating
a sibling. The early return preserves the parent's `requestId` and prevents
double registration in the request tracker.

### Zero-import invariant for the Edge stub

`src/integrations/nextjs/edge.mts` MUST NOT import any runtime symbol
outside its own directory. Type-only imports (`import type { … } from …`)
are elided at emit time and do not count; any other import would pull
Node-only code into the Edge bundle and break `next build` in an Edge
route. `scripts/verify-edge-stub.js` reads the compiled `edge.mjs` and
fails the build on any violation.

---

## Security Considerations

- The Edge stub captures no errors and has no transport, so the Edge
  surface cannot leak PII or error payloads. Errors that occur in Edge
  routes are handled by the host app, not by `errorcore`.
- `withServerAction` filters headers via the SDK's `HeaderFilter` the
  same way other middleware does. Action arguments are NOT captured;
  only the error (if thrown) and the ALS context are recorded.

---

## Edge Cases

- SDK not initialized (Node entry): `withErrorcore` and `withServerAction`
  warn once and pass the request/action through untouched.
- SDK shutting down: both wrappers pass through (via `isActive()` false).
- Server Action throws synchronously before `await`: caught by the wrapper,
  captured via `captureError`, rethrown to the framework.
- Anonymous action function (`action.name === ''`): URL falls back to
  `action/action`.
- Client Component accidentally imports `errorcore/nextjs`: the `browser`
  condition maps to the Edge stub, so the client bundle gets a safe no-op
  instead of Node-only code.
- Top-level `errorcore` import in a Next.js app (not through the subpath):
  the top-level entry has no Edge conditions, so the Node-only code path
  will fail at `next build` time. Documented in the README.

---

## Testing Requirements

Unit tests under `test/unit/integrations/nextjs/`:

- `server-action.test.ts`: context propagation, tracker lifecycle, SDK
  inactive pass-through, nested context pass-through, SDK setup failure
  pass-through, error capture + rethrow + cleanup, **NO flush on
  success or failure**, argument forwarding, URL naming.
- `edge-stub.test.ts`: every export is a function, all operations are
  no-ops / pass-through, `withContext(fn)` returns `fn()`, `trackState`
  returns the container unchanged, `getTraceparent()` returns null.
- `exports-shape.test.ts`: Node and Edge entries expose identical named
  exports (drift guard).

Smoke under `tmp-nextjs-smoke/`:

- `node smoke-node.cjs`: Node condition resolves to `dist/integrations/
  nextjs/index.js`; full exercise of `init` + `withErrorcore` +
  `withServerAction` + `shutdown`.
- `node --conditions=edge-light smoke-edge.mjs`: Edge condition resolves
  to `dist/integrations/nextjs/edge.mjs`; all operations no-op cleanly.

Post-build check:

- `npm run verify:edge-stub`: compiled Edge stub has zero external
  runtime imports.

---

## Completion Criteria

- `errorcore/nextjs` subpath resolves to the Node entry for `require`/
  `import`/`default` conditions and to the Edge stub for `edge-light`/
  `workerd`/`browser`.
- `withServerAction` passes all 10 unit tests including the no-flush
  regression guard.
- Edge stub passes all 9 no-op tests.
- Exports-shape parity test passes.
- `npm run build && npm run verify:edge-stub && npm test` all pass.
- Both smokes (`smoke-node.cjs`, `smoke-edge.mjs`) print OK.
- Main entry behavior unchanged — all pre-existing tests still pass.

---

## 0.2.0 Additions

### Middleware capture (C1)

**Problem.** `withErrorcore` wraps the route handler. Clerk's middleware runs earlier and can reject requests (401/404) before any route handler executes. Every denied request disappears from capture.

**New export.** `withNextMiddleware` from `errorcore/nextjs`:

```ts
export function withNextMiddleware(
  middleware: (req: NextRequest) => Promise<NextResponse | Response>,
  sdk?: SDKInstanceLike,
): (req: NextRequest) => Promise<NextResponse | Response>;
```

**Behavior:**

1. If SDK not active, return middleware untouched (pass-through).
2. If ALS context already exists (middleware nested inside an existing route context), run middleware inside the existing context — no double-registration.
3. Otherwise, create a new `RequestContext` from the `NextRequest` (same header filtering and traceparent parsing as `withErrorcore`), register in `requestTracker`.
4. `als.runWithContext` the middleware body.
5. Capture thrown errors, rethrow. Clean up in `finally`.
6. Return-value handling:
   - `undefined` return → pass-through. Never treated as a rejection, never captured, regardless of `captureMiddlewareStatusCodes`.
   - `Response` / `NextResponse` return → inspect `.status`. If it matches `config.captureMiddlewareStatusCodes`, capture a synthetic `Error(\`Middleware returned HTTP ${status}\`)` with `name = 'MiddlewareRejection'`.
   - Anything else → pass-through, no capture.

**`captureMiddlewareStatusCodes` config.**

```ts
interface SDKConfig {
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';  // default: 'none'
}
```

- `'none'` (default) — never capture middleware-returned responses, only thrown errors
- `number[]` — capture if returned status is in the list (e.g., `[500, 502, 503, 504]`)
- `'all'` — capture every non-2xx response

Default `'none'` avoids rate-limit exhaustion from Clerk denying bot traffic. Users who want auth-denial visibility opt in explicitly.

**ALS propagation contract.** The ALS context started by `withNextMiddleware` propagates automatically into the downstream route handler. In Node runtime this is intrinsic to `AsyncLocalStorage` — the request moves through `middleware → route` within the same async chain. The `withErrorcore` wrapper at `middleware/nextjs.ts` already checks `instance.als.getContext?.() !== undefined` and skips re-creating a context, so the flow nests correctly.

**Edge runtime.** The existing `edge.mts` no-op stub exports `withNextMiddleware` as a passthrough. Only Node runtime gets real wrapping.

**No user-land escape hatch.** `getModuleInstance` stays `@internal` and undocumented. Users who need bespoke middleware behavior use `withNextMiddleware` with `captureMiddlewareStatusCodes`, or open an issue to drive a future public `errorcore/advanced` subpath.

### Edge runtime capture (C2)

No code change. The `edge.mts` no-op stub is intentional — `errorcore`'s Node-only dependencies (`node:inspector`, `node:async_hooks`, file transport) cannot run in Edge. This is a correctness guarantee.

**Concrete Edge capture path (for users who need it):**

> **Edge-runtime routes are not captured by `errorcore/nextjs` (the Edge entry is a no-op stub).** If you need error capture from Edge handlers, POST directly to your `errorcore` ingestion endpoint:
>
> ```ts
> // app/api/chat/route.ts — runtime: edge
> export const runtime = 'edge';
>
> async function encryptForIngest(payload: object, rawKey: ArrayBuffer): Promise<EncryptedEnvelope> {
>   const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
>   const iv = crypto.getRandomValues(new Uint8Array(12));
>   const pt = new TextEncoder().encode(JSON.stringify(payload));
>   const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
>   return {
>     key_id: process.env.ERRORCORE_KEY_ID,
>     iv: btoa(String.fromCharCode(...iv)),
>     ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))),
>   };
> }
>
> export async function POST(req: Request) {
>   try {
>     // ... handler logic
>   } catch (err) {
>     const envelope = await encryptForIngest({ error: { name: err.name, message: err.message, stack: err.stack }, capturedAt: new Date().toISOString() }, ingestKey);
>     await fetch(process.env.ERRORCORE_COLLECTOR_URL, {
>       method: 'POST',
>       headers: { 'content-type': 'application/json', 'authorization': `Bearer ${process.env.ERRORCORE_INGEST_TOKEN}` },
>       body: JSON.stringify(envelope),
>     });
>     throw err;
>   }
> }
> ```

Expected envelope format (published as part of the ingest API doc):

```json
{
  "key_id": "optional — required when the collector supports key rotation",
  "salt": "base64, when using password-derived keys",
  "iv": "base64, 12 bytes for AES-GCM",
  "ciphertext": "base64",
  "authTag": "optional when not combined into ciphertext"
}
```

**Unencrypted path (dev only):** If you don't want to encrypt from Edge, the ingest token must have `allow_unencrypted: true` on the project — fine for local development, **risky in production** because the payload traverses the network in plaintext. Documented as such.

**Limitations (out of scope for 0.2.0):**
- C3: framework-level 404s and static 500s remain invisible. No interceptor exists for these at the Edge layer.
- C5: client-side (browser) errors are out of SDK scope.
