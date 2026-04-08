# Data structures

errorcore is a client-side SDK. It does not use a traditional database. All data is held in memory during operation and serialized to JSON for transport or file storage.

This document describes the data structures, their fields, relationships, and how data is written and read.

## ErrorPackage

The top-level structure sent to the collector when an error is captured. Schema version is `1.0.0`.

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `'1.0.0'` | Schema version identifier. |
| `capturedAt` | `string` | ISO 8601 timestamp of when the error was captured. |
| `timeAnchor` | `TimeAnchor` | Links wall-clock time to high-resolution time for correlating I/O event timestamps. |
| `error` | `ErrorInfo` | The captured error. See ErrorInfo below. |
| `localVariables` | `CapturedFrame[]` or absent | Local variables from stack frames, if `captureLocalVariables` is enabled. |
| `request` | `object` or absent | The inbound HTTP request context. Fields: `id`, `method`, `url`, `headers`, `body` (optional), `bodyTruncated` (optional), `receivedAt`. |
| `ioTimeline` | `IOEventSerialized[]` | Ordered list of I/O events associated with this error. |
| `evictionLog` | `EvictionRecordSerialized[]` | Records of I/O events that were evicted from the buffer before capture. |
| `ambientContext` | `AmbientEventContext` or absent | Metadata about non-request-scoped events used when no request context was available. |
| `stateReads` | `StateReadSerialized[]` | State reads from tracked containers. |
| `concurrentRequests` | `RequestSummary[]` | Summary of other in-flight requests at capture time. |
| `processMetadata` | `ProcessMetadata` | Process-level information. |
| `codeVersion` | `object` | Contains `gitSha` (string, optional) and `packageVersion` (string, optional). |
| `environment` | `Record<string, string>` | Captured environment variables (filtered by allowlist/blocklist). |
| `integrity` | `object` or absent | HMAC-SHA256 signature. Fields: `algorithm` (`'HMAC-SHA256'`), `signature`. |
| `completeness` | `Completeness` | Describes what was captured, what was truncated, and what failed. |

## ErrorInfo

Describes a single error in the cause chain.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Error constructor name (e.g., `TypeError`, `Error`). |
| `message` | `string` | Error message. |
| `stack` | `string` | Full stack trace string. |
| `cause` | `ErrorInfo` or absent | Recursive cause chain (from `error.cause`). |
| `properties` | `Record<string, unknown>` | Any non-standard properties attached to the error object. |

## IOEventSlot

In-memory representation of a single I/O event. Stored in the circular buffer.

| Field | Type | Description |
|-------|------|-------------|
| `seq` | `number` | Monotonically increasing sequence number. |
| `phase` | `'active'` or `'done'` | Whether the I/O operation is in progress or completed. |
| `startTime` | `bigint` | High-resolution start time (`process.hrtime.bigint()`). |
| `endTime` | `bigint` or `null` | High-resolution end time, null if still active. |
| `durationMs` | `number` or `null` | Duration in milliseconds, null if still active. |
| `type` | `IOEventType` | One of: `http-server`, `http-client`, `undici`, `db-query`, `dns`, `tcp`, `cache-read`. |
| `direction` | `'inbound'` or `'outbound'` | Whether the event represents an incoming or outgoing operation. |
| `requestId` | `string` or `null` | The request context this event belongs to. Null if context was lost. |
| `contextLost` | `boolean` | True if AsyncLocalStorage context was not available when the event was recorded. |
| `target` | `string` | Target identifier (hostname, database name, query summary). |
| `method` | `string` or `null` | HTTP method or database operation. |
| `url` | `string` or `null` | Full URL for HTTP events. |
| `statusCode` | `number` or `null` | HTTP response status code. |
| `fd` | `number` or `null` | File descriptor for TCP/socket events. |
| `requestHeaders` | `Record<string, string>` or `null` | Outgoing request headers (after PII filtering). |
| `responseHeaders` | `Record<string, string>` or `null` | Response headers (after PII filtering). |
| `requestBody` | `Buffer` or `null` | Raw request body bytes (if body capture is enabled). |
| `responseBody` | `Buffer` or `null` | Raw response body bytes (if body capture is enabled). |
| `requestBodyDigest` | `string` or `null` | SHA-256 digest of the request body (if digest capture is enabled). |
| `responseBodyDigest` | `string` or `null` | SHA-256 digest of the response body (if digest capture is enabled). |
| `requestBodyTruncated` | `boolean` | Whether the request body was truncated due to size limits. |
| `responseBodyTruncated` | `boolean` | Whether the response body was truncated. |
| `requestBodyOriginalSize` | `number` or `null` | Original size of the request body before truncation. |
| `responseBodyOriginalSize` | `number` or `null` | Original size of the response body before truncation. |
| `error` | `{ type, message }` or `null` | Error that occurred during this I/O operation. |
| `aborted` | `boolean` | Whether the operation was aborted. |
| `dbMeta` | `object` or absent | Database-specific metadata. Fields: `query`, `params`, `rowCount`, `collection`. |
| `estimatedBytes` | `number` | Estimated memory footprint of this slot, used for byte-limit enforcement. |

### IOEventSerialized

The serialized form of `IOEventSlot` sent in the `ioTimeline` array. Same fields as `IOEventSlot` except:

- `startTime` and `endTime` are strings (nanosecond timestamps as decimal strings) instead of `bigint`.
- `requestBody` and `responseBody` are deserialized values (`unknown`) instead of `Buffer`.

## RequestContext

Tracks the state of a single inbound HTTP request. Stored in AsyncLocalStorage.

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | `string` | Unique identifier for this request (nanoid). |
| `startTime` | `bigint` | High-resolution time when the request started. |
| `method` | `string` | HTTP method. |
| `url` | `string` | Request URL. |
| `headers` | `Record<string, string>` | Request headers (after PII filtering). |
| `body` | `Buffer` or `null` | Request body (if body capture is enabled). |
| `bodyTruncated` | `boolean` | Whether the body was truncated. |
| `ioEvents` | `IOEventSlot[]` | I/O events scoped to this request. |
| `stateReads` | `StateRead[]` | State reads that occurred during this request. |

## StateRead

Records a single read operation on a tracked container.

| Field | Type | Description |
|-------|------|-------------|
| `container` | `string` | Name of the tracked container (as passed to `trackState()`). |
| `operation` | `string` | Type of read operation (e.g., `get`, `has`, `property-access`). |
| `key` | `unknown` | The key that was read. |
| `value` | `unknown` | The value that was returned. |
| `timestamp` | `bigint` | High-resolution time of the read. Serialized as decimal string in `StateReadSerialized`. |

## EvictionRecord

Logged when an I/O event is evicted from the circular buffer.

| Field | Type | Description |
|-------|------|-------------|
| `seq` | `number` | Sequence number of the evicted event. |
| `type` | `IOEventType` | Type of the evicted event. |
| `direction` | `IODirection` | Direction of the evicted event. |
| `target` | `string` | Target of the evicted event. |
| `requestId` | `string` or `null` | Request context of the evicted event. |
| `startTime` | `bigint` | When the evicted event started. Serialized as decimal string. |
| `evictedAt` | `bigint` | When the eviction occurred. Serialized as decimal string. |

## AmbientEventContext

Included in the ErrorPackage when the error occurred outside a request context and ambient (non-request-scoped) events were used.

| Field | Type | Description |
|-------|------|-------------|
| `totalBufferEventsAtCapture` | `number` | Total events in the buffer at capture time. |
| `seqRange` | `{ min, max }` or `null` | Sequence number range of retrieved events. |
| `seqGaps` | `number` | Number of gaps in the sequence (indicating evicted events). |
| `distinctRequestIds` | `string[]` | Request IDs found in the ambient events. |
| `retrievedCount` | `number` | Number of events retrieved for the package. |

## CapturedFrame

A single stack frame with captured local variables.

| Field | Type | Description |
|-------|------|-------------|
| `functionName` | `string` | Name of the function at this frame. |
| `filePath` | `string` | Source file path. |
| `lineNumber` | `number` | Line number in the source file. |
| `columnNumber` | `number` | Column number. |
| `locals` | `Record<string, unknown>` | Local variable names and their values at this frame. |

## ProcessMetadata

Snapshot of the process state at capture time.

| Field | Type | Description |
|-------|------|-------------|
| `nodeVersion` | `string` | `process.version`. |
| `v8Version` | `string` | V8 engine version. |
| `platform` | `string` | `process.platform`. |
| `arch` | `string` | `process.arch`. |
| `pid` | `number` | Process ID. |
| `hostname` | `string` | `os.hostname()`. |
| `containerId` | `string` or absent | Container ID (parsed from `/proc/self/cgroup`). |
| `uptime` | `number` | Process uptime in seconds. |
| `memoryUsage` | `object` | Contains `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers` (all numbers, bytes). |
| `activeHandles` | `number` | Number of active handles (`process._getActiveHandles().length`). |
| `activeRequests` | `number` | Number of active requests (`process._getActiveRequests().length`). |
| `activeResourceTypes` | `Record<string, number>` or absent | Counts of active handle types. |
| `eventLoopLagMs` | `number` | Measured event loop lag in milliseconds. |

## RequestSummary

Included in `concurrentRequests` to summarize other in-flight requests at the time of the error.

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | `string` | Unique request identifier. |
| `method` | `string` | HTTP method. |
| `url` | `string` | Request URL. |
| `startTime` | `string` | ISO timestamp or high-resolution time string. |

## Completeness

Describes what the ErrorPackage contains and what was dropped or truncated.

| Field | Type | Description |
|-------|------|-------------|
| `requestCaptured` | `boolean` | Whether a request context was available. |
| `requestBodyTruncated` | `boolean` | Whether the request body was truncated. |
| `ioTimelineCaptured` | `boolean` | Whether I/O events were included. |
| `usedAmbientEvents` | `boolean` | Whether ambient (non-request-scoped) events were used. |
| `ioEventsDropped` | `number` | Number of I/O events dropped due to serialization limits. |
| `ioPayloadsTruncated` | `number` | Number of I/O event payloads (bodies) that were truncated. |
| `alsContextAvailable` | `boolean` | Whether AsyncLocalStorage context was available. |
| `localVariablesCaptured` | `boolean` | Whether local variables were captured. |
| `localVariablesTruncated` | `boolean` | Whether captured locals were truncated. |
| `stateTrackingEnabled` | `boolean` | Whether state tracking was active. |
| `stateReadsCaptured` | `boolean` | Whether state reads were included. |
| `concurrentRequestsCaptured` | `boolean` | Whether concurrent request data was included. |
| `piiScrubbed` | `boolean` | Whether PII scrubbing was applied. |
| `encrypted` | `boolean` | Whether the package was encrypted. |
| `captureFailures` | `string[]` | List of failures encountered during capture. |
| `rateLimiterDrops` | `object` or absent | If captures were rate-limited: `droppedCount`, `firstDropMs`, `lastDropMs`. |

## TimeAnchor

Correlates wall-clock time with high-resolution time so that consumers can convert `hrtime` timestamps to real dates.

| Field | Type | Description |
|-------|------|-------------|
| `wallClockMs` | `number` | `Date.now()` at anchor point. |
| `hrtimeNs` | `string` | `process.hrtime.bigint()` at the same moment, as a decimal string. |

## Dead-letter store format

The dead-letter file is an NDJSON file (one JSON object per line).

### Payload envelope

```json
{
  "version": 1,
  "kind": "payload",
  "storedAt": "2025-01-15T10:30:00.000Z",
  "payload": "<serialized ErrorPackage or encrypted payload as string>",
  "mac": "<HMAC-SHA256 hex digest>"
}
```

### Marker envelope

```json
{
  "version": 1,
  "kind": "marker",
  "storedAt": "2025-01-15T10:30:00.000Z",
  "code": "<marker-code>",
  "mac": "<HMAC-SHA256 hex digest>"
}
```

- `mac` is computed over the `payload` (for payload envelopes) or `code` (for marker envelopes) using the `encryptionKey` or transport `authorization` as the HMAC key.
- Lines with invalid MACs are skipped during drain.
- Maximum file size: 50 MB (default). Maximum individual payload: 6 MB.

## Serialization limits

All values in the ErrorPackage are cloned through a limiter before serialization:

| Limit | Default | Description |
|-------|---------|-------------|
| `maxDepth` | 8 | Maximum nesting depth for objects and arrays. |
| `maxArrayItems` | 20 | Maximum number of elements serialized per array. |
| `maxObjectKeys` | 50 | Maximum number of keys serialized per object. |
| `maxStringLength` | 2048 | Maximum character length per string value. |
| `maxPayloadSize` | 32 KB | Maximum size of a single serialized body or value. |
| `maxTotalPackageSize` | 5 MB | Maximum total size of the entire ErrorPackage JSON. |

Values exceeding these limits are truncated, and the corresponding `completeness` flags are set.

## Data write path

1. **I/O events**: Written to `IOEventBuffer` (circular buffer, in memory) as they occur. Evicted events are logged to the eviction ring.
2. **Request context**: Created by middleware, stored in `AsyncLocalStorage`, and populated with I/O events and state reads throughout the request lifecycle.
3. **Error capture**: On error, `ErrorCapturer` reads from the buffer, request context, state tracker, and request tracker to assemble `ErrorPackageParts`. `PackageBuilder` serializes these parts into the final `ErrorPackage`.
4. **Transport**: The serialized package is sent via the configured transport. On failure, written to the dead-letter store.

## Data read path

1. **I/O events**: Read from the buffer by `requestId` (request-scoped) or in bulk (ambient). Events are read-only after creation; the buffer is append-only with eviction.
2. **Dead-letter store**: Read line-by-line during drain. Each line is parsed, MAC-verified, and the payload extracted. Successfully sent lines are removed by rewriting the file without them.
3. **Config validation**: The CLI `validate` command reads and resolves the config file, printing all resolved values.
4. **Status check**: The CLI `status` command reads the dead-letter file, counts lines, and extracts timestamps.
