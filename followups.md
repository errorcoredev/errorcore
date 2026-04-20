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

## Scheduled for 0.2

- Encryption key rotation. Accept a `previousEncryptionKey` (or list) so
  existing dead-letter entries encrypted/HMAC'd with the prior key can still
  be verified and drained after a rotation. Documented in README Security as
  a 0.1.x limitation.

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
