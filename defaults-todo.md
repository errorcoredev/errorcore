# Defaults to revisit when production telemetry exists

The errorcore SDK ships with three default values that the project-wide gap analysis (2026-05) flagged as potentially undersized for real workloads:

- `rateLimitPerMinute = 60` (≈ 1/s) — likely low for enterprise apps with bursty failure modes.
- Serverless `bufferSize = 50` — may evict before capture at sustained 200+ concurrent invocations.
- `maxPayloadSize = 32 KB` — likely truncates verbose errors that include locals + bodies.

A synthetic-load investigation was scoped (see `C:\Users\harin\.claude\plans\errorcore-remaining\10-defaults-reevaluation.md`) and **deferred**. Reason: errorcore has no production traffic yet. Synthetic load gives synthetic answers and tempts us to lock in numbers that will not survive contact with real workloads. Same principle as "don't make decisions at capture time you can't reverse" — don't tune defaults at synthetic time when you can re-tune at telemetry time.

## Revisit when

Any of:
- A real customer is sending production traffic (paid, free, or design partner).
- An open-source user opens an issue tied to one of these defaults.
- The ingestion backend hits commercial availability (per the 1.0.0 milestone in `followups.md`).

## Inputs to gather first

When you have real captures, before changing any default, collect a week (minimum) of:

1. **For `rateLimitPerMinute`** — burst-rate distribution per service. p50, p95, p99, and max errors-per-minute observed. The interesting question is not the average; it is the burst ceiling that production hits during incidents. If p99 burst > current default, the default is wrong.

2. **For `bufferSize` (serverless)** — distribution of concurrent in-flight requests at error capture time, per function. p50, p95, p99 concurrency. Drop count from buffer eviction (`completeness.ioEventsDropped`) per request. If the eviction rate is non-zero in routine operation, the default is wrong.

3. **For `maxPayloadSize`** — distribution of actual serialized payload sizes pre-truncation. p50, p95, p99 per service type (HTTP API, worker, scheduled job, server action). Truncation count from `completeness.ioPayloadsTruncated` and from oversized-package rejections. If p95 actual size exceeds 50% of the cap in any service type, the default is wrong.

4. **For dead-letter drain throughput** — payloads/sec sustained during a real outage drain. If drain throughput cannot keep up with backlog growth at saturation, the DLQ size cap and the per-batch dispatcher concurrency become the tuning targets, not these three defaults.

## Decision criteria when the data is in

For each default, decide:

- **Raise** if telemetry shows truncation / drops at the current cap during routine operation.
- **Lower** if telemetry shows the cap is never approached and the cost (memory, capture time) of headroom is measurable.
- **Make adaptive** if production splits cleanly into "high-throughput service" and "low-throughput service" with very different needs — do this only if a single default cannot serve both within an order of magnitude.
- **Keep** if telemetry is within an order of magnitude of the current default and no operator complaint exists.

## Out of scope

This file documents what to measure, not what the answer should be. Setting target numbers now (e.g. "raise to 200/min") would be the same mistake as the synthetic investigation: pre-committing to numbers we cannot back up. Hold the line.
