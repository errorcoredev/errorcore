# Module 01: Types and Configuration

> **Spec status:** LOCKED
> **Source files:** `src/types.ts`, `src/config.ts`
> **Dependencies:** None
> **Build order position:** 1

---

## Module Contract Header

Every source file in this module must begin with:

```typescript
/**
 * @module 01-types-and-config
 * @spec spec/01-types-and-config.md
 * @dependencies none
 */
```

---

## Purpose

Define all shared TypeScript interfaces and the configuration schema with defaults and validation. These types are the vocabulary of the entire SDK — every other module imports from here and nothing else at this layer.

---

## Scope

- Define all shared interfaces (`IOEventSlot`, `RequestContext`, `StateRead`, `StateWrite`, `CapturedFrame`, `ErrorPackage`, `Completeness`, `SerializationLimits`, `SDKConfig`, `ResolvedConfig`)
- Define a `resolveConfig(userConfig: Partial<SDKConfig>): ResolvedConfig` function that merges user input with defaults and validates constraints
- Export the `ErrorPackage` schema at version `1.1.0`

---

## Non-Goals

- No runtime behavior. No classes. No state. Pure type definitions and one config-merging function.
- Does not implement serialization, scrubbing, or any business logic.

---

## Dependencies

None. This is the foundation module.

---

## Node.js APIs Used

None. Pure TypeScript type definitions and plain object manipulation.

---

## Data Structures

### IOEventSlot

```typescript
interface IOEventSlot {
  seq: number;                             // from EventClock.tick() (module 19)
  hrtimeNs: bigint;                        // process.hrtime.bigint() at push() (module 20)
  phase: 'active' | 'done';
  startTime: bigint;                       // when the IO operation started (may differ from hrtimeNs)
  endTime: bigint | null;
  durationMs: number | null;
  type: 'http-server' | 'http-client' | 'undici' | 'db-query' | 'dns' | 'tcp' | 'cache-read';
  direction: 'inbound' | 'outbound';
  requestId: string | null;
  contextLost: boolean;
  target: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  fd: number | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: Buffer | null;
  responseBody: Buffer | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  requestBodyOriginalSize: number | null;
  responseBodyOriginalSize: number | null;
  error: { type: string; message: string } | null;
  aborted: boolean;
  estimatedBytes: number;
}
```

### RequestContext

```typescript
interface RequestContext {
  requestId: string;
  startTime: bigint;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  bodyTruncated: boolean;
  ioEvents: IOEventSlot[];
  stateReads: StateRead[];
  stateWrites: StateWrite[];               // module 22
  inheritedTracestate?: string[];          // module 21
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: number;                       // module 06 — W3C trace-flags byte (0-255)
  /** Internal scratch — not serialized; surfaced into Completeness at package time. */
  completenessOverflow?: { stateWritesDropped: number };
}
```

### StateRead

```typescript
interface StateRead {
  seq: number;                             // from EventClock.tick() (module 20)
  container: string;
  operation: string;
  key: unknown;
  value: unknown;    // eagerly serialized POJO — no external references
  timestamp: bigint;
}
```

### StateWrite (module 22)

```typescript
interface StateWrite {
  seq: number;                             // from EventClock.tick()
  hrtimeNs: bigint;                        // process.hrtime.bigint()
  container: string;
  operation: 'set' | 'delete';
  key: unknown;                            // cloneAndLimit(TIGHT_LIMITS)
  value: unknown;                          // cloneAndLimit(TIGHT_LIMITS); undefined for 'delete'
}

interface StateWriteSerialized {
  seq: number;
  hrtimeNs: string;                        // bigint → string
  container: string;
  operation: 'set' | 'delete';
  key: unknown;
  value: unknown;
}
```

### CapturedFrame

```typescript
interface CapturedFrame {
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  locals: Record<string, unknown>;
}
```

### Completeness

```typescript
interface Completeness {
  requestCaptured: boolean;
  requestBodyTruncated: boolean;
  ioTimelineCaptured: boolean;
  ioEventsDropped: number;
  ioPayloadsTruncated: number;
  alsContextAvailable: boolean;
  localVariablesCaptured: boolean;
  localVariablesTruncated: boolean;
  stateTrackingEnabled: boolean;
  stateReadsCaptured: boolean;
  stateWritesDropped?: number;             // module 22 — overflow surfaced here
  concurrentRequestsCaptured: boolean;
  piiScrubbed: boolean;
  encrypted: boolean;
  captureFailures: string[];
}
```

### TimeAnchor

```typescript
interface TimeAnchor {
  wallClockMs: number;                     // Date.now() at SDK startup (one-shot)
  hrtimeNs: string;                        // process.hrtime.bigint().toString() at SDK startup
}
```

### ErrorPackage

```typescript
interface ErrorPackage {
  schemaVersion: '1.1.0';
  capturedAt: string;                      // ISO 8601, per-package (not per-event)
  errorEventSeq: number;                   // module 20 — EventClock.tick() at capture entry
  errorEventHrtimeNs: string;              // module 20 — bigint serialized
  eventClockRange: { min: number; max: number };  // module 20 — over all stamped events
  timeAnchor: TimeAnchor;                  // for consumer-side wall-clock derivation
  error: {
    type: string;
    message: string;
    stack: string;
    cause?: ErrorInfo;
    properties: Record<string, unknown>;
  };
  localVariables?: CapturedFrame[];
  request?: {
    id: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | object;
    bodyTruncated?: boolean;
    receivedAt: string;
  };
  ioTimeline: IOEventSerialized[];
  stateReads: StateReadSerialized[];
  stateWrites: StateWriteSerialized[];     // module 22 — peer to stateReads
  concurrentRequests: RequestSummary[];
  processMetadata: ProcessMetadata;
  codeVersion: { gitSha?: string; packageVersion?: string };
  environment: Record<string, string>;
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    tracestate?: string;                   // module 21 — inbound header verbatim at capture time
  };
  completeness: Completeness;
}
```

### SerializationLimits

```typescript
interface SerializationLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxPayloadSize: number;
  maxTotalPackageSize: number;
}
```

### SDKConfig (user-facing) and ResolvedConfig (internal, all fields required)

```typescript
interface SDKConfig {
  bufferSize?: number;
  bufferMaxBytes?: number;
  maxPayloadSize?: number;
  maxConcurrentRequests?: number;
  rateLimitPerMinute?: number;
  headerAllowlist?: string[];
  headerBlocklist?: RegExp[];
  envAllowlist?: string[];
  envBlocklist?: RegExp[];
  encryptionKey?: string;
  transport?: TransportConfig;
  captureLocalVariables?: boolean;
  captureDbBindParams?: boolean;
  captureBody?: boolean;
  piiScrubber?: (key: string, value: unknown) => unknown;
  replaceDefaultScrubber?: boolean;
  serialization?: Partial<SerializationLimits>;
  maxLocalsCollectionsPerSecond?: number;
  maxCachedLocals?: number;
  maxLocalsFrames?: number;
  allowInsecureTransport?: boolean;
  traceContext?: {
    vendorKey?: string;                    // module 21 — default 'ec'
  };
  stateTracking?: {
    captureWrites?: boolean;               // module 22 — default true
    maxWritesPerContext?: number;          // module 22 — default 50
  };
}
```

---

## Implementation Notes

### Default values for ResolvedConfig

| Field | Default |
|-------|---------|
| `bufferSize` | 200 |
| `bufferMaxBytes` | 52428800 (50 MB) |
| `maxPayloadSize` | 32768 (32 KB) |
| `maxConcurrentRequests` | 50 |
| `rateLimitPerMinute` | 10 |
| `headerAllowlist` | `['content-type', 'content-length', 'accept', 'user-agent', 'x-request-id', 'x-correlation-id', 'host']` |
| `headerBlocklist` | `/authorization\|cookie\|set-cookie\|x-api-key\|x-auth-token/i`, `/auth\|token\|key\|secret\|password\|credential/i` |
| `envAllowlist` | `['NODE_ENV', 'NODE_VERSION', 'PORT', 'HOST', 'TZ', 'LANG', 'npm_package_version']` |
| `envBlocklist` | `/key\|secret\|token\|password\|credential\|auth\|private/i` |
| `encryptionKey` | `undefined` |
| `transport` | `{ type: 'stdout' }` |
| `captureLocalVariables` | `false` |
| `captureDbBindParams` | `false` |
| `captureBody` | `false` |
| `serialization.maxDepth` | 8 |
| `serialization.maxArrayItems` | 20 |
| `serialization.maxObjectKeys` | 50 |
| `serialization.maxStringLength` | 2048 |
| `serialization.maxPayloadSize` | 32768 |
| `serialization.maxTotalPackageSize` | 5242880 (5 MB) |
| `maxLocalsCollectionsPerSecond` | 20 |
| `maxCachedLocals` | 50 |
| `maxLocalsFrames` | 5 |
| `traceContext.vendorKey` | `'ec'` (must match `[a-z0-9_\-*\/]{1,256}`) |
| `stateTracking.captureWrites` | `true` |
| `stateTracking.maxWritesPerContext` | 50 |

### resolveConfig behavior

- Shallow-merge user config over defaults.
- Validate numeric fields are positive integers where applicable.
- Validate `bufferSize` >= 10 and <= 100000.
- Validate `bufferMaxBytes` >= 1048576 (1 MB).
- Validate `maxPayloadSize` >= 1024 and <= `bufferMaxBytes`.
- Validate `traceContext.vendorKey` matches `/^[a-z0-9_\-*\/]{1,256}$/` (W3C tracestate vendor-key grammar).
- Validate `stateTracking.maxWritesPerContext` is a non-negative integer.
- If validation fails, throw a descriptive `Error` at init time — not a silent fallback.

---

## Security Considerations

- Header and env blocklists are security-critical. Defaults MUST always block `authorization`, `cookie`, `set-cookie`, and any key matching sensitive patterns.
- The config object itself may contain the `encryptionKey`. It must never be serialized into error packages.

---

## Edge Cases

- User passes an empty config object `{}` — all defaults apply.
- User passes unknown keys — silently ignore (do not throw).
- User passes `bufferSize: 0` — reject with validation error.
- User passes `headerAllowlist` containing a blocked header — the blocklist wins (blocklist is checked after allowlist).

---

## Testing Requirements

- `resolveConfig({})` returns all defaults.
- `resolveConfig({ bufferSize: 500 })` merges correctly.
- Validation rejects invalid values with descriptive error messages.
- Header blocklist always overrides allowlist.
- All interfaces export successfully (compilation test).

---

## Completion Criteria

- `src/types.ts` exports all interfaces listed above.
- `src/config.ts` exports `resolveConfig()` with full validation.
- All unit tests pass.
- No module-level mutable state.
- No runtime dependencies.
