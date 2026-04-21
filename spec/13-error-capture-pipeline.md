# Module 13: Error Capture Pipeline

> **Spec status:** LOCKED
> **Source files:** `src/capture/error-capturer.ts`, `src/capture/process-metadata.ts`, `src/capture/package-builder.ts`
> **Dependencies:** Modules 01, 02, 03, 04, 05, 06, 12
> **Build order position:** 13

---

## Module Contract Header

```typescript
/**
 * @module 13-error-capture-pipeline
 * @spec spec/13-error-capture-pipeline.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts, io-event-buffer.ts, scrubber.ts,
 *               encryption.ts, rate-limiter.ts, als-manager.ts, request-tracker.ts, inspector-manager.ts
 */
```

---

## Purpose

Orchestrate the complete error-time capture flow: serialize the error, retrieve local variables, extract the request context and I/O timeline, assemble the `ErrorPackage`, apply PII scrubbing, compute completeness flags, encrypt, and hand off to transport.

---

## Scope

- `ErrorCapturer` class: main capture orchestrator
- `ProcessMetadata` class: collect startup and runtime process information
- `PackageBuilder` class: assemble and serialize the final `ErrorPackage`

---

## Non-Goals

- Does not manage the transport layer (module 14 does delivery).
- Does not subscribe to process events (the SDK composition root does that in module 16).
- Does not manage the inspector session (module 12 does that).

---

## Dependencies

- Module 01: `ErrorPackage`, `Completeness`, `ResolvedConfig`, `IOEventSlot`, `RequestContext`
- Module 02: `cloneAndLimit`, `STANDARD_LIMITS`
- Module 03: `IOEventBuffer`
- Module 04: `Scrubber`
- Module 05: `Encryption`, `RateLimiter`
- Module 06: `ALSManager`, `RequestTracker`
- Module 12: `InspectorManager`

---

## Node.js APIs Used

### process-metadata.ts
- `process.version`, `process.versions.v8`, `process.platform`, `process.arch`, `process.pid`
- `process.memoryUsage()`
- `process.uptime()`
- `process._getActiveHandles().length`, `process._getActiveRequests().length`
- `process.env` (filtered at startup)
- `require('node:fs').readFileSync('.git/HEAD')` — try/catch
- `setTimeout()` with `.unref()` for event loop lag measurement

### error-capturer.ts
- `process.hrtime.bigint()` for capture timestamp

---

## Data Structures

### ErrorCapturer class

```typescript
class ErrorCapturer {
  constructor(deps: {
    buffer: IOEventBuffer;
    als: ALSManager;
    inspector: InspectorManager;
    rateLimiter: RateLimiter;
    requestTracker: RequestTracker;
    processMetadata: ProcessMetadata;
    packageBuilder: PackageBuilder;
    transport: Transport;
    config: ResolvedConfig;
  });
  capture(error: Error, options?: { isUncaught?: boolean }): ErrorPackage | null;
}
```

### ProcessMetadata class

```typescript
class ProcessMetadata {
  constructor(config: ResolvedConfig);
  collectStartupMetadata(): void;
  getStartupMetadata(): StartupMetadata;
  getRuntimeMetadata(): RuntimeMetadata;
  getEventLoopLag(): number;
  startEventLoopLagMeasurement(): void;
  shutdown(): void;
}
```

### PackageBuilder class

```typescript
class PackageBuilder {
  constructor(deps: { scrubber: Scrubber; config: ResolvedConfig });
  build(parts: ErrorPackageParts): ErrorPackage;
}
```

---

## Implementation Notes

### ErrorCapturer.capture() sequence — 500ms budget

```
1. Rate limit check
   rateLimiter.tryAcquire() -> if false: return null

2. Error serialization
   Extract type, message, stack, custom properties via cloneAndLimit(STANDARD_LIMITS)
   Walk error.cause chain (max depth 5)

3. Local variables
   inspector.getLocals(error) -> CapturedFrame[] | null

4. ALS context
   als.getContext() -> RequestContext | undefined

5. I/O timeline
   If context available: buffer.filterByRequestId(context.requestId)
   If no context: buffer.getRecent(20) as ambient events

6. State reads
   If context available: context.stateReads
   If no context or state tracking not enabled: []

7. Concurrent requests
   requestTracker.getSummaries()

8. Process metadata
   processMetadata.getRuntimeMetadata() (fresh: memory, uptime, handles, lag)

9. Build ErrorPackage
   packageBuilder.build({ error, locals, request, ioTimeline, stateReads, concurrent, metadata })

10. PII scrub (handled inside packageBuilder.build)

11. Completeness flags (computed inside packageBuilder.build)

12. Encrypt (if key configured)
    encryption.encrypt(JSON.stringify(package))

13. Hand off to transport
    transport.send(payload)

14. Return the ErrorPackage (or null if rate limited)
```

### Error cause chain

```
function serializeError(error: Error, depth: number = 0): ErrorInfo {
  if (depth > 5) return { type: 'Error', message: '[Cause chain depth limit]', stack: '' }
  return {
    type: error.constructor?.name || 'Error',
    message: error.message || '',
    stack: error.stack || '',
    cause: error.cause instanceof Error ? serializeError(error.cause, depth + 1) : undefined,
    properties: cloneAndLimit(extractCustomProperties(error), STANDARD_LIMITS)
  }
}
```

### ProcessMetadata

**Startup (cached, collected once):**
- Node.js version, V8 version, platform, arch, PID
- Git SHA: `process.env.GIT_SHA || process.env.COMMIT_SHA || process.env.SOURCE_VERSION || readGitHead()`
- Package version: `process.env.npm_package_version`
- Environment: filter `process.env` through env allowlist/blocklist

**Runtime (collected fresh per capture):**
- `process.memoryUsage()` — `{ rss, heapTotal, heapUsed, external, arrayBuffers }`
- `process.uptime()`
- `process._getActiveHandles().length`
- `process._getActiveRequests().length`
- Event loop lag (latest value from measurement chain)

**Event loop lag measurement:**
- `setTimeout` chain (NOT `setInterval`): schedule `setTimeout(fn, 0)`, measure actual delay vs expected. Chain to next measurement.
- Store latest lag value. Timer is `.unref()`'d.
- `shutdown()` clears the timeout.

### PackageBuilder.build

1. Assemble all parts into `ErrorPackage` schema
2. Run PII scrubber on the entire package: `scrubber.scrubObject(package)`
3. Compute completeness flags based on what data is present/absent
4. Final size check: `JSON.stringify(package).length` vs `maxTotalPackageSize`
5. If too large, progressively shed data:
   a. Truncate I/O event bodies (largest first)
   b. Drop ambient I/O events (keep only failing request's timeline)
   c. Drop state reads
   d. Update completeness flags
6. Return the final package

---

## Security Considerations

- The entire ErrorPackage is run through the PII scrubber before output. This is defense-in-depth — individual components also filter data at recording time.
- Error custom properties may contain secrets (e.g., `error.config.apiKey`). The scrubber catches these.
- The `error.cause` chain is walked to max depth 5 to prevent infinite loops.
- Encryption key is NEVER included in the ErrorPackage.

---

## Edge Cases

- Rate limit exceeded: return `null`, increment dropped count
- Inspector unavailable: `localVariablesCaptured = false` in completeness
- ALS context unavailable: `alsContextAvailable = false`, ambient I/O events used instead
- State tracking not enabled: `stateTrackingEnabled = false`, empty stateReads
- Error with no stack trace: `stack: ''`
- Error with non-Error cause: cause not serialized
- Serialization of error properties fails (getter throws): `cloneAndLimit` handles gracefully
- Package exceeds 5MB after assembly: progressive shedding reduces size
- `process._getActiveHandles` not available: return -1
- `.git/HEAD` not found: git SHA is `undefined`

---

## Testing Requirements

### ErrorCapturer
- Capture with full context (ALS, inspector, I/O events): complete package
- Capture without ALS context: ambient events used, `alsContextAvailable: false`
- Rate limit exceeded: returns `null`
- Error with cause chain: serialized correctly, depth limited at 5

### ProcessMetadata
- Startup metadata cached correctly
- Git SHA from env var
- Git SHA from `.git/HEAD` file
- Runtime metadata collected fresh
- Event loop lag measurement produces reasonable values
- `shutdown()` stops measurement

### PackageBuilder
- Completeness flags accurate for various scenarios
- PII scrubber applied to entire package
- Progressive shedding when package exceeds size limit
- Schema version is `'1.0.0'`
- `capturedAt` is valid ISO 8601

---

## Completion Criteria

- `ErrorCapturer`, `ProcessMetadata`, `PackageBuilder` classes exported.
- Full capture sequence executes within 500ms budget.
- Completeness flags accurately reflect what was and wasn't captured.
- PII scrubbing applied to entire package.
- Progressive shedding keeps package under size limit.
- All unit tests pass.

---

## 0.2.0 Additions

### Source-map resolve-path sync-on-miss contract (G3)

**Root cause.** `SourceMapResolver.warmCache()` walks `require.cache` at init. In Next.js, app routes don't enter `require.cache` until their first request (lazy-load), so warm-at-init misses them entirely. On first-error, `resolveStack` hits a cache miss and schedules async warm via `setImmediate` — the stack returned by the *current* resolve call is still unresolved. Second error in same file: cache populated, resolved. This produced the observed behavior: first trace in `.next/server/…/route.js:1:2486`, later trace in `webpack://blubeez/app/…/route.ts:79:21`.

**Fix — sync-on-miss with size gate.** In `resolveStack`, on cache miss, check the candidate map's file size first (a `stat` call):

- If size ≤ `sourceMapSyncThresholdBytes` (default 2 MB) → synchronous `getConsumer(filePath)`. One-time disk read + `JSON.parse` + `new SourceMapConsumer` per new file.
- If size > threshold (or size unknown) → do NOT block. Call `scheduleWarm(filePath)` as before, flag the frame with `locals: source_map_async_pending`, leave the frame in bundled form for this capture. Subsequent captures pick up the resolved consumer.

`resolveStackCacheOnly` stays cache-only and is used on the three paths that genuinely cannot afford blocking:
- `uncaughtException` (Node is about to terminate)
- `SIGTERM` shutdown capture
- `unhandledRejection`-at-exit

The `MAX_CACHE_SIZE` constant is raised from 50 to 128. Rationale: a medium Next.js app has 100–300 compiled server chunks; 50 churns aggressively and undoes resolution gains. 256 is too generous because `SourceMapConsumer` holds 5–20 MB of parsed mappings per entry in the pathological case. 128 is the count-based proxy pending a byte-size budget (tracked in `followups.md`).

### Three-state cache (G3)

Replace `Map<string, CachedConsumer | null>` with an explicit three-state type:

```ts
type CacheEntry =
  | { type: 'consumer'; consumer: SourceMapConsumer; usedAt: number }
  | { type: 'missing'; cachedAt: number }
  | { type: 'corrupt'; reason: string; cachedAt: number };
```

Semantics:
- `consumer` — happy path
- `missing` — no map file exists (adjacent `.map`, `sourceMappingURL`, nothing found). Prevents re-reading filesystem on every subsequent error for the same miss.
- `corrupt` — map existed but `JSON.parse` or `new SourceMapConsumer` threw. Reason preserved for telemetry. Prevents per-error parse storm on the same broken map.

**TTL for negative entries.** `missing` and `corrupt` entries expire after **1 hour** to survive re-deploys where the user pushed a fixed build without restarting the observer process. `consumer` entries do not expire by TTL; they are evicted by LRU when the cache reaches `MAX_CACHE_SIZE = 128`.

### Source-map telemetry (G3)

New field on `Completeness`:

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

### Sync-on-miss safety invariant

`getConsumer(filePath)` on the sync path MUST NOT yield the event loop between read, parse, and cache-set. No `await`, no `.then()`, no Promise creation. Under single-threaded JS execution, a second caller with the same `filePath` during the sync call is impossible — there is no concurrency to dedup against. If a future refactor introduces any microtask boundary, replace with an in-flight `Map<string, Promise<CacheEntry>>` dedup table.

### New config field

`sourceMapSyncThresholdBytes: number` (default `2_097_152`, i.e., 2 MB). Setting to `0` forces fully async behavior (matches pre-0.2.0 semantics, for users who prefer the cascade-safe option unconditionally). Available as `config.sourceMapSyncThresholdBytes`; plumbed through `sdk.ts` to the resolver constructor.
