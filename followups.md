# Follow-ups

Out-of-scope items from the coordinated P0+P1 fix pass. Address in a later
release. Anything new discovered mid-pass gets appended here.

## Deferred from P0+P1 pass (mid-pass decisions)

- Recording-layer listener finalizer refactor. The plan described a
  central `finalize(slot)` routine that would walk a slot's list of
  attached listeners and detach them. On review, the listeners' lifetimes
  are bounded by the request's natural end (`close`, `finish`, `end`
  events) so the actual leak surface is much narrower than initially
  flagged. Keep the AUTH/HELLO credential redaction (landed) and revisit
  the full listener audit in a dedicated pass.
- Async `resolveStack` in `source-map-resolver.ts`. The readFileSync
  blocking concern is already mitigated by `scheduleWarm()` which defers
  actual disk I/O to `setImmediate`, plus the new 4 MB read cap. A full
  pipeline async refactor is deferred; the blocking surface is already
  small and bounded.
- Dead-letter cross-process lock. Current implementation serializes
  in-process `clearSent` but does not protect against the CLI `drain`
  command running concurrently against a live SDK process. Document the
  limitation in `OPERATIONS.md` on next update and consider a proper
  lockfile (wx-create, fcntl on posix) in a follow-up.

## Deferred from P0+P1 pass (P2 and P3)

- Body-capture memoization of content-type allowlist and toLowerCase work on
  the per-chunk hot path. `src/recording/body-capture.ts` around 112-114 and
  521-540.
- Source-map resolver `warmPromises` flushWarmQueue back-pressure. The pass
  bounded the array at 256 but did not add true back-pressure to callers.
- Rate-limiter `timestamps.filter` micro-optimization to a ring buffer.
- Email and phone regex boundary anchors in `src/pii/patterns.ts`.
- Scrubber `lastIndex` reset fragility under async interleave
  in `src/pii/scrubber.ts` around 28-35.
- `clone-and-limit.ts` budget undercount: key length subtracted from budget
  but value serialization cost is not. Limits are approximate.
- `rate-limiter.ts` `droppedCount` practical overflow. Requires 9e15
  increments, not reachable in a real deployment.
- `inspector-manager.ts` `rateLimitTimer` exact 1000ms boundary cosmetic.
- `file-transport.ts` same-millisecond rotation collision if more than one
  rotation fires in the same tick. Mitigated by the monotonic counter added
  in the pass, but base filename is still millisecond granular.
- Dead-letter drain `errorcore drain` CLI: print a single-line copy-paste
  command and absolute path when suggesting the operator run it.
- Emit `onInternalWarning` with full cause strings for every `emitSafeWarning`
  call; current detail is the constructor name only.

## Deferred from 0.2.0 gap-fixes pass (Phase 8)

Items explicitly deferred during the 0.2.0 design and implementation pass. Each has a tracking note explaining why it was cut and what the acceptance criterion for the follow-up would be.

- **Byte-size cache budget for source-map cache.** `MAX_CACHE_SIZE = 128` is a count-based proxy. The correct long-term eviction criterion is total bytes of `SourceMapConsumer` memory across all cached entries (e.g., 512 MB cap). A count-based proxy is sufficient for 0.2.0 because a typical medium Next.js app has 100–300 chunks and `SourceMapConsumer` averages 5–10 MB per entry. Track the eviction count field in `completeness.sourceMapResolution.evictions` to gather production signal on whether 128 is enough before implementing a byte-size secondary criterion.

- **Per-`activate()` lifetime sync-parse budget.** The 2 MB size gate bounds per-capture sync parse at ~100 ms on modern hardware. An unusual workload with many small-but-fragmented maps (e.g., 50 × 1.9 MB maps cold-starting in parallel) could stack up to ~5 s of cumulative sync parse spread across 50 requests on a bad start. A lifetime budget (e.g., 2 s cumulative per `activate()` call) with fallback-to-async after exhaustion would complement the size gate in this edge case. Defer to 0.3.0; add an integration test reproducing the cascade scenario to justify the complexity before implementing.

- **`parseTimeoutMs` — source-map parse abort.** A clock-check inside the consumer builder loop that aborts parsing after a configurable timeout. Only needed if production observability shows a `source_map_async_pending` rate that merits the complexity. The current 4 MB file cap already bounds worst-case parse at ~500 ms on modern hardware. Defer to 0.3.0 after gathering telemetry on `framesUnresolved` counts.

- **`errorcore/advanced` subpath.** Users who need bespoke middleware behavior beyond `withNextMiddleware` + `captureMiddlewareStatusCodes` would benefit from a public `getSDK()` export and a stable `AdvancedSDKHandle` interface. Deliberately not shipped in 0.2.0 to avoid a speculative public API surface. Candidate name: `errorcore/advanced`. Open a tracking issue when concrete demand surfaces (at least two distinct user-reported use cases before committing to the API shape).

- **1.0.0 release.** Reserved for concurrent release with the ingestion-backend's commercial availability. Pre-1.0 semver allows breaking changes at minor bumps. Do not bump to 1.0.0 until the ingestion API contract is stable for paying users. The `CHANGELOG` "Breaking (pre-1.0 semver window)" heading signals this explicitly to consumers.

## Business and operational

- Package name `errorcore` squat check and trademark clearance before first
  public publish.
- PolyForm Small Business license compatibility with consumer license
  scanners (FOSSA, Snyk). Expect flags.
- Stray `tmp-*` directories in repo root are excluded from the npm tarball
  but should be removed from the git working tree.

## Reclassified or mitigated on verification

- `src/context/request-tracker.ts` sweepExpired NaN math is not reachable:
  `context.startTime` is set unconditionally. No fix needed.
- `src/middleware/koa.ts` already awaits `runWithContext`. No fix needed.
