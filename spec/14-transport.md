# Module 14: Transport and Delivery

> **Spec status:** LOCKED
> **Source files:** `src/transport/transport.ts`, `src/transport/http-transport.ts`, `src/transport/file-transport.ts`, `src/transport/stdout-transport.ts`
> **Dependencies:** Module 01 (types, config), Module 05 (encryption)
> **Build order position:** 14

---

## Module Contract Header

```typescript
/**
 * @module 14-transport
 * @spec spec/14-transport.md
 * @dependencies types.ts, config.ts, encryption.ts
 */
```

---

## Purpose

Ship serialized (and optionally encrypted) error packages to their destination without blocking the event loop. Supports HTTPS, file, and stdout transports with a worker-thread dispatcher for off-main-thread I/O.

---

## Scope

- `Transport` interface
- `TransportDispatcher` class: worker-thread-based dispatch with main-thread fallback
- `HttpTransport`: HTTPS POST with retry and timeout
- `FileTransport`: append JSON-lines to file with rotation
- `StdoutTransport`: write JSON-lines to stdout

---

## Non-Goals

- Does not assemble or scrub error packages (module 13 does that).
- Does not manage encryption (module 05 does that; dispatcher receives already-encrypted payloads if configured).

---

## Dependencies

- Module 01: `ResolvedConfig`, `TransportConfig`
- Module 05: `Encryption` (optional, for cases where transport handles encryption)

---

## Node.js APIs Used

### transport.ts (dispatcher)
- `require('node:worker_threads').Worker`
- `worker.postMessage()` / `parentPort.on('message')`
- `setImmediate()` for fallback chunked writes

### http-transport.ts
- `require('node:https').request()`
- `require('node:http').request()` (if insecure transport allowed)

### file-transport.ts
- `require('node:fs').appendFile()`
- `require('node:fs').stat()` for rotation size check
- `require('node:fs').writeFileSync()` for emergency sync flush

### stdout-transport.ts
- `process.stdout.write()`

---

## Data Structures

### Transport interface

```typescript
interface Transport {
  send(payload: string | Buffer): Promise<void>;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}
```

### TransportDispatcher class

```typescript
class TransportDispatcher implements Transport {
  constructor(config: { config: ResolvedConfig; encryption: Encryption | null });
  send(payload: string | Buffer): Promise<void>;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  sendSync(payload: string): void;  // emergency sync flush for process.on('exit')
}
```

---

## Implementation Notes

### Worker thread dispatcher

1. At construction, spawn a single long-lived worker thread.
2. The worker thread file (`transport-worker.ts`) receives messages via `parentPort.on('message')`.
3. Messages: `{ type: 'send', payload }`, `{ type: 'flush' }`, `{ type: 'shutdown' }`
4. The worker creates the appropriate transport (HTTP, file, or stdout) based on config.
5. `send()`: post message to worker, resolve when worker acknowledges.
6. `flush()`: post flush message, wait for worker to drain its queue.
7. `shutdown()`: post shutdown message, wait for worker to exit (with timeout). If timeout: `worker.terminate()`.

### Fallback (no worker thread)

If `worker_threads` is unavailable or worker creation fails:
- Use `setImmediate`-chunked writes on the main thread.
- `send()` queues the payload and processes it in the next tick.
- This is slower but functional.

### HTTP transport

- Default: require HTTPS. Reject HTTP URLs unless `config.allowInsecureTransport: true`.
- Include `Authorization` header with user-configured API key.
- Content-Type: `application/json`
- Retry: 3 attempts with exponential backoff (1s, 2s, 4s).
- After 3 failures: drop payload, increment failure counter.
- Timeout: 10 seconds per request (via `setTimeout` + `req.destroy()`).

### File transport

- Append JSON-line to configured file path via `fs.appendFile`.
- File rotation: before each write, check file size via `fs.stat`. If size > configured limit (default 100MB), rotate: rename current file to `filename.TIMESTAMP.bak`, create new file.
- `sendSync(payload)`: use `fs.writeFileSync` for emergency flush on `process.on('exit')`.

### Stdout transport

- `process.stdout.write(payload + '\n')`
- Simplest transport. Useful for container environments.
- `sendSync` uses `process.stderr.write()` (stderr is unbuffered, more reliable during exit).

---

## Security Considerations

- HTTP transport MUST enforce HTTPS by default. Sending error packages over plain HTTP exposes sensitive data.
- The `Authorization` header value (API key) must NOT appear in error packages or logs.
- Worker thread communication uses `postMessage` (structured clone). Payloads are not accessible from other threads.
- File transport writes encrypted payloads. If encryption is not configured, the file contains scrubbed but unencrypted data — this is documented as a security tradeoff.

---

## Edge Cases

- Worker thread creation fails: fall back to main-thread dispatch
- Worker thread dies unexpectedly: detect via `worker.on('exit')`, recreate or fall back
- HTTP endpoint unreachable: retry 3 times, then drop payload
- HTTP endpoint returns non-2xx: treat as failure, retry
- File write fails (disk full, permissions): log warning, drop payload
- `shutdown()` timeout: forcefully terminate worker
- `sendSync()` called during exit: must be synchronous (no async operations)
- Payload is very large (5MB): worker thread handles structured clone. HTTP transport sends in one request. File transport writes in one append.

---

## Testing Requirements

- TransportDispatcher with mock worker: send/flush/shutdown lifecycle
- HTTP transport: mock HTTPS server receives payload with correct headers
- HTTP transport: retry on failure (mock server returns 500 twice, 200 on third)
- HTTP transport: timeout handling
- HTTP transport: rejects HTTP URLs (no TLS)
- File transport: appends JSON-line to file
- File transport: rotation at size limit
- File transport: sendSync writes synchronously
- Stdout transport: writes to stdout
- Fallback mode when worker unavailable
- Shutdown with timeout forces worker termination

---

## Completion Criteria

- `TransportDispatcher` class exported implementing `Transport` interface.
- `HttpTransport`, `FileTransport`, `StdoutTransport` classes exported.
- Worker-thread dispatch works with fallback.
- HTTPS enforced by default.
- Retry and timeout for HTTP transport.
- File rotation works.
- `sendSync` works for emergency flush.
- All unit tests pass.
