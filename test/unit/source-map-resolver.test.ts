import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSync,
  readFileSync,
  realExistsSyncHolder,
  realReadFileSyncHolder
} = vi.hoisted(() => {
  const realExistsSyncHolder: { fn?: (typeof import('node:fs'))['existsSync'] } = {};
  const realReadFileSyncHolder: { fn?: (typeof import('node:fs'))['readFileSync'] } = {};
  return {
    existsSync: vi.fn<(p: string) => boolean>(),
    readFileSync: vi.fn<(p: string, enc?: string) => string>(),
    realExistsSyncHolder,
    realReadFileSyncHolder
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  realExistsSyncHolder.fn = actual.existsSync;
  realReadFileSyncHolder.fn = actual.readFileSync;
  return { ...actual, existsSync, readFileSync };
});

import { SourceMapResolver } from '../../src/capture/source-map-resolver';

// Real source maps generated via SourceMapGenerator.
// Maps generated lines 1, 10, and 20 to original.ts line 5, column 10, name 'myFunc'.
const NAMED_SOURCEMAP_JSON = JSON.stringify({
  version: 3,
  sources: ['original.ts'],
  names: ['myFunc'],
  mappings: 'AAIUA;;;;;;;;;IAAAA;;;;;;;;;;EAAAA',
  file: 'bundle.js'
});

// Maps generated line 20 col 2 to original.ts line 5, column 10, no name.
const NAMELESS_SOURCEMAP_JSON = JSON.stringify({
  version: 3,
  sources: ['original.ts'],
  names: [],
  mappings: ';;;;;;;;;;;;;;;;;;;EAIU',
  file: 'bundle.js'
});

describe('SourceMapResolver', () => {
  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveStack – passthrough behavior', () => {
    it('passes non-frame lines through unchanged', () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();
      const stack = 'Error: something broke\n    at Object.<anonymous> (/app/index.js:1:1)';
      const result = resolver.resolveStack(stack);

      expect(result.split('\n')[0]).toBe('Error: something broke');
    });

    it('passes frames through when no source map is found', () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();
      const frame = '    at myFunc (/app/dist/bundle.js:10:5)';
      const stack = `Error: oops\n${frame}`;
      const result = resolver.resolveStack(stack);

      expect(result).toContain(frame);
    });

    it('preserves the full stack when no frames match the V8 pattern', () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();
      const stack = 'Error: test\nsome random text\nanother line';
      const result = resolver.resolveStack(stack);

      expect(result).toBe(stack);
    });
  });

  describe('resolveStack – source map resolution', () => {
    it('resolves frames when an adjacent .map file exists', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      // Frame at line 10, col 5 => originalPositionFor({line:10, column:4})
      // => { source: 'original.ts', line: 5, column: 10, name: 'myFunc' }
      const stack = 'Error: boom\n    at minified (/app/dist/bundle.js:10:5)';
      // First call: cache miss. statSync fails (mock path) → schedules async warm.
      resolver.resolveStack(stack);
      // Wait for background warm to complete.
      await resolver.flushWarmQueue();
      // Second call uses the now-populated cache.
      const result = resolver.resolveStack(stack);

      expect(result).toContain('original.ts:5:11');
      expect(result).toContain('myFunc');
    });

    it('uses the original function name from the source map', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      // Frame at line 20, col 3 => originalPositionFor({line:20, column:2})
      // => { source: 'original.ts', line: 5, column: 10, name: 'myFunc' }
      const stack = 'Error: test\n    at minifiedName (/app/dist/bundle.js:20:3)';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      expect(result).toContain('myFunc (original.ts:5:11)');
    });

    it('formats frames without a function name correctly', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMELESS_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      // Anonymous frame at line 20, col 3 => originalPositionFor({line:20, column:2})
      // => { source: 'original.ts', line: 5, column: 10, name: null }
      const stack = 'Error: test\n    at /app/dist/bundle.js:20:3';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      const resolvedLine = result.split('\n')[1];
      expect(resolvedLine).toBe('    at original.ts:5:11');
    });

    it('passes the frame through when the source map has no mapping for the position', () => {
      // Nameless map only maps line 20 col 2. Line 999 has no mapping.
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMELESS_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      const frame = '    at fn (/app/dist/bundle.js:999:1)';
      const result = resolver.resolveStack(`Error\n${frame}`);

      expect(result).toContain(frame);
    });
  });

  describe('cache behavior', () => {
    it('does not re-read the file on the second call for the same path', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      const stack = 'Error\n    at fn (/app/dist/bundle.js:1:1)';

      // First call: cache miss, statSync fails (mock path) → schedules async warm
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const firstCallCount = readFileSync.mock.calls.length;

      // Second call should use cache, no new reads
      resolver.resolveStack(stack);
      expect(readFileSync.mock.calls.length).toBe(firstCallCount);
    });

    it('caches null results so the filesystem is not re-checked', async () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();
      const stack = 'Error\n    at fn (/app/dist/missing.js:1:1)';

      // First call: cache miss → schedules async warm → warm caches missing entry
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const firstExistsCount = existsSync.mock.calls.length;

      // Second call should use cached missing entry, no new filesystem checks
      resolver.resolveStack(stack);
      expect(existsSync.mock.calls.length).toBe(firstExistsCount);
    });
  });

  describe('V8 frame parsing', () => {
    it('parses named function frames: "    at func (/path/file.js:10:5)"', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      // line:10, col:5 in frame => resolver passes {line:10, column:4} to consumer
      const stack = 'Error\n    at func (/path/file.js:10:5)';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      expect(result).toContain('myFunc (original.ts:5:11)');
    });

    it('parses anonymous frames: "    at /path/file.js:10:5"', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      const stack = 'Error\n    at /path/file.js:10:5';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      // name='myFunc' from the map
      expect(result).toContain('myFunc (original.ts:5:11)');
    });
  });

  describe('path traversal guard', () => {
    it('rejects sourceMappingURL containing "../" traversal', () => {
      const sourceContent = 'var x = 1;\n//# sourceMappingURL=../../etc/passwd';

      existsSync.mockImplementation((p: string) => {
        if (p.endsWith('.map')) return false;
        return true;
      });
      readFileSync.mockReturnValue(sourceContent);

      const resolver = new SourceMapResolver();
      const frame = '    at fn (/app/dist/bundle.js:1:1)';
      const result = resolver.resolveStack(`Error\n${frame}`);

      // The traversal URL should be rejected; frame passes through unchanged
      expect(result).toContain(frame);
    });

    it('allows sourceMappingURL within the same directory', async () => {
      const sourceContent = 'var x = 1;\n//# sourceMappingURL=bundle.js.map';

      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.map')) return NAMED_SOURCEMAP_JSON;
        return sourceContent;
      });

      const resolver = new SourceMapResolver();
      // Line 1, col 1 => originalPositionFor({line:1, column:0})
      // => { source: 'original.ts', line: 5, column: 10, name: 'myFunc' }
      const stack = 'Error\n    at fn (/app/dist/bundle.js:1:1)';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      expect(result).toContain('original.ts:5:11');
    });

    it('rejects sourceMappingURL that resolves outside the base directory', () => {
      const sourceContent = 'var x = 1;\n//# sourceMappingURL=../../../tmp/evil.map';

      existsSync.mockImplementation((p: string) => {
        if (p.endsWith('.map')) return false;
        return true;
      });
      readFileSync.mockReturnValue(sourceContent);

      const resolver = new SourceMapResolver();
      const frame = '    at fn (/app/dist/bundle.js:1:1)';
      const result = resolver.resolveStack(`Error\n${frame}`);

      expect(result).toContain(frame);
    });
  });

  describe('warning on no source maps', () => {
    it('emits a console.warn on the first stack with unresolved frames', () => {
      existsSync.mockReturnValue(false);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolver = new SourceMapResolver();
      resolver.resolveStack('Error\n    at fn (/app/a.js:1:1)');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[ErrorCore]');
    });

    it('does not emit the warning on subsequent calls', () => {
      existsSync.mockReturnValue(false);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolver = new SourceMapResolver();
      resolver.resolveStack('Error\n    at fn (/app/a.js:1:1)');
      resolver.resolveStack('Error\n    at fn (/app/b.js:2:2)');
      resolver.resolveStack('Error\n    at fn (/app/c.js:3:3)');

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when there are no frames at all', () => {
      existsSync.mockReturnValue(false);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resolver = new SourceMapResolver();
      resolver.resolveStack('Error: no stack frames here');

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('eviction', () => {
    it('evicts the oldest consumer entry after 128+ unique files are cached', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();

      // Fill the cache with 129 unique file entries (max is 128)
      for (let i = 0; i < 129; i++) {
        resolver.resolveStack(`Error\n    at fn (/app/file${i}.js:1:1)`);
      }

      // All loads are synchronous now.
      await resolver.flushWarmQueue();

      readFileSync.mockClear();
      existsSync.mockClear();

      // file0 was the first inserted and should have been evicted.
      // This call triggers a synchronous reload for the evicted entry.
      resolver.resolveStack('Error\n    at fn (/app/file0.js:1:1)');
      await resolver.flushWarmQueue();

      expect(readFileSync).toHaveBeenCalled();
    });

    it('does not evict missing/corrupt entries during LRU eviction', async () => {
      const resolver = new SourceMapResolver();

      // Insert a missing cache entry first (no .map, no source file).
      // Await its warm before changing the mock, so it is stored as 'missing'.
      existsSync.mockReturnValue(false);
      resolver.resolveStack('Error\n    at fn (/app/missing-entry.js:1:1)');
      await resolver.flushWarmQueue();

      // Now fill with valid consumer entries up to the limit
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      for (let i = 0; i < 128; i++) {
        resolver.resolveStack(`Error\n    at fn (/app/valid${i}.js:1:1)`);
      }
      await resolver.flushWarmQueue();

      readFileSync.mockClear();
      existsSync.mockClear();

      // The missing entry should NOT have been evicted by LRU.
      // It must still be in cache (no disk read on second resolve).
      resolver.resolveStack('Error\n    at fn (/app/missing-entry.js:1:1)');
      await resolver.flushWarmQueue();

      // If the missing entry was preserved in cache, existsSync is NOT called again.
      expect(existsSync).not.toHaveBeenCalledWith('/app/missing-entry.js.map');
    });
  });

  describe('G3 — three-state cache', () => {
    it('caches a missing result and does not re-hit disk on subsequent calls', () => {
      const readSyncSpy = vi.spyOn(fs, 'readFileSync');
      const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const resolver = new SourceMapResolver();
      const stack = 'Error: x\n    at foo (/nonexistent/file.js:1:1)';
      resolver.resolveStack(stack);
      const callsAfterFirst = readSyncSpy.mock.calls.length + existsSyncSpy.mock.calls.length;
      resolver.resolveStack(stack);
      const callsAfterSecond = readSyncSpy.mock.calls.length + existsSyncSpy.mock.calls.length;
      // Second call must not touch disk for the same missing path.
      expect(callsAfterSecond).toBe(callsAfterFirst);
      vi.restoreAllMocks();
    });

    it('caches a corrupt result with reason and does not re-parse on subsequent calls', () => {
      const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
        String(p).endsWith('.map')
      );
      // statSync is used by fileSizeUnderThreshold; return a small size so we sync-load.
      vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as ReturnType<typeof fs.statSync>);
      const readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('not valid json{{{');
      const resolver = new SourceMapResolver();
      const stack = 'Error: x\n    at foo (/fake/file.js:1:1)';
      resolver.resolveStack(stack);
      const firstReads = readFileSyncSpy.mock.calls.length;
      resolver.resolveStack(stack);
      expect(readFileSyncSpy.mock.calls.length).toBe(firstReads);
      const telemetry = resolver.consumeTelemetry();
      expect(telemetry.corrupt).toBeGreaterThanOrEqual(1);
      void existsSyncSpy;
      vi.restoreAllMocks();
    });

    it('consumeTelemetry returns a snapshot and resets counters', () => {
      const resolver = new SourceMapResolver();
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      resolver.resolveStack('Error: x\n    at foo (/a.js:1:1)');
      const first = resolver.consumeTelemetry();
      expect(first.cacheMisses + first.missing).toBeGreaterThanOrEqual(1);
      const second = resolver.consumeTelemetry();
      expect(second).toEqual({
        framesResolved: 0,
        framesUnresolved: 0,
        cacheHits: 0,
        cacheMisses: 0,
        missing: 0,
        corrupt: 0,
        evictions: 0
      });
      vi.restoreAllMocks();
    });
  });
});

// ---------------------------------------------------------------------------
// Task 16 — Sync-on-miss with 2MB size gate helpers
// ---------------------------------------------------------------------------

function writeSmallValidSourceMap(): { filePath: string; mapPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-smap-'));
  const filePath = path.join(dir, 'file.js');
  const mapPath = filePath + '.map';
  fs.writeFileSync(filePath, 'console.log("hi");\n//# sourceMappingURL=file.js.map\n');
  // Minimal valid source map — maps column 0 line 1 of generated to line 10 col 0 of source.
  const smap = {
    version: 3,
    file: 'file.js',
    sources: ['webpack://my-app/src/file.ts'],
    names: [],
    mappings: 'AAAA'
  };
  fs.writeFileSync(mapPath, JSON.stringify(smap));
  return { filePath, mapPath };
}

function writeLargeSourceMap(byteSize: number): { filePath: string; mapPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-smap-'));
  const filePath = path.join(dir, 'file.js');
  const mapPath = filePath + '.map';
  fs.writeFileSync(filePath, 'console.log("hi");\n//# sourceMappingURL=file.js.map\n');
  const padding = 'A'.repeat(byteSize - 200);
  const smap = {
    version: 3,
    file: 'file.js',
    sources: ['webpack://my-app/src/file.ts'],
    names: [],
    mappings: 'AAAA',
    _padding: padding
  };
  fs.writeFileSync(mapPath, JSON.stringify(smap));
  return { filePath, mapPath };
}

describe('G3 — sync-on-miss with size gate', () => {
  // These tests write real files — forward existsSync/readFileSync to real impls.
  beforeEach(() => {
    existsSync.mockImplementation((p) => realExistsSyncHolder.fn!(p));
    readFileSync.mockImplementation(((p: string, options?: BufferEncoding | null) =>
      (realReadFileSyncHolder.fn as (p: string, o?: BufferEncoding | null) => string)(p, options)) as typeof readFileSync);
  });

  afterEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  it('resolves a frame synchronously on the first call when map is under threshold', () => {
    const { filePath } = writeSmallValidSourceMap();
    // Use a large threshold so the small map is under it.
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    // The frame should be resolved in the first call (sync-on-miss).
    expect(result).toContain('webpack://my-app/src/file.ts');
  });

  it('does not resolve synchronously when map exceeds threshold (schedules async)', async () => {
    // Create a large map (> 10 bytes threshold used in this test)
    const { filePath } = writeLargeSourceMap(500);
    // Tiny threshold so the map is always over it.
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 10 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    // First call should NOT resolve synchronously (map is over threshold).
    expect(result).not.toContain('webpack://my-app/src/file.ts');
    // After flushing the warm queue, the cache is populated.
    await resolver.flushWarmQueue();
    const result2 = resolver.resolveStack(stack);
    expect(result2).toContain('webpack://my-app/src/file.ts');
  });

  it('threshold 0 always schedules async (never sync-on-miss)', async () => {
    const { filePath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 0 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    // Threshold 0 = always async, first call is unresolved.
    expect(result).not.toContain('webpack://my-app/src/file.ts');
    // After flush, resolved.
    await resolver.flushWarmQueue();
    const result2 = resolver.resolveStack(stack);
    expect(result2).toContain('webpack://my-app/src/file.ts');
  });
});
