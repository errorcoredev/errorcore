
import fs = require('node:fs');
import path = require('node:path');

interface FileTransportConfig {
  path: string;
  maxSizeBytes?: number;
  maxBackups?: number;
}

export class FileTransport {
  private readonly path: string;

  private readonly maxSizeBytes: number;

  private readonly maxBackups: number;

  public constructor(config: FileTransportConfig) {
    this.path = config.path;
    this.maxSizeBytes = config.maxSizeBytes ?? 100 * 1024 * 1024;
    this.maxBackups = config.maxBackups ?? 5;
  }

  public async send(payload: string | Buffer): Promise<void> {
    try {
      await this.rotateIfNeeded();
      const line = Buffer.isBuffer(payload)
        ? Buffer.concat([payload, Buffer.from('\n')])
        : `${payload}\n`;

      await new Promise<void>((resolve, reject) => {
        fs.appendFile(this.path, line, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] File transport dropped payload: ${message}`);
      throw error;
    }
  }

  public async flush(): Promise<void> {
    // fsync to ensure all prior appendFile writes are durable on disk.
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open(this.path, 'r', (error, value) => {
        if (error) {
          // File may not exist yet if nothing was written. That's fine.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
      fs.writeFileSync(this.path, `${payload}\n`, { flag: 'a' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] File transport sync write failed: ${message}`);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
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

    const rotatedPath = `${this.path}.${Date.now()}.bak`;

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
