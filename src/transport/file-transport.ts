
import fs = require('node:fs');
import path = require('node:path');

import { safeConsole } from '../debug-log';
import { toTransportPayload, type TransportSendInput } from './payload';

const OWNER_READ_WRITE_MODE = 0o600;

interface FileTransportConfig {
  path: string;
  maxSizeBytes?: number;
  maxBackups?: number;
}

export class FileTransport {
  private readonly path: string;

  private readonly maxSizeBytes: number;

  private readonly maxBackups: number;

  // Serialize rotation operations. Without this, two concurrent send()
  // calls that each observe the file size over the threshold both try
  // to rename and the second rename races with the first append.
  private rotatePromise: Promise<void> | null = null;

  // Monotonic suffix within the same millisecond so same-tick rotations
  // do not collide at Date.now() ms granularity.
  private rotateCounter = 0;

  public constructor(config: FileTransportConfig) {
    this.path = config.path;
    this.maxSizeBytes = config.maxSizeBytes ?? 100 * 1024 * 1024;
    this.maxBackups = config.maxBackups ?? 5;
  }

  public async send(input: TransportSendInput): Promise<void> {
    try {
      await this.rotateIfNeeded();
      await this.ensureDirectory();
      const payload = toTransportPayload(input).serialized;
      const line = Buffer.isBuffer(payload)
        ? Buffer.concat([payload, Buffer.from('\n')])
        : `${payload}\n`;

      await new Promise<void>((resolve, reject) => {
        fs.appendFile(this.path, line, { mode: OWNER_READ_WRITE_MODE }, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] File transport dropped payload: ${message}`);
      throw error;
    }
  }

  public async flush(): Promise<void> {
    // fsync to ensure all prior appendFile writes are durable on disk.
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open(this.path, 'r+', (error, value) => {
        if (error) {
          // File may not exist yet if nothing was written. A parent path
          // that is not a directory is equivalent here because no file was
          // accepted for flushing.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            resolve(-1);
            return;
          }
          reject(error);
          return;
        }
        resolve(value);
      });
    });

    if (fd === -1) {
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        fs.fsync(fd, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      await new Promise<void>((resolve) => {
        fs.close(fd, () => resolve());
      });
    }
  }

  public async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public sendSync(payload: string): void {
    try {
      this.ensureDirectorySync();
      fs.writeFileSync(this.path, `${payload}\n`, { flag: 'a', mode: OWNER_READ_WRITE_MODE });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] File transport sync write failed: ${message}`);
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = path.dirname(this.path);
    if (directory === '.' || directory === '') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      fs.mkdir(directory, { recursive: true, mode: 0o700 }, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private ensureDirectorySync(): void {
    const directory = path.dirname(this.path);
    if (directory === '.' || directory === '') {
      return;
    }

    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private async rotateIfNeeded(): Promise<void> {
    // Serialize: if a rotation is already in flight, await it and then
    // re-check whether another one is still needed. Without this, N
    // concurrent sends can each observe "over threshold" before anyone
    // renames, and the winners of that race call rename on a file that
    // no longer exists at that name.
    if (this.rotatePromise !== null) {
      await this.rotatePromise;
    }

    this.rotatePromise = this.rotateOnce();
    try {
      await this.rotatePromise;
    } finally {
      this.rotatePromise = null;
    }
  }

  private async rotateOnce(): Promise<void> {
    const stats = await new Promise<fs.Stats | null>((resolve) => {
      fs.stat(this.path, (error, value) => {
        if (error) {
          resolve(null);
          return;
        }

        resolve(value);
      });
    });

    if (stats === null || stats.size <= this.maxSizeBytes) {
      return;
    }

    // Timestamp is ms granular. Add a per-instance counter so two
    // rotations inside the same millisecond still produce distinct
    // filenames.
    const stamp = Date.now();
    const seq = ++this.rotateCounter;
    const rotatedPath = `${this.path}.${stamp}-${seq}.bak`;

    await new Promise<void>((resolve, reject) => {
      fs.rename(this.path, rotatedPath, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await this.cleanupOldBackups();
  }

  private async cleanupOldBackups(): Promise<void> {
    const dir = path.dirname(this.path);
    const base = path.basename(this.path);
    const prefix = `${base}.`;
    const suffix = '.bak';

    try {
      const files = await new Promise<string[]>((resolve, reject) => {
        fs.readdir(dir, (error, entries) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(entries);
        });
      });

      const backups = files
        .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .reverse();

      for (const backup of backups.slice(this.maxBackups)) {
        const fullPath = path.join(dir, backup);

        await new Promise<void>((resolve) => {
          fs.unlink(fullPath, () => resolve());
        });
      }
    } catch {
    }
  }
}
