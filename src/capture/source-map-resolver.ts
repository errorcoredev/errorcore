
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceMapConsumer } from 'source-map-js';

interface CachedConsumer {
  consumer: SourceMapConsumer;
  usedAt: number;
}

const V8_FRAME_RE = /^(\s+at\s+)(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
const SOURCEMAP_URL_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/;
const WEBPACK_INTERNAL_RE = /^webpack-internal:\/\/\/[^/]*\/(\.\/.+)$/;
const MAX_CACHE_SIZE = 50;
// Cap .js/.map file reads. A maliciously large or simply bloated map
// would otherwise block the event loop during background warming.
const MAX_SOURCE_READ_BYTES = 4 * 1024 * 1024;
const MAX_WARM_PROMISES = 256;

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

export class SourceMapResolver {
  private readonly cache = new Map<string, CachedConsumer | null>();

  private warnedNoMaps = false;

  private readonly pendingWarms = new Set<string>();

  private warmPromises: Promise<void>[] = [];

  /**
   * Resolve stack frames using only cached source maps. No disk I/O.
   * Schedules background warming for any cache misses so subsequent
   * captures of the same file will resolve correctly.
   */
  public resolveStack(stack: string): string {
    const lines = stack.split('\n');
    const resolved: string[] = [];
    let frameCount = 0;
    let resolvedCount = 0;
    const missedPaths: string[] = [];

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

      if (!this.cache.has(effectivePath)) {
        missedPaths.push(effectivePath);
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

      const cached = this.cache.get(effectivePath)!;
      if (cached === null) {
        resolved.push(line);
        continue;
      }

      cached.usedAt = Date.now();
      const original = cached.consumer.originalPositionFor({
        line: lineNum,
        column: colNum - 1
      });

      if (original.source === null || original.line === null) {
        resolved.push(line);
        continue;
      }

      resolvedCount++;
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
      console.warn(
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

    for (const missedPath of missedPaths) {
      this.scheduleWarm(missedPath);
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

      // Only use the cache — never load from disk.
      if (!this.cache.has(effectivePath)) {
        resolved.push(line);
        continue;
      }

      const cached = this.cache.get(effectivePath)!;
      if (cached === null) {
        resolved.push(line);
        continue;
      }

      cached.usedAt = Date.now();
      const original = cached.consumer.originalPositionFor({
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

  /**
   * Pre-populate the source map cache for files already loaded by Node.
   * Called at SDK init to avoid disk I/O on the first error capture.
   */
  public warmCache(): void {
    if (typeof require === 'undefined' || require.cache === undefined) {
      return;
    }

    const filePaths = Object.keys(require.cache).filter(
      (p) => !p.includes('node_modules') && (p.endsWith('.js') || p.endsWith('.mjs'))
    );

    for (const filePath of filePaths) {
      if (this.cache.size >= MAX_CACHE_SIZE) {
        break;
      }
      // getConsumer handles caching + eviction internally
      this.getConsumer(filePath);
    }
  }

  /**
   * Schedule a background load for a source map file that was not in cache.
   * Uses setImmediate to avoid blocking the current tick.
   */
  private scheduleWarm(filePath: string): void {
    if (this.pendingWarms.has(filePath) || this.cache.has(filePath)) {
      return;
    }

    this.pendingWarms.add(filePath);
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          this.getConsumer(filePath);
        } catch {
          // Ignore — cache will store null for failures
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

  private getConsumer(filePath: string): SourceMapConsumer | null {
    if (this.cache.has(filePath)) {
      const cached = this.cache.get(filePath)!;

      if (cached !== null) {
        cached.usedAt = Date.now();
      }

      return cached?.consumer ?? null;
    }

    const consumer = this.loadConsumer(filePath);

    if (this.cache.size >= MAX_CACHE_SIZE) {
      this.evictOldest();
    }

    if (consumer === null) {
      this.cache.set(filePath, null);
    } else {
      this.cache.set(filePath, { consumer, usedAt: Date.now() });
    }

    return consumer;
  }

  private loadConsumer(filePath: string): SourceMapConsumer | null {
    try {
      const adjacentMap = filePath + '.map';

      if (fs.existsSync(adjacentMap)) {
        const raw = readIfWithinSize(adjacentMap);
        return raw === null ? null : new SourceMapConsumer(JSON.parse(raw));
      }

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const source = readIfWithinSize(filePath);
      if (source === null) {
        return null;
      }
      const lastLines = source.slice(-512);
      const match = SOURCEMAP_URL_RE.exec(lastLines);

      if (match === null) {
        return null;
      }

      const url = match[1];

      if (url.startsWith('data:')) {
        const base64Match = /base64,(.+)/.exec(url);

        if (base64Match === null) {
          return null;
        }
        // Size-cap the inline map's encoded form before decoding. A 4 MB
        // base64 blob expands to ~3 MB and is still a reasonable bound
        // for any legitimate production source map.
        if (base64Match[1].length > MAX_SOURCE_READ_BYTES) {
          return null;
        }
        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
        return new SourceMapConsumer(JSON.parse(decoded));
      }

      const baseDir = path.resolve(path.dirname(filePath));
      const mapPath = path.resolve(baseDir, url);

      // Path-traversal guard normalized through path.relative so mixed
      // slash directions (common on Windows when the sourceMappingURL
      // uses '/') do not bypass the check.
      const rel = path.relative(baseDir, mapPath);
      if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
        return null;
      }

      if (!fs.existsSync(mapPath)) {
        return null;
      }

      const raw = readIfWithinSize(mapPath);
      return raw === null ? null : new SourceMapConsumer(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry === null) {
        this.cache.delete(key);
        return;
      }

      if (entry.usedAt < oldestTime) {
        oldestTime = entry.usedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
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
