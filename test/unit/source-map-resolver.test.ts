import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceMapGenerator } from 'source-map-js';
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
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
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

      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const firstCallCount = readFileSync.mock.calls.length;

      resolver.resolveStack(stack);
      expect(readFileSync.mock.calls.length).toBe(firstCallCount);
    });

    it('caches null results so the filesystem is not re-checked', async () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();
      const stack = 'Error\n    at fn (/app/dist/missing.js:1:1)';

      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const firstExistsCount = existsSync.mock.calls.length;

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

    it('parses bare async anonymous frames: "    at async /path/file.js:10:5"', async () => {
      existsSync.mockImplementation((p: string) => p.endsWith('.map'));
      readFileSync.mockReturnValue(NAMED_SOURCEMAP_JSON);

      const resolver = new SourceMapResolver();
      const stack = 'Error\n    at async /path/file.js:10:5';
      resolver.resolveStack(stack);
      await resolver.flushWarmQueue();
      const result = resolver.resolveStack(stack);

      expect(result).toContain('at async myFunc (original.ts:5:11)');
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

      for (let i = 0; i < 129; i++) {
        resolver.resolveStack(`Error\n    at fn (/app/file${i}.js:1:1)`);
      }

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

  describe('audit cache bounds and invalidation', () => {
    it('bounds total cache entries, including missing source maps', async () => {
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();

      for (let index = 0; index < 300; index += 1) {
        resolver.resolveStack(`Error\n    at fn (/app/missing-${index}.js:1:1)`);
      }
      await resolver.flushWarmQueue();

      const cacheSize = (resolver as unknown as { cache: Map<string, unknown> }).cache.size;
      expect(cacheSize).toBeLessThanOrEqual(256);
    });

    it('sweeps expired negative entries when resolving later paths', async () => {
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      existsSync.mockReturnValue(false);

      const resolver = new SourceMapResolver();

      resolver.resolveStack('Error\n    at fn (/app/old-missing.js:1:1)');
      await resolver.flushWarmQueue();

      now += 60 * 60 * 1000 + 1;
      resolver.resolveStack('Error\n    at fn (/app/new-missing.js:1:1)');
      await resolver.flushWarmQueue();

      const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;
      expect([...cache.keys()].join('\n')).not.toContain('old-missing');
    });
  });
});

// Helpers for the sync-on-miss source-map path. The 2 MB gate keeps the
// synchronous JSON.parse off the hot path for large maps.

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

function writeNamedExternalSourceMap(): { filePath: string; mapPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-smap-named-'));
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir);
  const filePath = path.join(distDir, 'server.js');
  const mapPath = filePath + '.map';
  fs.writeFileSync(filePath, 'function a(){throw new Error("boom")}a();\n');
  fs.writeFileSync(mapPath, NAMED_SOURCEMAP_JSON);
  return { filePath, mapPath };
}

function writeLocalNameSourceMap(): { filePath: string; mapPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-smap-locals-'));
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir);
  const filePath = path.join(distDir, 'server.js');
  const mapPath = filePath + '.map';
  const generated = 'async function a(e){let i=Number(process.env.T||1500),t=await postJson("/x",{tags:e},i);return t.tags.map(String)}\n';
  fs.writeFileSync(filePath, generated);

  const generator = new SourceMapGenerator({ file: 'server.js' });
  for (const [generatedColumn, originalName, originalLine] of [
    [generated.indexOf('(e)') + 1, 'tags', 10],
    [generated.indexOf('i=Number'), 'timeoutMs', 11],
    [generated.indexOf('t=await'), 'enrichment', 12]
  ] as const) {
    generator.addMapping({
      generated: {
        line: 1,
        column: generatedColumn
      },
      original: {
        line: originalLine,
        column: 8
      },
      source: '../routes/api/tags.js',
      name: originalName
    });
  }
  generator.addMapping({
    generated: {
      line: 1,
      column: generated.indexOf('t.tags')
    },
    original: {
      line: 12,
      column: 15
    },
    source: '../routes/api/tags.js',
    name: 'enrichment'
  });
  fs.writeFileSync(mapPath, generator.toString());
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

function overwriteSourceMapSource(mapPath: string, source: string): void {
  const smap = {
    version: 3,
    file: 'file.js',
    sources: [source],
    names: [],
    mappings: 'AAAA'
  };
  fs.writeFileSync(mapPath, JSON.stringify(smap));
}

describe('G3 — sync-on-miss with size gate', () => {
  // These tests write real files — forward existsSync/readFileSync to real impls.
  let originalNodeOptions: string | undefined;

  beforeEach(() => {
    originalNodeOptions = process.env.NODE_OPTIONS;
    existsSync.mockImplementation((p) => realExistsSyncHolder.fn!(p));
    readFileSync.mockImplementation(((p: string, options?: BufferEncoding | null) =>
      (realReadFileSyncHolder.fn as (p: string, o?: BufferEncoding | null) => string)(p, options)) as typeof readFileSync);
  });

  afterEach(() => {
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  it('resolves a frame synchronously on the first call when map is under threshold', () => {
    const { filePath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    expect(result).toContain('webpack://my-app/src/file.ts');
  });

  it('does not resolve synchronously when map exceeds threshold (schedules async)', async () => {
    const { filePath } = writeLargeSourceMap(500);
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 10 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    expect(result).not.toContain('webpack://my-app/src/file.ts');
    await resolver.flushWarmQueue();
    const result2 = resolver.resolveStack(stack);
    expect(result2).toContain('webpack://my-app/src/file.ts');
  });

  it('loads production-sized external maps when the sync threshold allows them', () => {
    const { filePath } = writeLargeSourceMap(5 * 1024 * 1024);
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 16 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;

    expect(resolver.resolveStack(stack)).toContain('webpack://my-app/src/file.ts');
  });

  it('threshold 0 always schedules async (never sync-on-miss)', async () => {
    const { filePath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 0 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const result = resolver.resolveStack(stack);
    expect(result).not.toContain('webpack://my-app/src/file.ts');
    await resolver.flushWarmQueue();
    const result2 = resolver.resolveStack(stack);
    expect(result2).toContain('webpack://my-app/src/file.ts');
  });

  it('invalidates a cached source map when file contents change at the same path', () => {
    const { filePath, mapPath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;

    expect(resolver.resolveStack(stack)).toContain('webpack://my-app/src/file.ts');

    overwriteSourceMapSource(mapPath, 'webpack://my-app/src/replaced.ts');

    expect(resolver.resolveStack(stack)).toContain('webpack://my-app/src/replaced.ts');
  });

  it('resolves bundled frames even when V8 source maps are enabled but did not rewrite the stack', () => {
    process.env.NODE_OPTIONS = `${originalNodeOptions ?? ''} --enable-source-maps`;
    const { filePath } = writeSmallValidSourceMap();
    const distPath = path.join(path.dirname(filePath), 'dist', 'server.js');
    fs.mkdirSync(path.dirname(distPath));
    fs.copyFileSync(filePath, distPath);
    fs.copyFileSync(filePath + '.map', distPath + '.map');

    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at routeHandler (${distPath}:1:1)`;

    expect(resolver.resolveStack(stack)).toContain('webpack://my-app/src/file.ts');
  });

  it('leaves already source-mapped frames untouched when V8 source maps are enabled', () => {
    process.env.NODE_OPTIONS = `${originalNodeOptions ?? ''} --enable-source-maps`;
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = 'Error: x\n    at routeHandler (webpack://my-app/src/server.ts:10:2)';

    expect(resolver.resolveStack(stack)).toBe(stack);
    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(resolver.consumeTelemetry()).toEqual({
      framesResolved: 0,
      framesUnresolved: 0,
      cacheHits: 0,
      cacheMisses: 0,
      missing: 0,
      corrupt: 0,
      evictions: 0
    });
  });

  it('uses an external minified bundle map to restore original file and function names', () => {
    const { filePath } = writeNamedExternalSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: boom\n    at a (${filePath}:20:3)`;

    expect(resolver.resolveStack(stack)).toContain('myFunc (original.ts:5:11)');
  });

  it('uses source-map names to restore captured minified local names', () => {
    const { filePath } = writeLocalNameSourceMap();
    const generated = fs.readFileSync(filePath, 'utf8');
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const frame = {
      functionName: 'a',
      filePath,
      lineNumber: 1,
      columnNumber: generated.indexOf('t.tags') + 1,
      locals: {
        e: ['errorcore', 'validation'],
        i: 1500,
        t: { tags: ['errorcore'] }
      }
    };

    const [resolved] = resolver.resolveCapturedFrames([frame]) ?? [];

    expect(resolved).toMatchObject({
      filePath: '../routes/api/tags.js',
      lineNumber: 12,
      locals: {
        tags: ['errorcore', 'validation'],
        timeoutMs: 1500,
        enrichment: { tags: ['errorcore'] }
      }
    });
    expect(resolved?.locals).not.toHaveProperty('e');
    expect(resolved?.locals).not.toHaveProperty('i');
    expect(resolved?.locals).not.toHaveProperty('t');
  });
});
