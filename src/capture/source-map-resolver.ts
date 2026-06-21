
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SourceMapConsumer } from 'source-map-js';

import { safeConsole } from '../debug-log';
import type { CapturedFrame } from '../types';

type CacheEntry =
  | {
      type: 'consumer';
      consumer: SourceMapConsumer;
      usedAt: number;
      filePath: string;
      mapPath: string;
      identityPath: string;
      contentHash: string;
      mapIdentity: SourceMapFileIdentity | null;
    }
  | { type: 'missing'; cachedAt: number; filePath: string }
  | {
      type: 'corrupt';
      reason: string;
      cachedAt: number;
      filePath: string;
      mapPath?: string;
      identityPath?: string;
      contentHash?: string;
      mapIdentity?: SourceMapFileIdentity | null;
    };

interface SourceMapFileIdentity {
  size: number;
  mtimeMs: number;
}

const V8_FRAME_RE = /^(\s+at\s+(?:async\s+)?)(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
const SOURCEMAP_URL_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/;
const WEBPACK_INTERNAL_RE = /^webpack-internal:\/\/\/[^/]*\/(\.\/.+)$/;
const SOURCE_MAPPED_PROTOCOL_RE = /^(?:webpack|webpack-internal|vite|rollup):\/\//;
const ORIGINAL_SOURCE_EXTENSION_RE = /\.(?:ts|tsx|jsx|mts|cts|vue|svelte)$/i;
const GENERATED_JS_EXTENSION_RE = /\.(?:js|mjs|cjs)$/i;
const GENERATED_BUNDLE_PATH_RE =
  /(?:^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|chunks?|server\/chunks)(?:\/|$)|(?:^|\/)[^/]*(?:bundle|chunk|min)\.m?js$/i;
const MAX_CACHE_SIZE = 128;
const MAX_TOTAL_CACHE_ENTRIES = 256;
// Cap .js/.map file reads. A maliciously large or simply bloated map
// would otherwise block the event loop during background warming.
const MAX_SOURCE_READ_BYTES = 32 * 1024 * 1024;
const MAX_WARM_PROMISES = 256;
const LOCAL_NAME_MAPPING_WINDOW_COLUMNS = 2500;
// Negative (missing/corrupt) cache entries expire after 1 hour so that
// a newly deployed source map is picked up without restarting the process.
const NEGATIVE_ENTRY_TTL_MS = 60 * 60 * 1000;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;
const IDENTIFIER_START_RE = /[A-Za-z_$]/;
const MINIFIED_LOCAL_RE = /^[A-Za-z_$][\w$]{0,2}$/;

function readIfWithinSize(filePath: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  // The bound is applied post-read. This still allocates a full-size
  // string for an oversized file, but the subsequent JSON.parse is
  // skipped, which is where the real CPU/memory cost lives. A bound on
  // the read itself would require an fd-based path and break tests
  // that mock only fs.readFileSync.
  if (contents.length > MAX_SOURCE_READ_BYTES) {
    return null;
  }
  return contents;
}

function hashSourceMap(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function getSourceMapFileIdentity(filePath: string): SourceMapFileIdentity | null {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function looksOriginalLocalName(name: string): boolean {
  return !MINIFIED_LOCAL_RE.test(name);
}

function identifierAtColumn(line: string, column: number): string | null {
  if (line.length === 0) {
    return null;
  }

  let index = Math.max(0, Math.min(column, line.length - 1));
  if (!IDENTIFIER_CHAR_RE.test(line[index]!)) {
    if (index > 0 && IDENTIFIER_CHAR_RE.test(line[index - 1]!)) {
      index -= 1;
    } else {
      let forward = index + 1;
      while (
        forward < line.length &&
        forward <= column + 2 &&
        !IDENTIFIER_CHAR_RE.test(line[forward]!)
      ) {
        forward += 1;
      }
      if (forward >= line.length || forward > column + 2) {
        return null;
      }
      index = forward;
    }
  }

  let start = index;
  while (start > 0 && IDENTIFIER_CHAR_RE.test(line[start - 1]!)) {
    start -= 1;
  }
  if (!IDENTIFIER_START_RE.test(line[start]!)) {
    return null;
  }

  let end = index + 1;
  while (end < line.length && IDENTIFIER_CHAR_RE.test(line[end]!)) {
    end += 1;
  }

  return line.slice(start, end);
}

function detectV8SourceMapFlag(): boolean {
  const inExecArgv = process.execArgv.some(
    (a) => a === '--enable-source-maps' || a.startsWith('--enable-source-maps=')
  );
  if (inExecArgv) return true;
  const opts = process.env.NODE_OPTIONS ?? '';
  // Match --enable-source-maps as a standalone flag or as `=value`. The
  // trailing-context group (\s|=|$) prevents false-matching speculative
  // future flags like --enable-source-maps-pretty.
  return /(^|\s)--enable-source-maps(\s|=|$)/.test(opts);
}

export class SourceMapResolver {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly pathToCacheKey = new Map<string, string>();

  private readonly sourceLinesCache = new Map<string, string[] | null>();

  private readonly syncThresholdBytes: number;

  /**
   * When V8 is already resolving source maps via --enable-source-maps,
   * resolveStack short-circuits to a no-op so we don't double-resolve and
   * waste CPU. The flag is captured once at construction.
   */
  private readonly v8ResolvesSourceMaps: boolean = detectV8SourceMapFlag();

  private warnedNoMaps = false;

  private readonly pendingWarms = new Set<string>();

  private warmPromises: Promise<void>[] = [];

  private telemetry = {
    framesResolved: 0,
    framesUnresolved: 0,
    cacheHits: 0,
    cacheMisses: 0,
    missing: 0,
    corrupt: 0,
    evictions: 0
  };

  public constructor(options?: { sourceMapSyncThresholdBytes?: number }) {
    this.syncThresholdBytes = options?.sourceMapSyncThresholdBytes ?? 2 * 1024 * 1024;
  }

  /**
   * Resolve stack frames using source maps. On cache miss, loads synchronously
   * if the adjacent .map file is within the syncThresholdBytes limit; otherwise
   * schedules a background warm for the next capture.
   */
  public resolveStack(stack: string): string {
    // If V8 already rewrote the stack, avoid a second source-map pass. In some
    // bundled production paths V8 leaves generated locations intact even with
    // --enable-source-maps, so only skip when frames look like original sources.
    if (this.v8ResolvesSourceMaps && this.stackAppearsAlreadySourceMapped(stack)) {
      return stack;
    }
    return this._resolveStackImpl(stack);
  }

  private stackAppearsAlreadySourceMapped(stack: string): boolean {
    let sawFrame = false;
    let sawAppFrame = false;

    for (const line of stack.split('\n')) {
      const match = V8_FRAME_RE.exec(line);
      if (match === null) {
        continue;
      }

      sawFrame = true;
      const filePath = this.normalizeWebpackPath(match[3]!);

      if (this.isExternalFramePath(filePath)) {
        continue;
      }

      sawAppFrame = true;
      if (!this.framePathAppearsSourceMapped(filePath)) {
        return false;
      }
    }

    return !sawFrame || sawAppFrame;
  }

  private framePathAppearsSourceMapped(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    if (SOURCE_MAPPED_PROTOCOL_RE.test(normalized)) {
      return true;
    }

    if (ORIGINAL_SOURCE_EXTENSION_RE.test(this.stripQueryAndHash(normalized))) {
      return true;
    }

    if (this.hasAdjacentSourceMap(normalized)) {
      return false;
    }

    if (this.isLikelyGeneratedBundlePath(normalized)) {
      return false;
    }

    if (!this.isAbsoluteFramePath(normalized)) {
      return true;
    }

    return !GENERATED_JS_EXTENSION_RE.test(this.stripQueryAndHash(normalized)) ||
      /(?:^|\/)(?:src|lib|routes|controllers|models|services|handlers|middleware)(?:\/|$)/.test(
        normalized
      );
  }

  private isExternalFramePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.startsWith('node:') ||
      normalized.includes('node:internal') ||
      normalized.includes('/node_modules/');
  }

  private hasAdjacentSourceMap(filePath: string): boolean {
    const cached = this.peekCachedEntry(filePath);
    if (cached?.type === 'consumer') {
      return true;
    }

    try {
      return fs.existsSync(filePath + '.map');
    } catch {
      return false;
    }
  }

  private isLikelyGeneratedBundlePath(filePath: string): boolean {
    const withoutQuery = this.stripQueryAndHash(filePath);
    return GENERATED_JS_EXTENSION_RE.test(withoutQuery) && GENERATED_BUNDLE_PATH_RE.test(withoutQuery);
  }

  private isAbsoluteFramePath(filePath: string): boolean {
    if (/^[a-zA-Z]:\//.test(filePath)) {
      return true;
    }

    if (filePath.startsWith('file://')) {
      return true;
    }

    return path.isAbsolute(filePath);
  }

  private stripQueryAndHash(filePath: string): string {
    return filePath.split(/[?#]/, 1)[0] ?? filePath;
  }

  private _resolveStackImpl(stack: string): string {
    const lines = stack.split('\n');
    const resolved: string[] = [];
    let frameCount = 0;
    let resolvedCount = 0;

    for (const line of lines) {
      const match = V8_FRAME_RE.exec(line);

      if (match === null) {
        resolved.push(line);
        continue;
      }

      const [, indent, funcName, filePath, lineStr, colStr] = match;
      const lineNum = parseInt(lineStr, 10);
      const colNum = parseInt(colStr, 10);

      frameCount++;

      const effectivePath = this.normalizeWebpackPath(filePath);

      let entry = this.getCachedEntry(effectivePath);

      if (entry === undefined) {
        this.telemetry.cacheMisses++;
        if (this.fileSizeUnderThreshold(effectivePath)) {
          entry = this.getConsumer(effectivePath) ?? undefined;
        } else {
          this.scheduleWarm(effectivePath);
        }
      }

      entry ??= this.getCachedEntry(effectivePath);

      if (entry === undefined) {
        if (effectivePath !== filePath) {
          if (funcName) {
            resolved.push(`${indent}${funcName} (${effectivePath}:${lineStr}:${colStr})`);
          } else {
            resolved.push(`${indent}${effectivePath}:${lineStr}:${colStr}`);
          }
        } else {
          resolved.push(line);
        }
        continue;
      }

      if (entry.type === 'missing') {
        this.telemetry.cacheHits++;
        this.telemetry.missing++;
        resolved.push(line);
        continue;
      }

      if (entry.type === 'corrupt') {
        this.telemetry.cacheHits++;
        this.telemetry.corrupt++;
        resolved.push(line);
        continue;
      }

      this.telemetry.cacheHits++;
      entry.usedAt = Date.now();
      const original = entry.consumer.originalPositionFor({
        line: lineNum,
        column: colNum - 1
      });

      if (original.source === null || original.line === null) {
        this.telemetry.framesUnresolved++;
        resolved.push(line);
        continue;
      }

      resolvedCount++;
      this.telemetry.framesResolved++;
      const resolvedFunc = original.name ?? funcName;
      const resolvedCol = (original.column ?? 0) + 1;
      const resolvedSource = original.source;

      if (resolvedFunc) {
        resolved.push(`${indent}${resolvedFunc} (${resolvedSource}:${original.line}:${resolvedCol})`);
      } else {
        resolved.push(`${indent}${resolvedSource}:${original.line}:${resolvedCol}`);
      }
    }

    if (!this.warnedNoMaps && resolvedCount === 0 && frameCount > 0) {
      this.warnedNoMaps = true;
      safeConsole.warn(
        '[ErrorCore] No source maps found for captured stack traces. ' +
        'Stack frames will reference minified/bundled locations.\n' +
        'If you use a bundler (webpack, esbuild, Next.js, etc.), configure it to emit ' +
        'server-side source maps. For Next.js, add to next.config.mjs:\n' +
        '  webpack: (config, { isServer }) => {\n' +
        '    if (isServer) config.devtool = "source-map";\n' +
        '    return config;\n' +
        '  },'
      );
    }

    return resolved.join('\n');
  }

  /**
   * Resolve stack frames using only cached source maps. No disk I/O.
   * Used on the uncaughtException path where blocking is unacceptable.
   * Returns the raw frame for any cache miss.
   */
  public resolveStackCacheOnly(stack: string): string {
    const lines = stack.split('\n');
    const resolved: string[] = [];

    for (const line of lines) {
      const match = V8_FRAME_RE.exec(line);

      if (match === null) {
        resolved.push(line);
        continue;
      }

      const [, indent, funcName, filePath, lineStr, colStr] = match;
      const lineNum = parseInt(lineStr, 10);
      const colNum = parseInt(colStr, 10);

      const effectivePath = this.normalizeWebpackPath(filePath);

      const entry = this.peekCachedEntry(effectivePath);
      if (entry === undefined) {
        resolved.push(line);
        continue;
      }

      if (entry.type === 'missing' || entry.type === 'corrupt') {
        resolved.push(line);
        continue;
      }

      entry.usedAt = Date.now();
      const original = entry.consumer.originalPositionFor({
        line: lineNum,
        column: colNum - 1
      });

      if (original.source === null || original.line === null) {
        resolved.push(line);
        continue;
      }

      const resolvedFunc = original.name ?? funcName;
      const resolvedCol = (original.column ?? 0) + 1;

      if (resolvedFunc) {
        resolved.push(`${indent}${resolvedFunc} (${original.source}:${original.line}:${resolvedCol})`);
      } else {
        resolved.push(`${indent}${original.source}:${original.line}:${resolvedCol}`);
      }
    }

    return resolved.join('\n');
  }

  public resolveCapturedFrames(frames: CapturedFrame[] | null): CapturedFrame[] | null {
    if (frames === null) {
      return null;
    }

    return frames.map((frame) => this.resolveCapturedFrame(frame));
  }

  public resolveCapturedFrame(frame: CapturedFrame): CapturedFrame {
    const effectivePath = this.normalizeWebpackPath(frame.filePath);
    let entry = this.getCachedEntry(effectivePath);

    if (entry === undefined) {
      this.telemetry.cacheMisses++;
      if (this.fileSizeUnderThreshold(effectivePath)) {
        entry = this.getConsumer(effectivePath) ?? undefined;
      } else {
        this.scheduleWarm(effectivePath);
      }
    }

    entry ??= this.getCachedEntry(effectivePath);

    if (entry === undefined || entry.type === 'missing' || entry.type === 'corrupt') {
      return frame;
    }

    this.telemetry.cacheHits++;
    entry.usedAt = Date.now();
    const original = entry.consumer.originalPositionFor({
      line: frame.lineNumber,
      column: Math.max(0, frame.columnNumber - 1)
    });

    let resolved = frame;
    if (original.source !== null && original.line !== null) {
      this.telemetry.framesResolved++;
      resolved = {
        ...resolved,
        functionName: original.name ?? resolved.functionName,
        filePath: original.source,
        lineNumber: original.line,
        columnNumber: (original.column ?? 0) + 1
      };
    } else {
      this.telemetry.framesUnresolved++;
    }

    const renamedLocals = this.resolveLocalNames(entry.consumer, effectivePath, frame, {
      source: original.source,
      line: original.line
    });
    if (renamedLocals !== frame.locals) {
      resolved = {
        ...resolved,
        locals: renamedLocals
      };
    }

    return resolved;
  }

  /**
   * Pre-populate the source map cache for files already loaded by Node.
   * Called at SDK init to avoid disk I/O on the first error capture.
   */
  public warmCache(): void {
    if (typeof require === 'undefined' || require.cache === undefined) {
      return;
    }

    const filePaths = Object.keys(require.cache).filter(
      (p) =>
        !p.includes('node_modules') &&
        (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs'))
    );

    for (const filePath of filePaths) {
      if (this._countConsumers() >= MAX_CACHE_SIZE) {
        break;
      }
      this.getConsumer(filePath);
    }
  }

  /**
   * Return telemetry counters and reset them to zero.
   */
  public consumeTelemetry(): {
    framesResolved: number;
    framesUnresolved: number;
    cacheHits: number;
    cacheMisses: number;
    missing: number;
    corrupt: number;
    evictions: number;
  } {
    const snapshot = { ...this.telemetry };
    this.telemetry.framesResolved = 0;
    this.telemetry.framesUnresolved = 0;
    this.telemetry.cacheHits = 0;
    this.telemetry.cacheMisses = 0;
    this.telemetry.missing = 0;
    this.telemetry.corrupt = 0;
    this.telemetry.evictions = 0;
    return snapshot;
  }

  /**
   * Schedule a background load for a source map file that was not in cache.
   * Uses setImmediate to avoid blocking the current tick.
   * Used by Task 16's async path and by warmCache.
   */
  protected scheduleWarm(filePath: string): void {
    this._sweepCache();
    if (this.pendingWarms.has(filePath) || this.peekCachedEntry(filePath) !== undefined) {
      return;
    }

    this.pendingWarms.add(filePath);
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          this.getConsumer(filePath);
        } catch {
          // Ignore - cache will store missing/corrupt for failures
        } finally {
          this.pendingWarms.delete(filePath);
          resolve();
        }
      });
    });

    // Bound the backlog of outstanding warms. In a long-running process
    // with many distinct source files and no flushWarmQueue() awaiter,
    // the array would otherwise grow without limit.
    if (this.warmPromises.length >= MAX_WARM_PROMISES) {
      this.warmPromises.shift();
    }
    this.warmPromises.push(promise);
  }

  /**
   * Await all pending background warm operations. Called during shutdown.
   */
  public async flushWarmQueue(): Promise<void> {
    if (this.warmPromises.length === 0) {
      return;
    }
    await Promise.allSettled(this.warmPromises);
    this.warmPromises = [];
  }

  private getConsumer(filePath: string): CacheEntry | null {
    if (!filePath) {
      return null;
    }

    const cached = this.getCachedEntry(filePath);
    if (cached !== undefined) {
      return cached;
    }

    const loaded = this.loadConsumer(filePath);

    if (loaded === null) {
      return null;
    }

    const existing = this.cache.get(loaded.cacheKey);
    if (existing !== undefined) {
      this.pathToCacheKey.set(filePath, loaded.cacheKey);
      return existing;
    }

    // Only evict when consumer entries would overflow. Missing/corrupt are
    // lightweight and expire by TTL; they do not count against the LRU cap.
    if (loaded.entry.type === 'consumer' && this._countConsumers() >= MAX_CACHE_SIZE) {
      this.evictOldest();
    }

    this.cache.set(loaded.cacheKey, loaded.entry);
    this.pathToCacheKey.set(filePath, loaded.cacheKey);
    this.enforceMaxEntries();
    return loaded.entry;
  }

  private loadConsumer(filePath: string): { cacheKey: string; entry: CacheEntry } | null {
    try {
      const adjacentMap = filePath + '.map';

      if (fs.existsSync(adjacentMap)) {
        const raw = readIfWithinSize(adjacentMap);
        if (raw === null) {
          return {
            cacheKey: `corrupt:${adjacentMap}:unreadable`,
            entry: {
              type: 'corrupt',
              reason: 'map file too large or unreadable',
              cachedAt: Date.now(),
              filePath,
              mapPath: adjacentMap,
              identityPath: adjacentMap,
              mapIdentity: getSourceMapFileIdentity(adjacentMap)
            }
          };
        }
        const contentHash = hashSourceMap(raw);
        const cacheKey = this.makeSourceMapCacheKey(adjacentMap, contentHash);
        try {
          const consumer = new SourceMapConsumer(JSON.parse(raw));
          return {
            cacheKey,
            entry: {
              type: 'consumer',
              consumer,
              usedAt: Date.now(),
              filePath,
              mapPath: adjacentMap,
              identityPath: adjacentMap,
              contentHash,
              mapIdentity: getSourceMapFileIdentity(adjacentMap)
            }
          };
        } catch (e) {
          return {
            cacheKey: `corrupt:${adjacentMap}:${contentHash}`,
            entry: {
              type: 'corrupt',
              reason: String(e),
              cachedAt: Date.now(),
              filePath,
              mapPath: adjacentMap,
              identityPath: adjacentMap,
              contentHash,
              mapIdentity: getSourceMapFileIdentity(adjacentMap)
            }
          };
        }
      }

      if (!fs.existsSync(filePath)) {
        return {
          cacheKey: `missing:${filePath}`,
          entry: { type: 'missing', cachedAt: Date.now(), filePath }
        };
      }

      const source = readIfWithinSize(filePath);
      if (source === null) {
        return {
          cacheKey: `missing:${filePath}:unreadable`,
          entry: { type: 'missing', cachedAt: Date.now(), filePath }
        };
      }
      const lastLines = source.slice(-512);
      const match = SOURCEMAP_URL_RE.exec(lastLines);

      if (match === null) {
        return {
          cacheKey: `missing:${filePath}:no-url`,
          entry: { type: 'missing', cachedAt: Date.now(), filePath }
        };
      }

      const url = match[1];

      if (url.startsWith('data:')) {
        const base64Match = /base64,(.+)/.exec(url);

        if (base64Match === null) {
          return {
            cacheKey: `corrupt:${filePath}:inline-missing-base64`,
            entry: {
              type: 'corrupt',
              reason: 'data: URL missing base64 payload',
              cachedAt: Date.now(),
              filePath,
              mapPath: `${filePath}#inline`,
              identityPath: filePath,
              mapIdentity: getSourceMapFileIdentity(filePath)
            }
          };
        }
        // Size-cap the inline map's encoded form before decoding. A 4 MB
        // base64 blob expands to ~3 MB and is still a reasonable bound
        // for any legitimate production source map.
        if (base64Match[1].length > MAX_SOURCE_READ_BYTES) {
          return {
            cacheKey: `corrupt:${filePath}:inline-too-large`,
            entry: {
              type: 'corrupt',
              reason: 'inline source map exceeds size limit',
              cachedAt: Date.now(),
              filePath,
              mapPath: `${filePath}#inline`,
              identityPath: filePath,
              mapIdentity: getSourceMapFileIdentity(filePath)
            }
          };
        }
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
        const contentHash = hashSourceMap(decoded);
        const cacheKey = this.makeSourceMapCacheKey(`${filePath}#inline`, contentHash);
        try {
          const consumer = new SourceMapConsumer(JSON.parse(decoded));
          return {
            cacheKey,
            entry: {
              type: 'consumer',
              consumer,
              usedAt: Date.now(),
              filePath,
              mapPath: `${filePath}#inline`,
              identityPath: filePath,
              contentHash,
              mapIdentity: getSourceMapFileIdentity(filePath)
            }
          };
        } catch (e) {
          return {
            cacheKey: `corrupt:${filePath}#inline:${contentHash}`,
            entry: {
              type: 'corrupt',
              reason: String(e),
              cachedAt: Date.now(),
              filePath,
              mapPath: `${filePath}#inline`,
              identityPath: filePath,
              contentHash,
              mapIdentity: getSourceMapFileIdentity(filePath)
            }
          };
        }
      }

      const baseDir = path.resolve(path.dirname(filePath));
      const mapPath = path.resolve(baseDir, url);

      // Path-traversal guard normalized through path.relative so mixed
      // slash directions (common on Windows when the sourceMappingURL
      // uses '/') do not bypass the check.
      const rel = path.relative(baseDir, mapPath);
      if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
        return {
          cacheKey: `missing:${filePath}:traversal`,
          entry: { type: 'missing', cachedAt: Date.now(), filePath }
        };
      }

      if (!fs.existsSync(mapPath)) {
        return {
          cacheKey: `missing:${mapPath}`,
          entry: { type: 'missing', cachedAt: Date.now(), filePath }
        };
      }

      const raw = readIfWithinSize(mapPath);
      if (raw === null) {
        return {
          cacheKey: `corrupt:${mapPath}:unreadable`,
          entry: {
            type: 'corrupt',
            reason: 'map file too large or unreadable',
            cachedAt: Date.now(),
            filePath,
            mapPath,
            identityPath: mapPath,
            mapIdentity: getSourceMapFileIdentity(mapPath)
          }
        };
      }
      const contentHash = hashSourceMap(raw);
      const cacheKey = this.makeSourceMapCacheKey(mapPath, contentHash);
      try {
        const consumer = new SourceMapConsumer(JSON.parse(raw));
        return {
          cacheKey,
          entry: {
            type: 'consumer',
            consumer,
            usedAt: Date.now(),
            filePath,
            mapPath,
            identityPath: mapPath,
            contentHash,
            mapIdentity: getSourceMapFileIdentity(mapPath)
          }
        };
      } catch (e) {
        return {
          cacheKey: `corrupt:${mapPath}:${contentHash}`,
          entry: {
            type: 'corrupt',
            reason: String(e),
            cachedAt: Date.now(),
            filePath,
            mapPath,
            identityPath: mapPath,
            contentHash,
            mapIdentity: getSourceMapFileIdentity(mapPath)
          }
        };
      }
    } catch (e) {
      return {
        cacheKey: `corrupt:${filePath}:exception`,
        entry: { type: 'corrupt', reason: String(e), cachedAt: Date.now(), filePath }
      };
    }
  }

  private makeSourceMapCacheKey(mapPath: string, contentHash: string): string {
    return `${mapPath}:${contentHash}`;
  }

  private resolveLocalNames(
    consumer: SourceMapConsumer,
    generatedFilePath: string,
    frame: CapturedFrame,
    original: { source: string | null; line: number | null }
  ): Record<string, unknown> {
    const localNames = Object.keys(frame.locals);
    const minifiedNames = new Set(localNames.filter((name) => MINIFIED_LOCAL_RE.test(name)));
    if (minifiedNames.size === 0) {
      return frame.locals;
    }

    const generatedLine = this.readGeneratedLine(generatedFilePath, frame.lineNumber);
    if (generatedLine === null) {
      return frame.locals;
    }

    const candidates = new Map<string, Array<{
      originalName: string;
      generatedDistance: number;
      originalLineDistance: number;
    }>>();
    const frameColumnZeroBased = Math.max(0, frame.columnNumber - 1);
    const minColumn = Math.max(0, frameColumnZeroBased - LOCAL_NAME_MAPPING_WINDOW_COLUMNS);
    const maxColumn = frameColumnZeroBased + LOCAL_NAME_MAPPING_WINDOW_COLUMNS;

    consumer.eachMapping((mapping) => {
      if (
        mapping.generatedLine !== frame.lineNumber ||
        mapping.name === null ||
        mapping.generatedColumn < minColumn ||
        mapping.generatedColumn > maxColumn
      ) {
        return;
      }

      if (original.source !== null && mapping.source !== original.source) {
        return;
      }

      if (
        original.line !== null &&
        mapping.originalLine !== null &&
        mapping.originalLine > original.line + 2
      ) {
        return;
      }

      if (!looksOriginalLocalName(mapping.name)) {
        return;
      }

      const generatedName = identifierAtColumn(generatedLine, mapping.generatedColumn);
      if (generatedName === null || !minifiedNames.has(generatedName)) {
        return;
      }

      const originalLineDistance =
        original.line === null || mapping.originalLine === null
          ? 0
          : Math.abs(original.line - mapping.originalLine);
      const bucket = candidates.get(generatedName) ?? [];
      bucket.push({
        originalName: mapping.name,
        generatedDistance: Math.abs(mapping.generatedColumn - frameColumnZeroBased),
        originalLineDistance
      });
      candidates.set(generatedName, bucket);
    });

    if (candidates.size === 0) {
      return frame.locals;
    }

    let changed = false;
    const renamed: Record<string, unknown> = {};
    const usedNames = new Set(localNames);
    for (const [name, value] of Object.entries(frame.locals)) {
      const options = candidates.get(name);
      if (options === undefined || options.length === 0) {
        renamed[name] = value;
        continue;
      }

      options.sort((a, b) =>
        a.originalLineDistance - b.originalLineDistance ||
        a.generatedDistance - b.generatedDistance ||
        a.originalName.localeCompare(b.originalName)
      );

      const selected = options.find((option) => !usedNames.has(option.originalName));
      if (selected === undefined) {
        renamed[name] = value;
        continue;
      }

      renamed[selected.originalName] = value;
      usedNames.add(selected.originalName);
      changed = true;
    }

    return changed ? renamed : frame.locals;
  }

  private readGeneratedLine(filePath: string, lineNumber: number): string | null {
    if (lineNumber < 1) {
      return null;
    }

    const cached = this.sourceLinesCache.get(filePath);
    if (cached !== undefined) {
      if (cached === null) {
        return null;
      }
      return cached[lineNumber - 1] ?? null;
    }

    const source = readIfWithinSize(filePath);
    if (source === null) {
      this.sourceLinesCache.set(filePath, null);
      return null;
    }

    const lines = source.split(/\r?\n/);
    this.sourceLinesCache.set(filePath, lines);
    while (this.sourceLinesCache.size > MAX_CACHE_SIZE) {
      const oldestKey = this.sourceLinesCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.sourceLinesCache.delete(oldestKey);
    }

    return lines[lineNumber - 1] ?? null;
  }

  private peekCachedEntry(filePath: string): CacheEntry | undefined {
    const cacheKey = this.pathToCacheKey.get(filePath);
    if (cacheKey === undefined) {
      return undefined;
    }

    const entry = this.cache.get(cacheKey);
    if (entry === undefined) {
      this.pathToCacheKey.delete(filePath);
    }
    return entry;
  }

  private getCachedEntry(filePath: string): CacheEntry | undefined {
    this._sweepCache();
    const cacheKey = this.pathToCacheKey.get(filePath);
    if (cacheKey === undefined) {
      return undefined;
    }

    const entry = this.cache.get(cacheKey);
    if (entry === undefined) {
      this.pathToCacheKey.delete(filePath);
      return undefined;
    }

    if (entry.type === 'missing' || entry.type === 'corrupt') {
      if (Date.now() - entry.cachedAt > NEGATIVE_ENTRY_TTL_MS) {
        this.deleteCacheKey(cacheKey);
        return undefined;
      }

      if (!this.isCacheIdentityCurrent(entry)) {
        this.deleteCacheKey(cacheKey);
        return undefined;
      }

      return entry;
    }

    if (!this.isCacheIdentityCurrent(entry)) {
      this.deleteCacheKey(cacheKey);
      return undefined;
    }

    entry.usedAt = Date.now();
    return entry;
  }

  private isCacheIdentityCurrent(entry: CacheEntry): boolean {
    const identityPath = entry.type === 'missing' ? undefined : entry.identityPath;
    const expected = entry.type === 'missing' ? undefined : entry.mapIdentity;

    if (identityPath === undefined || expected === undefined || expected === null) {
      return true;
    }

    const current = getSourceMapFileIdentity(identityPath);
    return current !== null &&
      current.size === expected.size &&
      current.mtimeMs === expected.mtimeMs;
  }

  private deleteCacheKey(cacheKey: string): void {
    this.cache.delete(cacheKey);
    for (const [filePath, mappedKey] of this.pathToCacheKey.entries()) {
      if (mappedKey === cacheKey) {
        this.pathToCacheKey.delete(filePath);
      }
    }
  }

  private getEntryTime(entry: CacheEntry): number {
    return entry.type === 'consumer' ? entry.usedAt : entry.cachedAt;
  }

  private enforceMaxEntries(): void {
    while (this.cache.size > MAX_TOTAL_CACHE_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, entry] of this.cache.entries()) {
        const time = this.getEntryTime(entry);
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = key;
        }
      }

      if (oldestKey === null) {
        return;
      }

      this.deleteCacheKey(oldestKey);
      this.telemetry.evictions++;
    }
  }

  private _countConsumers(): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (entry.type === 'consumer') count++;
    }
    return count;
  }

  /**
   * Evict the least-recently-used consumer entry from the cache.
   * Missing/corrupt entries are not evicted here - they expire by TTL.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.type === 'consumer' && entry.usedAt < oldestTime) {
        oldestTime = entry.usedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.deleteCacheKey(oldestKey);
      this.telemetry.evictions++;
    }
  }

  /**
   * Sweep expired negative entries from the cache. Called lazily.
   */
  protected _sweepCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if ((entry.type === 'missing' || entry.type === 'corrupt') &&
          now - entry.cachedAt > NEGATIVE_ENTRY_TTL_MS) {
        this.deleteCacheKey(key);
      }
    }
  }

  protected fileSizeUnderThreshold(filePath: string): boolean {
    if (this.syncThresholdBytes <= 0) return false;
    const adjacentMap = filePath + '.map';
    try {
      const s = fs.statSync(adjacentMap);
      return s.size <= this.syncThresholdBytes;
    } catch {
      return false;
    }
  }

  private normalizeWebpackPath(filePath: string): string {
    const match = WEBPACK_INTERNAL_RE.exec(filePath);
    if (match !== null) {
      return path.resolve(match[1]);
    }
    return filePath;
  }
}
