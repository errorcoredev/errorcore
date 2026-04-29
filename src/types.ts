
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
  requestBody: Buffer | null;
  responseBody: Buffer | null;
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
  body: Buffer | null;
  bodyTruncated: boolean;
  ioEvents: IOEventSlot[];
  stateReads: StateRead[];
  stateWrites: StateWrite[];
  inheritedTracestate?: string[];
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** Internal scratch — not serialized; surfaced into Completeness at package time. */
  completenessOverflow?: { stateWritesDropped: number };
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
  body: Buffer | null;
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
  hostname: string;
  containerId?: string;
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
}

export interface ErrorPackage {
  schemaVersion: '1.1.0';
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
  };
  integrity?: {
    algorithm: 'HMAC-SHA256';
    signature: string;
  };
  completeness: Completeness;
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
  payload: string;
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
      maxBackups?: number;
    };

export type PublicTransportConfig =
  | { type: 'stdout' }
  | { type: 'file'; path: string; maxSizeBytes?: number; maxBackups?: number }
  | {
      type: 'http';
      url: string;
      timeoutMs?: number;
      maxBackups?: number;
    };

/**
 * Codes the SDK emits via `onInternalWarning` for individual backpressure
 * or drop events. See docs/BACKPRESSURE.md for the full matrix — what each
 * code means, what the SDK did, and whether data was lost.
 */
export type InternalWarningCode =
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
  | 'errorcore_payloads_dropped'
  | 'errorcore_payloads_dead_lettered';

export interface InternalWarning {
  code: InternalWarningCode | AggregateWarningCode;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

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
  allowUnencrypted?: boolean;
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
  sourceMapSyncThresholdBytes?: number;
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';
  traceContext?: {
    vendorKey?: string;
  };
  stateTracking?: {
    captureWrites?: boolean;
    maxWritesPerContext?: number;
  };
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
  allowUnencrypted: boolean;
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
  sourceMapSyncThresholdBytes: number;
  captureMiddlewareStatusCodes: number[] | 'none' | 'all';
  traceContext: {
    vendorKey: string;
  };
  stateTracking: {
    captureWrites: boolean;
    maxWritesPerContext: number;
  };
}

export interface PackageAssemblyWorkerConfig extends Omit<ResolvedConfig, 'piiScrubber'> {
  piiScrubber: undefined;
}

export interface PackageAssemblyWorkerData {
  config: PackageAssemblyWorkerConfig;
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
