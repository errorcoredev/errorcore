
import path = require('node:path');
import { createHash } from 'node:crypto';

import type { CapturedFrame, ResolvedConfig } from '../types';
import { looksLikeHighEntropySecret } from '../pii/scrubber';

export const ERRORCORE_CAPTURE_ID_SYMBOL = Symbol.for('errorcore.v1.captureId');

export interface LocalsRingBufferEntry {
  id: string;
  requestId: string | null;
  errorName: string;
  errorMessage: string;
  frameCount: number;
  structuralHash: string;
  frames: CapturedFrame[];
  createdAt: number;
}

export class LocalsRingBuffer {
  private readonly capacity: number;
  private readonly entries: LocalsRingBufferEntry[] = [];
  private nextId = 0;

  public constructor(capacity: number) {
    this.capacity = capacity;
  }

  public allocateId(): string {
    return String(++this.nextId);
  }

  public push(entry: LocalsRingBufferEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.capacity) this.entries.shift();
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
const CACHE_TTL_MS = 30000;
const DEBUGGER_IDLE_TIMEOUT_MS = 30000;
const SDK_ROOT = path.resolve(__dirname, '..').replace(/\\/g, '/');

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

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface Scope {
  type: string;
  object: RemoteObject;
}

interface CallFrame {
  functionName: string;
  location: {
    lineNumber: number;
    columnNumber: number;
  };
  url?: string;
  scopeChain: Scope[];
}

interface PausedEventParams {
  reason: string;
  data?: RemoteObject;
  callFrames: CallFrame[];
}

interface AppFrameLocation {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
}

interface CachedLocalsEntry {
  frames: CapturedFrame[] | null;
  timestamp: number;
  ambiguous: boolean;
}

interface InspectorManagerDeps {
  getRequestId?: () => string | undefined;
}

function getInspectorModule(): InspectorModule {
  return require('node:inspector') as InspectorModule;
}

interface MissedCollection {
  reason: string;
  timestamp: number;
}

const MAX_MISSED_COLLECTION_LOG = 20;

export class InspectorManager {
  private readonly maxCollectionsPerSecond: number;

  private readonly maxCachedLocals: number;

  private readonly maxLocalsFrames: number;

  private readonly captureLocalVariables: boolean;

  private readonly getRequestId: () => string | undefined;

  private available = false;

  private initialized = false;

  private session: InspectorSession | null = null;

  private readonly cache = new Map<string, CachedLocalsEntry>();

  private collectionCountThisSecond = 0;

  private rateLimitTimer: NodeJS.Timeout | null = null;

  private cacheSweepTimer: NodeJS.Timeout | null = null;

  private debuggerIdleTimer: NodeJS.Timeout | null = null;

  private debuggerPauseActive = false;

  private readonly missedCollections: MissedCollection[] = [];

  private pauseEventsReceived = 0;

  public constructor(config: ResolvedConfig, deps: InspectorManagerDeps = {}) {
    this.maxCollectionsPerSecond = config.maxLocalsCollectionsPerSecond;
    this.maxCachedLocals = config.maxCachedLocals;
    this.maxLocalsFrames = config.maxLocalsFrames;
    this.captureLocalVariables = config.captureLocalVariables;
    this.getRequestId = deps.getRequestId ?? (() => undefined);

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
      console.warn('[ErrorCore] Debugger already attached; local variable capture disabled');
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
      }, 1000);
      this.rateLimitTimer.unref();
      this.cacheSweepTimer = setInterval(() => {
        this._sweepCache();
      }, 10000);
      this.cacheSweepTimer.unref();
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
  ): { frames: CapturedFrame[] | null; missReason: string | null } {
    if (!this.captureLocalVariables) {
      return { frames: null, missReason: null };
    }

    if (!this.available) {
      return { frames: null, missReason: 'not_available' };
    }

    this.ensureDebuggerActive();

    if (!this.initialized) {
      return { frames: null, missReason: 'not_initialized' };
    }

    const requestId = this.getRequestId() ?? '__no_context__';

    const appFrame = this._extractFirstAppFrameFromStack(error.stack);

    if (appFrame === null) {
      return { frames: null, missReason: 'no_app_frame_key' };
    }

    const key = this._buildCorrelationKey(requestId, appFrame);
    const entry = this.cache.get(key);

    if (entry !== undefined) {
      this.cache.delete(key);

      if (entry.ambiguous) {
        return { frames: null, missReason: 'ambiguous_correlation' };
      }

      if (entry.frames !== null) {
        return { frames: entry.frames, missReason: null };
      }
    }

    const recentMissSummary = this.buildMissSummary();

    return {
      frames: null,
      missReason: `cache_miss (pauses=${this.pauseEventsReceived}${recentMissSummary})`
    };
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public ensureDebuggerActive(): void {
    if (!this.available) {
      return;
    }

    if (!this.initialized && !this._initSession()) {
      return;
    }

    if (this.session === null) {
      return;
    }

    if (!this.debuggerPauseActive) {
      this.session.post(
        'Debugger.setPauseOnExceptions',
        { state: 'all' },
        () => undefined
      );
      this.debuggerPauseActive = true;
    }

    this.deactivateAfterIdle();
  }

  public shutdown(): void {
    if (this.rateLimitTimer !== null) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    if (this.cacheSweepTimer !== null) {
      clearInterval(this.cacheSweepTimer);
      this.cacheSweepTimer = null;
    }

    if (this.debuggerIdleTimer !== null) {
      clearTimeout(this.debuggerIdleTimer);
      this.debuggerIdleTimer = null;
    }

    this.cache.clear();

    if (this.session !== null) {
      try {
        if (this.debuggerPauseActive) {
          this.session.post(
            'Debugger.setPauseOnExceptions',
            { state: 'none' },
            () => undefined
          );
        }
      } catch (error) {
        console.warn('[ErrorCore] Failed to reset pause-on-exceptions during shutdown:', error instanceof Error ? error.message : String(error));
      }
      try {
        this.session.post('Debugger.disable', () => undefined);
      } catch (error) {
        console.warn('[ErrorCore] Failed to disable debugger during shutdown:', error instanceof Error ? error.message : String(error));
      }
      try {
        this.session.disconnect();
      } catch (error) {
        console.warn('[ErrorCore] Failed to disconnect inspector session during shutdown:', error instanceof Error ? error.message : String(error));
      }
    }

    this.session = null;
    this.debuggerPauseActive = false;
    this.available = false;
  }

  private recordMiss(reason: string): void {
    if (this.missedCollections.length >= MAX_MISSED_COLLECTION_LOG) {
      this.missedCollections.shift();
    }
    this.missedCollections.push({ reason, timestamp: Date.now() });
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

  private _onPaused(params: PausedEventParams): void {
    try {
      this.deactivateAfterIdle();
      this.pauseEventsReceived += 1;

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

        if (this._cacheEntryCount() >= this.maxCachedLocals) {
          this.recordMiss('cache_full');
          return;
        }

        let appFrames = params.callFrames
          .filter((frame) => this._isAppFrame(frame.url))
          .slice(0, this.maxLocalsFrames);

        if (appFrames.length === 0) {
          const hasWebpackContext = params.callFrames.some(
            (frame) => frame.url !== undefined && frame.url.startsWith('webpack-internal://')
          );

          if (hasWebpackContext) {
            appFrames = params.callFrames
              .filter((frame) =>
                this._isAppFrame(frame.url) ||
                (frame.url === '' && frame.scopeChain.some((s) => s.type === 'local'))
              )
              .slice(0, this.maxLocalsFrames);
          }

          if (appFrames.length === 0) {
            this.recordMiss('no_app_frames');
            return;
          }
        }

        const requestId = this.getRequestId() ?? '__no_context__';

        const webpackFallbackUrl = appFrames[0]?.url === ''
          ? params.callFrames.find((f) => f.url?.startsWith('webpack-internal://'))?.url
          : undefined;

        const firstAppFrame = this._toAppFrameLocation(appFrames[0], webpackFallbackUrl);

        if (firstAppFrame === null) {
          this.recordMiss('no_app_frame_key');
          return;
        }

        const key = this._buildCorrelationKey(requestId, firstAppFrame);

        if (this.cache.get(key)?.ambiguous === true) {
          this.recordMiss('ambiguous_correlation');
          return;
        }

        const collected: CapturedFrame[] = [];
        let pendingCollections = 0;
        let stored = false;

        const storeCollectedFrames = () => {
          if (stored || pendingCollections > 0) {
            return;
          }

          if (collected.length === 0) {
            this.recordMiss('empty_locals');
            return;
          }

          const existing = this.cache.get(key);

          if (existing !== undefined) {
            this.cache.set(key, {
              frames: null,
              timestamp: Date.now(),
              ambiguous: true
            });
            this.recordMiss('ambiguous_correlation');
            stored = true;
            return;
          }

          this.cache.set(key, {
            frames: collected,
            timestamp: Date.now(),
            ambiguous: false
          });

          this.collectionCountThisSecond += 1;
          stored = true;
        };

        for (const frame of appFrames) {
          const localScope = frame.scopeChain.find((scope) => scope.type === 'local');

          if (localScope?.object.objectId === undefined || this.session === null) {
            continue;
          }

          pendingCollections += 1;

          this.session.post(
            'Runtime.getProperties',
            {
              objectId: localScope.object.objectId,
              ownProperties: true
            },
            (error, result) => {
              pendingCollections -= 1;

              if (error || result === undefined) {
                storeCollectedFrames();
                return;
              }

              const properties = (result as { result?: PropertyDescriptor[] }).result;

              if (properties === undefined) {
                storeCollectedFrames();
                return;
              }

              collected.push({
                functionName: frame.functionName,
                filePath: frame.url ?? '',
                lineNumber: frame.location.lineNumber + 1,
                columnNumber: frame.location.columnNumber + 1,
                locals: this._extractLocals(properties)
              });
              storeCollectedFrames();
            }
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ErrorCore] Inspector paused handler failed: ${message}`);
      }
    } finally {
      if (this.session !== null) {
        try {
          this.session.post('Debugger.resume', () => undefined);
        } catch {
        }
      }
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
      return `[Function: ${object.description ?? 'anonymous'}]`;
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

    return `[${object.className ?? 'Object'}]`;
  }

  private _buildCorrelationKey(
    requestId: string,
    frame: AppFrameLocation
  ): string {
    return `${requestId}:${frame.filePath}:${frame.lineNumber}:${frame.columnNumber}`;
  }

  private _toAppFrameLocation(frame: CallFrame | undefined, fallbackUrl?: string): AppFrameLocation | null {
    const url = frame?.url || fallbackUrl;
    if (url === undefined || url === '') {
      return null;
    }

    return {
      filePath: this._normalizeFramePath(url),
      lineNumber: frame!.location.lineNumber + 1,
      columnNumber: frame!.location.columnNumber + 1
    };
  }

  private _extractFirstAppFrameFromStack(stack: string | undefined): AppFrameLocation | null {
    if (stack === undefined || stack === '') {
      return null;
    }

    const lines = stack.split('\n').slice(1);

    for (const line of lines) {
      const parsed = this._parseStackFrameLine(line);

      if (parsed === null || !this._isAppFrame(parsed.filePath)) {
        continue;
      }

      return parsed;
    }

    return null;
  }

  private _parseStackFrameLine(line: string): AppFrameLocation | null {
    const trimmed = line.trim();
    let location = trimmed.startsWith('at ') ? trimmed.slice(3).trim() : trimmed;

    if (location.endsWith(')')) {
      let openParenIndex = -1;

      for (let i = location.length - 1; i >= 0; i--) {
        if (location[i] === '(' && (i === 0 || location[i - 1] === ' ')) {
          openParenIndex = i;
          break;
        }
      }

      if (openParenIndex !== -1) {
        location = location.slice(openParenIndex + 1, -1);
      }
    }

    const match = location.match(/^(.*):(\d+):(\d+)$/);

    if (match === null) {
      return null;
    }

    const filePath = match[1];

    if (filePath === undefined || filePath === '') {
      return null;
    }

    return {
      filePath: this._normalizeFramePath(filePath),
      lineNumber: Number(match[2]),
      columnNumber: Number(match[3])
    };
  }

  private _normalizeFramePath(filePath: string): string {
    let normalized = filePath.replace(/^file:\/\//, '').replace(/\\/g, '/');

    const webpackMatch = normalized.match(/^webpack-internal:\/\/\/[^/]*\/(\.\/.+)$/);
    if (webpackMatch !== null) {
      normalized = webpackMatch[1];
    }

    return normalized;
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
      normalizedUrl.startsWith(`${SDK_ROOT}/`)
    );
  }

  private deactivateAfterIdle(): void {
    if (this.debuggerIdleTimer !== null) {
      clearTimeout(this.debuggerIdleTimer);
    }

    this.debuggerIdleTimer = setTimeout(() => {
      this.debuggerIdleTimer = null;

      if (!this.debuggerPauseActive || this.session === null) {
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
        this.debuggerPauseActive = false;
      }
    }, DEBUGGER_IDLE_TIMEOUT_MS);
    this.debuggerIdleTimer.unref();
  }

  private _cacheEntryCount(): number {
    return this.cache.size;
  }

  private _sweepCache(): void {
    const cutoff = Date.now() - CACHE_TTL_MS;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < cutoff) {
        this.cache.delete(key);
      }
    }
  }
}
