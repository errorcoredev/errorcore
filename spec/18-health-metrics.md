# Module 18: Health Metrics

> **Spec status:** LOCKED
> **Source files:** `src/health/health-metrics.ts`, `src/health/types.ts`
> **Dependencies:** Module 13 (error capture pipeline), Module 14 (transport), Module 16 (SDK composition)
> **Build order position:** 18 (after SDK composition and Next.js integration)

---

## Module Contract Header

```typescript
/**
 * @module 18-health-metrics
 * @spec spec/18-health-metrics.md
 * @dependencies None at runtime. Read by src/sdk.ts via dependency injection.
 */
```

---

## Purpose

Expose a single point-in-time snapshot of the SDK's self-observability state so operators can answer "is this thing dropping my errors?" without attaching a debugger. Intended to be mounted on a `/healthz` handler and scraped by a metrics system.

---

## Scope

- `HealthMetrics` class that owns cumulative counters, a fixed-size latency ring buffer, and the most recent transport-failure sample.
- `HealthSnapshot` interface returned by `SDKInstance.getHealth()` and the module-level `getHealth()` facade.
- `DeadLetterStore.getPendingCount()` gauge (added to Module 14 to back the `deadLetterDepth` field).
- `ErrorCapturer.getPendingTransportCount()` gauge (added to Module 13 to back the `transportQueueDepth` field).

---

## Non-Goals

- No HTTP endpoint, route, or middleware. The SDK returns a POJO; users mount it on their own router.
- No OpenTelemetry metrics export. The snapshot is the public contract; adapters can be added elsewhere without API change.
- No config flag to enable/disable collection. Overhead is a handful of integer increments per capture and one array write per send.
- No histogram library dependency. Percentiles are computed by sorting the 512-sample ring in place on read.
- No change to the reset-on-read `errorCapturer.getDiagnostics()` path; that serves a different purpose (internal-warning callback trigger).

---

## Dependencies

- Module 01: none directly (consumed types live inside this module).
- Module 13: `ErrorCapturer` injects a `HealthMetrics` instance and calls record methods from its capture/dispatch paths.
- Module 14: `DeadLetterStore.getPendingCount()` reads an in-memory counter maintained alongside `appendPayloadSync` / `clearSent`.
- Module 16: `createSDK()` owns lifecycle; `SDKInstance.getHealth()` aggregates the snapshot.

---

## Node.js APIs Used

- `Date.now()` for wall-clock timestamps on latency samples and failure timestamps.
- Array `push` / indexed assignment for the ring buffer; `Array.prototype.sort` on read for percentile computation.

No I/O, no timers, no listeners.

---

## Data Structures

### `HealthSnapshot` (public)

```typescript
export interface HealthSnapshot {
  // Monotonic counters since init().
  captured: number;
  dropped: number;
  droppedBreakdown: {
    rateLimited: number;
    captureFailed: number;
    deadLetterWriteFailed: number;
  };
  transportFailures: number;

  // Current gauges.
  transportQueueDepth: number;
  deadLetterDepth: number;
  ioBufferDepth: number;

  // Rolling-window / last-value samples.
  flushLatencyP50: number;       // ms; 0 when no samples
  flushLatencyP99: number;       // ms; 0 when no samples
  lastFailureReason: string | null;
  lastFailureAt: number | null;  // unix ms
}
```

### `HealthMetrics` (internal)

Plain class with five integer counters, a 512-slot number array for the latency ring, a ring write index, and two optional last-failure fields.

---

## Semantics

- **Monotonicity**: counters never reset for the lifetime of the SDK instance. Operators compute rates by differencing two scraped snapshots.
- **`dropped` invariant**: `dropped === droppedBreakdown.rateLimited + droppedBreakdown.captureFailed + droppedBreakdown.deadLetterWriteFailed`. Enforced by the aggregation in `SDKInstance.getHealth()`, not by maintaining a separate `dropped` counter.
- **"Dead-lettered" is not "dropped"**: a transport failure that was successfully written to the dead-letter store is pending retry, not lost. It increments `transportFailures` and `deadLetterDepth`, not `dropped`.
- **`captured`**: every payload that entered the transport pipeline (post-rate-limit, post-serialization). An error that later fails transport is still "captured" — the capture succeeded; only the send failed.
- **`transportFailures`**: counts `transport.send()` rejections (after any HTTP retry). A rejection increments this counter regardless of whether the payload was dead-lettered or dropped, so this is independent of `dropped`.
- **`transportQueueDepth`**: `ErrorCapturer.pendingTransportDispatches.size`. Covers both worker and fallback send paths because every dispatch flows through `dispatchTransport`.
- **`deadLetterDepth`**: `DeadLetterStore.getPendingCount()`, counting only `kind: 'payload'` envelopes. Failure markers are diagnostics, not retryable payloads.
- **`ioBufferDepth`**: `IOEventBuffer.getStats().slotCount`. Distinct from `transportQueueDepth` — this is the I/O context ring buffer, not pending sends.
- **`flushLatencyP50/P99`**: nearest-rank percentile over the last 512 completed `transport.send()` round-trips, including any HTTP retries. Returns 0 when no samples have been recorded.
- **`lastFailureReason`**: most recent rejection's `error.message` truncated to 200 chars. `null` until the first failure. `lastFailureAt` is the matching `Date.now()`.

---

## Percentile Math

Nearest-rank on the populated portion of the ring: copy samples, sort ascending, return `sorted[floor(p * (n - 1))]`. The record path allocates nothing after the ring fills; the query path allocates one array per call, which is fine for `/healthz` scrape frequency.

---

## Instrumentation Points

| Event | Source file | Hook |
|-------|-------------|------|
| Rate-limited drop | `src/capture/error-capturer.ts` | Before `return null` in the `tryAcquire()` false branch |
| Capture/serialization failure | `src/capture/error-capturer.ts` | Top of the outer `catch` in `capture()` |
| Transport send entered + succeeded | `src/capture/error-capturer.ts` | `dispatchTransport` — record `captured` on entry, `recordFlushLatency` on `.then()` |
| Transport send failed | `src/capture/error-capturer.ts` | `.catch()` — record latency, transport failure with reason/time, and (for DLQ-off and DLQ-write-failed branches) a `droppedDlqWriteFailed` |
| Dead-letter write succeeded | — | No health counter; the DLQ gauge captures it next read |
| Dead-letter write failed / no DLQ configured | `src/capture/error-capturer.ts` | `recordDroppedDlqWriteFailed()` |

---

## Testing Expectations

Unit tests (`test/unit/health-metrics.test.ts`):
- Fresh instance reports zeros and nulls.
- Each `recordX()` increments its counter monotonically.
- `recordFlushLatency` ring wraps correctly at the 513th sample (oldest evicted).
- `getLatencyPercentile(0.5)` and `(0.99)` on `[1..100]` return 50 and 99 respectively (nearest-rank).
- `recordTransportFailure` truncates the reason at 200 characters and stores the timestamp.
- Repeated reads of `getCaptured`/`getDroppedBreakdown`/`getTransportFailures` are idempotent (pins the monotonic contract).

Integration tests (`test/unit/sdk-composition.test.ts`):
- Fresh SDK returns zeros and nulls.
- `captured` tracks successful captures; `flushLatencyP50 >= 0` after a successful flush.
- Rate-limit overflow drives `droppedBreakdown.rateLimited` without advancing `captured`.
- A failing transport with no DLQ yields `transportFailures === N`, `dropped === N`, `droppedBreakdown.deadLetterWriteFailed === N`.
- A failing transport with a DLQ yields `transportFailures === N`, `deadLetterDepth === N`, `dropped === 0`.
- Invariant: `dropped === rateLimited + captureFailed + deadLetterWriteFailed` after every scenario.
- Monotonicity: two consecutive reads with no captures between return identical counter values.
- Module-level `getHealth()` returns `null` before `init()` and a snapshot after.

---

## Implementation Guardrails

- `HealthMetrics` must not hold references to any host objects or payloads. It is a pure counter aggregator.
- No timers, no listeners, no filesystem access. Introducing any of these moves the module out of scope and requires a spec revision.
- `getHealth()` on `SDKInstance` is safe to call from any SDK state, including pre-`activate` and post-`shutdown`. It must never throw.
- The `lastFailureReason` truncation limit (200 chars) matches the existing `capture_failed` warning detail truncation to keep log-vs-snapshot strings consistent.
