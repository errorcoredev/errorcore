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
- Does not evaluate expressions or execute code via the inspector.
- Does not use `Runtime.evaluate` or `Runtime.callFunctionOn`.
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

### Internal cache

```
Map<string, { frames: CapturedFrame[], timestamp: number }>
```

Key: `error.constructor.name + ': ' + error.message`

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
for each app frame (max maxFrames, default 5):
  localScope = frame.scopeChain.find(s => s.type === 'local')
  if no localScope or no objectId -> skip

  session.post('Runtime.getProperties', { objectId, ownProperties: true }, (err, result) => {
    // callback fires SYNCHRONOUSLY
    if err or !result -> skip
    collected.push({
      functionName, filePath, lineNumber (+1, V8 is 0-based), columnNumber (+1),
      locals: _extractLocals(result.result)
    })
  })

Cache collected frames keyed by _buildCacheKey(params.data)
Increment collectionCountThisSecond
```

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

### Cache key strategy

- `_buildCacheKey(data: RemoteObject)`:
  - Error objects: `data.className + ': ' + firstLine(data.description)`
  - Non-Error throws: `String(data.value)` or `data.description`
  - Collisions: most recent entry wins (Map.set overwrites)

### getLocals matching

```
getLocals(error: Error):
  key = error.constructor.name + ': ' + error.message
  entry = cache.get(key)
  if !entry -> return null
  cache.delete(key)    // consume on retrieval (one-shot)
  return entry.frames
```

### Cache maintenance

- Max entries: 50 (configurable via `maxCachedLocals`)
- TTL: 30 seconds
- Sweep: every 10 seconds via `setInterval(.unref())`
- Rate limit: 20 collections/second via `setInterval(.unref())`

---

## Security Considerations

- The inspector session is powerful. It MUST NOT evaluate arbitrary code, expose the session externally, or use `Runtime.evaluate`.
- Sensitive variable names are redacted: `password`, `secret`, `token`, `apiKey`, `privateKey`, `credential`, `auth`, `sessionId`.
- No V8 `objectId` references are stored after resume — they become invalid.
- The session is strictly used for `Debugger.enable/disable`, `Debugger.setPauseOnExceptions`, `Debugger.resume`, and `Runtime.getProperties`.

---

## Edge Cases

- `node:inspector` not available: `available = false`, `getLocals()` returns `null`
- Another debugger attached (`inspector.url()` returns truthy): `available = false`, warn
- `session.connect()` throws: `available = false`
- Exception in `_onPaused` handler body: `finally` block ensures `Debugger.resume` is called
- `Runtime.getProperties` returns error for a frame: that frame skipped, others still collected
- All frames are library code (node_modules): Gate 4 rejects, resume immediately
- Cache full: Gate 3 rejects, resume immediately
- Rate limit exceeded: Gate 2 rejects, resume immediately
- Error thrown and caught repeatedly: same cache key, most recent locals win
- Non-Error throws (e.g., `throw "string"`): key from `data.value`/`data.description`
- `getLocals()` called but no matching cache entry (TTL expired, or thrown from library code): returns `null`

---

## Testing Requirements

- Constructor with `captureLocalVariables: false`: no session, `getLocals()` returns `null`, `isAvailable()` returns `false`
- Constructor with mock session: verify `Debugger.enable` and `setPauseOnExceptions` called
- `_onPaused` with `reason !== 'exception'`: resume immediately, no collection
- `_onPaused` with all-library frames: resume without collection
- `_onPaused` with app frames: locals collected and cached
- Gate ordering: rate limit prevents collection; cache capacity prevents collection
- `_extractLocals`: sensitive variable names redacted (`password`, `apiKey`, etc.)
- `_serializeRemoteObject`: all type/subtype combinations produce correct output per the table above
- `getLocals()`: returns cached frames and removes entry (one-shot)
- `getLocals()` after TTL expiry: returns `null`
- `_onPaused` exception in handler body: resume still called (try/finally)
- `shutdown()`: session disconnected, timers cleared, cache emptied, `available = false`

---

## Completion Criteria

- `InspectorManager` class exported with `getLocals()`, `isAvailable()`, `shutdown()`.
- 4-gate fast path in `_onPaused` works correctly with < 0.01ms cost for common case.
- `Debugger.resume` always called (try/finally).
- All `session.post` calls use synchronous callback form.
- No V8 objectIds stored after resume.
- Graceful degradation for all unavailability scenarios.
- All unit tests pass.
