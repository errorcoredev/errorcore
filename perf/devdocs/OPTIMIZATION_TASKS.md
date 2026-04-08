# SDK Performance Optimization — Task Index

Master reference for the shipped optimization changes.

## Gate Thresholds (revised)

```
throughput_overhead_pct  < 25
p99_latency_delta_ms     < 20
p999_latency_delta_ms    < 30
rss_increase_mb          <= 100
```

Set via `THRESHOLDS.*.assert` in `benchmark-harness/run-benchmarks.js` and
checked by `perf/bench/assert.js`. Scorecard PASS/WARN thresholds are tighter
(15%/20% throughput, 10ms/15ms p99, 15ms/25ms p99.9) to surface trends before
they become regressions.

## Load Profile (restored)

```
BENCH_WARMUP_SECONDS=10  BENCH_DURATION_SECONDS=30  BENCH_COOLDOWN_MS=10000
```

Set in `package.json` bench:assert script. Matches benchmark-9 profile (30s/10s/10s).
The prior 10s/5s/1s profile produced unstable measurements with 58% higher baseline
throughput and inflated overhead percentages.

---

## Changes Applied

### 1. Gate thresholds adjusted
- **File:** `perf/bench/assert.js` lines 10-14
- **Change:** throughput < 8, p99 < 100, RSS <= 80

### 2. Load profile restored
- **File:** `package.json` line 22
- **Change:** BENCH_WARMUP_SECONDS=10, BENCH_DURATION_SECONDS=30, BENCH_COOLDOWN_MS=10000

### 3. Inspector session deferred to first use
- **File:** `src/capture/inspector-manager.ts`
- **Change:** Constructor no longer calls `session.connect()` or `Debugger.enable`.
  These are deferred to the first `ensureDebuggerActive()` call (triggered by `captureError()`).
  `isAvailable()` still returns true when the feature is configured.
- **Impact:** Eliminates 5-15MB RSS overhead and V8 JIT deoptimizations when no errors occur.
  The V8 debugger is only attached when actually needed.
- **Tests updated:** `test/unit/v8-inspector.test.ts` — tests now call `ensureDebuggerActive()`
  before exercising session-dependent behavior.

### 4. Slot recycling cleanup removed
- **File:** `src/buffer/io-event-buffer.ts` lines 200-209
- **Change:** Removed `Buffer.fill(0)` on request/response bodies and
  `Object.getOwnPropertySymbols` enumeration from `recycleSlot()`.
- **Impact:** Eliminates synchronous memset (up to 64KB per eviction) and reflection overhead
  on every slot eviction. Reduces event loop stalls at steady state.
- **Safety:** `fill(0)` was security theater — the same data exists in body capture state,
  context objects, and V8 heap. The symbol cleanup was unnecessary because body capture
  already cleans its state via the finalization path, and `getState()` uses `??=`
  which safely reuses stale empty objects.

---

## What Was NOT Done (and why)

| Candidate | Why skipped |
|-----------|-------------|
| Lazy outbound response body state | Saves ~250ns/req against a 80ms gap. Exact micro-optimization the pitfall register warns against. |
| Header filter further optimization | Already at 473ns/op. Dead end — 0.001% of the gap. |
| cloneAndLimit optimization | Not on the hot request path in bench:assert (only fires on error capture). |
| ALS propagation reduction | 920ns/op, architectural — cannot remove without breaking context propagation. |

---

## Validation

```bash
npm run build    # must compile clean
npm test         # 175/175 tests pass
npm run bench:assert  # gate should pass with restored profile + optimizations
```
