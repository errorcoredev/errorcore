
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceMapConsumer } from 'source-map-js';

interface CachedConsumer {
  consumer: SourceMapConsumer;
  usedAt: number;
}

const V8_FRAME_RE = /^(\s+at\s+)(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
const SOURCEMAP_URL_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/;
const MAX_CACHE_SIZE = 50;

export class SourceMapResolver {
  private readonly cache = new Map<string, CachedConsumer | null>();

  public resolveStack(stack: string): string {
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

      const consumer = this.getConsumer(filePath);

      if (consumer === null) {
        resolved.push(line);
        continue;
      }

      const original = consumer.originalPositionFor({
        line: lineNum,
        column: colNum - 1
      });

      if (original.source === null || original.line === null) {
        resolved.push(line);
        continue;
      }

      const resolvedFunc = original.name ?? funcName;
      const resolvedCol = (original.column ?? 0) + 1;
      const resolvedSource = original.source;

      if (resolvedFunc) {
        resolved.push(`${indent}${resolvedFunc} (${resolvedSource}:${original.line}:${resolvedCol})`);
      } else {
        resolved.push(`${indent}${resolvedSource}:${original.line}:${resolvedCol}`);
      }
    }

    return resolved.join('\n');
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
        const raw = fs.readFileSync(adjacentMap, 'utf8');
        return new SourceMapConsumer(JSON.parse(raw));
      }

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const source = fs.readFileSync(filePath, 'utf8');
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

        const decoded = Buffer.from(base64Match[1], 'base64').toString('utf8');
        return new SourceMapConsumer(JSON.parse(decoded));
      }

      const mapPath = path.resolve(path.dirname(filePath), url);

      if (!fs.existsSync(mapPath)) {
        return null;
      }

      const raw = fs.readFileSync(mapPath, 'utf8');
      return new SourceMapConsumer(JSON.parse(raw));
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
}
