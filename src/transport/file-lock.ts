import * as fs from 'node:fs';
import * as path from 'node:path';

import { safeConsole } from '../debug-log';

const SLEEP_MS = 50;
export const MAX_RETRIES = 20;
const OWNER_FILE = 'owner.json';
const REMOVE_RETRIES = 3;
const TRANSIENT_REMOVE_ERRORS = new Set(['EBUSY', 'EACCES', 'ENOTEMPTY', 'EPERM']);

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return true;
  }
}

type ExistingLock =
  | { state: 'missing' }
  | { state: 'active'; holderPid: number | null }
  | { state: 'stale'; holderPid: number };

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

function isTransientRemoveError(err: unknown): boolean {
  return TRANSIENT_REMOVE_ERRORS.has((err as NodeJS.ErrnoException).code ?? '');
}

function parseOwnerPid(contents: string): number | null {
  try {
    const metadata = JSON.parse(contents) as { pid?: unknown };
    return typeof metadata.pid === 'number' && Number.isInteger(metadata.pid) && metadata.pid > 0
      ? metadata.pid
      : null;
  } catch {
    return null;
  }
}

function parseLegacyPid(contents: string): number | null {
  const trimmed = contents.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const pid = Number.parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function lockStateForPid(pid: number | null): ExistingLock {
  if (pid === null) return { state: 'active', holderPid: null };
  return isProcessAlive(pid)
    ? { state: 'active', holderPid: pid }
    : { state: 'stale', holderPid: pid };
}

function readExistingLock(lockPath: string): ExistingLock {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { state: 'missing' };
    return { state: 'active', holderPid: null };
  }

  if (stat.isDirectory()) {
    try {
      return lockStateForPid(parseOwnerPid(fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf8')));
    } catch {
      return { state: 'active', holderPid: null };
    }
  }

  if (stat.isFile()) {
    try {
      return lockStateForPid(parseLegacyPid(fs.readFileSync(lockPath, 'utf8')));
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { state: 'missing' };
      return { state: 'active', holderPid: null };
    }
  }

  return { state: 'active', holderPid: null };
}

function writeOwnerMetadata(lockPath: string): void {
  fs.writeFileSync(
    path.join(lockPath, OWNER_FILE),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 }
  );
}

function removeExistingLock(lockPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    return;
  }

  if (stat.isDirectory()) {
    for (let attempt = 0; attempt <= REMOVE_RETRIES; attempt++) {
      try {
        fs.rmSync(lockPath, {
          recursive: true,
          force: true,
          maxRetries: REMOVE_RETRIES,
          retryDelay: SLEEP_MS
        });
        return;
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return;
        if (attempt < REMOVE_RETRIES && isTransientRemoveError(err)) {
          sleepSync(SLEEP_MS);
          continue;
        }
        throw err;
      }
    }
    return;
  }

  fs.unlinkSync(lockPath);
}

export function acquireLock(lockPath: string): void {
  let removedStalePid: number | null = null;
  let lastHolder: number | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeOwnerMetadata(lockPath);
      } catch (err) {
        removeExistingLock(lockPath);
        throw err;
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const existing = readExistingLock(lockPath);
      if (existing.state === 'missing') continue;

      lastHolder = existing.holderPid;
      if (existing.state === 'stale') {
        if (removedStalePid === existing.holderPid) {
          throw new Error(
            `[ErrorCore] Lock at ${lockPath} held by dead PID ${existing.holderPid}; stale removal retry failed.`
          );
        }
        removedStalePid = existing.holderPid;
        removeExistingLock(lockPath);
        continue;
      }

      sleepSync(SLEEP_MS);
    }
  }

  throw new Error(
    `[ErrorCore] Failed to acquire lock at ${lockPath} after ${MAX_RETRIES} retries ` +
    `(${MAX_RETRIES * SLEEP_MS}ms). Holding PID: ${lastHolder ?? 'unknown'}. ` +
    `If no other errorcore process is running, remove ${lockPath} manually.`
  );
}

export function releaseLock(lockPath: string): void {
  try {
    removeExistingLock(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      safeConsole.warn(`[ErrorCore] Failed to release lock ${lockPath}: ${(err as Error).message}`);
    }
  }
}

export function withLockSync<T>(lockPath: string, fn: () => T): T {
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
