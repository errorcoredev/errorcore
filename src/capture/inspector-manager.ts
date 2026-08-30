
import path = require('node:path');
import { createHash } from 'node:crypto';

import type {
  CapturedArgument,
  CapturedFrame,
  CapturedScope,
  CapturedValue,
  ModeState,
  ResolvedConfig
} from '../types';
import { EventClock } from '../context/event-clock';
import { looksLikeHighEntropySecret } from '../pii/scrubber';
import { safeConsole } from '../debug-log';
import { buildNonErrorThrownInfo } from './normalize-thrown';

export const ERRORCORE_CAPTURE_ID_SYMBOL = Symbol.for('errorcore.v1.captureId');
export const LOCALS_CACHE_TTL_MS = 30_000;

export interface LocalsRingBufferEntry {
  id: string;
  seq: number;
  hrtimeNs: bigint;
  requestId: string | null;
  errorName: string;
  errorMessage: string;
  frameCount: number;
  structuralHash: string;
  frames: CapturedFrame[];
  createdAt: number;
}

export class LocalsRingBuffer {
  private capacity: number;
  private readonly ttlMs: number;
  private readonly entries: LocalsRingBufferEntry[] = [];
  private nextId = 0;

  public constructor(capacity: number, ttlMs = LOCALS_CACHE_TTL_MS) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  public allocateId(): string {
    return String(++this.nextId);
  }

  public push(entry: LocalsRingBufferEntry): void {
    this.pruneExpired(entry.createdAt);
    this.entries.push(entry);
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  public resize(capacity: number): void {
    this.capacity = capacity;
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  public pruneExpired(now = Date.now()): number {
    const before = this.entries.length;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const ageMs = now - this.entries[index].createdAt;
      if (ageMs < 0 || ageMs > this.ttlMs) {
        this.entries.splice(index, 1);
      }
    }
    return before - this.entries.length;
  }

  public consumeFrames(frames: CapturedFrame[]): boolean {
    const index = this.entries.findIndex((entry) => entry.frames === frames);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  public get size(): number {
    return this.entries.length;
  }

  public getById(id: string): LocalsRingBufferEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].id === id) return this.entries[i];
    }
    return undefined;
  }

  public findByIdentity(key: {
    requestId: string | null;
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): LocalsRingBufferEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount &&
        e.structuralHash === key.structuralHash
      ) {
        return e;
      }
    }
    return undefined;
  }

  /**
   * When findByIdentity misses, this returns a one-word reason
   * describing the closest disagreement in the ring buffer. Used to
   * surface granular cache_miss reasons in completeness instead of
   * the bare "cache_miss" bucket.
   */
  public diagnoseIdentityMiss(key: {
    requestId: string | null;
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): 'cache_empty' | 'requestId_mismatch' | 'name_mismatch' | 'message_mismatch' | 'frame_count_mismatch' | 'hash_mismatch' {
    if (this.entries.length === 0) return 'cache_empty';

    // Walk newest-to-oldest. Score each entry by how many key components
    // match; the closest match wins and reports its first disagreement.
    let best: { entry: LocalsRingBufferEntry; score: number } | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      let score = 0;
      if (e.requestId === key.requestId) score += 16;
      if (e.errorName === key.errorName) score += 8;
      if (e.errorMessage === key.errorMessage) score += 4;
      if (e.frameCount === key.frameCount) score += 2;
      if (e.structuralHash === key.structuralHash) score += 1;
      if (best === null || score > best.score) {
        best = { entry: e, score };
        if (score === 31) break;
      }
    }

    if (best === null) return 'cache_empty';
    const e = best.entry;
    if (e.requestId !== key.requestId) return 'requestId_mismatch';
    if (e.errorName !== key.errorName) return 'name_mismatch';
    if (e.errorMessage !== key.errorMessage) return 'message_mismatch';
    if (e.frameCount !== key.frameCount) return 'frame_count_mismatch';
    return 'hash_mismatch';
  }

  public findByDegradedKey(key: {
    requestId: string | null;
    errorName: string;
    errorMessage: string;
    frameCount: number;
  }): LocalsRingBufferEntry[] {
    const out: LocalsRingBufferEntry[] = [];
    for (const e of this.entries) {
      if (
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount
      ) out.push(e);
    }
    return out;
  }

  public findByLooseKey(key: {
    requestId: string | null;
    errorName: string;
    errorMessage: string;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage
    );
  }

  public findBackgroundMatches(key: {
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.requestId === null &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount &&
        e.structuralHash === key.structuralHash
    );
  }

  public findByContentKey(key: {
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount &&
        e.structuralHash === key.structuralHash
    );
  }

  public findByContentDegradedKey(key: {
    errorName: string;
    errorMessage: string;
    frameCount: number;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount
    );
  }

  public findByContentLooseKey(key: {
    errorName: string;
    errorMessage: string;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage
    );
  }

  public findRecentEntries(now: number, maxAgeMs: number): LocalsRingBufferEntry[] {
    return this.entries.filter((entry) => {
      const ageMs = now - entry.createdAt;
      return ageMs >= 0 && ageMs <= maxAgeMs;
    });
  }
}

export function computeStructuralHash(
  frames: ReadonlyArray<{ functionName: string }>
): string {
  const joined = frames.map((f) => f.functionName || '<anonymous>').join('\u241F');
  return createHash('sha1').update(joined).digest('hex');
}

export function countCallFrames(
  frames: ReadonlyArray<{ functionName: string }>
): number {
  return frames.length;
}

const SENSITIVE_VAR_RE =
  /password|passwd|secret|token|key|auth|credential|ssn|social.*security|credit.*card|card.*number|cvv|cvc|expir/i;
const STRING_LIMIT = 2048;
const DEBUGGER_IDLE_TIMEOUT_MS = 30000;
const RUNTIME_DIR = __dirname.replace(/\\/g, '/');
const SDK_ROOT = path.resolve(__dirname, '..').replace(/\\/g, '/');
const EXCLUDE_SDK_ROOT = shouldExcludeSdkRootForRuntime(RUNTIME_DIR, SDK_ROOT);

const FUNCTION_NAME_MAX = 80;
const LOCALS_GUARD_RECOVERY_MS = 5 * 60 * 1000;

export function shouldExcludeSdkRootForRuntime(runtimeDir: string, sdkRoot: string): boolean {
  const normalizedRuntimeDir = runtimeDir.replace(/\\/g, '/');
  const normalizedSdkRoot = sdkRoot.replace(/\\/g, '/');

  if (/(?:^|\/)node_modules\/errorcore(?:\/dist)?$/.test(normalizedSdkRoot)) {
    return true;
  }

  // Local source-tree tests and ts-node-style execution load files from
  // src/capture; compiled package execution loads from dist/capture. In
  // those modes the parent directory is genuinely SDK-owned. In an app
  // bundle, however, __dirname is commonly /app/dist and the parent is /app,
  // so excluding the parent would classify every app source frame as SDK.
  return (
    (normalizedRuntimeDir.endsWith('/src/capture') && normalizedSdkRoot.endsWith('/src')) ||
    (normalizedRuntimeDir.endsWith('/dist/capture') && normalizedSdkRoot.endsWith('/dist'))
  );
}

// Per-class allowlists of properties worth surfacing in a captured local.
// Keep these tight so we don't accidentally surface PII (e.g. req.body
// goes through the existing body-capture path, not here). Empty/undefined
// = surface every preview property.
const INTERESTING_KEYS_BY_CLASS: Record<string, string[]> = {
  IncomingMessage: ['method', 'url', 'statusCode', 'statusMessage', 'httpVersion', 'complete'],
  ServerResponse: ['statusCode', 'statusMessage', 'headersSent', 'finished', 'writableEnded'],
  ClientRequest: ['method', 'path', 'host', 'protocol', 'finished', 'writableEnded'],
  Layer: ['name', 'method', 'regexp', 'path'],
  Route: ['path', 'methods'],
  Socket: ['readyState', 'remoteAddress', 'remotePort', 'localPort']
};

function extractFunctionName(description: string): string {
  if (description === '') {
    return '<anonymous>';
  }

  // V8 RemoteObject.description for a function may be:
  //   "function fooBar(a, b) { … }"        (named function)
  //   "(req, res) => { … }"                (anonymous arrow)
  //   "async function* gen() { … }"        (async generator)
  //   "[Function: foo]"                    (already pre-stringified)
  // We want just the identifier - never the body.
  const namedMatch = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(description);
  if (namedMatch !== null) {
    return namedMatch[1].slice(0, FUNCTION_NAME_MAX);
  }

  const bracketMatch = /^\[Function:\s*([^\]]+)\]/.exec(description);
  if (bracketMatch !== null) {
    return bracketMatch[1].trim().slice(0, FUNCTION_NAME_MAX);
  }

  // Anonymous arrow / unnamed expression - describe by signature shape only.
  const arrowMatch = /^\s*(\([^)]*\))\s*=>/.exec(description);
  if (arrowMatch !== null) {
    return `<anonymous>${arrowMatch[1]}`.slice(0, FUNCTION_NAME_MAX);
  }

  // Fallback: the head of the description, stripped of newlines.
  return description.replace(/\s+/g, ' ').slice(0, FUNCTION_NAME_MAX);
}

interface InspectorModule {
  url(): string | undefined;
  Session: new () => InspectorSession;
}

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    callback: (error?: Error | null, result?: unknown) => void
  ): void;
  post(
    method: string,
    params: Record<string, unknown>,
    callback: (error?: Error | null, result?: unknown) => void
  ): void;
  on(event: 'Debugger.paused', handler: (event: { params: PausedEventParams }) => void): void;
}

interface PropertyPreview {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
  valuePreview?: ObjectPreview;
}

interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PropertyPreview[];
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface Scope {
  type: string;
  name?: string;
  object: RemoteObject;
}

interface CallFrame {
  callFrameId?: string;
  functionName: string;
  location: {
    lineNumber: number;
    columnNumber: number;
  };
  url?: string;
  scopeChain: Scope[];
  this?: RemoteObject;
}

interface PausedEventParams {
  reason: string;
  data?: RemoteObject;
  callFrames: CallFrame[];
}

interface DescriptionStackFrame {
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
}

type InspectorFrameKind = 'app' | 'library' | 'excluded';

interface ResolvedInspectorFrame {
  frame: CallFrame;
  callFrameIndex: number;
  renderedFrame?: DescriptionStackFrame;
  kind: InspectorFrameKind;
}

interface InspectorFrameSelection {
  frames: ResolvedInspectorFrame[];
  missReason?: 'no_app_frames' | 'non_app_empty_url_exception';
}

interface InspectorManagerDeps {
  getRequestId?: () => string | undefined;
  eventClock?: EventClock;
}

function getInspectorModule(): InspectorModule {
  return require('node:inspector') as InspectorModule;
}

interface MissedCollection {
  reason: string;
  timestamp: number;
}

const MAX_MISSED_COLLECTION_LOG = 20;
const REQUEST_MISMATCH_RECENT_MATCH_MS = 1000;

export interface LocalsWithDiagnostics {
  frames: CapturedFrame[] | null;
  missReason: string | null;
  captureLayer?: 'tag' | 'identity';
  degradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'dropped_request' | 'background';
}

function selectSingleRecentMatch(
  matches: LocalsRingBufferEntry[],
  now = Date.now()
): LocalsRingBufferEntry | undefined {
  if (matches.length === 1) {
    return matches[0];
  }

  const recent = matches.filter((entry) => {
    const ageMs = now - entry.createdAt;
    return ageMs >= 0 && ageMs <= REQUEST_MISMATCH_RECENT_MATCH_MS;
  });

  return recent.length === 1 ? recent[0] : undefined;
}

function capturedFrameSignature(entry: LocalsRingBufferEntry): string {
  return entry.frames
    .map((frame) =>
      `${frame.functionName}|${frame.filePath}|${frame.lineNumber}|${frame.columnNumber}`
    )
    .join('\n');
}

function selectNewestRecentEquivalentMatch(
  matches: LocalsRingBufferEntry[],
  now = Date.now()
): LocalsRingBufferEntry | undefined {
  const recent = matches.filter((entry) => {
    const ageMs = now - entry.createdAt;
    return ageMs >= 0 && ageMs <= REQUEST_MISMATCH_RECENT_MATCH_MS;
  });
  if (recent.length === 0) {
    return undefined;
  }
  if (recent.length === 1) {
    return recent[0];
  }

  const signature = capturedFrameSignature(recent[0]);
  if (recent.every((entry) => capturedFrameSignature(entry) === signature)) {
    return recent[recent.length - 1];
  }

  return undefined;
}

function selectNewestRecentMatch(
  matches: LocalsRingBufferEntry[],
  now = Date.now()
): LocalsRingBufferEntry | undefined {
  const recent = matches.filter((entry) => {
    const ageMs = now - entry.createdAt;
    return ageMs >= 0 && ageMs <= REQUEST_MISMATCH_RECENT_MATCH_MS;
  });
  return recent.length === 0 ? undefined : recent[recent.length - 1];
}

function normalizeLooseErrorMessage(message: string): string {
  return message.replace(/^[A-Za-z_$][\w$]*(?:Error)?:\s+/, '');
}

export class InspectorManager {
  private maxCollectionsPerSecond: number;

  private maxCachedLocals: number;

  private maxLocalsFrames: number;

  private captureLocalVariables: boolean;

  private localVariablesMode: ResolvedConfig['localVariablesMode'];

  private maxLocalsObjectProperties: number;

  private readonly config: ResolvedConfig;

  private readonly getRequestId: () => string | undefined;

  private readonly eventClock: EventClock;

  private available = false;

  private initialized = false;

  private session: InspectorSession | null = null;

  private readonly ringBuffer: LocalsRingBuffer;

  private collectionCountThisSecond = 0;

  private rateLimitTimer: NodeJS.Timeout | null = null;

  private pauseIdleTimer: NodeJS.Timeout | null = null;

  private pauseOnExceptionsActive = false;

  private readonly missedCollections: MissedCollection[] = [];

  private pauseEventsReceived = 0;

  private pausesThisSecond = 0;

  private overLimitSeconds = 0;

  private pauseWallTimeMsWindow = 0;

  private pauseWindowStartedAtMs = 0;

  private guardTripped = false;

  private guardTrippedAtMs: number | null = null;

  private localsGuard: ResolvedConfig['localsGuard'];

  public constructor(config: ResolvedConfig, deps: InspectorManagerDeps = {}) {
    this.config = config;
    this.maxCollectionsPerSecond = config.maxLocalsCollectionsPerSecond;
    this.maxCachedLocals = config.maxCachedLocals;
    this.maxLocalsFrames = config.maxLocalsFrames;
    this.maxLocalsObjectProperties = config.modeState.maxLocalsObjectProperties;
    this.captureLocalVariables = config.captureLocalVariables;
    this.localVariablesMode = config.localVariablesMode;
    this.localsGuard = config.localsGuard;
    this.getRequestId = deps.getRequestId ?? (() => undefined);
    // EventClock is optional for test ergonomics; the SDK composition root
    // always passes one shared instance (module 19 contract).
    this.eventClock = deps.eventClock ?? new EventClock();
    this.ringBuffer = new LocalsRingBuffer(config.maxCachedLocals);

    if (this.captureLocalVariables) {
      this.available = true;
    }
  }

  private _initSession(): boolean {
    if (this.initialized) {
      return this.session !== null;
    }

    this.initialized = true;

    let inspectorModule: InspectorModule;

    try {
      inspectorModule = getInspectorModule();
    } catch {
      this.available = false;
      return false;
    }

    if (inspectorModule.url()) {
      safeConsole.warn('[ErrorCore] Debugger already attached; local variable capture disabled');
      this.available = false;
      return false;
    }

    try {
      this.session = new inspectorModule.Session();
      this.session.connect();
      this.session.post('Debugger.enable', () => undefined);
      this.session.on('Debugger.paused', (event) => {
        this._onPaused(event.params);
      });
      this.rateLimitTimer = setInterval(() => {
        this.collectionCountThisSecond = 0;
        this.evaluatePauseRateGuard();
      }, 1000);
      this.rateLimitTimer.unref();
      return true;
    } catch {
      this.available = false;
      this.session = null;
      return false;
    }
  }

  public getLocals(error: Error): CapturedFrame[] | null {
    return this.getLocalsWithDiagnostics(error).frames;
  }

  public getLocalsWithDiagnostics(
    error: Error
  ): LocalsWithDiagnostics {
    if (!this.captureLocalVariables) {
      return { frames: null, missReason: null };
    }

    this.ringBuffer.pruneExpired();

    if (this.guardTripped) {
      return { frames: null, missReason: 'disabled_adaptive_guard' };
    }

    if (!this.available) {
      return { frames: null, missReason: 'not_available' };
    }

    if (!this.isMainThread()) {
      return { frames: null, missReason: 'not_available_in_worker' };
    }

    if (error == null || typeof error !== 'object') {
      return {
        frames: null,
        missReason: `primitive_throw (value=${typeof error})`
      };
    }

    this.ensureDebuggerActive();

    if (!this.initialized) {
      return { frames: null, missReason: 'not_initialized' };
    }

    // Layer 1: Symbol tag lookup
    const taggedId = (error as unknown as Record<symbol, unknown>)[ERRORCORE_CAPTURE_ID_SYMBOL];
    if (typeof taggedId === 'string') {
      const entry = this.ringBuffer.getById(taggedId);
      if (entry !== undefined) {
        this.ringBuffer.consumeFrames(entry.frames);
        return {
          frames: entry.frames,
          missReason: null,
          captureLayer: 'tag',
          degradation: 'exact'
        };
      }
    }

    // Layer 2: identity-tuple lookup
    const result = this._layer2Lookup(error);
    if (result.frames !== null) {
      this.ringBuffer.consumeFrames(result.frames);
    }
    return result;
  }

  /**
   * Layer 2 identity-tuple lookup with bounded degradation cascade.
   *
   * With requestId:
   *   1. Exact match: requestId + errorName + errorMessage + frameCount + structuralHash
   *   2. Dropped-hash: requestId + errorName + errorMessage + frameCount (if unique → dropped_hash)
   *   3. Dropped-count: requestId + errorName + errorMessage (if unique → dropped_count)
   *   Ambiguity at any step → returns missReason='ambiguous_correlation'.
   *
   * Without requestId (background errors):
   *   - Background match: null requestId + errorName + errorMessage + frameCount + structuralHash
   *   - Multiple matches → missReason='ambiguous_context_less_match' (refuse to guess).
   */
  private _layer2Lookup(error: Error): LocalsWithDiagnostics {
    const requestId = this.getRequestId() ?? null;

    const errorName = error.name || 'Error';
    const errorMessage = error.message || '';
    const stackFunctions = parseStackForFunctionNames(error.stack);
    const frameCount = stackFunctions.length;
    const structuralHash = computeStructuralHash(stackFunctions);

    if (requestId !== null) {
      // Exact key
      const exact = this.ringBuffer.findByIdentity({
        requestId,
        errorName,
        errorMessage,
        frameCount,
        structuralHash
      });
      if (exact !== undefined) {
        return {
          frames: exact.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'exact'
        };
      }

      // Dropped-hash: match without structuralHash
      const degradedMatches = this.ringBuffer.findByDegradedKey({
        requestId,
        errorName,
        errorMessage,
        frameCount
      });
      if (degradedMatches.length === 1) {
        return {
          frames: degradedMatches[0].frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_hash'
        };
      }
      const recentEquivalentDroppedHashMatch = selectNewestRecentEquivalentMatch(degradedMatches);
      if (recentEquivalentDroppedHashMatch !== undefined) {
        return {
          frames: recentEquivalentDroppedHashMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_hash'
        };
      }
      const recentDroppedHashMatch = selectNewestRecentMatch(degradedMatches);
      if (recentDroppedHashMatch !== undefined) {
        return {
          frames: recentDroppedHashMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_hash'
        };
      }
      if (degradedMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      // Dropped-count: match without frameCount or structuralHash
      const looseMatches = this.ringBuffer.findByLooseKey({
        requestId,
        errorName,
        errorMessage
      });
      if (looseMatches.length === 1) {
        return {
          frames: looseMatches[0].frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_count'
        };
      }
      const recentEquivalentDroppedCountMatch = selectNewestRecentEquivalentMatch(looseMatches);
      if (recentEquivalentDroppedCountMatch !== undefined) {
        return {
          frames: recentEquivalentDroppedCountMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_count'
        };
      }
      const recentDroppedCountMatch = selectNewestRecentMatch(looseMatches);
      if (recentDroppedCountMatch !== undefined) {
        return {
          frames: recentDroppedCountMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_count'
        };
      }
      if (looseMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      const requestMismatchMatches = this.ringBuffer
        .findByContentKey({
          errorName,
          errorMessage,
          frameCount,
          structuralHash
        })
        .filter((entry) => entry.requestId !== requestId);
      const recentRequestMismatchMatch = selectSingleRecentMatch(requestMismatchMatches);
      if (recentRequestMismatchMatch !== undefined) {
        return {
          frames: recentRequestMismatchMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      const recentEquivalentRequestMismatchMatch = selectNewestRecentEquivalentMatch(
        requestMismatchMatches
      );
      if (recentEquivalentRequestMismatchMatch !== undefined) {
        return {
          frames: recentEquivalentRequestMismatchMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      if (requestMismatchMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      const requestMismatchDroppedHashMatches = this.ringBuffer
        .findByContentDegradedKey({
          errorName,
          errorMessage,
          frameCount
        })
        .filter((entry) => entry.requestId !== requestId);
      const recentRequestMismatchDroppedHashMatch = selectSingleRecentMatch(
        requestMismatchDroppedHashMatches
      );
      if (recentRequestMismatchDroppedHashMatch !== undefined) {
        return {
          frames: recentRequestMismatchDroppedHashMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      const recentEquivalentRequestMismatchDroppedHashMatch = selectNewestRecentEquivalentMatch(
        requestMismatchDroppedHashMatches
      );
      if (recentEquivalentRequestMismatchDroppedHashMatch !== undefined) {
        return {
          frames: recentEquivalentRequestMismatchDroppedHashMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      if (requestMismatchDroppedHashMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      const requestMismatchLooseMatches = this.ringBuffer
        .findByContentLooseKey({
          errorName,
          errorMessage
        })
        .filter((entry) => entry.requestId !== requestId);
      const recentRequestMismatchLooseMatch = selectSingleRecentMatch(
        requestMismatchLooseMatches
      );
      if (recentRequestMismatchLooseMatch !== undefined) {
        return {
          frames: recentRequestMismatchLooseMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      const recentEquivalentRequestMismatchLooseMatch = selectNewestRecentEquivalentMatch(
        requestMismatchLooseMatches
      );
      if (recentEquivalentRequestMismatchLooseMatch !== undefined) {
        return {
          frames: recentEquivalentRequestMismatchLooseMatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      if (requestMismatchLooseMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      const normalizedErrorMessage = normalizeLooseErrorMessage(errorMessage);
      const topStackFunction = stackFunctions[0]?.functionName ?? '';
      const singleRecentRequestMismatch = this.ringBuffer
        .findRecentEntries(Date.now(), REQUEST_MISMATCH_RECENT_MATCH_MS)
        .filter((entry) =>
          entry.requestId !== requestId &&
          (
            normalizeLooseErrorMessage(entry.errorMessage) === normalizedErrorMessage ||
            (
              entry.errorName === 'NonErrorThrown' &&
              topStackFunction !== '' &&
              entry.frames[0]?.functionName === topStackFunction
            )
          )
        );
      if (singleRecentRequestMismatch.length === 1) {
        return {
          frames: singleRecentRequestMismatch[0].frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      const equivalentRecentRequestMismatch = selectNewestRecentEquivalentMatch(
        singleRecentRequestMismatch
      );
      if (equivalentRecentRequestMismatch !== undefined) {
        return {
          frames: equivalentRecentRequestMismatch.frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'dropped_request'
        };
      }
      if (singleRecentRequestMismatch.length > 1) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }
    } else {
      // Background match (no request context)
      const bgMatches = this.ringBuffer.findBackgroundMatches({
        errorName,
        errorMessage,
        frameCount,
        structuralHash
      });
      if (bgMatches.length === 1) {
        return {
          frames: bgMatches[0].frames,
          missReason: null,
          captureLayer: 'identity',
          degradation: 'background'
        };
      }
      if (bgMatches.length > 1) {
        return { frames: null, missReason: 'ambiguous_context_less_match' };
      }
    }

    const recentMissSummary = this.buildMissSummary();
    const lookupReason = this.ringBuffer.diagnoseIdentityMiss({
      requestId,
      errorName,
      errorMessage,
      frameCount,
      structuralHash
    });
    return {
      frames: null,
      missReason: `cache_miss (reason=${lookupReason}, pauses=${this.pauseEventsReceived}${recentMissSummary})`
    };
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public isDebuggerActive(): boolean {
    return (
      this.available &&
      !this.guardTripped &&
      this.session !== null &&
      this.pauseOnExceptionsActive
    );
  }

  public ensureDebuggerActive(): void {
    if (this.guardTripped) {
      return;
    }

    if (!this.available) {
      return;
    }

    if (!this.initialized && !this._initSession()) {
      return;
    }

    if (this.session === null) {
      return;
    }

    if (!this.pauseOnExceptionsActive) {
      this.session.post(
        'Debugger.setPauseOnExceptions',
        { state: 'all' },
        () => undefined
      );
      this.pauseOnExceptionsActive = true;
    }

    this.deactivateAfterIdle();
  }

  public disarmDebugger(): void {
    if (this.session !== null && this.pauseOnExceptionsActive) {
      try {
        this.session.post(
          'Debugger.setPauseOnExceptions',
          { state: 'none' },
          () => undefined
        );
      } catch {
        // Best effort: disarming must not affect mode switching.
      }
    }
    this.pauseOnExceptionsActive = false;
  }

  public applyModeState(
    next: Pick<
      ModeState,
      | 'captureLocalVariables'
      | 'localVariablesMode'
      | 'localsGuard'
      | 'maxLocalsCollectionsPerSecond'
      | 'maxCachedLocals'
      | 'maxLocalsFrames'
      | 'maxLocalsObjectProperties'
    >
  ): void {
    this.captureLocalVariables =
      next.captureLocalVariables && next.localVariablesMode !== 'none';
    this.localVariablesMode = next.localVariablesMode;
    this.maxCollectionsPerSecond = next.maxLocalsCollectionsPerSecond;
    this.maxCachedLocals = next.maxCachedLocals;
    this.ringBuffer.resize(next.maxCachedLocals);
    this.maxLocalsFrames = next.maxLocalsFrames;
    this.maxLocalsObjectProperties = next.maxLocalsObjectProperties;
    this.localsGuard = next.localsGuard;

    if (!this.captureLocalVariables) {
      this.disarmDebugger();
      this.available = false;
      return;
    }

    this.available = true;
    if (!this.localsGuard.enabled && this.guardTripped) {
      this.rearmAfterAdaptiveGuard();
    }
  }

  public rearmAfterAdaptiveGuard(): void {
    this.resetGuardTrip(Date.now());
    if (this.captureLocalVariables) {
      this.available = true;
      this.ensureDebuggerActive();
    }
  }

  public shutdown(): void {
    if (this.rateLimitTimer !== null) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    if (this.pauseIdleTimer !== null) {
      clearTimeout(this.pauseIdleTimer);
      this.pauseIdleTimer = null;
    }

    if (this.session !== null) {
      try {
        if (this.pauseOnExceptionsActive) {
          this.session.post(
            'Debugger.setPauseOnExceptions',
            { state: 'none' },
            () => undefined
          );
        }
      } catch (error) {
        safeConsole.warn('[ErrorCore] Failed to reset pause-on-exceptions during shutdown:', error instanceof Error ? error.message : String(error));
      }
      try {
        this.session.post('Debugger.disable', () => undefined);
      } catch (error) {
        safeConsole.warn('[ErrorCore] Failed to disable inspector during shutdown:', error instanceof Error ? error.message : String(error));
      }
      try {
        this.session.disconnect();
      } catch (error) {
        safeConsole.warn('[ErrorCore] Failed to disconnect inspector session during shutdown:', error instanceof Error ? error.message : String(error));
      }
    }

    this.session = null;
    this.pauseOnExceptionsActive = false;
    this.available = false;
  }

  private recordMiss(reason: string): void {
    if (this.missedCollections.length >= MAX_MISSED_COLLECTION_LOG) {
      this.missedCollections.shift();
    }
    this.missedCollections.push({ reason, timestamp: Date.now() });
  }

  private evaluatePauseRateGuard(): void {
    if (!this.localsGuard.enabled) {
      this.pausesThisSecond = 0;
      return;
    }
    if (this.guardTripped) {
      this.evaluateGuardRecovery();
      return;
    }
    if (this.pausesThisSecond > this.localsGuard.maxPausesPerSecond) {
      this.overLimitSeconds += 1;
    } else {
      this.overLimitSeconds = 0;
    }
    this.pausesThisSecond = 0;
    // Spec: trip only on sustained overload (10 consecutive over-limit
    // seconds), not on a single bursty second.
    if (this.overLimitSeconds >= 10) {
      this.tripGuard('pause_rate');
    }
  }

  private recordPauseWallTime(elapsedMs: number): void {
    if (!this.localsGuard.enabled || this.guardTripped) {
      return;
    }
    const now = Date.now();
    if (now - this.pauseWindowStartedAtMs > 60_000) {
      this.pauseWindowStartedAtMs = now;
      this.pauseWallTimeMsWindow = 0;
    }
    this.pauseWallTimeMsWindow += elapsedMs;
    if (this.pauseWallTimeMsWindow > this.localsGuard.maxPauseMsPerMinute) {
      this.tripGuard('pause_wall_time');
    }
  }

  private tripGuard(reason: 'pause_rate' | 'pause_wall_time'): void {
    if (this.guardTripped) {
      return;
    }
    this.guardTripped = true;
    this.guardTrippedAtMs = Date.now();
    if (this.session !== null && this.pauseOnExceptionsActive) {
      try {
        this.session.post(
          'Debugger.setPauseOnExceptions',
          { state: 'none' },
          () => undefined
        );
      } catch {
        // Session may already be torn down; the trip still stands.
      }
      this.pauseOnExceptionsActive = false;
    }
    safeConsole.warn(
      `[ErrorCore] Local-variable capture disabled by adaptive guard (${reason}). ` +
      'Debugger pauses from thrown exceptions exceeded the configured budget ' +
      '(localsGuard). Subsequent packages report locals: disabled_adaptive_guard. ' +
      "Set localsGuard: 'off' to keep locals armed regardless of pause load."
    );
  }

  private evaluateGuardRecovery(now = Date.now()): void {
    if (!this.guardTripped || this.guardTrippedAtMs === null) {
      this.pausesThisSecond = 0;
      return;
    }

    if (
      this.pausesThisSecond > this.localsGuard.maxPausesPerSecond ||
      this.pauseWallTimeMsWindow > this.localsGuard.maxPauseMsPerMinute
    ) {
      this.guardTrippedAtMs = now;
      this.pausesThisSecond = 0;
      this.pauseWallTimeMsWindow = 0;
      this.pauseWindowStartedAtMs = now;
      return;
    }

    this.pausesThisSecond = 0;
    if (now - this.guardTrippedAtMs >= LOCALS_GUARD_RECOVERY_MS) {
      this.resetGuardTrip(now);
      if (this.captureLocalVariables) {
        this.available = true;
        this.ensureDebuggerActive();
      }
    }
  }

  private resetGuardTrip(now: number): void {
    this.guardTripped = false;
    this.guardTrippedAtMs = null;
    this.overLimitSeconds = 0;
    this.pausesThisSecond = 0;
    this.pauseWallTimeMsWindow = 0;
    this.pauseWindowStartedAtMs = now;
  }

  private buildMissSummary(): string {
    if (this.missedCollections.length === 0) {
      return '';
    }

    const counts = new Map<string, number>();
    for (const entry of this.missedCollections) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [reason, count] of counts.entries()) {
      parts.push(`${count} ${reason}`);
    }

    return `, skipped: ${parts.join(', ')}`;
  }

  private installCaptureTag(
    exceptionObjectId: string,
    captureId: string
  ): void {
    if (this.session === null) return;
    const functionDeclaration = `
      function(symbolKeyName, captureId) {
        const sym = Symbol.for(symbolKeyName);
        if (this == null) return undefined;
        const existing = this[sym];
        if (typeof existing === 'string') return existing;
        if (Object.isFrozen(this)) return undefined;
        try {
          Object.defineProperty(this, sym, {
            value: captureId,
            enumerable: false,
            configurable: false,
            writable: false
          });
          return captureId;
        } catch {
          return undefined;
        }
      }
    `;
    this.session.post(
      'Runtime.callFunctionOn' as never,
      {
        functionDeclaration,
        objectId: exceptionObjectId,
        arguments: [
          { value: 'errorcore.v1.captureId' },
          { value: captureId }
        ],
        returnByValue: true,
        silent: true
      } as never,
      () => undefined
    );
  }

  private isErrorLikeRemoteObject(data: RemoteObject | undefined): boolean {
    if (data === undefined) {
      return true;
    }

    const className = data.className ?? '';
    if (className === 'Error' || /Error$/.test(className)) {
      return true;
    }

    if (data.type !== 'object') {
      return false;
    }

    return data.subtype === 'error';
  }

  private remoteObjectThrownValue(data: RemoteObject): unknown {
    if (data.subtype === 'null') {
      return null;
    }

    if (data.subtype === 'array') {
      return [];
    }

    if (data.type === 'undefined') {
      return undefined;
    }

    if (
      data.type === 'string' ||
      data.type === 'number' ||
      data.type === 'boolean' ||
      data.type === 'bigint' ||
      data.type === 'symbol'
    ) {
      return data.value ?? data.description;
    }

    return {};
  }

  private getPausedExceptionIdentity(data: RemoteObject | undefined): {
    errorName: string;
    errorMessage: string;
  } {
    if (!this.isErrorLikeRemoteObject(data) && data !== undefined) {
      const info = buildNonErrorThrownInfo(
        this.remoteObjectThrownValue(data),
        this.config
      );
      return {
        errorName: 'NonErrorThrown',
        errorMessage: info.message
      };
    }

    const errorName = data?.className ?? 'Error';
    const description = (data?.description ?? '').split(/\r?\n/, 1)[0] ?? '';
    return {
      errorName,
      errorMessage: description.startsWith(`${errorName}: `)
        ? description.slice(errorName.length + 2)
        : description
    };
  }

  private extractDescriptionStackFrames(description: string | undefined): DescriptionStackFrame[] {
    if (description === undefined || description === '') {
      return [];
    }

    const frames: DescriptionStackFrame[] = [];
    for (const line of description.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('at ')) {
        continue;
      }

      let functionName = '<anonymous>';
      let location = trimmed.slice(3).trim();
      if (location.endsWith(')')) {
        const openParen = location.lastIndexOf('(');
        if (openParen >= 0) {
          functionName = location
            .slice(0, openParen)
            .replace(/^(?:async\s+)+/, '')
            .trim() || '<anonymous>';
          location = location.slice(openParen + 1, -1);
        }
      }

      location = location.replace(/^(?:async\s+)+/, '');
      const locationMatch = /^(.*):(\d+):(\d+)$/.exec(location);
      if (locationMatch !== null) {
        frames.push({
          functionName,
          filePath: locationMatch[1],
          lineNumber: Number.parseInt(locationMatch[2], 10),
          columnNumber: Number.parseInt(locationMatch[3], 10)
        });
      }
    }

    return frames;
  }

  private isBundledAppDescriptionFrame(frame: DescriptionStackFrame | undefined): boolean {
    if (frame === undefined || !this._isAppFrame(frame.filePath)) {
      return false;
    }

    const normalized = frame.filePath.replace(/\\/g, '/');
    return normalized.includes('/dist/') || /(?:^|\/)dist\//.test(normalized);
  }

  private isExternalLibraryDescriptionFrame(frame: DescriptionStackFrame | undefined): boolean {
    if (frame === undefined) {
      return false;
    }

    const normalized = frame.filePath.replace(/\\/g, '/');
    return normalized.includes('/node_modules/');
  }

  private isInstrumentedExternalDescriptionFrame(frame: DescriptionStackFrame | undefined): boolean {
    if (!this.isExternalLibraryDescriptionFrame(frame)) {
      return false;
    }

    const normalized = frame!.filePath.replace(/\\/g, '/');
    return /\/node_modules\/(?:@[^/]+\/)?(?:sequelize|pg|ioredis|redis|mysql2|mongodb)\//.test(
      normalized
    );
  }

  private isAppDescriptionFrame(frame: DescriptionStackFrame | undefined): boolean {
    return frame !== undefined && this._isAppFrame(frame.filePath);
  }

  private isNodeInternalDescriptionFrame(frame: DescriptionStackFrame | undefined): boolean {
    if (frame === undefined) {
      return false;
    }

    const normalized = frame.filePath.replace(/\\/g, '/');
    return normalized.startsWith('node:') || normalized.includes('node:internal');
  }

  private classifyInspectorFrame(filePath: string): InspectorFrameKind {
    const normalized = filePath.replace(/\\/g, '/');
    if (
      normalized === '' ||
      normalized.startsWith('node:') ||
      normalized.includes('node:internal') ||
      /(?:^|\/)node_modules\/errorcore(?:\/|$)/.test(normalized) ||
      (EXCLUDE_SDK_ROOT && normalized.startsWith(`${SDK_ROOT}/`))
    ) {
      return 'excluded';
    }

    if (normalized.includes('/node_modules/')) {
      return 'library';
    }

    return this._isAppFrame(filePath) ? 'app' : 'excluded';
  }

  private selectInspectorFrames(params: PausedEventParams): InspectorFrameSelection {
    const descriptionFrames = this.extractDescriptionStackFrames(params.data?.description);
    const hasWebpackContext = params.callFrames.some(
      (frame) => frame.url !== undefined && frame.url.startsWith('webpack-internal://')
    );

    const resolvedFrames = params.callFrames.map((frame, callFrameIndex): ResolvedInspectorFrame => {
      const explicitUrl = frame.url !== undefined && frame.url.trim() !== '';
      const hasLocalScope = frame.scopeChain.some((scope) => scope.type === 'local');
      const renderedFrame = explicitUrl ? undefined : descriptionFrames[callFrameIndex];
      const filePath = explicitUrl ? frame.url! : renderedFrame?.filePath ?? '';
      let kind = explicitUrl || hasLocalScope
        ? this.classifyInspectorFrame(filePath)
        : 'excluded';

      // Preserve the established webpack safeguard for builds where V8 leaves
      // otherwise-capturable frame URLs empty and the description is clipped.
      if (!explicitUrl && renderedFrame === undefined && hasLocalScope && hasWebpackContext) {
        kind = 'app';
      }

      return {
        frame,
        callFrameIndex,
        ...(renderedFrame === undefined ? {} : { renderedFrame }),
        kind
      };
    });

    let nearestApp = resolvedFrames.find((entry) => entry.kind === 'app');
    if (nearestApp === undefined) {
      const emptyUrlLocalFrames = resolvedFrames.filter(
        ({ frame }) =>
          (frame.url === undefined || frame.url.trim() === '') &&
          frame.scopeChain.some((scope) => scope.type === 'local')
      );
      const bundledAppFrame = descriptionFrames.find((frame) =>
        this.isBundledAppDescriptionFrame(frame)
      );
      const externalDriverOrigin = this.isInstrumentedExternalDescriptionFrame(
        descriptionFrames[0]
      );
      const nonNodeInternalOrigin = descriptionFrames[0] !== undefined &&
        !this.isNodeInternalDescriptionFrame(descriptionFrames[0]);
      const appEvidenceFrame = bundledAppFrame ??
        ((externalDriverOrigin || nonNodeInternalOrigin)
          ? descriptionFrames.find((frame) => this.isAppDescriptionFrame(frame))
          : undefined);

      if (
        appEvidenceFrame !== undefined &&
        emptyUrlLocalFrames.length > 0 &&
        (
          emptyUrlLocalFrames.length > 1 ||
          externalDriverOrigin ||
          nonNodeInternalOrigin
        )
      ) {
        nearestApp = emptyUrlLocalFrames[0];
        nearestApp.kind = 'app';
        nearestApp.renderedFrame = appEvidenceFrame;
      } else {
        return {
          frames: [],
          missReason: emptyUrlLocalFrames.length > 0
            ? 'non_app_empty_url_exception'
            : 'no_app_frames'
        };
      }
    }

    const frameBudget = Math.max(1, this.maxLocalsFrames);
    if (frameBudget === 1) {
      return { frames: [nearestApp] };
    }

    const libraryLimit = this.localVariablesMode === 'deep'
      ? 3
      : this.localVariablesMode === 'shallow'
        ? 1
        : 0;
    const libraryFrames = resolvedFrames
      .filter(
        (entry) =>
          entry.callFrameIndex < nearestApp.callFrameIndex &&
          entry.kind === 'library'
      )
      .slice(0, Math.min(libraryLimit, frameBudget - 1));
    const selected = [...libraryFrames, nearestApp];

    for (const entry of resolvedFrames) {
      if (selected.length >= frameBudget) {
        break;
      }
      if (entry.callFrameIndex > nearestApp.callFrameIndex && entry.kind === 'app') {
        selected.push(entry);
      }
    }

    selected.sort((left, right) => left.callFrameIndex - right.callFrameIndex);
    return { frames: selected };
  }

  private _onPaused(params: PausedEventParams): void {
    // Stamp at entry - module 20 contract. Fires before any filtering, gating,
    // or async I/O. Pause events that don't produce a ring-buffer entry still
    // consume seq values; gaps in the seq stream from outside the inspector
    // are observable downstream and indicate a pause we declined to record.
    const stampedSeq = this.eventClock.tick();
    const stampedHrtimeNs = process.hrtime.bigint();
    try {
      this.deactivateAfterIdle();
      this.pauseEventsReceived += 1;
      this.pausesThisSecond += 1;

      try {
        if (
          params.reason !== 'exception' &&
          params.reason !== 'promiseRejection'
        ) {
          this.recordMiss('not_exception');
          return;
        }

        if (this.collectionCountThisSecond >= this.maxCollectionsPerSecond) {
          this.recordMiss('rate_limited');
          return;
        }

        this.ringBuffer.pruneExpired();

        const selection = this.selectInspectorFrames(params);
        if (selection.frames.length === 0) {
          this.recordMiss(selection.missReason ?? 'no_app_frames');
          return;
        }

        const { errorName, errorMessage } =
          this.getPausedExceptionIdentity(params.data);

        const requestId = this.getRequestId() ?? null;
        const captureId = this.ringBuffer.allocateId();

        const frameCount = params.callFrames.length;
        const structuralHash = computeStructuralHash(params.callFrames);

        const collected: Array<CapturedFrame | undefined> = new Array(selection.frames.length);
        const localProperties = new Map<number, PropertyDescriptor[]>();
        const argumentProperties = new Map<number, PropertyDescriptor[]>();
        let pendingCollections = 0;
        let setupComplete = false;
        let stored = false;

        const storeCollectedFrames = () => {
          if (stored || !setupComplete || pendingCollections > 0) {
            return;
          }

          const orderedFrames = collected.filter((frame): frame is CapturedFrame => frame !== undefined);
          for (let frameIndex = 0; frameIndex < orderedFrames.length; frameIndex += 1) {
            const args = argumentProperties.get(frameIndex);
            if (args !== undefined) {
              orderedFrames[frameIndex].arguments = this._extractArguments(
                args,
                localProperties.get(frameIndex) ?? [],
                stampedSeq,
                stampedHrtimeNs
              );
            }
          }

          if (orderedFrames.length === 0) {
            this.recordMiss('empty_locals');
            stored = true;
            return;
          }

          const entry: LocalsRingBufferEntry = {
            id: captureId,
            seq: stampedSeq,
            hrtimeNs: stampedHrtimeNs,
            requestId,
            errorName,
            errorMessage,
            frameCount,
            structuralHash,
            frames: orderedFrames,
            createdAt: Date.now()
          };

          this.ringBuffer.push(entry);
          this.collectionCountThisSecond += 1;
          stored = true;
        };

        for (let selectedIndex = 0; selectedIndex < selection.frames.length; selectedIndex += 1) {
          const { frame, callFrameIndex, renderedFrame } = selection.frames[selectedIndex];
          const rawLocation = {
            functionName: renderedFrame?.functionName ?? frame.functionName,
            filePath: renderedFrame?.filePath ?? frame.url ?? '',
            lineNumber: renderedFrame?.lineNumber ?? frame.location.lineNumber + 1,
            columnNumber: renderedFrame?.columnNumber ?? frame.location.columnNumber + 1
          };
          const capturedFrame: CapturedFrame = {
            frameId: `frame:${stampedSeq}:${callFrameIndex}`,
            callFrameIndex,
            captureSource: 'v8_inspector',
            ...rawLocation,
            rawLocation: { ...rawLocation },
            sourceMapOutcome: 'disabled',
            sourceContext: { status: 'unavailable', reason: 'source_artifact_not_configured' },
            inspectorSeq: stampedSeq,
            inspectorHrtimeNs: stampedHrtimeNs.toString(),
            correlationQuality: 'unmatched',
            causeOrigin: { kind: 'error', depth: 0 },
            scopes: [],
            arguments: [],
            argumentsUnavailableReason: frame.callFrameId === undefined
              ? 'call_frame_id_unavailable'
              : undefined,
            thisValue: frame.this === undefined
              ? undefined
              : this._captureValue('this', frame.this, 'this', stampedSeq, stampedHrtimeNs),
            thisUnavailableReason: frame.this === undefined ? 'inspector_this_unavailable' : undefined,
            capturePolicy: {
              maxFrames: this.maxLocalsFrames,
              maxBindingsPerScope: this.config.serialization.maxObjectKeys,
              cacheCapacity: this.maxCachedLocals,
              cacheTtlMs: LOCALS_CACHE_TTL_MS
            },
            locals: {}
          };
          collected[selectedIndex] = capturedFrame;

          const supportedScopes = frame.scopeChain.filter(
            (scope): scope is Scope & { type: CapturedScope['type'] } =>
              scope.type === 'local' || scope.type === 'closure' ||
              scope.type === 'catch' || scope.type === 'block'
          );
          for (const scope of supportedScopes) {
            if (scope.object.objectId === undefined || this.session === null) continue;
            pendingCollections += 1;
            this.session.post(
              'Runtime.getProperties',
              { objectId: scope.object.objectId, ownProperties: true, generatePreview: true },
              (error, result) => {
                if (!error && result !== undefined) {
                  const properties = (result as { result?: PropertyDescriptor[] }).result ?? [];
                  if (scope.type === 'local') {
                    localProperties.set(selectedIndex, properties);
                    capturedFrame.locals = this._extractLocals(properties);
                  }
                  capturedFrame.scopes!.push(
                    this._extractScope(scope, properties, stampedSeq, stampedHrtimeNs)
                  );
                } else {
                  capturedFrame.scopes!.push({
                    type: scope.type,
                    ...(scope.name === undefined ? {} : { name: scope.name }),
                    bindings: [],
                    truncated: false,
                    omittedBindings: 0,
                    unavailableReason: 'inspector_scope_read_failed'
                  });
                }
                pendingCollections -= 1;
                storeCollectedFrames();
              }
            );
          }

          if (frame.callFrameId !== undefined && this.session !== null) {
            pendingCollections += 1;
            this.session.post(
              'Debugger.evaluateOnCallFrame',
              {
                callFrameId: frame.callFrameId,
                expression: 'typeof arguments === "undefined" ? null : arguments',
                silent: true,
                returnByValue: false,
                generatePreview: true
              },
              (error, result) => {
                const remote = (result as { result?: RemoteObject } | undefined)?.result;
                if (!error && remote?.objectId !== undefined && this.session !== null) {
                  pendingCollections += 1;
                  this.session.post(
                    'Runtime.getProperties',
                    { objectId: remote.objectId, ownProperties: true, generatePreview: true },
                    (propertiesError, propertiesResult) => {
                      if (!propertiesError && propertiesResult !== undefined) {
                        argumentProperties.set(
                          selectedIndex,
                          (propertiesResult as { result?: PropertyDescriptor[] }).result ?? []
                        );
                        delete capturedFrame.argumentsUnavailableReason;
                      }
                      pendingCollections -= 1;
                      storeCollectedFrames();
                    }
                  );
                } else if (!error) {
                  argumentProperties.set(selectedIndex, []);
                  delete capturedFrame.argumentsUnavailableReason;
                } else {
                  capturedFrame.argumentsUnavailableReason = 'inspector_arguments_read_failed';
                }
                pendingCollections -= 1;
                storeCollectedFrames();
              }
            );
          }
        }

        setupComplete = true;
        storeCollectedFrames();

        if (params.data?.objectId !== undefined) {
          this.installCaptureTag(params.data.objectId, captureId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeConsole.warn(`[ErrorCore] Inspector paused handler failed: ${message}`);
      }
    } finally {
      if (this.session !== null) {
        try {
          this.session.post('Debugger.resume', () => undefined);
        } catch {
        }
      }
      this.recordPauseWallTime(
        Number(process.hrtime.bigint() - stampedHrtimeNs) / 1_000_000
      );
    }
  }

  private _extractLocals(properties: PropertyDescriptor[]): Record<string, unknown> {
    const locals: Record<string, unknown> = {};

    for (const property of properties) {
      if (SENSITIVE_VAR_RE.test(property.name)) {
        locals[property.name] = '[REDACTED]';
        continue;
      }

      locals[property.name] = this._serializeRemoteObject(property.value);
    }

    return locals;
  }

  private _extractScope(
    scope: Scope & { type: CapturedScope['type'] },
    properties: PropertyDescriptor[],
    seq: number,
    hrtimeNs: bigint
  ): CapturedScope {
    const limit = this.config.serialization.maxObjectKeys;
    const selected = properties.slice(0, limit);
    return {
      type: scope.type,
      ...(scope.name === undefined ? {} : { name: scope.name }),
      bindings: selected.map((property) => ({
        name: property.name,
        captured: this._captureValue(property.name, property.value, 'scope', seq, hrtimeNs)
      })),
      truncated: properties.length > selected.length,
      omittedBindings: Math.max(0, properties.length - selected.length)
    };
  }

  private _extractArguments(
    properties: PropertyDescriptor[],
    locals: PropertyDescriptor[],
    seq: number,
    hrtimeNs: bigint
  ): CapturedArgument[] {
    const numeric = properties
      .filter((property) => /^(?:0|[1-9]\d*)$/.test(property.name))
      .sort((a, b) => Number(a.name) - Number(b.name))
      .slice(0, this.config.serialization.maxArrayItems);
    const usedNames = new Set<string>();
    return numeric.map((property) => {
      const matches = locals.filter(
        (candidate) => !usedNames.has(candidate.name) && this._sameRemoteValue(candidate.value, property.value)
      );
      const matchedName = matches.length === 1 ? matches[0].name : null;
      if (matchedName !== null) usedNames.add(matchedName);
      return {
        index: Number(property.name),
        name: matchedName,
        nameStatus: matchedName === null ? 'unavailable' : 'matched_local_binding',
        ...this._captureValue(matchedName ?? `argument_${property.name}`, property.value, 'argument', seq, hrtimeNs)
      };
    });
  }

  private _sameRemoteValue(left: RemoteObject | undefined, right: RemoteObject | undefined): boolean {
    if (left === undefined || right === undefined) return false;
    if (left.objectId !== undefined || right.objectId !== undefined) {
      return left.objectId !== undefined && left.objectId === right.objectId;
    }
    return left.type === right.type && left.subtype === right.subtype &&
      Object.is(left.value, right.value) && left.description === right.description;
  }

  private _captureValue(
    name: string,
    object: RemoteObject | undefined,
    origin: CapturedValue['origin'],
    seq: number,
    hrtimeNs: bigint
  ): CapturedValue {
    if (SENSITIVE_VAR_RE.test(name)) {
      return {
        status: 'redacted',
        captureSource: 'v8_inspector',
        inspectorSeq: seq,
        inspectorHrtimeNs: hrtimeNs.toString(),
        origin,
        correlationQuality: 'unmatched',
        causeOrigin: { kind: 'error', depth: 0 },
        reason: 'sensitive_binding_name'
      };
    }
    if (object === undefined || object.description === '<optimized out>') {
      return {
        status: 'optimized_out',
        captureSource: 'v8_inspector',
        inspectorSeq: seq,
        inspectorHrtimeNs: hrtimeNs.toString(),
        origin,
        correlationQuality: 'unmatched',
        causeOrigin: { kind: 'error', depth: 0 },
        reason: 'v8_optimized_out'
      };
    }
    const value = this._serializeRemoteObject(object);
    const truncated =
      (typeof value === 'string' && value.includes('...[truncated,')) ||
      (typeof value === 'object' && value !== null &&
        (value as { _overflow?: unknown })._overflow === true);
    return {
      value,
      status: truncated ? 'truncated' : value === '[REDACTED]' ? 'redacted' : 'captured',
      captureSource: 'v8_inspector',
      inspectorSeq: seq,
      inspectorHrtimeNs: hrtimeNs.toString(),
      origin,
      correlationQuality: 'unmatched',
      causeOrigin: { kind: 'error', depth: 0 },
      ...(truncated ? { reason: 'capture_budget' } : {})
    };
  }

  private _serializeRemoteObject(object: RemoteObject | undefined): unknown {
    if (object === undefined) {
      return undefined;
    }

    if (object.subtype === 'null') {
      return null;
    }

    if (object.type === 'undefined') {
      return undefined;
    }

    if (object.type === 'string') {
      const value = typeof object.value === 'string' ? object.value : '';
      if (looksLikeHighEntropySecret(value)) {
        return '[REDACTED]';
      }
      return value.length > STRING_LIMIT
        ? `${value.slice(0, STRING_LIMIT)}...[truncated, ${value.length} chars]`
        : value;
    }

    if (object.type === 'number' || object.type === 'boolean') {
      return object.value;
    }

    if (object.type === 'bigint') {
      return {
        _type: 'BigInt',
        value: object.description
      };
    }

    if (object.type === 'symbol') {
      return {
        _type: 'Symbol',
        description: object.description
      };
    }

    if (object.type === 'function') {
      // V8's RemoteObject.description for functions can carry the entire
      // source body on some Node versions / inspector configurations,
      // which inflates the capture by KB per frame for zero debugging
      // value (the source is in the codebase). Extract only the function
      // name and arity-relevant metadata.
      return {
        _type: 'Function',
        name: extractFunctionName(object.description ?? ''),
        className: object.className ?? null
      };
    }

    if (object.subtype === 'array') {
      return `[Array(${object.description ?? ''})]`;
    }

    if (object.subtype === 'regexp' || object.subtype === 'date' || object.subtype === 'error') {
      return object.description;
    }

    if (object.subtype === 'map') {
      return `[Map(${object.description ?? ''})]`;
    }

    if (object.subtype === 'set') {
      return `[Set(${object.description ?? ''})]`;
    }

    // For object locals with a className we recognize, project a useful
    // subset from the V8 preview rather than collapsing to "[ClassName]".
    // The preview is fetched at getProperties time via generatePreview.
    if (object.preview !== undefined && object.preview.properties !== undefined) {
      const className = object.className ?? 'Object';
      const projected: Record<string, unknown> = { _type: className };
      const interesting = INTERESTING_KEYS_BY_CLASS[className];
      let projectedCount = 0;

      for (const prop of object.preview.properties) {
        if (interesting !== undefined && !interesting.includes(prop.name)) {
          continue;
        }
        if (projectedCount >= this.maxLocalsObjectProperties) {
          projected._overflow = true;
          break;
        }
        if (SENSITIVE_VAR_RE.test(prop.name)) {
          projected[prop.name] = '[REDACTED]';
          projectedCount += 1;
          continue;
        }
        if (prop.type === 'string' || prop.type === 'number' || prop.type === 'boolean') {
          projected[prop.name] = prop.value;
          projectedCount += 1;
        } else if (prop.value !== undefined) {
          projected[prop.name] = `[${prop.type}${prop.subtype ? `:${prop.subtype}` : ''}]`;
          projectedCount += 1;
        }
      }

      if (object.preview.overflow === true) {
        projected._overflow = true;
      }

      if (Object.keys(projected).length > 1) {
        return projected;
      }
    }

    return `[${object.className ?? 'Object'}]`;
  }

  private _isAppFrame(url: string | undefined): boolean {
    if (url === undefined || url === '') {
      return false;
    }

    const normalizedUrl = url.replace(/\\/g, '/');

    return !(
      normalizedUrl.startsWith('node:') ||
      normalizedUrl.includes('/node_modules/') ||
      normalizedUrl.includes('node:internal') ||
      (EXCLUDE_SDK_ROOT && normalizedUrl.startsWith(`${SDK_ROOT}/`))
    );
  }

  private isMainThread(): boolean {
    try {
      const { isMainThread } = require('node:worker_threads') as { isMainThread: boolean };
      return isMainThread;
    } catch {
      return true;
    }
  }

  private deactivateAfterIdle(): void {
    if (this.pauseIdleTimer !== null) {
      clearTimeout(this.pauseIdleTimer);
    }

    this.pauseIdleTimer = setTimeout(() => {
      this.pauseIdleTimer = null;

      if (!this.pauseOnExceptionsActive || this.session === null) {
        return;
      }

      try {
        this.session.post(
          'Debugger.setPauseOnExceptions',
          { state: 'none' },
          () => undefined
        );
      } catch {
      } finally {
        this.pauseOnExceptionsActive = false;
      }
    }, DEBUGGER_IDLE_TIMEOUT_MS);
    this.pauseIdleTimer.unref();
  }
}

/**
 * Parses an Error.stack string and returns an array of { functionName } objects
 * for use in structural hash / frame count computation.
 * Lines like "    at functionName (path:1:2)" → functionName
 * Lines like "    at /path/file:1:2" (no function) → empty string
 * Non-frame lines are skipped.
 */
export function parseStackForFunctionNames(
  stack: string | undefined
): Array<{ functionName: string }> {
  if (stack === undefined || stack === '') {
    return [];
  }

  const lines = stack.split('\n');
  const result: Array<{ functionName: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) {
      continue;
    }

    const rest = trimmed.slice(3).trim();

    if (rest.endsWith(')')) {
      const openParen = rest.lastIndexOf('(');
      if (openParen > 0) {
        const fnName = rest.slice(0, openParen).trim();
        result.push({ functionName: fnName });
        continue;
      }
    }

    if (/^.+:\d+:\d+$/.test(rest)) {
      result.push({ functionName: '' });
    }
  }

  return result;
}
