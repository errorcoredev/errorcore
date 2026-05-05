# Backpressure Contract

The SDK emits structured warnings via the `onInternalWarning` config callback whenever it drops a capture, skips a dead-letter write, or hits a limit that affects delivery. This document is the authoritative list of conditions, behaviors, and warning codes for the SDK-side contract.

## Callback Signature

```ts
onInternalWarning?: (warning: {
  code: InternalWarningCode | AggregateWarningCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}) => void;
```

The callback MUST NOT throw into the SDK; any thrown error is swallowed. The same callback receives both per-event codes and aggregate summaries (`EC_PAYLOADS_DROPPED`, `EC_PAYLOADS_DEAD_LETTERED`) emitted periodically at shutdown or flush.

The SDK scrubs warning `context` and `cause` before invoking user code. When the underlying trigger was an `Error`, `cause` is emitted as `{ name, message, stackHead?, code? }`; full stacks, Authorization headers, cookies, collector credentials, credentialed URLs, and large raw payloads are not forwarded.

## Matrix

| Condition | SDK behavior | Warning code | Data loss? |
|---|---|---|---|
| Transport slow but eventually succeeds | HTTP transport retries internally; payload delivered on any successful attempt | no warning | No |
| Transport timeout after retries | Each attempt times out at `timeoutMs`; after 5 total attempts or the 30s retry budget the transport rejects; payload dead-lettered if DLQ configured, else dropped | `EC_TRANSPORT_TIMEOUT` | No if DLQ accepts; else Yes |
| Transport down or rejects | `transport.send()` rejects; payload dead-lettered if DLQ configured, else dropped | `EC_TRANSPORT_FAILED` | No if DLQ accepts; else Yes |
| Dead-letter write fails from disk capacity (`ENOSPC`, `EDQUOT`) | Append throws; payload dropped | `EC_DISK_FULL` | Yes |
| Dead-letter write fails from other errno (`EACCES`, `EISDIR`, etc.) | Append throws; payload dropped | `EC_DLQ_WRITE_FAILED` | Yes |
| Dead-letter at size cap | Append returns `false`; payload dropped | `EC_DLQ_FULL` | Yes |
| Dead-letter payload oversized | Append returns `false`; payload dropped | `EC_DLQ_FULL` | Yes |
| Dead-letter path configured without a stable signing secret | SDK disables DLQ persistence because unsigned disk content cannot be replayed safely | `EC_DLQ_DISABLED` | Yes if transport also fails |
| Final serialized envelope exceeds `hardCapBytes` | Payload is dropped before transport | `EC_PACKAGE_OVER_HARD_CAP` | Yes |
| Rate limit hit | Capture dropped at entry; drop summary rolls into next successful package completeness | `EC_RATE_LIMITED` | Yes |
| Capture assembly fails | Primary or fallback package assembly fails | `EC_CAPTURE_FAILED` | Yes if fallback also fails |
| Encryption key invalid | `createSDK()` throws synchronously; SDK does not boot | `EC_ENCRYPTION_KEY_INVALID` as thrown error text, not callback | Yes, SDK unavailable |

## Notes

- Retries are internal. The transport's own retry budget is exhausted before transport warning callbacks fire. The callback fires once at final failure, not once per attempt.
- Aggregate codes `EC_PAYLOADS_DROPPED` and `EC_PAYLOADS_DEAD_LETTERED` carry `context: { count: number }`.
- `context.stage` on `EC_CAPTURE_FAILED` is `primary` when the top-level capture path failed and `fallback` when worker assembly failed and inline fallback also failed.
- `context.errno` on DLQ write failures carries the Node errno code when available.
- When a DLQ write returns `false` because the store is full or the payload is oversized, the store itself emits `EC_DLQ_FULL`; the dispatcher does not emit a duplicate warning.

## Out Of Scope

The following diagnostics may still write short console messages, but they are not payload-loss backpressure events:

- Custom PII scrubber throws: the default scrubber path is used instead.
- Dead-letter drain failure at startup: payloads remain in the DLQ for a later attempt.
- V8 Inspector already attached: local-variable capture is disabled for the lifetime of the SDK.

## Verification

`test/integration/backpressure.test.ts` forces the matrix rows and asserts that the expected code fires, `sdk.captureError` does not throw into user code, and the SDK remains usable after the condition is removed.
