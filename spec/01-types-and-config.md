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

- Define all shared interfaces (`IOEventSlot`, `RequestContext`, `StateRead`, `CapturedFrame`, `ErrorPackage`, `Completeness`, `SerializationLimits`, `SDKConfig`, `ResolvedConfig`)
- Define a `resolveConfig(userConfig: Partial<SDKConfig>): ResolvedConfig` function that merges user input with defaults and validates constraints
- Export the `ErrorPackage` schema at version `1.0.0`

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
  seq: number;
  phase: 'active' | 'done';
  startTime: bigint;
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
}
```

### StateRead

```typescript
interface StateRead {
  container: string;
  operation: string;
  key: unknown;
  value: unknown;    // eagerly serialized POJO — no external references
  timestamp: bigint;
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
  concurrentRequestsCaptured: boolean;
  piiScrubbed: boolean;
  encrypted: boolean;
  captureFailures: string[];
}
```

### ErrorPackage

```typescript
interface ErrorPackage {
  schemaVersion: '1.0.0';
  capturedAt: string;
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
  concurrentRequests: RequestSummary[];
  processMetadata: ProcessMetadata;
  codeVersion: { gitSha?: string; packageVersion?: string };
  environment: Record<string, string>;
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

### resolveConfig behavior

- Shallow-merge user config over defaults.
- Validate numeric fields are positive integers where applicable.
- Validate `bufferSize` >= 10 and <= 100000.
- Validate `bufferMaxBytes` >= 1048576 (1 MB).
- Validate `maxPayloadSize` >= 1024 and <= `bufferMaxBytes`.
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
