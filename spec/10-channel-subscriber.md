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
