
export type IOEventPhase = 'active' | 'done';

export type IOEventType =
  | 'http-server'
  | 'http-client'
  | 'undici'
  | 'db-query'
  | 'dns'
  | 'tcp'
  | 'cache-read';

export type IODirection = 'inbound' | 'outbound';

export interface IOEventSlot {
  seq: number;
  hrtimeNs: bigint;
  phase: IOEventPhase;
  startTime: bigint;
  endTime: bigint | null;
  durationMs: number | null;
  type: IOEventType;
  direction: IODirection;
  requestId: string | null;
  contextLost: boolean;
  target: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  fd: number | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  // String when the body's content-type is textual (e.g. application/json,
  // text/*) and was successfully decoded to UTF-8 at materialization time.
  // Buffer when the body is binary or could not be safely decoded. null
  // when the body was never captured.
  requestBody: Buffer | string | null;
  responseBody: Buffer | string | null;
  requestBodyDigest?: string | null;
  responseBodyDigest?: string | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  requestBodyOriginalSize: number | null;
  responseBodyOriginalSize: number | null;
  error: { type: string; message: string } | null;
  aborted: boolean;
  dbMeta?: {
    query?: string;
    params?: string;
    rowCount?: number | null;
    collection?: string;
  };
  estimatedBytes: number;
}

export interface RequestContext {
  requestId: string;
  startTime: bigint;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Buffer | null;
  bodyTruncated: boolean;
  ioEvents: IOEventSlot[];
  stateReads: StateRead[];
  stateWrites: StateWrite[];
  /** Inbound tracestate header verbatim (module 21). Echoed to ErrorPackage. */
  inboundTracestate?: string;
  /** Foreign vendor entries from inbound tracestate, preserved for re-emission. */
  inheritedTracestate?: string[];
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /**
   * W3C trace-flags byte (0-255). Carries the full byte (not just the
   * sampled bit) so future flag definitions round-trip across services.
   * Inherited from a valid inbound traceparent; defaults to 0x01
   * (sampled) when this request originated the trace. See module 06.
   */
  traceFlags: number;
  /** Internal scratch — not serialized; surfaced into Completeness at package time. */
  completenessOverflow?: { stateWritesDropped: number };
  /**
   * True when this service originated the trace (no inbound
   * traceparent). Set by ALSManager.createRequestContext; surfaced as
   * trace.isEntrySpan in the package. Optional only because some test
   * fixtures construct RequestContext by hand — production code paths
   * always populate it.
   */
  isEntrySpan?: boolean;
}

export interface StateRead {
  seq: number;
  container: string;
  operation: string;
  key: unknown;
  value: unknown;
  timestamp: bigint;
}

export interface StateWrite {
  seq: number;
  hrtimeNs: bigint;
  container: string;
  operation: 'set' | 'delete';
  key: unknown;
  value: unknown;
}

export interface StateWriteSerialized {
  seq: number;
  hrtimeNs: string;
  container: string;
  operation: 'set' | 'delete';
  key: unknown;
  value: unknown;
}

export interface CapturedFrame {
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  locals: Record<string, unknown>;
}

export interface AmbientEventContext {
  totalBufferEventsAtCapture: number;
  seqRange: { min: number; max: number } | null;
  seqGaps: number;
  distinctRequestIds: string[];
  retrievedCount: number;
}

export interface EvictionRecord {
  seq: number;
  type: IOEventType;
  direction: IODirection;
  target: string;
  requestId: string | null;
  startTime: bigint;
  evictedAt: bigint;
}

export interface EvictionRecordSerialized {
  seq: number;
  type: IOEventType;
  direction: IODirection;
  target: string;
  requestId: string | null;
  startTime: string;
  evictedAt: string;
}

export interface TimeAnchor {
  wallClockMs: number;
  hrtimeNs: string;
}

export interface RateLimiterDropSummary {
  droppedCount: number;
  firstDropMs: number;
  lastDropMs: number;
}

export interface Completeness {
  requestCaptured: boolean;
  requestBodyTruncated: boolean;
  ioTimelineCaptured: boolean;
  usedAmbientEvents: boolean;
  ioEventsDropped: number;
  ioPayloadsTruncated: number;
  alsContextAvailable: boolean;
  localVariablesCaptured: boolean;
  localVariablesTruncated: boolean;
  stateTrackingEnabled: boolean;
  stateReadsCaptured: boolean;
  stateWritesDropped?: number;
  concurrentRequestsCaptured: boolean;
  piiScrubbed: boolean;
  encrypted: boolean;
  captureFailures: string[];
  rateLimiterDrops?: RateLimiterDropSummary;
  localVariablesCaptureLayer?: 'tag' | 'identity';
  localVariablesDegradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'background';
  localVariablesFrameAlignment?: 'full' | 'prefix_only';
  sourceMapResolution?: {
    framesResolved: number;
    framesUnresolved: number;
    cacheHits: number;
    cacheMisses: number;
    missing: number;
    corrupt: number;
    evictions: number;
  };
}

export interface ErrorInfo {
  type: string;
  message: string;
  stack: string;
  rawStack?: string;
  cause?: ErrorInfo;
  properties: Record<string, unknown>;
}

export interface ErrorPackageRequestContextData {
  requestId: string;
  startTime: bigint;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Buffer | null;
  bodyTruncated: boolean;
}

export interface IOEventSerialized {
  seq: number;
  hrtimeNs: string;
  type: IOEventSlot['type'];
  direction: IOEventSlot['direction'];
  target: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  fd: number | null;
  requestId: string | null;
  contextLost: boolean;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: unknown | null;
  responseBody: unknown | null;
  requestBodyDigest?: string | null;
  responseBodyDigest?: string | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  requestBodyOriginalSize: number | null;
  responseBodyOriginalSize: number | null;
  error: { type: string; message: string } | null;
  aborted: boolean;
  dbMeta?: {
    query?: string;
    params?: string;
    rowCount?: number | null;
    collection?: string;
  };
}

export interface StateReadSerialized {
  seq: number;
  container: string;
  operation: string;
  key: unknown;
  value: unknown;
  timestamp: string;
}

export interface RequestSummary {
  requestId: string;
  method: string;
  url: string;
  startTime: string;
}

export interface ProcessMetadata {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  arch: string;
  pid: number;
  /** Parent process id; useful for correlating sidecar/host relationships. */
  ppid?: number;
  hostname: string;
  containerId?: string;
  /** Spec §5: app-level deployment-env (staging|prod|...). */
  deploymentEnv?: string;
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  activeHandles: number;
  activeRequests: number;
  activeResourceTypes?: Record<string, number>;
  eventLoopLagMs: number;
  /**
   * One-time anchor captured at SDK init. Lets a receiver align any
   * event's hrtimeNs to UTC across services using:
   *   eventUtcMs = startAnchor.wallClockMs +
   *                (eventHrtimeNs - startAnchor.hrtimeNs) / 1_000_000
   * Stable for the lifetime of the process, so reconstruction agents can
   * trust it as the canonical wall-clock origin even when individual
   * capture's per-package timeAnchor drifts (it doesn't, today, but the
   * field exists so it can survive future restructuring).
   */
  processStartAnchor: TimeAnchor;
}

export interface ErrorPackage {
  schemaVersion: '1.1.0';
  /** Stable, per-event identifier minted at capture time (UUIDv4 today). */
  eventId: string;
  /**
   * Application/service name that produced this capture. Resolved from
   * config.service, falling back to OTEL_SERVICE_NAME, then
   * npm_package_name, then "unknown-service". Lets a backend attribute a
   * capture without inferring from the transport's filename or hostname.
   */
  service: string;
  capturedAt: string;
  errorEventSeq: number;
  errorEventHrtimeNs: string;
  eventClockRange: { min: number; max: number };
  fingerprint?: string;
  timeAnchor: TimeAnchor;
  error: {
    type: string;
    message: string;
    stack: string;
    rawStack?: string;
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
  evictionLog: EvictionRecordSerialized[];
  ambientContext?: AmbientEventContext;
  stateReads: StateReadSerialized[];
  stateWrites: StateWriteSerialized[];
  concurrentRequests: RequestSummary[];
  processMetadata: ProcessMetadata;
  codeVersion: { gitSha?: string; packageVersion?: string; functionVersion?: string; functionArn?: string };
  environment: Record<string, string>;
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    tracestate?: string;
    /** W3C trace-flags byte observed at capture (0-255). Optional for back-compat. */
    traceFlags?: number;
    /**
     * True when this service originated the trace (no inbound
     * traceparent header was present). Lets the reconstruction agent
     * distinguish gateway entry-spans from spans whose parent belongs
     * to a peer it hasn't seen yet (the latter signals a missing
     * upstream capture).
     */
    isEntrySpan?: boolean;
  };
  /**
   * Set when enforceHardCap had to shed fields to fit the 1 MB envelope cap.
   * Lists the dropped fields in order so reconstruction agents can flag the
   * loss explicitly. Absent on captures that fit cleanly.
   */
  truncated?: {
    reason: string;
    droppedFields: string[];
  };
  completeness: Completeness;
}

/**
 * Wire-format envelope for a captured ErrorPackage. The plaintext package
 * is JSON, optionally compressed with zlib deflate, then encrypted with
 * AES-256-GCM. AAD binds eventId, sdk.version, and keyId so a leaked
 * ciphertext cannot be replayed against a different key without authTag
 * failure. An outer HMAC-SHA256 over iv|ciphertext|authTag|AAD detects
 * tampering before any GCM verification touches the ciphertext.
 *
 * `iv` / `authTag` / `hmac` carry the literal string `"unencrypted"` when
 * the SDK is running in transparent-envelope mode (allowUnencrypted: true,
 * no DEK). Receivers MUST reject those before passing the body to a
 * decryption pipeline.
 */
export interface EncryptedEnvelope {
  v: 1;
  eventId: string;
  sdk: { name: 'errorcore'; version: string };
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  hmac: string;
  /** True when the inner plaintext was zlib-deflated before encryption. */
  compressed: boolean;
  producedAt: number;
}

export interface ErrorPackageParts {
  errorEventSeq: number;
  errorEventHrtimeNs: bigint;
  error: {
    type: string;
    message: string;
    stack: string;
    rawStack?: string;
    cause?: ErrorInfo;
    properties: Record<string, unknown>;
  };
  localVariables: CapturedFrame[] | null;
  requestContext?: ErrorPackageRequestContextData;
  ioTimeline: IOEventSlot[];
  evictionLog: EvictionRecord[];
  ambientContext?: AmbientEventContext;
  stateReads: StateRead[];
  stateWrites: StateWrite[];
  /** Internal: passed through from RequestContext.completenessOverflow. */
  completenessOverflow?: { stateWritesDropped: number };
  concurrentRequests: RequestSummary[];
  processMetadata: ProcessMetadata;
  timeAnchor: TimeAnchor;
  codeVersion: { gitSha?: string; packageVersion?: string; functionVersion?: string; functionArn?: string };
  environment: Record<string, string>;
  ioEventsDropped: number;
  captureFailures: string[];
  alsContextAvailable: boolean;
  stateTrackingEnabled: boolean;
  usedAmbientEvents: boolean;
  rateLimiterDrops?: RateLimiterDropSummary;
  traceContext?: {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    tracestate?: string;
    traceFlags?: number;
    isEntrySpan?: boolean;
  };
  sourceMapResolution?: {
    framesResolved: number;
    framesUnresolved: number;
    cacheHits: number;
    cacheMisses: number;
    missing: number;
    corrupt: number;
    evictions: number;
  };
  /** Layer 1/2 telemetry threaded from InspectorManager.getLocalsWithDiagnostics */
  localVariablesCaptureLayer?: 'tag' | 'identity';
  localVariablesDegradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'background';
  /** Layer 3 alignment flag — set by PackageBuilder.build() */
  localVariablesFrameAlignment?: 'full' | 'prefix_only';
  fingerprint?: string;
}

export interface PackageAssemblyResult {
  packageObject: ErrorPackage;
  /** JSON-stringified envelope ready for the wire. */
  payload: string;
  /** The structured envelope (preferred input to typed transports). */
  envelope?: EncryptedEnvelope;
}

export interface TraceHeaders {
  traceparent: string;
  tracestate?: string;
}

export interface TraceContextInput {
  traceparent?: string;
  tracestate?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface TransportPayload {
  /** Exact bytes/string accepted by the transport for persistence or wire send. */
  serialized: string | Buffer;
  /** Parsed envelope metadata when the payload is an Errorcore envelope. */
  envelope?: Pick<EncryptedEnvelope, 'v' | 'eventId' | 'sdk' | 'keyId'>;
}

export interface SerializationLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxPayloadSize: number;
  maxTotalPackageSize: number;
}

export type TransportConfig =
  | { type: 'stdout' }
  | { type: 'file'; path: string; maxSizeBytes?: number; maxBackups?: number }
  | {
      type: 'http';
      url: string;
      authorization?: string;
      timeoutMs?: number;
      protocol?: 'auto' | 'http1' | 'http2';
      maxBackups?: number;
    };

export type PublicTransportConfig =
  | { type: 'stdout' }
  | { type: 'file'; path: string; maxSizeBytes?: number; maxBackups?: number }
  | {
      type: 'http';
      url: string;
      timeoutMs?: number;
      protocol?: 'auto' | 'http1' | 'http2';
      maxBackups?: number;
    };

/**
 * Codes the SDK emits via `onInternalWarning` for individual backpressure
 * or drop events. See docs/BACKPRESSURE.md for the full matrix — what each
 * code means, what the SDK did, and whether data was lost.
 *
 * The legacy snake_case names are retained as a deprecated type-level
 * union for back-compat with consumers that pin them as string-literal
 * types; runtime emissions now use the EC_* names.
 */
export type InternalWarningCode =
  | 'EC_RATE_LIMITED'
  | 'EC_CAPTURE_FAILED'
  | 'EC_DLQ_WRITE_FAILED'
  | 'EC_DLQ_FULL'
  | 'EC_DLQ_DISABLED'
  | 'EC_DLQ_UNSIGNED'
  | 'EC_TRANSPORT_FAILED'
  | 'EC_TRANSPORT_TIMEOUT'
  | 'EC_TRANSPORT_4XX'
  | 'EC_DISK_FULL'
  | 'EC_ENCRYPTION_KEY_INVALID'
  | 'EC_ENCRYPTION_KEY_MISSING'
  | 'EC_DECRYPT_HMAC_MISMATCH'
  | 'EC_DECRYPT_AUTH_TAG_MISMATCH'
  | 'EC_MAC_KEY_TOO_SHORT'
  | 'EC_PRODUCTION_PLAINTEXT_BYPASS'
  | 'EC_PACKAGE_OVER_HARD_CAP'
  | 'EC_SANITIZE_SKIP'
  | 'EC_PAYLOADS_DROPPED'
  | 'EC_PAYLOADS_DEAD_LETTERED'
  // --- Deprecated snake_case literals (retained for type-level back-compat) ---
  | 'rate_limited'
  | 'capture_failed'
  | 'dead_letter_write_failed'
  | 'dead_letter_full'
  | 'transport_failed'
  | 'transport_timeout'
  | 'disk_full'
  | 'encryption_key_invalid';

/**
 * Codes the SDK emits via `onInternalWarning` as periodic aggregates
 * summarising counts over a flush interval, rather than per-event.
 */
export type AggregateWarningCode =
  | 'EC_PAYLOADS_DROPPED'
  | 'EC_PAYLOADS_DEAD_LETTERED'
  // --- Deprecated snake_case literals (retained for type-level back-compat) ---
  | 'errorcore_payloads_dropped'
  | 'errorcore_payloads_dead_lettered';

export interface InternalWarning {
  code: InternalWarningCode | AggregateWarningCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

/** Console verbosity gate for internal SDK messages. Does not affect onInternalWarning. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Structured representation of an underlying error that triggered an
 * InternalWarning. Always emitted as `cause` when an Error caused the
 * warning. When the trigger is not an Error (e.g. a string, a falsy
 * value), `cause` falls back to the original raw value for back-compat.
 */
export interface SerializedCause {
  name: string;
  message: string;
  stackHead?: string;
}

/**
 * Result of verifying an HMAC or decrypting a payload against a key
 * chain (primary + previous keys). `keyIndex` is 0 for the primary
 * key and 1+ for previous keys (in declaration order).
 */
export type EncryptionVerifyResult =
  | { ok: true; keyIndex: number }
  | { ok: false };

/**
 * Optional async callback for resolving the data-encryption key from a
 * KMS or other secret store. Called once at SDK init. Must return either
 * a 64-character hex string or a 32-byte Buffer.
 */
export type EncryptionKeyCallback = () => string | Buffer;

export interface SDKConfig {
  bufferSize?: number;
  bufferMaxBytes?: number;
  maxPayloadSize?: number;
  maxConcurrentRequests?: number;
  rateLimitPerMinute?: number;
  rateLimitWindowMs?: number;
  headerAllowlist?: string[];
  headerBlocklist?: RegExp[];
  envAllowlist?: string[];
  envBlocklist?: RegExp[];
  encryptionKey?: string;
  /**
   * Optional separate MAC key (64-char hex). When unset, the SDK derives
   * a MAC sub-key from the DEK via PBKDF2 with a distinct salt — back-
   * compatible with the single-secret config. Setting both lets operators
   * rotate the encryption and authentication keys independently.
   */
  macKey?: string;
  /**
   * Synchronous resolver for the DEK. Called once during SDK creation before activation.
   */
  encryptionKeyCallback?: EncryptionKeyCallback;
  previousEncryptionKeys?: string[];
  allowUnencrypted?: boolean;
  /**
   * Triple-flag friction: required (along with allowUnencrypted: true and
   * NODE_ENV=production) before the SDK will start an HTTP transport in
   * production without a DEK. Without it, the SDK refuses init.
   */
  allowProductionPlaintext?: boolean;
  /**
   * Hard cap on the encrypted+base64 envelope size in bytes. Defaults to
   * 1 MB. If a package's serialized form exceeds this after scrub, the
   * SDK drops fields in order (localVariables first, then truncates
   * ioTimeline to last 50 entries, then drops further sections).
   */
  hardCapBytes?: number;
  transport: TransportConfig;
  captureLocalVariables?: boolean;
  captureDbBindParams?: boolean;
  captureRequestBodies?: boolean;
  captureResponseBodies?: boolean;
  captureBody?: boolean;
  captureBodyDigest?: boolean;
  bodyCaptureContentTypes?: string[];
  piiScrubber?: (key: string, value: unknown) => unknown;
  replaceDefaultScrubber?: boolean;
  serialization?: Partial<SerializationLimits>;
  maxLocalsCollectionsPerSecond?: number;
  maxCachedLocals?: number;
  maxLocalsFrames?: number;
  uncaughtExceptionExitDelayMs?: number;
  allowPlainHttpTransport?: boolean;
  allowInvalidCollectorCertificates?: boolean;
  deadLetterPath?: string;
  maxDrainOnStartup?: number;
  useWorkerAssembly?: boolean;
  flushIntervalMs?: number;
  resolveSourceMaps?: boolean;
  serverless?: boolean | 'auto';
  onInternalWarning?: (warning: InternalWarning) => void;
  drivers?: {
    pg?: unknown;
    mongodb?: unknown;
    mysql2?: unknown;
    ioredis?: unknown;
  };
  silent?: boolean;
  logLevel?: LogLevel;
  sourceMapSyncThresholdBytes?: number;
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';
  traceContext?: {
    vendorKey?: string;
  };
  stateTracking?: {
    captureWrites?: boolean;
    maxWritesPerContext?: number;
  };
  /**
   * Application/service name attributed to every captured ErrorPackage.
   * If unset: resolved from process.env.OTEL_SERVICE_NAME, then
   * process.env.npm_package_name, then the literal "unknown-service".
   */
  service?: string;
  /**
   * Deployment environment label (staging|production|preview|...).
   * Falls back to process.env.ERRORCORE_ENVIRONMENT if unset. Distinct
   * from NODE_ENV — operators commonly run NODE_ENV=production in
   * non-production fleets, which makes that variable a poor source of
   * truth for the receiver.
   */
  deploymentEnv?: string;
}

export interface ResolvedConfig {
  bufferSize: number;
  bufferMaxBytes: number;
  maxPayloadSize: number;
  maxConcurrentRequests: number;
  rateLimitPerMinute: number;
  rateLimitWindowMs: number;
  headerAllowlist: string[];
  headerBlocklist: RegExp[];
  envAllowlist: string[];
  envBlocklist: RegExp[];
  encryptionKey: string | undefined;
  macKey: string | undefined;
  encryptionKeyCallback: EncryptionKeyCallback | undefined;
  previousEncryptionKeys: string[];
  allowUnencrypted: boolean;
  allowProductionPlaintext: boolean;
  hardCapBytes: number;
  transport: PublicTransportConfig;
  captureLocalVariables: boolean;
  captureDbBindParams: boolean;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureBody: boolean;
  captureBodyDigest: boolean;
  bodyCaptureContentTypes: string[];
  piiScrubber: ((key: string, value: unknown) => unknown) | undefined;
  replaceDefaultScrubber: boolean;
  serialization: SerializationLimits;
  maxLocalsCollectionsPerSecond: number;
  maxCachedLocals: number;
  maxLocalsFrames: number;
  uncaughtExceptionExitDelayMs: number;
  allowPlainHttpTransport: boolean;
  allowInvalidCollectorCertificates: boolean;
  deadLetterPath: string | undefined;
  maxDrainOnStartup: number;
  useWorkerAssembly: boolean;
  flushIntervalMs: number;
  resolveSourceMaps: boolean;
  serverless: boolean;
  onInternalWarning: ((warning: InternalWarning) => void) | undefined;
  drivers: {
    pg?: unknown;
    mongodb?: unknown;
    mysql2?: unknown;
    ioredis?: unknown;
  };
  silent: boolean;
  logLevel: LogLevel;
  sourceMapSyncThresholdBytes: number;
  captureMiddlewareStatusCodes: number[] | 'none' | 'all';
  traceContext: {
    vendorKey: string;
  };
  stateTracking: {
    captureWrites: boolean;
    maxWritesPerContext: number;
  };
  /** Resolved service name. Always set after resolveConfig. */
  service: string;
  /** Spec §5 deployment environment label, resolved from config or env. */
  deploymentEnv: string | undefined;
}

export interface PackageAssemblyWorkerConfig extends Omit<ResolvedConfig, 'piiScrubber'> {
  piiScrubber: undefined;
}

export interface PackageAssemblyEncryptionConfig {
  encryptionKey: string;
  macKey?: string;
  previousEncryptionKeys: string[];
  sdkVersion: string;
  derivedKeyHex?: string;
}

export interface PackageAssemblyWorkerData {
  config: PackageAssemblyWorkerConfig;
  encryption?: PackageAssemblyEncryptionConfig;
}

export type PackageAssemblyWorkerRequest =
  | {
      id: number;
      type: 'assemble';
      parts: ErrorPackageParts;
    }
  | {
      id: number;
      type: 'shutdown';
    };

export type PackageAssemblyWorkerResponse =
  | {
      id: number;
      result?: PackageAssemblyResult;
      error?: undefined;
    }
  | {
      id: number;
      error: string;
      result?: undefined;
    };
