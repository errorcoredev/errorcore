# Module 06: Request Context and AsyncLocalStorage

> **Spec status:** LOCKED
> **Source files:** `src/context/als-manager.ts`, `src/context/request-tracker.ts`
> **Dependencies:** Module 01 (types, config), Module 19 (EventClock — for `merge` on tracestate ingest), Module 21 (tracestate parsing)
> **Build order position:** 6

---

## Module Contract Header

```typescript
/**
 * @module 06-request-context
 * @spec spec/06-request-context.md
 * @dependencies types.ts, config.ts
 */
```

---

## Purpose

Provide the `AsyncLocalStorage`-based request context binding that correlates I/O events to individual inbound HTTP requests, and a concurrent request tracker for error-time context.

---

## Scope

- `ALSManager` class: owns an `AsyncLocalStorage<RequestContext>` instance, provides context creation and access
- `RequestTracker` class: maintains a capped `Map<string, RequestContext>` of in-flight requests with TTL sweep

---

## Non-Goals

- Does not subscribe to diagnostics channels (that is module 08/10).
- Does not create middleware (that is module 15).
- Does not capture I/O events or bodies.

---

## Dependencies

- Module 01: `RequestContext`, `ResolvedConfig`

---

## Node.js APIs Used

### als-manager.ts
- `require('node:async_hooks').AsyncLocalStorage`
- `require('node:crypto').randomBytes(16)` — trace-id generation (W3C 16 bytes)
- `require('node:crypto').randomBytes(8)` — span-id generation (W3C 8 bytes)
- `process.hrtime.bigint()` — `RequestContext.startTime`
- `process.pid` — request-id prefix (`<pid>-<counter>`, not `randomUUID`)

### request-tracker.ts
- `setInterval()` with `.unref()` for TTL sweep

---

## Data Structures

### ALSManager class

```typescript
class ALSManager {
  constructor(deps: {
    eventClock: EventClock;                                       // module 19
    config: Pick<ResolvedConfig, 'traceContext'>;                 // module 21
  });
  createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    traceparent?: string;
    tracestate?: string;                                          // module 21
  }): RequestContext;
  runWithContext<T>(ctx: RequestContext, fn: () => T): T;
  getContext(): RequestContext | undefined;
  getRequestId(): string | undefined;
  getStore(): AsyncLocalStorage<RequestContext>;
  formatTraceparent(): string | null;
  formatOutboundTracestate(): string | null;                      // module 21
}
```

### RequestTracker class

```typescript
class RequestTracker {
  constructor(config: { maxConcurrent: number; ttlMs: number });
  add(ctx: RequestContext): void;
  remove(requestId: string): void;
  getAll(): RequestContext[];
  getSummaries(): RequestSummary[];
  getCount(): number;
  shutdown(): void;
}

interface RequestSummary {
  requestId: string;
  method: string;
  url: string;
  startTime: bigint;
}
```

---

## Implementation Notes

### ALSManager

- Creates a fresh `AsyncLocalStorage` instance in its constructor. This is a class, NOT a module-level singleton.
- `createRequestContext` copies values out of the `req` parameter into a new `RequestContext` object. It does NOT store a reference to the original `req` object (GC safety).
- `requestId` is `<process.pid>-<counter>`, where the counter increments per request and wraps at `Number.MAX_SAFE_INTEGER`. The pid prefix gives cross-process uniqueness without paying for a UUID per request.
- `startTime` generated via `process.hrtime.bigint()`.
- `ioEvents`, `stateReads`, and `stateWrites` arrays are initialized empty.
- `getStore()` exposes the raw `AsyncLocalStorage` instance for use with `diagnostics_channel.channel.bindStore()`.

### Tracestate ingest (module 21)

When `req.tracestate` is provided:

1. Call `parseTracestate(req.tracestate, vendorKey)` (module 21).
2. If `receivedSeq !== null`, call `eventClock.merge(receivedSeq)` (module 19). The merge bumps our local clock so subsequent events stamp with values guaranteed greater than the peer's.
3. Store `parsed.inheritedEntries` on `RequestContext.inheritedTracestate` if non-empty (else leave undefined). These are re-emitted by HTTP recorders on egress.

`formatOutboundTracestate()` returns the egress string for the **current** ALS context using `formatTracestate(eventClock.current(), ctx.inheritedTracestate, vendorKey)`. Returns `null` if no ALS context is active. Used by `recording/http-client.ts` and `recording/undici.ts`.

### Traceparent ingest and egress

The `traceparent` HTTP header is parsed on inbound and emitted on outbound following the W3C Trace Context recommendation ([https://www.w3.org/TR/trace-context/](https://www.w3.org/TR/trace-context/)). The ingest path lives in `src/context/als-manager.ts`'s file-local `parseTraceparent`. Egress is `ALSManager.formatTraceparent()`, exposed publicly via `getTraceparent()` on the SDK and on the Next.js subpath.

#### Wire format (version 00)

```
<version>-<trace-id>-<parent-id>-<trace-flags>
```

Where:

- `version` is exactly 2 lowercase hex chars. The current implementation emits `00`. On parse, the version is read but does not gate parsing of the remaining fields except as listed under Parse rejection rules.
- `trace-id` is exactly 32 lowercase hex chars (16 bytes).
- `parent-id` (a.k.a. span-id of the upstream caller) is exactly 16 lowercase hex chars (8 bytes).
- `trace-flags` is exactly 2 lowercase hex chars. The full byte (0–255) is preserved in `RequestContext.traceFlags` so unknown bits round-trip across services per W3C §3.2.2.4.

Future W3C versions MAY append additional fields after `trace-flags`. Parsers accept them by ignoring everything after the fourth `-`-delimited part.

#### Parse rejection rules

`parseTraceparent` returns `null` (which causes `createRequestContext` to fall back to a freshly generated trace) in any of the following cases. Every rule is required for W3C compliance and is verified by a unit test in `test/unit/serverless.test.ts`.

| Rule | Source | Behavior |
|------|--------|----------|
| Header is `undefined` or empty | (n/a) | `parseTraceparent` returns `null`. `createRequestContext` originates a new trace. |
| Fewer than 4 `-`-delimited parts | (structural) | Returns `null`. |
| Version is not 2 lowercase hex chars | W3C §3.2.2.1 | Returns `null`. |
| Version is `'ff'` | W3C §3.2.2.1 (reserved) | Returns `null`. Parsers MUST NOT use this value. |
| Trace-id is not 32 lowercase hex chars | W3C §3.2.2.3 | Returns `null`. |
| Trace-id is all zeros (`'0'.repeat(32)`) | W3C §3.2.2.3 | Returns `null`. The all-zero value is an invalid sentinel and a known sign of a misconfigured propagator. |
| Parent-id is not 16 lowercase hex chars | W3C §3.2.2.3 | Returns `null`. |
| Parent-id is all zeros (`'0'.repeat(16)`) | W3C §3.2.2.3 | Returns `null`. Same reasoning as the all-zero trace-id. |
| Flags are not 2 lowercase hex chars | W3C §3.2.2.4 | Returns `null`. |

Uppercase hex (e.g. `A` instead of `a`) fails the regex check on whichever field contains it. The check is intentionally strict: the W3C spec mandates lowercase and a tolerant parser would mask broken upstream propagators.

#### Trace-flags propagation rule

`RequestContext.traceFlags` carries the **full byte** observed on inbound, not just the sampled bit. On egress, `formatTraceparent` re-emits this byte verbatim. This preserves unknown flag bits across the SDK so that a downstream service which understands a flag bit the SDK does not still sees it on the outbound `traceparent`.

When this request originated the trace (no inbound `traceparent`, or the inbound was rejected per the rules above), `traceFlags` defaults to `0x01` (sampled). The default is `0x01` rather than `0x00` because errorcore is an error-monitoring SDK and wants to capture errors regardless of upstream sampling; setting `0x00` on origination would tell downstream services we explicitly chose not to sample, which is the wrong signal.

Operators who want to mirror an upstream's "do not sample" decision should ensure that upstream emits a valid `traceparent` (with the desired flag byte) so the rule above propagates it.

#### Span-id semantics

On every inbound request, `createRequestContext` generates a fresh `spanId` via `crypto.randomBytes(8).toString('hex')`. The fresh `spanId` represents the new span this request creates. The `parent-id` field on outbound `traceparent` is filled from `RequestContext.spanId` (per W3C §3.2.2.2: "the parent-id of the outgoing request is the span-id of the current operation"). The inbound `parent-id` is preserved on `RequestContext.parentSpanId` for the package's `trace.parentSpanId` field but is NOT used on egress.

#### Generation

When errorcore originates a trace (no inbound or the inbound was rejected):

- `traceId` via `crypto.randomBytes(16).toString('hex')` (32 lowercase hex chars).
- `spanId` via `crypto.randomBytes(8).toString('hex')` (16 lowercase hex chars).
- `traceFlags = 0x01`.

The generators use the OS CSPRNG via Node's `crypto` module. The probability that either generator produces an all-zero value is `2^-128` for trace-id and `2^-64` for span-id. We do not assert non-zero on the generated values: at the CSPRNG bit rate this would never trigger on real hardware.

#### Public surface

- `errorcore.getTraceparent(): string | null` — current request's egress `traceparent`. Returns `null` when called outside a request scope.
- `errorcore/nextjs` re-exports `getTraceparent()`. The edge stub returns `null` unconditionally.

### RequestTracker

- Uses a `Map<string, RequestContext>` internally.
- `add(ctx)`: if map size >= `maxConcurrent`, do NOT add. Log a debug warning. The cap is a reporting limit, not a hard constraint on the application.
- `remove(requestId)`: delete from map. No-op if not present.
- TTL sweep: every 60 seconds, remove entries whose `startTime` is older than `ttlMs` (default 5 minutes). This catches requests where the connection was dropped without a `response.finish` event.
- Sweep timer is created with `.unref()`.
- `shutdown()`: clear the interval timer and the map.
- `getSummaries()` returns lightweight objects (id, method, url, startTime) without full I/O timelines.

---

## Security Considerations

- RequestContext stores filtered headers (filtering is done by the caller before passing to `createRequestContext`). The ALSManager itself does not filter.
- The request tracker holds RequestContext objects in memory for the duration of the request. These are removed on response finish or TTL expiry.

---

## Edge Cases

- ALS context is `undefined` outside of request scope (background jobs, timers that lost context). `getContext()` returns `undefined`. All consumers handle this.
- ALS context is `undefined` inside native addon callbacks that don't preserve async context.
- Multiple `ALSManager` instances (in tests) are fully independent. Each has its own `AsyncLocalStorage`.
- Request never removed from tracker (connection dropped without `response.finish`): TTL sweep removes it after 5 minutes.
- Tracker at capacity: new requests are not added. Existing requests continue to work.
- `remove()` called twice for same requestId: second call is a no-op.
- `shutdown()` called while requests are in-flight: map is cleared, no further tracking.

---

## Testing Requirements

### ALSManager
- Context propagation across async boundaries (setTimeout, setImmediate, Promise chains, EventEmitter)
- Context isolation between concurrent requests (two parallel requests see their own context)
- `getContext()` returns `undefined` outside request scope
- `getRequestId()` returns `undefined` outside request scope
- Multiple ALSManager instances do not interfere with each other
- `createRequestContext` does not store reference to input object (verify by mutating input after creation)

### RequestTracker
- `add` and `remove` work correctly
- `getAll` returns all tracked contexts
- `getSummaries` returns lightweight objects
- Cap enforcement: adding beyond maxConcurrent is silently dropped
- TTL sweep removes stale entries (use short TTL in tests)
- `remove` is idempotent
- `shutdown` clears map and stops timer

---

## Completion Criteria

- `ALSManager` class exported with all methods.
- `RequestTracker` class exported with all methods.
- Context propagation works across all async boundaries.
- Multiple instances are independent.
- TTL sweep runs on `.unref()`'d timer.
- All unit tests pass.
