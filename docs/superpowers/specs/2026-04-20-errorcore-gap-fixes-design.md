# errorcore 0.2.0 — Gap Fixes Design

**Date:** 2026-04-20
**Source report:** `D:\blue\errorcore-gap-report.md` (blubeez integration, 35-entry ndjson)
**Target release:** `errorcore@0.2.0`
**Scope:** P0 (G4) + P1 (G1, G2) + P2 (G3, C1, C2). P3 items deferred.

---

## 1. Problem

A blubeez (Next.js 14 App Router + Clerk + Supabase + LangChain) integration test against the current main produced 35 captures. 0/35 dropped, 0/35 malformed — the capture pipeline is sound. But the three features that justify errorcore over simpler trackers are all dark:

- **G1** — `completeness.localVariablesCaptured: false` on every entry, `captureFailures: ['locals: no_app_frame_key']`. V8 inspector captures frames but can't correlate to errors.
- **G2** — `ioTimeline: []`, `completeness.ioTimelineCaptured: false` on every entry. No HTTP inbound, no HTTP outbound, no DB, no DNS/net events despite the app hitting Supabase, Clerk, and LangChain.
- **G3** — First-hit stacks are opaque `.next/server/.../route.js:1:2486`; subsequent hits resolve to `webpack://blubeez/app/.../route.ts:79:21`. Cold-cache race.
- **G4** — The config resolver throws on `allowInsecureTransport` regardless of value. Server refuses to start for anyone copying an older config.

Plus coverage gaps: Clerk middleware rejections invisible (C1), Edge routes invisible (C2).

---

## 2. Design principles

Three principles govern every decision below.

**Correlate by identity, never by path.** Path serialization is a moving target (V8 raw, webpack-internal, webpack://, file://, source-map-translated, `--enable-source-maps` native hook). Any design that relies on two sides agreeing on a path format will fail under some runtime combination. G1 solves this by tagging the exception itself; G3 solves it by making one-shot parse synchronous.

**Surface what's happening at startup.** Silent fallbacks are how gaps grew into blind spots. Every recorder, every patch, every cache state reports its status once at activate, and surfaces telemetry in `completeness`.

**Document tiered guarantees, not aspirational uniformity.** The SDK promise for Next.js App Router is not the same as for plain Express, and pretending otherwise is the original sin behind this gap report. We ship three tiers of support and tell users which they're in.

---

## 3. G1 — Inspector locals correlation (three cooperating layers)

### 3.1 Root cause

`InspectorManager._onPaused` captures locals keyed by `requestId + normalizedPath + line + col`. `InspectorManager.getLocalsWithDiagnostics` looks up using `_extractFirstAppFrameFromStack(error.stack)` — which walks the error's serialized stack.

In bundled Next.js, the two sides see different path worlds:

- V8 `Debugger.paused` gives `frame.url` = bundled chunk path (`.next/server/chunks/abc.js`) with single-line column offsets.
- `error.stack` at capture time has already been translated by Next.js's source-map-support hook (or `--enable-source-maps`) to `webpack://blubeez/app/.../route.ts:79:21`.

The cache keys never match. Every capture logs `no_app_frame_key`.

`_isAppFrame` and `SDK_ROOT` fixes don't help because they address frame *classification*, not the *format mismatch*. Translating V8's frame URLs through `SourceMapResolver` in the inspector doesn't help either because `error.stack` may or may not already be translated depending on load order — detecting that state reliably is not possible, and double-translation produces garbage.

### 3.2 Three cooperating layers

**Layer 1 — Tag the exception at pause (primary).**

In the `Debugger.paused` handler, after extracting frames, call `Runtime.callFunctionOn` against the exception's `RemoteObject` (available at `params.data.objectId`) with a function that installs a non-enumerable, non-configurable property keyed by `Symbol.for('errorcore.v1.captureId')`. The value is a short ID that indexes the locals ring buffer.

```js
// function body passed to Runtime.callFunctionOn:
function(symbolKey, captureId) {
  if (this == null) return undefined;        // primitive throw
  // Existing tag wins; we never overwrite. Re-throws hit this branch.
  const existing = this[symbolKey];
  if (typeof existing === 'string') return existing;
  if (Object.isFrozen(this)) return undefined;  // frozen (e.g. cross-realm)
  try {
    Object.defineProperty(this, symbolKey, {
      value: captureId,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return captureId;
  } catch {
    return undefined;                        // unexpected defineProperty failure
  }
}
```

The return value is **advisory** — it informs the inspector's own bookkeeping but is not consulted at capture time. At `getLocals(error)` time, the authoritative read is always `error[Symbol.for('errorcore.v1.captureId')]` off the exception object itself. O(1) lookup, no path comparison, survives any stack rewriting.

Properties:
- Idempotent on re-throws: `configurable: false` + the read-existing-first guard means the first pause's tag sticks through subsequent re-throws. A later pause sees the tag already set, returns it, never attempts a second `defineProperty`.
- Invisible to serialization: `enumerable: false` excludes it from `JSON.stringify`, `Object.keys`, spread operators.
- Visible under `Object.getOwnPropertySymbols` — accepted cost; user-level inspection of error objects in the debugger will see an `errorcore.v1.captureId` symbol, which is self-describing.
- Requires `Debugger.setPauseOnExceptions: 'all'` (not `'uncaught'`). The existing InspectorManager already configures `state: 'all'` at [inspector-manager.ts:258](C:\Users\harin\Downloads\errorcore\ec-master\src\capture\inspector-manager.ts:258); this is a hard dependency because Layer 1's whole point is tagging caught-and-reported errors where the user later calls `sdk.captureError(err)`.

**Layer 2 — Identity tuple with structural hash (fallback).**

For cases where tagging physically can't work — primitive throws (`throw 'oops'`), frozen errors, cross-realm exceptions, any path where `Runtime.callFunctionOn` fails — fall back to a structural identity tuple:

```
key = {
  requestId: string | null,
  errorName: string,
  errorMessage: string,
  frameCount: number,
  structuralHash: string,  // SHA-1 of functionNames.join('\u241F')
}
```

`structuralHash` is built from `functionName[]` only — **never from paths**. Function names usually survive bundling and source-map rewriting (both sides read them from the same V8 source), so the hash is stable across format differences.

Lookup selects the key axis based on whether a requestId is present.

**With requestId** (normal in-request capture). Try progressively looser keys, flag each step:

1. `requestId + name + message + frameCount + structuralHash` → `exact`
2. Drop `structuralHash` → `requestId + name + message + frameCount`, flag `locals: degraded_dropped_hash`
3. Drop `frameCount` → `requestId + name + message`, flag `locals: degraded_dropped_count`

**Without requestId** (background error — `setTimeout`/`setImmediate` callback, worker completion, uncaught rejection from a detached promise). Skip the request-scoped steps and start from structure:

4. `name + message + frameCount + structuralHash` → flag `locals: background_context_less`

**Refuses to guess when ambiguous.** If step 4 returns >1 buffer entry with different frame sets, return `null` and flag `locals: ambiguous_context_less_match` rather than pick one. This is the accepted-and-documented collision mode: two unrelated `TypeError: Cannot read properties of undefined (reading 'x')` in the process with identical stack structure will not resolve, which is strictly better than returning wrong locals.

**Minification caveat.** `structuralHash` depends on function names surviving the build. In minified Next.js production builds, mangling collapses names to `a`/`b`/`c` — the background-context-less path (step 4) degrades to mostly-ambiguous because step 4 matches across all captures in the buffer with the same structural prefix. **This is accepted** because Layer 1 (Symbol tag) should cover the overwhelming common case; background errors from minified bundles will preferentially hit Layer 1, and Layer 2 step 4 is the genuine-rare-case fallback. In-request errors (steps 1–3) are unaffected by minification because `requestId` carries identity orthogonal to names.

**Layer 3 — Frame-index alignment (best-effort).**

V8's `params.callFrames` and `error.stack`'s rendered frames are **usually** in lockstep on the common path, but alignment is best-effort, not guaranteed, even without a custom `prepareStackTrace`:

- V8 callFrames can include internal frames (microtask checkpoints, async bootstrap thunks) that Node's default stack formatter strips.
- `Error.captureStackTrace(err, constructorOpt)` clips frames at and above the `constructorOpt` factory — common in error-wrapper libraries (Nest.js, axios, many custom `AppError` classes).
- `--enable-source-maps` and third-party `source-map-support` can each re-render in subtly different ways.

Locals are stored keyed by V8 frame index (0, 1, 2, ...). At serialization time, the rendered stack (after `SourceMapResolver.resolveStack`) is indexed identically — frame 0 gets frame-0's locals, etc.

**Graceful degradation** when the counts disagree: attach locals only to the common prefix `[0 .. min(N, M) - 1]` and flag `locals: frame_count_mismatch_prefix_only` with both counts and the likely cause (`prepareStackTrace_override` / `captureStackTrace_clip` / `internal_frames_stripped`) in the reason string when it can be inferred.

### 3.3 Graceful-absence cases

Each of the following sets `completeness.localVariablesCaptured: false` with a specific `captureFailures` entry, and never silently drops data:

| Case | Flag | Notes |
|------|------|-------|
| Edge runtime | no-op already via `edge.mts` stub | `captureLocalVariables: false` implicit |
| Worker thread | `locals: not_available_in_worker` | `node:inspector` not supported in workers |
| Primitive throw (`throw 42`) | `locals: primitive_throw` | Layer 1 skipped, Layer 2 fingerprint from `String(value)` |
| Frozen error | `locals: frozen_exception` | Layer 1 skipped, Layer 2 used |
| Cross-realm | `locals: cross_realm` | same |
| Minified bundle, name collision | `locals: ambiguous_context_less_match` | ships with Layer 2 degradation flags |
| Inspector not available | `locals: not_available` | pre-existing flag, unchanged |

### 3.4 Sizing and rate control

- Ring buffer capacity: reuse existing `maxCachedLocals: 50`. Buffer pressure handles retention without a fixed time window; entries are LIFO and the buffer only sheds when full. No time-based expiry.
- `Runtime.callFunctionOn` per pause: throttled by the existing `maxLocalsCollectionsPerSecond: 20` gate. No new rate control.
- Lookup does NOT consume entries — same error object captured N times (middleware logs, handler catch, express error middleware) resolves to the same locals N times.

### 3.5 Telemetry

New in `completeness`:

```
localVariablesCaptured: boolean
localVariablesCaptureLayer?: 'tag' | 'identity'          // correlation path used
localVariablesDegradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'background'
localVariablesFrameAlignment?: 'full' | 'prefix_only'    // rendering path (Layer 3)
```

Layer 3 (frame-index alignment) is a rendering step, not a correlation path — it applies after L1 or L2 have already produced a frame set. `localVariablesFrameAlignment: 'prefix_only'` flags the custom-`prepareStackTrace` mismatch case.

`captureFailures` continues to include specific miss reasons. A production dashboard can chart "% capture via Layer 1 vs Layer 2" and catch regressions where Layer 1 starts failing silently and Layer 2 absorbs the traffic.

### 3.6 Files changed

- `src/capture/inspector-manager.ts` — rewrite `_onPaused`, `getLocals`, cache structure
- `src/capture/error-capturer.ts` — pass error reference into inspector (already does), read layer/degradation flags into completeness
- `src/types.ts` — extend `Completeness`
- `spec/12-v8-inspector.md` — rewrite correlation section
- `test/unit/v8-inspector.test.ts` — tag path, fallback path, frame-index alignment, each degradation flag

---

## 4. G2 — Recorder shape audit, driver injection, startup diagnostics

### 4.1 Root cause, two independent issues

**Issue A (shape bugs — this is the critical single-bug fix).** `HttpServerRecorder.handleRequestStart` early-returns when `message.socket === undefined`. The `http.server.request.start` diagnostic-channel payload is `{ request, response }`  — **socket has never been part of that channel's payload, in any Node version**. The strict early-return at [http-server.ts:257](C:\Users\harin\Downloads\errorcore\ec-master\src\recording\http-server.ts:257) drops every single inbound request. The fallback `message.socket ?? request.socket` on line 262 is unreachable dead code.

This single bug is the primary cause of the empty `ioTimeline` observed in the blubeez report — not a contributing factor among several. Fixing it should restore HTTP inbound capture immediately in the Next.js environment and anywhere else that exercises the default path. The other shape issues below are follow-on cleanup to prevent the same class of failure on adjacent channels.

**Issue B (DB drivers, fundamentally unfixable from inside errorcore).** `pg.ts:10` uses `createRequire(__filename)` to resolve `pg` relative to errorcore's install path. Webpack replaces `require('pg')` in user code with `__webpack_require__(moduleId)`, which reads from webpack's own module registry — **that registry never goes through Node's CommonJS loader**. There is no layer to hook inside the bundle. `serverExternalPackages` works because it puts `pg` back on the `Module._load` path.

Attempted fixes via `Module._load` interception or prototype prestine-check tricks don't target the right layer and will not work. This is accepted.

### 4.2 Shape audit

Audit every subscribed channel against actual Node shapes (not just docs), on Node 18 / 20 / 22 / 24, and fix:

| Channel | Current assumption | Real shape | Fix |
|---------|--------------------|------------|-----|
| `http.server.request.start` | `{ request, response, socket, server }` | `{ request, response, server }`; `socket` unreliable | Remove `message.socket === undefined` early return; use `request.socket` |
| `http.client.request.start` | `{ request, socket }` | `{ request }` only; socket attaches later via `response` | Remove socket early-return; attach FD from `request.socket` if present, else null |
| `undici:request:create` | Node `ClientRequest` shape | undici `RequestImpl`; distinct API surface | Audit against undici types, normalize before passing to body capture |
| Response-finished channels | subscribes to `http.server.response.finish` only | newer Node emits `http.server.response.created`; older `http.server.response.finish` | Subscribe to both if available, dedup by request identity |

Each fix ships with a **shape-assertion test** that constructs the real channel payload per Node major version and asserts the recorder consumes it without early-returning or throwing.

**Matrix scoping (per user direction):** don't test the boring cells.

| Recorder | 18 | 20 | 22 | 24 | Rationale |
|----------|----|----|----|----|-----------|
| http-server | ✓ | ✓ | ✓ | ✓ | shape drift observed |
| undici | ✓ | ✓ | ✓ | ✓ | internal API changed between versions |
| pg / mongodb / mysql2 / ioredis | ✓ CI only | ✓ CI only | ✓ CI only | ✓ CI only | fail for reasons orthogonal to Node version |
| http-client | — | ✓ CI only | — | — | single-version unless bug surfaces |
| net | — | ✓ CI only | — | — | stable |
| dns | — | ✓ CI only | — | — | stable |

### 4.3 `drivers` config option

New optional config field:

```ts
interface SDKConfig {
  // ...
  drivers?: {
    pg?: unknown;         // require('pg')
    mongodb?: unknown;    // require('mongodb')
    mysql2?: unknown;     // require('mysql2')
    ioredis?: unknown;    // require('ioredis')
  };
}
```

When set, the corresponding recorder's `install()` uses the user-provided reference instead of `nodeRequire('pg')`. This patches the exact instance the user's code will use.

**Works in:** plain Node, Express, Fastify, Koa, NestJS, single-module-graph bundlers (Vite SSR, esbuild, plain webpack without chunk splitting).

**Does not reliably work in:** Next.js App Router (per-route chunk duplication means different routes may hold different `pg` instances). The Next.js fix remains `serverExternalPackages`.

### 4.4 Three-tier user guidance

Canonical doc block, mirrored in README and `spec/08-io-recording.md`:

> **Tier 1 — Plain Node.js** (Express, Fastify, Koa, NestJS, raw `http`): automatic. No config needed. All recorders install against the same `require()` graph the app uses.
>
> **Tier 2 — Single-graph bundlers** (Vite SSR, esbuild, plain webpack): automatic if the driver is not tree-shaken, or pass explicit references:
> ```ts
> errorcore.init({
>   drivers: { pg: require('pg'), mongodb: require('mongodb') },
> });
> ```
>
> **Tier 3 — Next.js App Router**: externalize drivers from the webpack bundle:
> ```js
> // next.config.js
> module.exports = {
>   serverExternalPackages: ['pg', 'mongodb', 'mysql2', 'ioredis'],
> };
> ```
> Without this, the DB timeline will not populate — the startup diagnostic will report `warn(bundled-unpatched)`. HTTP inbound, HTTP outbound, and `fetch` (undici) recording work in all three tiers.

### 4.5 Bundled-env detection

Only webpack leaves a reliable runtime marker (`__webpack_require__`). Vite SSR, esbuild, Rollup, and bun's bundler do not. We are **honest about the detection limits** rather than inventing fragile heuristics:

```ts
function detectBundler(): 'webpack' | 'unknown' {
  if (typeof (globalThis as any).__webpack_require__ !== 'undefined') return 'webpack';
  return 'unknown';
}
const isNextJs = process.env.NEXT_RUNTIME === 'nodejs';
```

For each DB recorder, determine state:

- `drivers.<name>` provided → patch that exact reference → `ok`
- Driver absent from the resolve path → `skip(not-installed)`
- Driver present, `detectBundler() === 'webpack'`, no `drivers.<name>` → `warn(bundled-unpatched)` — we *know* the patch is ineffective
- Driver present, `detectBundler() === 'unknown'`, no `drivers.<name>` → we proceed with `nodeRequire('pg')` and report `ok` BUT also emit an informational note on the first activate: *"Bundler auto-detection is available only for webpack. If you use Vite SSR, esbuild, or another bundler and do not see DB events, pass drivers: { pg: require('pg') } to init() to ensure we patch the same instance your code uses."* Suppressible via `silent: true`.

This matches the Tier framing honestly:
- Tier 1 (plain Node) and Tier 2 (single-graph webpack) → auto-detected and correct.
- Tier 2 non-webpack (Vite/esbuild) → auto-reports `ok` optimistically, with an up-front "verify by passing `drivers` if you want certainty" note.
- Tier 3 (Next.js App Router) → `warn(bundled-unpatched)` + `serverExternalPackages` recommendation.

Warning messages are runtime-specific:
- Next.js: `"pg detected in bundled Next.js; add 'pg' to serverExternalPackages in next.config.js to enable DB timeline capture."`
- Other webpack: `"pg detected in a bundled environment; pass drivers: { pg: require('pg') } to errorcore.init() to enable DB timeline capture."`

### 4.6 Startup diagnostic output

At end of `activate()`, emit a diagnostic block unless `config.silent === true`. **Best case is a single line** (all recorders `ok`/`skip`, no warns). **With warns it grows to 3–6 lines** (one summary line + one per-warn guidance line + optional bundler-auto-detect note). Document this growth explicitly in the README so users aren't surprised.

Summary line (always, shape unchanged by warn state):

```
[errorcore] 0.2.0 node=20.11.0 recorders: http-server=ok http-client=ok undici=ok net=ok dns=ok pg=skip(not-installed) mongodb=warn(bundled-unpatched) mysql2=skip(not-installed) ioredis=skip(not-installed)
```

Three states, never collapsed:
- `ok` — installed and active
- `skip(<reason>)` — intentionally not installed (driver absent, feature disabled); no user action
- `warn(<reason>)` — wanted to install but couldn't; user action required

Followed (on separate lines) by actionable guidance for each `warn` state only:

```
[errorcore]   → mongodb: driver present but bundled. See: https://errorcore.dev/docs/nextjs#drivers
```

And, when `detectBundler() === 'unknown'` but a driver is present, a single best-effort info line (suppressible independently via `silent`):

```
[errorcore]   info: Bundler auto-detection covers webpack only. If DB events don't appear, pass drivers: { pg: require('pg'), ... } to init().
```

### 4.7 Files changed

- `src/recording/http-server.ts` — remove socket early-return, use `request.socket`
- `src/recording/http-client.ts` — audit, same pattern
- `src/recording/undici.ts` — audit RequestImpl shape
- `src/recording/channel-subscriber.ts` — subscribe to both response-finish and response-created
- `src/recording/patches/patch-manager.ts` — accept `drivers` option, route to each patcher
- `src/recording/patches/{pg,mongodb,mysql2,ioredis}.ts` — accept explicit driver ref
- `src/config.ts` — add `drivers`, `silent` fields
- `src/sdk.ts` — emit startup diagnostic in `activate()`, after channel subscribe
- `src/types.ts` — extend `SDKConfig`, `ResolvedConfig`
- `spec/08-io-recording.md`, `spec/09-database-patches.md`, `spec/10-channel-subscriber.md` — tier doc, shape contracts
- `spec/17-nextjs-integration.md` — `serverExternalPackages` guidance
- `test/unit/io-recording.test.ts` — shape-assertion tests per recorder per Node version (scoped matrix)
- `test/unit/database-patches.test.ts` — `drivers` injection tests
- `test/unit/sdk-composition.test.ts` — startup diagnostic state tests (ok/skip/warn)
- `README.md` — three-tier block

---

## 5. G3 — Source-map cold-cache race

### 5.1 Root cause

`SourceMapResolver.warmCache()` walks `require.cache` at init. In Next.js, app routes don't enter `require.cache` until their first request (lazy-load), so warm-at-init misses them entirely. On first-error, `resolveStack` hits a cache miss and calls `scheduleWarm(filePath)` via `setImmediate` — async. The stack returned by the *current* resolve call is still unresolved. Second error in same file: cache populated, resolved output.

Observed in the gap report: first traceId got `.next/server/…/route.js:1:2486`, traceId a few hundred ms later got `webpack://blubeez/app/…/route.ts:79:21`.

### 5.2 Fix — sync-on-miss with a size gate and three-state cache

In `resolveStack`, on cache miss, **check the candidate map's file size first** (a stat call, ~microseconds):

- If size ≤ `SYNC_MAP_THRESHOLD_BYTES` (default 2MB) → synchronous `getConsumer(filePath)`. One-time disk read + `JSON.parse` + `new SourceMapConsumer` per new file. Fast path.
- If size > threshold (or size unknown — `.map` resolves via `sourceMappingURL` with no pre-check) → do NOT block. Call `scheduleWarm(filePath)` as today, flag the frame with `locals: source_map_async_pending`, leave the frame in its bundled form for this capture. Subsequent captures pick up the resolved consumer.

Rationale: the cascade scenario (N concurrent routes cold-start, all throwing, each capture loading a fresh map) multiplies per-capture blocking time. A 2MB threshold catches the pathological fat-map case (≥500ms parse on modern hardware) while letting the common case (≤2MB maps, ≤100ms parse) through. 20 concurrent cold captures × 100ms ≈ 2s total event-loop blocking spread across 20 request completions — acceptable on a bad start, eliminated entirely on warm process.

`resolveStackCacheOnly` stays cache-only and is used on the three paths that genuinely can't afford any blocking:
- `uncaughtException` (Node is about to terminate the process)
- `SIGTERM` shutdown capture
- `unhandledRejection`-at-exit

The sync-on-miss path applies to the normal capture path only, where the 5–100ms parse cost (bounded by the 2MB threshold) is noise against encryption + HMAC + worker dispatch + transport latency.

`SYNC_MAP_THRESHOLD_BYTES` is configurable via `config.sourceMapSyncThresholdBytes`; defaults to 2MB. Setting to `0` forces fully async (matches pre-0.2.0 behavior, for users who want the cascade-safe option unconditionally).

### 5.3 Three cache states

Replace `Map<string, CachedConsumer | null>` with:

```ts
type CacheEntry =
  | { type: 'consumer'; consumer: SourceMapConsumer; usedAt: number }
  | { type: 'missing'; cachedAt: number }
  | { type: 'corrupt'; reason: string; cachedAt: number };
```

Semantics:
- `consumer` — happy path
- `missing` — no map file exists (adjacent `.map`, `sourceMappingURL`, nothing found). Prevents re-reading filesystem for the same miss on every subsequent error.
- `corrupt` — map existed but `JSON.parse` or `new SourceMapConsumer` threw. Reason preserved for telemetry. Prevents per-error parse storm on the same broken map.

Negative entries (`missing`, `corrupt`) expire after 1 hour to survive re-deploys where the user pushed a fixed build without restarting the observer process.

### 5.4 Cache sizing

`MAX_CACHE_SIZE: 128` (up from 50). Rationale: a medium Next.js app has 100–300 compiled server chunks; 50 churns aggressively and undoes resolution gains. 256 is too generous because `SourceMapConsumer` holds 5–20MB of parsed mappings per entry in the pathological case (256 × 10MB = 2.5GB).

128 is a count-based proxy for memory. A byte-size budget (e.g., 512MB total consumer memory tracked) is the right long-term metric; defer to a followup ticket, tracked in `followups.md`.

### 5.5 Synchronous end-to-end

`getConsumer(filePath)` on the sync path must not yield the event loop between read, parse, and cache-set. No `await`, no `.then()`, no Promise creation. Under single-threaded JS execution, a second caller with the same `filePath` during the sync call is impossible — there is no concurrency to dedup against.

If a future refactor introduces any microtask boundary, replace with an in-flight `Map<string, Promise<CacheEntry>>` dedup table. Not needed now.

### 5.6 Telemetry

Add to `Completeness`:

```ts
sourceMapResolution?: {
  framesResolved: number;       // count of frames that got source-mapped
  framesUnresolved: number;     // count that stayed as bundled positions
  cacheHits: number;
  cacheMisses: number;          // misses that triggered a sync load
  missing: number;              // entries where no map exists
  corrupt: number;              // entries where parse failed
  evictions: number;            // entries LRU-evicted during this capture
};
```

Surfaces degradation in dashboards: "1 frame unresolved because source map was evicted from cache" beats silent opaque stacks. Also provides production signal on whether 128 is enough — track eviction counts over time.

### 5.7 Parse-budget followups

The 2MB sync threshold (§5.2) bounds per-capture sync parse at ~100ms on modern hardware. The existing `MAX_SOURCE_READ_BYTES = 4MB` cap still applies to the async path, so maps above 2MB parse in the background via `setImmediate` and become available for later captures.

Further tightening, if observed in production, lands as 0.3.0 followups (tracked in `followups.md`):
- **Per-`activate()` lifetime sync-parse budget** (e.g., 2s cumulative) with fallback-to-async after exhaustion. Complements the size gate in unusual workloads where many small-but-fragmented maps stack up.
- **`parseTimeoutMs`** that aborts parsing via a clock-check inside the consumer builder loop. Only needed if we see a `source_map_async_pending` rate that merits the complexity.
- **Byte-size cache budget** (secondary eviction criterion beyond count-of-128).

### 5.8 Files changed

- `src/capture/source-map-resolver.ts` — replace cache shape with three-state, sync-on-miss with size gate in `resolveStack`, new telemetry accumulator, `MAX_CACHE_SIZE = 128`
- `src/capture/error-capturer.ts` — thread `sourceMapResolution` telemetry into `Completeness`
- `src/config.ts`, `src/types.ts` — new `sourceMapSyncThresholdBytes` config field, extend `Completeness`
- `src/sdk.ts` — plumb the threshold through to the resolver constructor
- `spec/13-error-capture-pipeline.md` — update resolve-path contract, size-gate behavior
- `test/unit/source-map-resolver.test.ts` — sync-on-miss, size-gate async fallback, missing-cache, corrupt-cache, negative-entry 1-hour expiry, cache sizing at 128, telemetry
- `followups.md` — byte-size budget, lifetime sync budget, parseTimeoutMs

---

## 6. G4 — `allowInsecureTransport` semantics

### 6.1 Root cause

`config.ts:193-197` throws whenever the field is *present* in user config, regardless of value. Users who copied older config templates with the field defaulted to `false` hit this wall on `next start`.

### 6.2 Fix — deprecate with grace, reject contradictions

```ts
const legacyValue = (userConfig as { allowInsecureTransport?: unknown }).allowInsecureTransport;

if (legacyValue === true) {
  if (userConfig.allowPlainHttpTransport === false) {
    throw new Error(
      'Config contradiction: allowInsecureTransport: true and allowPlainHttpTransport: false cannot both be set. ' +
      'Remove allowInsecureTransport (deprecated) and set allowPlainHttpTransport: true if you intend to allow plain HTTP.'
    );
  }
  throw new Error(
    'allowInsecureTransport: true was renamed to allowPlainHttpTransport: true in 0.2.0. ' +
    'Update your config. (Deprecated in 0.2.0, will be removed in 1.0.0.)'
  );
}

if (legacyValue === false) {
  warnLegacyInsecureTransportOnce();  // one-shot per process
}
```

One-shot warn is stored on a module-scoped boolean; subsequent `init()` calls (dev hot-reload, test-suite create/destroy cycles) don't repeat it.

### 6.3 Config template migration

`config-template/errorcore.config.js`: replace the current line 55 with a commented reference preserved for one release cycle, so users who grep their config for `allowInsecureTransport` find the migration note instead of silence:

```js
// allowInsecureTransport: removed in 0.2.0, see CHANGELOG — use allowPlainHttpTransport
// allowPlainHttpTransport: false,
```

Both templates (`errorcore.config.js`, `errorcore.config.minimal.js`) get updated.

### 6.4 CHANGELOG entry

Top-of-file migration block:

```md
## 0.2.0

### Breaking (pre-1.0 semver window)

- `allowInsecureTransport: true` is rejected with an error pointing at `allowPlainHttpTransport: true`.
- `allowInsecureTransport: false` is accepted as a silent no-op with a one-time deprecation warning.
- `allowInsecureTransport: true` combined with `allowPlainHttpTransport: false` is rejected as a contradiction.

Deprecated in 0.2.0, will be removed in 1.0.0.
```

### 6.5 Files changed

- `src/config.ts` — replace the current throw with the tri-valued handler, add one-shot warn
- `config-template/errorcore.config.js`, `config-template/errorcore.config.minimal.js` — migration comment
- `CHANGELOG.md` — migration block
- `test/unit/types-and-config.test.ts` — all four semantics (undefined / false / true / true+false contradiction)

---

## 7. C1 — Next.js middleware capture

### 7.1 Root cause

`withErrorcore` wraps the route handler. Clerk's middleware runs earlier and can reject requests (401/404) before any route handler ever executes. Every denied request disappears from capture.

### 7.2 Fix — `withNextMiddleware` + opt-in status-code capture

New export from `errorcore/nextjs`:

```ts
export function withNextMiddleware(
  middleware: (req: NextRequest) => Promise<NextResponse | Response>,
  sdk?: SDKInstanceLike,
): (req: NextRequest) => Promise<NextResponse | Response>;
```

Behavior, mirrors `withErrorcore`:

1. If SDK not active, return middleware untouched.
2. If ALS context already exists, run middleware inside the existing context (no double-registration).
3. Else, create a new `RequestContext` from the `NextRequest` (same header filtering, traceparent parsing as `withErrorcore`), register in `requestTracker`.
4. `als.runWithContext` the middleware body.
5. Capture thrown errors, rethrow. Clean up in `finally`.
6. **Return-value handling:**
   - `undefined` return → pass-through. Clerk (and many other Next.js middleware patterns) returns `undefined` to signal "let the request proceed to the route handler." This is never treated as a rejection and never captured, regardless of `captureMiddlewareStatusCodes`.
   - `Response` / `NextResponse` return → inspect `.status`. If it matches `config.captureMiddlewareStatusCodes`, capture a synthetic `Error(`Middleware returned HTTP ${status}`)` with `name = 'MiddlewareRejection'`.
   - Anything else (rare but theoretically possible) → pass-through, no capture.

### 7.3 New config field

```ts
interface SDKConfig {
  // ...
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';  // default: 'none'
}
```

- `'none'` (default) — never capture middleware-returned responses, only thrown errors
- `number[]` — capture if returned status is in the list (e.g., `[500, 502, 503, 504]` for server errors; `[401, 403, 500]` to include auth denials)
- `'all'` — capture every non-2xx response

Default `'none'` avoids blowing the rate limit with Clerk-denying-every-bot traffic. Users who want auth-denial visibility opt in.

### 7.4 ALS propagation contract

The ALS context started by `withNextMiddleware` MUST propagate into the downstream route handler. In Node runtime this is intrinsic to `AsyncLocalStorage` — the request moves through `middleware → route` within the same async chain, so `als.getContext()` inside the route handler returns the middleware-created context.

The `withErrorcore` wrapper at `middleware/nextjs.ts:33` already checks `instance.als.getContext?.() !== undefined` and skips re-creating a context, so the flow naturally nests.

A dedicated test asserts this: middleware sets requestId X, route handler calls `captureError(err)`, captured payload shows `trace.traceId` equal to the middleware's.

Edge runtime: the existing `edge.mts` stub exports `withNextMiddleware` as a passthrough (per C2). Only Node runtime gets real wrapping.

### 7.5 No user-land escape hatch in 0.2.0

We do **not** document a user-land "wrap your own middleware with `getModuleInstance`" pattern. The internal/public stance was contradictory: documenting an `@internal` function makes it de facto public, and future tightening becomes a breaking change.

Instead:
- `getModuleInstance` stays `@internal`, undocumented in user-facing docs.
- Users who need bespoke middleware behavior have two supported paths:
  1. Use `withNextMiddleware(myMiddleware)` and configure `captureMiddlewareStatusCodes` to express what to capture.
  2. If that's insufficient, open an issue describing the unmet use case. We'll either extend `withNextMiddleware` or commit to a public advanced-API subpath in a future release (candidate name: `errorcore/advanced` with a narrowed `getSDK()` export and a stable `AdvancedSDKHandle` interface) — but only when we have concrete demand, not speculatively.

This keeps the 0.2.0 surface area honest: what we ship is stable; what users want beyond that drives a future version.

### 7.6 Files changed

- `src/integrations/nextjs/middleware.ts` (new) — `withNextMiddleware` implementation
- `src/integrations/nextjs/index.ts` — re-export
- `src/integrations/nextjs/edge.mts` — passthrough stub for `withNextMiddleware`
- `src/integrations/nextjs/types.ts` — `NextRequest`, `NextResponse` structural types
- `src/config.ts`, `src/types.ts` — `captureMiddlewareStatusCodes`
- `spec/17-nextjs-integration.md` — section on middleware capture, propagation contract, user-land escape hatch
- `test/unit/integrations/nextjs/middleware.test.ts` — SDK inactive passthrough, context propagation into downstream route handler, status-code capture with each config value, error-throwing middleware, nested-context pass-through
- `test/unit/integrations/nextjs/exports-shape.test.ts` — ensure Edge stub and Node entry stay in sync

---

## 8. C2 — Edge runtime docs

No code change. The `edge.mts` no-op stub is intentional.

### 8.1 Concrete Edge capture path (docs)

Add to `spec/17-nextjs-integration.md` and README:

> **Edge-runtime routes are not captured by `errorcore/nextjs` (the Edge entry is a no-op stub).** This is a correctness guarantee — `errorcore`'s Node-only dependencies (`node:inspector`, `node:async_hooks`, file transport) cannot run in Edge. If you need error capture from Edge handlers, POST directly to your `errorcore` ingestion endpoint:
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

**Expected envelope format** (published as part of the ingest API doc):

```json
{
  "key_id": "optional — required when the collector supports key rotation",
  "salt": "base64, when using password-derived keys",
  "iv": "base64, 12 bytes for AES-GCM",
  "ciphertext": "base64",
  "authTag": "optional when not combined into ciphertext"
}
```

**Unencrypted path** (dev only):

> If you don't want to encrypt from Edge, the ingest token must have `allow_unencrypted: true` on the project — fine for local development, **risky in production** because the payload traverses the network in plaintext. Documented as such.

### 8.2 Files changed

- `spec/17-nextjs-integration.md` — Edge section
- `README.md` — short note with link to spec
- No source changes

---

## 9. Testing

### 9.1 CI smoke — `next build && next start`

Upgrade `tmp-nextjs-smoke/` into a real smoke fixture:

**Fixture structure:**
- Minimal Next.js 14 App Router app
- `instrumentation.ts` → `errorcore.init({ transport: { type: 'file', path: './smoke-errors.ndjson' }, captureLocalVariables: true, allowUnencrypted: true })`
- `app/api/test-error/route.ts` — handler wrapped in `withErrorcore`, calls a **meaningful** function with real intermediate locals:

```ts
function computeUserDiscount(user: User, cart: Cart): number {
  const base = cart.items.reduce((s, it) => s + it.price * it.qty, 0);
  const tierMultiplier = user.tier === 'gold' ? 0.8 : 1.0;
  const promoDiscount = cart.promoCode ? lookupPromo(cart.promoCode) : 0;
  // error fires here with user, cart, base, tierMultiplier, promoDiscount all in scope
  throw new Error('discount computation boom');
}
```

**Assertions on captured ndjson:**
- At least 1 entry
- `completeness.ioTimelineCaptured: true` AND `ioTimeline.length > 0` with at least one `http-server` inbound event
- `completeness.localVariablesCaptured: true` AND `localVariables` contains a frame where `locals.user`, `locals.cart`, and at least one intermediate (`base` or `tierMultiplier` or `promoDiscount`) are present
- **First entry (request 1, not request 2)** has a stack frame in `webpack://` or `file://<source>` form, NOT `.next/server/…/route.js`
- The resolved frame points to the actual throw line in source — `line` equals the line number of the `throw new Error(...)` statement in `computeUserDiscount` (not line 1 of the compiled bundle), and `column` is within ±2 of the column where `throw` appears. This confirms the source-map resolution is semantically correct, not just format-correct.
- `sourceMapResolution.framesResolved > 0` on the first request

### 9.2 CI variant — `--enable-source-maps`

Add a second smoke run with `NODE_OPTIONS=--enable-source-maps`. This installs Node's native `Error.prepareStackTrace` hook, which is a common production deployment pattern and the variant most likely to surface G1 regressions (because it changes what `error.stack` looks like before errorcore reads it).

### 9.3 Per-recorder shape tests

Scoped matrix per §4.2: http-server × 18/20/22/24, undici × 18/20/22/24, DB patches single-version. Shape-assertion tests feed the real channel payload per version and assert the recorder does not early-return or throw.

### 9.4 Unit coverage for new paths

- `test/unit/v8-inspector.test.ts` — Layer 1 tag path, Layer 2 fallback with each degradation level, Layer 3 frame-index alignment with and without count mismatch, each graceful-absence case
- `test/unit/source-map-resolver.test.ts` — sync-on-miss, missing-cache, corrupt-cache, negative-entry 1-hour expiry, sizing at 128, telemetry emission
- `test/unit/types-and-config.test.ts` — all four G4 semantics, `drivers` config, `captureMiddlewareStatusCodes` config, `silent` config
- `test/unit/sdk-composition.test.ts` — startup diagnostic state strings per recorder state
- `test/unit/io-recording.test.ts` — shape-assertion tests
- `test/unit/integrations/nextjs/middleware.test.ts` — `withNextMiddleware` (§7.6)

---

## 10. Versioning & release

### 10.1 Version: 0.2.0

Pre-1.0 semver allows breaking changes at minor bumps. 0.2.0 bundles:

- New exports: `withNextMiddleware`
- New config fields: `drivers`, `captureMiddlewareStatusCodes`, `silent`, `sourceMapSyncThresholdBytes`
- New completeness telemetry fields: `localVariablesCaptureLayer`, `localVariablesDegradation`, `sourceMapResolution`
- G4 behavior: relaxed-but-behavior-changing
- New build guarantees: sync-on-miss source maps, identity-correlation locals, shape-robust recorders

Do not bump to 1.0.0. 1.0.0 is reserved for concurrent release with the ingestion backend's commercial availability — "the contract is stable for paying users." Current contract is still moving.

No release candidate. Without external users to pressure-test, an RC is ceremony; ship 0.2.0 direct.

### 10.2 CHANGELOG entry (full draft)

```md
## 0.2.0 (2026-MM-DD)

### Breaking (pre-1.0 semver window)

- **Config**: `allowInsecureTransport: true` is rejected with an error pointing at `allowPlainHttpTransport: true`. `allowInsecureTransport: false` is accepted as a silent no-op with a one-time deprecation warning. `allowInsecureTransport: true` combined with `allowPlainHttpTransport: false` is rejected as a contradiction. Deprecated in 0.2.0, will be removed in 1.0.0.
- **Startup output**: a single diagnostic line is printed at `activate()` listing recorder states. Suppress with `config.silent: true`.

### Fixed

- Local variables now capture correctly in bundled environments (Next.js, Vite SSR, webpack). Inspector locals are correlated via a non-enumerable Symbol tag on the exception object (Layer 1), with identity-tuple fallback (Layer 2) and frame-index alignment (Layer 3). [G1]
- HTTP inbound and outbound recorders no longer early-return on missing `socket` in diagnostic-channel payloads. HTTP server, HTTP client, and undici now subscribe against real Node channel shapes per supported version. [G2 shape audit]
- Source-map resolution is consistent from the first capture. Cache misses load synchronously on the normal capture path (uncaughtException/SIGTERM paths remain cache-only). [G3]

### Added

- `withNextMiddleware(middleware)` — wrap a Next.js middleware handler to start an ALS context, capture thrown errors, and optionally capture non-2xx responses. Propagates context into the wrapped route handler. `undefined` returns are always pass-through. [C1]
- `captureMiddlewareStatusCodes: number[] | 'none' | 'all'` config — control which middleware-returned status codes are captured. Default `'none'`. [C1]
- `drivers: { pg?, mongodb?, mysql2?, ioredis? }` config — explicit driver references for bundled environments. [G2]
- `silent: boolean` config — suppress the startup diagnostic block.
- `sourceMapSyncThresholdBytes: number` config (default 2MB) — maps larger than this resolve asynchronously to avoid cold-cascade event-loop blocking. [G3]
- Three-state recorder telemetry in the startup block: `ok`, `skip(<reason>)`, `warn(<reason>)`, with per-warn guidance lines.
- `completeness.localVariablesCaptureLayer`, `completeness.localVariablesDegradation`, `completeness.localVariablesFrameAlignment`, `completeness.sourceMapResolution` fields.

### Docs

- `spec/17-nextjs-integration.md` expanded with Tier 1/2/3 guidance, `serverExternalPackages` recommendation, Edge capture pattern, `withNextMiddleware` reference.
- README mirrors the three-tier block.

### Deferred (tracked in followups.md)

- Byte-size budget for source-map cache (secondary eviction criterion).
- `parseTimeoutMs` for source-map parse (bounded at ~500ms today by the 4MB file cap).
- 1.0.0 release concurrent with ingestion-backend commercial availability.
```

---

## 11. Out of scope

Explicitly NOT in this design:

- **C3** — framework-level 404s and static 500s remain invisible. Noted as a limitation in spec/17.
- **C4** — public 500-returning test route: rolled into §9.1 (CI smoke already covers 5xx via a route variant, without a separate new route).
- **C5** — client-side (browser) errors. Out of SDK scope; documented.
- **M1–M6** — cosmetic observations from the gap report. Either absorbed into this work (M3 URL normalization lands naturally with the http-server audit) or deferred to 0.2.x patch as they surface.
- **1.0.0** — reserved for commercial launch.

---

## 12. Success criteria

This design is successful when, on a re-run of the blubeez integration test (35 captures, same methodology as the 2026-04-20 run):

1. `completeness.captureFailures` is empty on all entries where the app had ALS context.
2. `completeness.localVariablesCaptured: true` on every entry that passed Layer 1 (expected majority); entries via Layer 2 flagged with the specific degradation.
3. `ioTimeline.length > 0` for every HTTP-triggered capture; includes http-server inbound + at least one outbound (undici or http-client).
4. DB events populate iff the user has configured `serverExternalPackages` OR passed `drivers`; the startup diagnostic says so explicitly.
5. First-hit stack from any new route is source-map-resolved (not `.next/server/…/route.js:1:column`).
6. `next start` succeeds with a config containing `allowInsecureTransport: false`.
7. Clerk middleware rejections are captured iff the user has set `captureMiddlewareStatusCodes` to include the status. Default (`'none'`) preserves current behavior.
8. The startup line clearly communicates which recorders are active and which require user action.
