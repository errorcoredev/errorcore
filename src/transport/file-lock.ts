import * as fs from 'node:fs';

const SLEEP_MS = 50;
export const MAX_RETRIES = 20;

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

export function acquireLock(lockPath: string): void {
  let staleRetried = false;
  let lastHolder: number | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let holderPid = NaN;
      try {
        holderPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      lastHolder = Number.isFinite(holderPid) ? holderPid : null;

      if (!isProcessAlive(holderPid)) {
        if (staleRetried) {
          throw new Error(
            `[ErrorCore] Lock at ${lockPath} held by dead PID ${holderPid}; stale removal retry failed.`
          );
        }
        staleRetried = true;
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
        }
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
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[ErrorCore] Failed to release lock ${lockPath}: ${(err as Error).message}`);
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
