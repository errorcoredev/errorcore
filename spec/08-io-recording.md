# Module 08: I/O Recording Layer

> **Spec status:** LOCKED
> **Source files:** `src/recording/http-server.ts`, `src/recording/http-client.ts`, `src/recording/undici.ts`, `src/recording/net-dns.ts`
> **Dependencies:** Module 01 (types), Module 03 (buffer), Module 06 (ALS, request tracker), Module 07 (body capture)
> **Build order position:** 8

---

## Module Contract Header

```typescript
/**
 * @module 08-io-recording
 * @spec spec/08-io-recording.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts, request-tracker.ts, body-capture.ts, header-filter.ts
 */
```

---

## Purpose

Handle `diagnostics_channel` messages for HTTP server, HTTP client, undici, net, and DNS events. Extract scalar data from host objects synchronously into IOEventSlot POJOs and push them into the circular buffer. Attach body capture where applicable.

---

## Scope

- `HttpServerRecorder` class: inbound HTTP request/response recording + ALS context entry
- `HttpClientRecorder` class: outbound HTTP (core `http`/`https` module) recording
- `UndiciRecorder` class: outbound undici/fetch recording
- `NetDnsRecorder` class: raw TCP and DNS recording

Each class accepts dependencies via constructor injection and exposes handler methods that the channel subscriber calls.

---

## Non-Goals

- Does not subscribe to channels itself (module 10 does that).
- Does not patch database drivers (module 09).
- Does not perform PII scrubbing at recording time.

---

## Dependencies

- Module 01: `IOEventSlot`, `ResolvedConfig`
- Module 03: `IOEventBuffer`
- Module 06: `ALSManager`, `RequestTracker`
- Module 07: `BodyCapture`
- Module 04: `HeaderFilter` (for filtering headers at extraction time)

---

## Node.js APIs Used

- `process.hrtime.bigint()` for timestamps
- `diagnostics_channel` message objects (received from channel subscriber)
- `IncomingMessage`, `ServerResponse`, `ClientRequest` properties (read, not stored)
- `response.on('finish')`, `req.on('close')`, `req.on('aborted')` event listeners
- `socket._handle?.fd` for file descriptor

---

## Data Structures

### HttpServerRecorder

```typescript
class HttpServerRecorder {
  constructor(deps: {
    buffer: IOEventBuffer;
    als: ALSManager;
    requestTracker: RequestTracker;
    bodyCapture: BodyCapture;
    headerFilter: HeaderFilter;
    config: ResolvedConfig;
  });
  handleRequestStart(message: { request: IncomingMessage; response: ServerResponse; socket: Socket; server: Server }): void;
  shutdown(): void;
}
```

### HttpClientRecorder

```typescript
class HttpClientRecorder {
  constructor(deps: {
    buffer: IOEventBuffer;
    als: ALSManager;
    bodyCapture: BodyCapture;
    headerFilter: HeaderFilter;
    config: ResolvedConfig;
  });
  handleRequestStart(message: { request: ClientRequest }): void;
  shutdown(): void;
}
```

### UndiciRecorder

```typescript
class UndiciRecorder {
  constructor(deps: {
    buffer: IOEventBuffer;
    als: ALSManager;
    headerFilter: HeaderFilter;
    config: ResolvedConfig;
  });
  handleRequestCreate(message: { request: UndiciRequest }): void;
  handleRequestHeaders(message: { request: UndiciRequest; response: any }): void;
  handleRequestTrailers(message: { request: UndiciRequest; trailers: any }): void;
  handleRequestError(message: { request: UndiciRequest; error: Error }): void;
  shutdown(): void;
}
```

### NetDnsRecorder

```typescript
class NetDnsRecorder {
  constructor(deps: {
    buffer: IOEventBuffer;
    als: ALSManager;
    config: ResolvedConfig;
  });
  handleNetConnect(message: any): void;
  handleDnsLookup(message: any): void;
  shutdown(): void;
}
```

---

## Implementation Notes

### HttpServerRecorder.handleRequestStart

1. Extract scalar values synchronously: `method`, `url`, `headers` (via headerFilter), `socket._handle?.fd`
2. Create `RequestContext` via `als.createRequestContext({ method, url, headers })`
3. Register context in request tracker
4. Enter ALS context. Two strategies:
   - Primary: `diagnostics_channel.channel.bindStore(als.getStore(), transformFn)` — Node 19.9+/18.19+
   - Fallback: monkey-patch `http.Server.prototype.emit` to wrap `'request'` events in `als.runWithContext()`
5. Push IOEventSlot to buffer: `type: 'http-server'`, `direction: 'inbound'`, `phase: 'active'`
6. Attach body capture for request stream and response
7. Listen for `response.on('finish')`: finalize slot (endTime, durationMs, statusCode, response headers), remove from request tracker, set `phase: 'done'`
8. Listen for `req.on('close')`/`req.on('aborted')`: set `aborted: true`, finalize

### GC safety — critical constraint

All handler methods MUST extract needed values into plain scalars/strings synchronously. The IOEventSlot MUST NOT hold references to `IncomingMessage`, `ServerResponse`, `Socket`, `ClientRequest`, or any other host object. Headers are copied via `headerFilter.filterHeaders()` which returns a new object.

### HttpClientRecorder.handleRequestStart

1. Read ALS context (may be `undefined`)
2. Extract: method, protocol, host, port, path -> target string
3. Push IOEventSlot: `type: 'http-client'`, `direction: 'outbound'`, `phase: 'active'`
4. Listen for `response` event on ClientRequest: capture status, headers
5. Attach body capture to response stream
6. On response `'end'`: finalize slot
7. On `'error'`/`'abort'`/`'close'`: record error, set aborted flag

### UndiciRecorder

Uses `WeakMap<UndiciRequest, IOEventSlot>` to correlate create -> headers -> trailers events.

- `handleRequestCreate`: push IOEventSlot, store in WeakMap
- `handleRequestHeaders`: look up slot, record status/headers
- `handleRequestTrailers`: look up slot, finalize
- `handleRequestError`: look up slot, record error

WeakMap ensures no memory leak if request is GC'd before trailers.

Body capture for undici response: use `undici:request:bodyChunkReceived` if available. If not, document as v1 limitation.

### NetDnsRecorder

- Net: subscribe to `net.client.socket`/`net.server.socket` if available. Fallback: monkey-patch `net.connect()`.
- DNS: monkey-patch `dns.resolve()`, `dns.resolve4()`, `dns.resolve6()`, `dns.lookup()` using the patch-manager pattern (but inlined, since DNS is part of this module).
- Record: timestamp, hostname/IP, port, FD, duration for DNS.

---

## Security Considerations

- Headers are filtered through HeaderFilter at extraction time — before being stored in the slot. Sensitive headers never enter the buffer.
- Body data may contain PII but is stored as-is. PII scrubbing happens at error-capture time.
- Request URLs may contain query parameters with PII. These are stored as-is. Scrubbing happens at capture time.

---

## Edge Cases

- ALS context unavailable when recording outbound HTTP: set `contextLost: true`, requestId: `null`
- Request aborted before response: finalize with `aborted: true`, no response data
- Response with no body (204, 304): body capture produces null, no truncation flag
- Socket has no `_handle` (e.g., Unix socket): `fd` is `null`
- `diagnostics_channel` fires with unexpected message shape: wrap handler in try/catch, log warning, skip event
- Undici request GC'd before trailers: WeakMap entry auto-removed, no leak
- DNS channel doesn't exist in Node 20: fall back to monkey-patching

---

## Testing Requirements

- HttpServerRecorder: simulate diagnostic message, verify IOEvent in buffer with correct method/url/status/headers
- HttpServerRecorder: verify ALS context created and propagated
- HttpServerRecorder: verify body capture attached
- HttpServerRecorder: aborted request sets aborted flag
- HttpClientRecorder: verify outbound request recorded with target string
- HttpClientRecorder: verify response status and headers captured
- HttpClientRecorder: verify error recorded on connection failure
- UndiciRecorder: verify create/headers/trailers sequence produces complete IOEvent
- UndiciRecorder: verify WeakMap cleanup (no leak on GC)
- NetDnsRecorder: verify DNS lookup recorded with hostname and duration
- All recorders: verify no host object references in IOEventSlot (GC safety)
- All recorders: verify contextLost flag when ALS is unavailable

---

## Completion Criteria

- All four recorder classes exported with handler methods.
- Handlers extract scalar data synchronously — no async work in handlers.
- GC safety: no host object references in any IOEventSlot.
- ALS context entry works for HTTP server requests.
- Body capture attached where applicable.
- All unit tests pass.

---

## 0.2.0 Additions

### Tiered driver support (G2)

Errorcore records IO events at different fidelity levels depending on the runtime environment. Canonical tiers (mirrored in README and `spec/09-database-patches.md`):

**Tier 1 — Plain Node.js** (Express, Fastify, Koa, NestJS, raw `http`): automatic. No config needed. All recorders install against the same `require()` graph the app uses.

**Tier 2 — Single-graph bundlers** (Vite SSR, esbuild, plain webpack): automatic if the driver is not tree-shaken, or pass explicit references via the `drivers` config option:

```ts
errorcore.init({
  drivers: { pg: require('pg'), mongodb: require('mongodb') },
});
```

**Tier 3 — Next.js App Router**: externalize drivers from the webpack bundle:

```js
// next.config.js
module.exports = {
  serverExternalPackages: ['pg', 'mongodb', 'mysql2', 'ioredis'],
};
```

Without this, the DB timeline will not populate — the startup diagnostic will report `warn(bundled-unpatched)`. HTTP inbound, HTTP outbound, and `fetch` (undici) recording work in all three tiers because they hook `diagnostics_channel`, not module prototypes.

### Channel payload shape contracts (G2)

Audit results for actual Node channel payload shapes (Node 18/20/22/24). These are the authoritative shapes handlers must accept:

| Channel | Actual payload shape | Fix applied in 0.2.0 |
|---------|---------------------|----------------------|
| `http.server.request.start` | `{ request, response, server }` — `socket` is **not** part of this payload in any Node version | Removed `message.socket === undefined` early-return; `socket` is read from `request.socket` instead |
| `http.client.request.start` | `{ request }` only — socket attaches later via `response` event | Removed socket early-return; `request.socket` used if present, else null |
| `undici:request:create` | undici `RequestImpl` shape — distinct from Node `ClientRequest` | Audited against undici types; normalized before passing to body capture |
| `http.server.response.finish` | response-finished event (older Node) | Both this and `http.server.response.created` are now subscribed; deduplicated by request identity via `WeakSet<IncomingMessage>` |
| `http.server.response.created` | response-finished event (newer Node) | See above |

**Shape-assertion tests** (added in `test/unit/io-recording.test.ts`) construct the real channel payload per Node major version and assert the recorder does not early-return or throw.

**Test matrix:**

| Recorder | 18 | 20 | 22 | 24 | Rationale |
|----------|----|----|----|----|-----------|
| http-server | CI | CI | CI | CI | shape drift observed |
| undici | CI | CI | CI | CI | internal API changed between versions |
| pg / mongodb / mysql2 / ioredis | CI only | CI only | CI only | CI only | fail for reasons orthogonal to Node version |
| http-client | — | CI only | — | — | single-version unless bug surfaces |
| net | — | CI only | — | — | stable |
| dns | — | CI only | — | — | stable |
