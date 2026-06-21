import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireLock, releaseLock } from '../../src/transport/file-lock';

const dirs: string[] = [];

function lockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-file-lock-'));
  dirs.push(dir);
  return path.join(dir, 'resource.lock');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('file lock', () => {
  it('uses an atomic directory as the active lock marker', () => {
    const target = lockPath();

    acquireLock(target);
    try {
      expect(fs.statSync(target).isDirectory()).toBe(true);
    } finally {
      releaseLock(target);
    }

    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not remove an existing lock when owner metadata is invalid', () => {
    const target = lockPath();
    fs.writeFileSync(target, '');

    expect(() => acquireLock(target)).toThrow(/Failed to acquire lock/);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('replaces a stale legacy file lock containing a dead PID with a directory lock', () => {
    const target = lockPath();
    fs.writeFileSync(target, '2147483647');

    acquireLock(target);
    try {
      expect(fs.statSync(target).isDirectory()).toBe(true);
    } finally {
      releaseLock(target);
    }

    expect(fs.existsSync(target)).toBe(false);
  });

  it('releaseLock removes a directory lock with owner metadata', () => {
    const target = lockPath();
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'owner'), String(process.pid));

    releaseLock(target);

    expect(fs.existsSync(target)).toBe(false);
  });

  it('releaseLock retries transient directory removal failures', async () => {
    const rmSync = vi.fn().mockImplementationOnce(() => {
      const err = new Error('not empty') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      throw err;
    }).mockImplementation(() => undefined);

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      lstatSync: vi.fn(() => ({
        isDirectory: () => true,
        isFile: () => false
      })),
      rmSync,
      unlinkSync: vi.fn()
    }));

    try {
      const { releaseLock: releaseLockWithMockFs } = await import('../../src/transport/file-lock');

      releaseLockWithMockFs('resource.lock');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    expect(rmSync).toHaveBeenCalledTimes(2);
  });
});
