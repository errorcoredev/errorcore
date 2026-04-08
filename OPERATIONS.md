# Operations

## SDK lifecycle

The SDK has four states:

1. **created** -- constructed but not yet active.
2. **active** -- hooks installed, capturing errors.
3. **shutting_down** -- teardown in progress.
4. **shutdown** -- all hooks removed, transport flushed.

Calling `init()` creates and activates the SDK. Calling `shutdown()` transitions through `shutting_down` to `shutdown`. The SDK cannot be re-activated after shutdown; call `init()` again to create a new instance.

## Startup sequence

When `activate()` is called, the SDK performs these steps in order:

1. Validates that `encryptionKey` is set (or `allowUnencrypted` is true).
2. Collects process startup metadata (Node.js version, memory, platform, container ID).
3. Installs HTTP server recording hooks.
4. Subscribes to `diagnostics_channel` events (for `undici`, DNS, TCP).
5. Installs monkey-patches on database drivers (`pg`, `mongodb`, `mysql2`, `ioredis`).
6. Registers process-level handlers (`uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT`, `beforeExit`).
7. Starts event loop lag measurement.
8. Drains pending dead-letter payloads (up to `maxDrainOnStartup`, default 200).

## Shutdown sequence

When `shutdown()` is called:

1. Unsubscribes from all `diagnostics_channel` channels.
2. Removes all monkey-patches from database drivers.
3. Shuts down HTTP server, client, undici, and DNS recorders.
4. Shuts down the V8 Inspector session.
5. Stops process metadata collection and event loop lag measurement.
6. Clears the request tracker.
7. Cancels all pending timers.
8. Waits for in-flight error captures to complete (5 second timeout).
9. Flushes the transport queue.
10. Shuts down the transport (5 second timeout).
11. Clears the I/O event buffer.
12. Removes all process-level signal handlers.

## Data flow

```
Inbound HTTP request
  |
  v
Middleware creates RequestContext (stored in AsyncLocalStorage)
  |
  v
RequestTracker registers the context for concurrent request tracking
  |
  v
Application code runs; patched modules emit I/O events:
  - http/https client requests
  - undici fetch calls
  - pg / mongodb / mysql2 / ioredis queries
  - DNS lookups
  - TCP connections
  |
  v
I/O events are written to the circular IOEventBuffer
  - Oldest events are evicted when capacity or byte limit is reached
  - Evictions are logged (latest 100 tracked)
  |
  v
Error occurs (throw, uncaughtException, unhandledRejection, or manual captureError)
  |
  v
ErrorCapturer assembles an ErrorPackage:
  1. Extracts error info (type, message, stack, cause chain)
  2. Captures local variables via V8 Inspector (if enabled)
  3. Retrieves I/O events for the current requestId from the buffer
  4. Falls back to ambient (non-request-scoped) events if no requestId
  5. Snapshots eviction log
  6. Collects state reads from StateTracker
  7. Summarizes concurrent requests from RequestTracker
  8. Collects process metadata (memory, event loop lag, uptime)
  9. Records code version (git SHA, package.json version)
  10. Captures allowed environment variables
  |
  v
PackageBuilder serializes and constrains the package:
  - Clones all values with depth/size limits
  - Scrubs PII (headers, env vars, URL query params, credit cards,
    emails, phone numbers, SSNs, API keys, JWTs, high-entropy strings)
  - Optionally encrypts with AES-256-GCM
  - Adds HMAC-SHA256 integrity signature
  - Records completeness metadata (what was captured, what was truncated)
  |
  v
TransportDispatcher sends the serialized payload:
  - HTTP: POST to collector
  - File: append NDJSON line
  - Stdout: write to console
  |
  v
On transport failure: DeadLetterStore persists the payload
```

## I/O event buffer

The buffer is a circular (ring) buffer that stores I/O events in insertion order.

- **Capacity**: `bufferSize` slots (default 200).
- **Byte limit**: `bufferMaxBytes` (default 50 MB).
- When full, the oldest event is evicted to make room.
- Evictions are logged with the event's sequence number, type, target, and timestamps.
- The latest 100 eviction records are kept.
- Each event tracks its estimated byte size for byte-limit enforcement.

Events are tagged with a `requestId` (from AsyncLocalStorage) when available. If the async context is lost, the event is marked with `contextLost: true` and attached to the ambient pool.

## Error handling

### Process-level handlers

- **uncaughtException**: Captures the error, waits up to `uncaughtExceptionExitDelayMs` (default 1500ms) for transport delivery, then exits with code 1.
- **unhandledRejection**: Wraps the rejection reason in an Error (if it is not already one) and captures it.
- **beforeExit**: Triggers graceful shutdown.
- **SIGTERM / SIGINT**: Shuts down the SDK, then re-raises the signal so the process can terminate normally.

### Capture failures

If error capture fails (e.g., Inspector timeout, serialization error), the SDK emits a warning and attempts a fallback capture with minimal context. If the fallback also fails, a warning is logged and the error is dropped.

Warning codes:

| Code | Meaning |
|------|---------|
| `errorcore_capture_failed` | Primary capture failed (Inspector or snapshot error) |
| `errorcore_capture_fallback_failed` | Fallback assembly also failed |
| `errorcore_transport_dispatch_failed` | Transport send failed |
| `errorcore_dead_letter_write_failed` | Dead-letter persistence failed |

All warnings are prefixed with `[ErrorCore]` and written to `console.warn`.

## Rate limiting

The rate limiter tracks captures per window (default: 60 per 60 seconds). When the limit is exceeded:

- The capture is dropped.
- The drop is counted.
- The `completeness.rateLimiterDrops` field in the next successful package includes `droppedCount`, `firstDropMs`, and `lastDropMs`.

## Transport details

### HTTP transport

- Sends a POST request to the configured `url`.
- Sets `Content-Type: application/json` and optionally `Authorization`.
- Timeout: `timeoutMs` (default 5000ms).
- Retry logic:
  - Up to 3 attempts.
  - Delays between retries: 200ms, 600ms, 1800ms.
  - Retryable: network timeouts, 5xx status codes, temporary DNS failures.
  - Non-retryable: TLS certificate errors (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
  - Non-retryable: 4xx status codes.
- By default, only HTTPS URLs are accepted. Set `allowPlainHttpTransport: true` for HTTP.
- TLS certificate validation can be disabled with `allowInvalidCollectorCertificates: true` (development only).

### File transport

- Appends NDJSON lines to the configured `path`.
- Rotates the file when it exceeds `maxSizeBytes`.
- Keeps up to `maxBackups` rotated copies (named `.1`, `.2`, etc.).
- File permissions are set to `0o600` (owner read/write only).

### Stdout transport

- Writes the serialized JSON payload to `process.stdout`.
- Intended for local development and debugging only.

## Dead-letter store

When transport delivery fails, the payload is written to a dead-letter file.

- **Location**: derived from the transport config, or set explicitly via `deadLetterPath`.
- **Format**: NDJSON, one envelope per line.
- **Envelope structure**:
  ```json
  {
    "version": 1,
    "kind": "payload",
    "storedAt": "2025-01-15T10:30:00.000Z",
    "payload": "<serialized error package>",
    "mac": "<HMAC-SHA256 signature>"
  }
  ```
- **Integrity**: Each entry is signed with HMAC-SHA256 using the `encryptionKey` or transport `authorization` value. Entries with invalid signatures are skipped during drain.
- **Size limit**: 50 MB by default. New entries are rejected when the file exceeds this limit.
- **Per-payload limit**: 6 MB per individual payload.
- **File permissions**: `0o600`.

### Automatic drain on startup

When the SDK initializes and finds pending dead-letter payloads, it re-sends up to `maxDrainOnStartup` (default 200) payloads through the configured transport. If more payloads exist, a warning is logged directing you to use `errorcore drain`.

### Manual drain via CLI

```bash
npx errorcore drain                  # Re-send all payloads (with confirmation prompt)
npx errorcore drain --dry-run        # Show pending payloads without sending
npx errorcore drain --force          # Skip confirmation prompt
npx errorcore status                 # Show dead-letter store size and payload count
```

Successfully sent payloads are removed from the store. Failed payloads are retained.

## Encryption

When `encryptionKey` is set, error packages are encrypted with AES-256-GCM before being handed to the transport.

- Key derivation: PBKDF2 with a random salt.
- Output format: JSON object with `salt`, `iv`, `ciphertext`, and `authTag` fields.
- The encrypted payload is what gets sent to the transport and stored in the dead-letter file.

## Worker thread assembly

When `useWorkerAssembly: true`, the package assembly step (serialization, PII scrubbing, encryption) runs in a separate worker thread. This keeps the main thread responsive during capture. The worker communicates via `postMessage`. Custom `piiScrubber` functions cannot be used with worker assembly (they are not serializable).

## Deployment considerations

- The SDK patches database drivers and HTTP modules at `require` time. Initialize errorcore before importing your application code to ensure all I/O is captured.
- `captureLocalVariables` uses the V8 Inspector protocol, which adds overhead. Limit this in high-throughput environments using `maxLocalsCollectionsPerSecond` (default 20) and `maxCachedLocals` (default 50).
- The I/O event buffer has a fixed capacity. In high-throughput services, older events may be evicted before an error occurs. Increase `bufferSize` if you need deeper history, but monitor memory usage.
- `uncaughtException` handling waits up to `uncaughtExceptionExitDelayMs` before exiting. Adjust this based on your transport latency.
- For containerized deployments, the SDK attempts to read the container ID from `/proc/self/cgroup`.
- The dead-letter store can grow up to 50 MB. Monitor disk usage and run `errorcore drain` periodically if transport failures are frequent.
- The SDK captures environment variables filtered by allowlist/blocklist. Review the defaults and adjust for your environment to avoid leaking sensitive values.
