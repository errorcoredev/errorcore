# Backpressure contract

The SDK emits structured warnings via the `onInternalWarning` config callback whenever it drops a capture, skips a dead-letter write, or hits a limit that affects delivery. This document is the authoritative list of conditions, behaviors, and warning codes.

## Callback signature

```ts
onInternalWarning?: (warning: {
  code: InternalWarningCode | AggregateWarningCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}) => void;
```

The callback MUST NOT throw into the SDK; any thrown error is swallowed. The same callback receives both per-event codes (the matrix below) and aggregate summaries (`errorcore_payloads_dropped`, `errorcore_payloads_dead_lettered`) emitted periodically at shutdown/flush.

## Matrix

| Condition | SDK behavior | Warning code | Data loss? |
|---|---|---|---|
| Transport slow but up (succeeds after retry) | HTTP transport retries up to 3× internally (200ms/600ms/1800ms backoff); payload delivered on any successful attempt | — (no warning on success) | No |
| Transport timeout (all retries) | Each attempt times out at `timeoutMs` (default 5000ms); after 3 exhausted attempts the transport rejects; payload dead-lettered if DLQ configured, else dropped | `transport_timeout` (fires once at final failure) | No if DLQ accepts; else Yes |
| Transport down (non-retryable) | `transport.send()` rejects; payload dead-lettered if DLQ configured, else dropped | `transport_failed` (fires once at final failure) | No if DLQ accepts; else Yes |
| Dead-letter write fails — out of disk (ENOSPC/EDQUOT) | `appendFileSync` throws; payload dropped | `disk_full` | Yes |
| Dead-letter write fails — other errno (EACCES, EISDIR, …) | `appendFileSync` throws; payload dropped | `dead_letter_write_failed` | Yes |
| Dead-letter at size cap (50 MB default) | Append returns `false`; payload dropped | `dead_letter_full` | Yes |
| Dead-letter payload oversized (> `maxPayloadBytes`, default 6 MB) | Append returns `false`; payload dropped | `dead_letter_full` | Yes |
| Rate limit hit (default 60 captures/min) | Capture dropped at entry; drop summary (count + timestamps) rolls into next successful capture's `completeness.rateLimiterDrops` | `rate_limited` | Yes |
| Encryption key invalid (length or entropy) | `createSDK()` throws synchronously; SDK does not boot | `encryption_key_invalid` (thrown Error only — the callback does not fire because the SDK is never constructed) | Yes (SDK unavailable) |

## Notes

- **Retries are internal.** The transport's own retry budget is exhausted before any warning fires. The callback fires **once** at final failure, not per attempt.
- **Aggregate codes.** `errorcore_payloads_dropped` and `errorcore_payloads_dead_lettered` summarise counts over the flush interval. They carry `context: { count: number }` and are orthogonal to the per-event codes above.
- **`context.stage` on `capture_failed`.** `'primary'` means the top-level capture try/catch fired (serialization, scrubber, ALS, locals); `'fallback'` means the worker-thread path failed and the inline fallback *also* failed. Both signal a dropped capture.
- **`context.errno` on DLQ write failures.** Carries the Node `ErrnoException.code` string (e.g. `'ENOSPC'`, `'EACCES'`). The SDK classifies `ENOSPC`/`EDQUOT` as `disk_full` and everything else as `dead_letter_write_failed`.
- **`encryption_key_invalid`.** The code exists so operator tooling can refer to it symbolically, but it does not flow through the callback: the SDK throws synchronously at `createSDK()`. Catch that exception at init instead.
- **No cascading warnings from the dispatcher.** When a DLQ write returns `false` because the store is full or the payload is oversized, the store itself has already emitted `dead_letter_full`; the ErrorCapturer dispatcher does not re-emit.

## Out of scope (documented but not wired)

The following sites emit `console.warn` diagnostics but do not participate in the backpressure contract because they do not produce a payload drop distinct from the ones already covered:

- `src/pii/scrubber.ts` — custom PII scrubber throws → falls back to default redaction. No data dropped.
- `src/sdk.ts` (drain path) — dead-letter drain failure at startup → payloads remain in DLQ for next attempt. No new data loss.
- `src/capture/inspector-manager.ts` — V8 Inspector already attached → local-variable capture disabled for the lifetime of the SDK. Feature degradation, not a drop.
- `src/sdk.ts` (DLQ disabled) — no `encryptionKey` or HTTP authorization secret → DLQ refuses to instantiate. Config-time degradation surfaced as a one-time `console.warn`.

## Verifying the contract

The `test/integration/backpressure.test.ts` suite forces each matrix row and asserts (a) the expected code fires, (b) `sdk.captureError` does not throw into user code, and (c) the SDK remains usable after the condition is removed.
