# Module 10: Channel Subscriber

> **Spec status:** LOCKED
> **Source files:** `src/recording/channel-subscriber.ts`
> **Dependencies:** Module 01 (config), Module 08 (recorders), Module 09 (patch manager)
> **Build order position:** 10

---

## Module Contract Header

```typescript
/**
 * @module 10-channel-subscriber
 * @spec spec/10-channel-subscriber.md
 * @dependencies config.ts, http-server.ts, http-client.ts, undici.ts, net-dns.ts
 */
```

---

## Purpose

Central orchestrator that subscribes to all `diagnostics_channel` channels and routes events to the appropriate recorder handler. Provides a single `subscribeAll()` / `unsubscribeAll()` interface for the SDK lifecycle.

---

## Scope

- Subscribe to all known diagnostic channel names
- Route channel messages to the correct recorder handler
- Graceful degradation when channels do not exist
- Clean unsubscribe on shutdown

---

## Non-Goals

- Does not implement recording logic (recorders do that).
- Does not manage the circular buffer directly.

---

## Dependencies

- Module 01: `ResolvedConfig`
- Module 08: `HttpServerRecorder`, `HttpClientRecorder`, `UndiciRecorder`, `NetDnsRecorder`

---

## Node.js APIs Used

- `require('node:diagnostics_channel')`
- `dc.subscribe(channelName, handler)`
- `dc.unsubscribe(channelName, handler)`

---

## Data Structures

### ChannelSubscriber class

```typescript
class ChannelSubscriber {
  constructor(deps: {
    httpServer: HttpServerRecorder;
    httpClient: HttpClientRecorder;
    undiciRecorder: UndiciRecorder;
    netDns: NetDnsRecorder;
    config: ResolvedConfig;
  });
  subscribeAll(): void;
  unsubscribeAll(): void;
}
```

---

## Implementation Notes

### Channel registry

```
http.server.request.start   -> httpServer.handleRequestStart
http.client.request.start   -> httpClient.handleRequestStart
undici:request:create        -> undiciRecorder.handleRequestCreate
undici:request:headers       -> undiciRecorder.handleRequestHeaders
undici:request:trailers      -> undiciRecorder.handleRequestTrailers
undici:request:error         -> undiciRecorder.handleRequestError
net.client.socket            -> netDns.handleNetConnect  (if available)
net.server.socket            -> netDns.handleNetConnect  (if available)
```

### subscribeAll

For each channel in the registry:
1. Wrap the handler in a try/catch (a handler must NEVER throw into the diagnostic channel publisher)
2. Attempt `dc.subscribe(channelName, wrappedHandler)`
3. If subscribe throws (channel doesn't exist in this Node version): log debug message, skip
4. Store the subscription (channel name + handler reference) for later unsubscribe

### unsubscribeAll

For each stored subscription:
1. `dc.unsubscribe(channelName, handler)`
2. Clear the stored subscriptions

### Handler wrapping

Every handler is wrapped: `(message, name) => { try { recorder.handleX(message) } catch (e) { /* log warning, never re-throw */ } }`. This ensures the SDK never breaks the host application's I/O by throwing inside a diagnostic channel subscriber.

---

## Security Considerations

- Diagnostic channel handlers run synchronously in the publisher's context. A slow handler blocks the I/O operation. All handlers must be fast (< 0.1ms typical).
- Handlers must never throw — a thrown error would propagate into the core HTTP module's internal code.

---

## Edge Cases

- Channel does not exist in current Node.js version: silently skip
- `unsubscribeAll()` called before `subscribeAll()`: no-op
- `subscribeAll()` called twice: unsubscribe first, then re-subscribe (idempotent)
- Handler receives unexpected message shape: try/catch prevents crash

---

## Testing Requirements

- subscribeAll registers handlers for all known channels
- unsubscribeAll removes all handlers
- Handler exception does not propagate (caught and logged)
- Missing channel does not cause error
- Idempotent subscribe (call twice, verify no duplicate handlers)

---

## Completion Criteria

- `ChannelSubscriber` class exported with `subscribeAll()` and `unsubscribeAll()`.
- All channel names from the registry are subscribed.
- Handlers are wrapped in try/catch.
- Graceful degradation for missing channels.
- All unit tests pass.

---

## 0.2.0 Additions

### Dual subscribe for response-finished events (G2)

**Problem.** The response-finished `diagnostics_channel` name changed across Node versions. Older Node versions emit `http.server.response.finish`; newer Node versions emit `http.server.response.created`. Subscribing to only one channel causes response finalization to be missed on the other version family.

**Fix.** Subscribe to **both** channels when available. Deduplicate by request identity using a `WeakSet<IncomingMessage>` so a request that triggers both channels (if both are emitted in a given version) only produces one finalized IOEventSlot.

**Updated channel registry:**

```
http.server.request.start       -> httpServer.handleRequestStart
http.server.response.finish     -> httpServer.handleResponseFinish   (if available)
http.server.response.created    -> httpServer.handleResponseFinish   (if available, deduplicated)
http.client.request.start       -> httpClient.handleRequestStart
undici:request:create           -> undiciRecorder.handleRequestCreate
undici:request:headers          -> undiciRecorder.handleRequestHeaders
undici:request:trailers         -> undiciRecorder.handleRequestTrailers
undici:request:error            -> undiciRecorder.handleRequestError
net.client.socket               -> netDns.handleNetConnect  (if available)
net.server.socket               -> netDns.handleNetConnect  (if available)
```

**Deduplication contract.** `HttpServerRecorder` maintains a `WeakSet<IncomingMessage>` (`_finalizedRequests`). `handleResponseFinish(message)` checks `_finalizedRequests.has(message.request)` before acting. If already present, return immediately. Otherwise add the request to the set and proceed with finalization. The WeakSet holds no strong reference — entries are GC'd with the request object.

**Rationale.** The dual-subscribe approach is safer than a runtime version-sniff (`process.version`) because:
1. The channel simply will not fire on versions that don't support it — `dc.subscribe` on a non-existent channel name is a no-op (graceful degradation already handled by the existing `subscribeAll` pattern).
2. Version strings are fragile as a long-term condition (Node releases, custom builds, Bun compatibility).
3. WeakSet dedup is O(1) and allocation-free on the common case where only one channel fires per request.
