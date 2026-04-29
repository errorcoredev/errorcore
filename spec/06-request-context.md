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
- `require('node:crypto').randomUUID()`
- `process.hrtime.bigint()`

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
- `requestId` generated via `crypto.randomUUID()`.
- `startTime` generated via `process.hrtime.bigint()`.
- `ioEvents`, `stateReads`, and `stateWrites` arrays are initialized empty.
- `getStore()` exposes the raw `AsyncLocalStorage` instance for use with `diagnostics_channel.channel.bindStore()`.

### Tracestate ingest (module 21)

When `req.tracestate` is provided:

1. Call `parseTracestate(req.tracestate, vendorKey)` (module 21).
2. If `receivedSeq !== null`, call `eventClock.merge(receivedSeq)` (module 19). The merge bumps our local clock so subsequent events stamp with values guaranteed greater than the peer's.
3. Store `parsed.inheritedEntries` on `RequestContext.inheritedTracestate` if non-empty (else leave undefined). These are re-emitted by HTTP recorders on egress.

`formatOutboundTracestate()` returns the egress string for the **current** ALS context using `formatTracestate(eventClock.current(), ctx.inheritedTracestate, vendorKey)`. Returns `null` if no ALS context is active. Used by `recording/http-client.ts` and `recording/undici.ts`.

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
