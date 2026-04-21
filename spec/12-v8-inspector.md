# Module 12: V8 Inspector Integration

> **Spec status:** LOCKED
> **Source files:** `src/capture/inspector-manager.ts`
> **Dependencies:** Module 01 (types, config)
> **Build order position:** 12

---

## Module Contract Header

```typescript
/**
 * @module 12-v8-inspector
 * @spec spec/12-v8-inspector.md
 * @dependencies types.ts, config.ts
 */
```

---

## Purpose

Manage a V8 inspector session that captures local variables from application-code stack frames when exceptions are thrown. Provides a cache of recently captured locals for matching at error-capture time.

This is a single unified class combining session lifecycle, the `Debugger.paused` handler, variable extraction, and the locals cache. These cannot be meaningfully separated.

---

## Scope

- `InspectorManager` class with constructor, `getLocals()`, and `shutdown()`
- `Debugger.paused` handler with 4-gate fast path
- Shallow local variable serialization from V8 `RemoteObject`
- TTL-based cache with rate limiting
- Graceful degradation when inspector is unavailable

---

## Non-Goals

- Does not orchestrate the full error capture flow (module 13 does that).
- Does not evaluate expressions or execute code via the inspector beyond the Symbol-tag call described in Layer 1 below.
- Does not expand nested objects via additional `Runtime.getProperties` calls (shallow only).

---

## Dependencies

- Module 01: `CapturedFrame`, `ResolvedConfig`

---

## Node.js APIs Used

- `require('node:inspector')` (synchronous API, NOT `node:inspector/promises`)
- `inspector.url()` — detect existing debugger sessions
- `new inspector.Session()`
- `session.connect()`
- `session.post(method, params?, callback?)`
- `session.on('Debugger.paused', handler)`
- `session.disconnect()`
- `setInterval()` with `.unref()` for cache sweep and rate limit reset

---

## Data Structures

### V8 Inspector Protocol types (subset used)

```
Debugger.enable()
Debugger.disable()
Debugger.setPauseOnExceptions({ state: 'all' | 'none' })
Debugger.resume()

Event Debugger.paused {
  params: {
    reason: 'exception' | 'promiseRejection' | 'other' | 'ambiguous' | ...
    data?: Runtime.RemoteObject
    callFrames: Debugger.CallFrame[]
  }
}

Debugger.CallFrame {
  callFrameId: string
  functionName: string
  location: { scriptId: string, lineNumber: number, columnNumber: number }
  url: string
  scopeChain: Debugger.Scope[]
}

Debugger.Scope {
  type: 'global' | 'local' | 'closure' | 'catch' | 'block' | 'script' | 'eval' | 'module' | 'with' | 'wasm-expression-stack'
  object: Runtime.RemoteObject
}

Runtime.getProperties({ objectId, ownProperties: true }) -> { result: Runtime.PropertyDescriptor[] }

Runtime.PropertyDescriptor { name: string, value?: Runtime.RemoteObject }

Runtime.RemoteObject {
  type: 'object' | 'function' | 'undefined' | 'string' | 'number' | 'boolean' | 'symbol' | 'bigint'
  subtype?: 'array' | 'null' | 'regexp' | 'date' | 'map' | 'set' | 'error' | ...
  className?: string
  value?: any
  description?: string
  objectId?: string       // INVALID after Debugger.resume
}
```

### InspectorManager class

```typescript
class InspectorManager {
  constructor(config: ResolvedConfig);
  getLocals(error: Error): CapturedFrame[] | null;
  isAvailable(): boolean;
  shutdown(): void;
}
```

### Internal cache (0.2.0 three-layer design)

The cache is keyed by a short capture ID (`string`), not by error message text. Layer 1 installs the ID as a Symbol property on the thrown exception; Layers 2 and 3 provide fallback paths when tagging is not possible.

```ts
// Ring buffer entry
interface LocalsCacheEntry {
  captureId: string;
  frames: CapturedFrame[];
  requestId: string | null;
  errorName: string;
  errorMessage: string;
  frameCount: number;
  structuralHash: string;   // SHA-1 of functionNames.join('\u241F')
  capturedAt: number;       // hrtime epoch, for rate control only
}
```

Primary index: `Map<string, LocalsCacheEntry>` keyed by `captureId`.
Secondary index: separate lookup structures for Layer 2 identity-tuple matching (maintained in parallel, details below).

---

## Implementation Notes

### Constructor initialization sequence

```
1. if (!config.captureLocalVariables) -> this.available = false; return
2. try { inspector = require('node:inspector') } catch -> this.available = false; return
3. if (inspector.url()) -> this.available = false; warn('Debugger already attached'); return
4. this.session = new inspector.Session()
5. try { this.session.connect() } catch -> this.available = false; return
6. this.session.post('Debugger.enable')
7. this.session.post('Debugger.setPauseOnExceptions', { state: 'all' })
8. this.session.on('Debugger.paused', this._onPaused.bind(this))
9. Set up rate limit timer (1-second setInterval, .unref())
10. Set up cache sweep timer (10-second setInterval, .unref())
```

`Debugger.setPauseOnExceptions: 'all'` (not `'uncaught'`) is a hard dependency for Layer 1: the whole point is tagging caught-and-reported errors where the user later calls `sdk.captureError(err)`.

### _onPaused handler — critical hot path

**CRITICAL CONSTRAINT:** All `session.post()` calls use the CALLBACK form. Callbacks fire synchronously while V8 is paused. This is confirmed by Node.js internals (PR #27893) and Sentry's production experience (PR #7637). `Debugger.resume` MUST be called synchronously before the handler returns. The entire handler is wrapped in `try/finally` with `session.post('Debugger.resume')` in the finally block.

**4-gate fast path:**

```
Gate 1: reason check (< 0.001ms)
  if reason !== 'exception' && reason !== 'promiseRejection' -> return (finally resumes)

Gate 2: rate limit (< 0.001ms)
  if collectionCountThisSecond >= maxCollectionsPerSecond (default 20) -> return

Gate 3: cache capacity (< 0.001ms)
  if cache.size >= maxCachedEntries (default 50) -> return

Gate 4: application code check (~0.01ms)
  Scan callFrames for at least one app frame.
  A frame is "app code" if its url does NOT:
    - Start with 'node:' (built-in modules)
    - Contain '/node_modules/' (libraries)
    - Contain 'node:internal'
    - Be empty or undefined (eval'd code)
    - Match the SDK's own file paths
  If no app frames found -> return
```

Gates are ordered by cost (cheapest first) and selectivity (most-filtering first).

**Collection (only reached if all 4 gates pass, ~0.1-0.5ms):**

```
1. Generate captureId (short random or monotonic string)
2. Layer 1: call Runtime.callFunctionOn against params.data.objectId
   (see Layer 1 section below)
3. for each app frame (max maxFrames, default 5):
     localScope = frame.scopeChain.find(s => s.type === 'local')
     if no localScope or no objectId -> skip
     session.post('Runtime.getProperties', { objectId, ownProperties: true }, (err, result) => {
       // callback fires SYNCHRONOUSLY
       if err or !result -> skip
       collected.push({
         functionName, filePath, lineNumber (+1, V8 is 0-based), columnNumber (+1),
         locals: _extractLocals(result.result),
         frameIndex: i,  // Layer 3 alignment
       })
     })
4. Build Layer 2 identity tuple from params.callFrames
5. Store entry in ring buffer, indexed by captureId
6. Increment collectionCountThisSecond
```

### Three cooperating correlation layers (0.2.0)

The root cause of `no_app_frame_key` in bundled Next.js: the V8 `Debugger.paused` handler sees frame URLs in the bundled chunk format (`.next/server/chunks/abc.js`), while `error.stack` at capture time has already been rewritten by source-map-support to `webpack://blubeez/app/.../route.ts:79:21`. Any path-comparison cache key will miss. The three-layer design eliminates path comparison entirely.

#### Layer 1 — Tag the exception at pause (primary)

After extracting frames, call `Runtime.callFunctionOn` against `params.data.objectId` (the thrown exception's `RemoteObject`) with a function that installs a non-enumerable Symbol property keyed by `Symbol.for('errorcore.v1.captureId')`:

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

The return value is advisory — it informs the inspector's own bookkeeping but is not consulted at capture time. At `getLocals(error)` time, the authoritative read is always `error[Symbol.for('errorcore.v1.captureId')]` off the exception object itself. O(1) lookup, no path comparison, survives any stack rewriting.

Properties:
- Idempotent on re-throws: `configurable: false` + read-existing-first guard means the first pause's tag sticks through subsequent re-throws.
- Invisible to serialization: `enumerable: false` excludes it from `JSON.stringify`, `Object.keys`, spread operators.
- Visible under `Object.getOwnPropertySymbols` — accepted cost; self-describing name.

Layer 1 is skipped (falls through to Layer 2) for: primitive throws (`throw 42`), frozen errors, cross-realm exceptions, and any path where `Runtime.callFunctionOn` fails.

#### Layer 2 — Identity tuple with structural hash (fallback)

For cases where Layer 1 physically cannot work, build an identity tuple from the pause data:

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

Lookup strategy:

**With requestId** (normal in-request capture) — try progressively looser keys:

1. `requestId + name + message + frameCount + structuralHash` → `exact`
2. Drop `structuralHash` → flag `locals: degraded_dropped_hash`
3. Drop `frameCount` → flag `locals: degraded_dropped_count`

**Without requestId** (background error — `setTimeout`/`setImmediate`, worker callback, uncaught rejection from a detached promise):

4. `name + message + frameCount + structuralHash` → flag `locals: background_context_less`

If step 4 returns >1 entry with different frame sets, return `null` and flag `locals: ambiguous_context_less_match`. This is the documented collision mode — strictly better than returning wrong locals.

**Minification caveat.** In minified production bundles, function names collapse to `a`/`b`/`c`, making step 4 mostly-ambiguous. Layer 1 (Symbol tag) covers the common case; in-request errors (steps 1–3) are unaffected by minification because `requestId` carries identity orthogonal to names.

#### Layer 3 — Frame-index alignment (best-effort)

V8's `params.callFrames` and `error.stack`'s rendered frames are usually in lockstep but alignment is best-effort:
- V8 callFrames can include internal frames (microtask checkpoints, async bootstrap thunks) that Node's default stack formatter strips.
- `Error.captureStackTrace(err, constructorOpt)` clips frames — common in error-wrapper libraries (Nest.js, axios, custom `AppError` classes).
- `--enable-source-maps` and `source-map-support` can each re-render in subtly different ways.

Locals are stored keyed by V8 frame index (0, 1, 2, ...). At serialization time, the rendered stack is indexed identically — frame 0 gets frame-0's locals.

**Graceful degradation** when counts disagree: attach locals only to the common prefix `[0 .. min(N, M) - 1]` and flag `locals: frame_count_mismatch_prefix_only` with both counts and the likely cause in the reason string when it can be inferred (`prepareStackTrace_override` / `captureStackTrace_clip` / `internal_frames_stripped`).

### Graceful-absence cases

Each of the following sets `completeness.localVariablesCaptured: false` with a specific `captureFailures` entry:

| Case | Flag |
|------|------|
| Edge runtime | `captureLocalVariables: false` implicit (edge.mts stub) |
| Worker thread | `locals: not_available_in_worker` |
| Primitive throw (`throw 42`) | `locals: primitive_throw` |
| Frozen error | `locals: frozen_exception` |
| Cross-realm | `locals: cross_realm` |
| Minified bundle, name collision | `locals: ambiguous_context_less_match` |
| Inspector not available | `locals: not_available` |

### _extractLocals

```
for each property:
  if SENSITIVE_VAR_RE matches name -> '[REDACTED]'
  else -> _serializeRemoteObject(prop.value)

SENSITIVE_VAR_RE = /^(password|secret|token|apiKey|privateKey|credential|auth|sessionId)$/i
```

### _serializeRemoteObject — shallow serialization

| Input type/subtype | Output |
|---|---|
| undefined | `undefined` |
| string | `obj.value` (capped at 2048 chars) |
| number | `obj.value` |
| boolean | `obj.value` |
| bigint | `{ _type: 'BigInt', value: obj.description }` |
| symbol | `{ _type: 'Symbol', description: obj.description }` |
| function | `'[Function: description]'` |
| null (subtype) | `null` |
| array (subtype) | `'[Array(description)]'` |
| regexp (subtype) | `obj.description` |
| date (subtype) | `obj.description` |
| error (subtype) | `obj.description` |
| map (subtype) | `'[Map(description)]'` |
| set (subtype) | `'[Set(description)]'` |
| other object | `'[className or Object]'` |

No objectIds are ever stored. No recursive expansion.

### getLocals matching

```
getLocals(error: Error):
  // Layer 1: direct Symbol-tag lookup (O(1))
  captureId = error[Symbol.for('errorcore.v1.captureId')]
  if captureId is a string:
    entry = ringBuffer.get(captureId)
    if entry:
      record telemetry: localVariablesCaptureLayer = 'tag'
      return applyLayer3Alignment(entry.frames, error.stack)

  // Layer 2: identity-tuple fallback
  entry = layer2Lookup(error)
  if entry:
    record telemetry: localVariablesCaptureLayer = 'identity'
    return applyLayer3Alignment(entry.frames, error.stack)

  return null  // no match
```

Lookup does NOT consume entries — same error captured N times resolves to the same locals N times.

### Telemetry (0.2.0)

New fields in `completeness`:

```
localVariablesCaptured: boolean
localVariablesCaptureLayer?: 'tag' | 'identity'          // correlation path used
localVariablesDegradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'background'
localVariablesFrameAlignment?: 'full' | 'prefix_only'    // rendering path (Layer 3)
```

### Cache maintenance

- Ring buffer capacity: `maxCachedLocals` (default 50). LIFO shedding; no time-based expiry.
- Rate limit: 20 collections/second via `setInterval(.unref())`.
- Lookup does NOT consume entries (unlike the pre-0.2.0 one-shot design).

---

## Security Considerations

- The inspector session is powerful. It MUST NOT evaluate arbitrary code, expose the session externally, or use `Runtime.evaluate`.
- Sensitive variable names are redacted: `password`, `secret`, `token`, `apiKey`, `privateKey`, `credential`, `auth`, `sessionId`.
- No V8 `objectId` references are stored after resume — they become invalid.
- The session uses: `Debugger.enable/disable`, `Debugger.setPauseOnExceptions`, `Debugger.resume`, `Runtime.getProperties`, and `Runtime.callFunctionOn` (Layer 1 Symbol-tag install only — the function body is a fixed literal, never user-supplied).
- The Symbol tag installed by Layer 1 (`Symbol.for('errorcore.v1.captureId')`) is visible under `Object.getOwnPropertySymbols` in user-land debuggers. The name is self-describing and the value is a non-sensitive short ID.

---

## Edge Cases

- `node:inspector` not available: `available = false`, `getLocals()` returns `null`
- Another debugger attached (`inspector.url()` returns truthy): `available = false`, warn
- `session.connect()` throws: `available = false`
- Exception in `_onPaused` handler body: `finally` block ensures `Debugger.resume` is called
- `Runtime.callFunctionOn` fails (Layer 1): skip tag, fall through to Layer 2
- `Runtime.getProperties` returns error for a frame: that frame skipped, others still collected
- All frames are library code (node_modules): Gate 4 rejects, resume immediately
- Cache full: Gate 3 rejects, resume immediately
- Rate limit exceeded: Gate 2 rejects, resume immediately
- Error re-thrown: Layer 1 tag already present (`configurable: false`), returns existing captureId, no double-store
- Non-Error throws (e.g., `throw "string"`): Layer 1 skipped (null objectId), Layer 2 fingerprint from `String(value)`; flag `locals: primitive_throw`
- Frozen error: Layer 1 `Object.isFrozen` check returns undefined, falls to Layer 2; flag `locals: frozen_exception`
- Cross-realm error: `defineProperty` may throw; caught, returns undefined, falls to Layer 2; flag `locals: cross_realm`
- `getLocals()` called but no matching entry (evicted from ring buffer, or library-only frames): returns `null`
- Layer 2 ambiguous match (minified bundle, multiple errors with same structural hash): returns `null`, flag `locals: ambiguous_context_less_match`

---

## Testing Requirements

- Constructor with `captureLocalVariables: false`: no session, `getLocals()` returns `null`, `isAvailable()` returns `false`
- Constructor with mock session: verify `Debugger.enable` and `setPauseOnExceptions: 'all'` called
- `_onPaused` with `reason !== 'exception'`: resume immediately, no collection
- `_onPaused` with all-library frames: resume without collection
- `_onPaused` with app frames: locals collected and cached
- Gate ordering: rate limit prevents collection; cache capacity prevents collection
- Layer 1: `Runtime.callFunctionOn` invoked; subsequent `getLocals(error)` with Symbol tag resolves via O(1) lookup, telemetry shows `layer: 'tag'`
- Layer 1 idempotent on re-throw: second `_onPaused` for same error object returns existing captureId, no second store
- Layer 1 skipped for primitive throw: Layer 2 fingerprint used, flag `primitive_throw`
- Layer 1 skipped for frozen error: Layer 2 used, flag `frozen_exception`
- Layer 2 with requestId: exact match, degraded-hash match, degraded-count match in order
- Layer 2 without requestId: background match, ambiguous match returns `null`
- Layer 3: frame count mismatch produces prefix-only locals and `frame_count_mismatch_prefix_only` flag
- `_extractLocals`: sensitive variable names redacted (`password`, `apiKey`, etc.)
- `_serializeRemoteObject`: all type/subtype combinations produce correct output per the table above
- `getLocals()`: non-consuming — same error resolved twice returns locals both times
- `_onPaused` exception in handler body: resume still called (try/finally)
- `shutdown()`: session disconnected, timers cleared, cache emptied, `available = false`

---

## Completion Criteria

- `InspectorManager` class exported with `getLocals()`, `isAvailable()`, `shutdown()`.
- 4-gate fast path in `_onPaused` works correctly with < 0.01ms cost for common case.
- `Debugger.resume` always called (try/finally).
- All `session.post` calls use synchronous callback form.
- No V8 objectIds stored after resume.
- Layer 1 Symbol-tag install via `Runtime.callFunctionOn` with the fixed function literal.
- Layer 2 identity-tuple fallback covers primitive throw, frozen error, cross-realm, and `callFunctionOn` failure.
- Layer 3 frame-index alignment with graceful prefix-only degradation.
- `getLocals()` is non-consuming (lookup does not delete entry).
- Telemetry fields `localVariablesCaptureLayer`, `localVariablesDegradation`, `localVariablesFrameAlignment` populated correctly.
- Graceful degradation for all unavailability scenarios.
- All unit tests pass.
