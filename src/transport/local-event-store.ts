import { randomUUID } from 'node:crypto';
import fs = require('node:fs');
import path = require('node:path');

import { withLockSync } from './file-lock';
import { toTransportPayload, type TransportSendInput } from './payload';
import type { InternalWarning, TransportPayload } from '../types';

export interface LocalEventStoreRecord {
  version: 1;
  kind: 'event';
  id: string;
  storedAt: string;
  payloadKind: NonNullable<TransportPayload['kind']> | 'error';
  payload: string;
}

interface LocalEventStoreOptions {
  maxSizeBytes?: number;
  maxBackups?: number;
  onInternalWarning?: (warning: InternalWarning) => void;
}

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 5;

function appendFileSyncDurable(filePath: string, data: string): void {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileSyncDurable(filePath: string, data: string): void {
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, data, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function parseRecord(line: string): LocalEventStoreRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<LocalEventStoreRecord>;
    if (
      parsed.version === 1 &&
      parsed.kind === 'event' &&
      typeof parsed.id === 'string' &&
      typeof parsed.storedAt === 'string' &&
      (parsed.payloadKind === 'error' || parsed.payloadKind === 'payload_blob') &&
      typeof parsed.payload === 'string'
    ) {
      return parsed as LocalEventStoreRecord;
    }
  } catch {
  }
  return null;
}

export class LocalEventStore {
  private readonly filePath: string;

  private readonly lockPath: string;

  private readonly maxSizeBytes: number;

  private readonly maxBackups: number;

  private readonly onInternalWarning: ((warning: InternalWarning) => void) | undefined;

  private rotateCounter = 0;

  public constructor(filePath: string, options: LocalEventStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;
    this.onInternalWarning = options.onInternalWarning;
  }

  public append(input: TransportSendInput): string | null {
    try {
      const payload = toTransportPayload(input);
      const id = randomUUID();
      const record: LocalEventStoreRecord = {
        version: 1,
        kind: 'event',
        id,
        storedAt: new Date().toISOString(),
        payloadKind: payload.kind ?? 'error',
        payload: Buffer.isBuffer(payload.serialized)
          ? payload.serialized.toString('utf8')
          : payload.serialized
      };

      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      withLockSync(this.lockPath, () => {
        this.rotateIfNeededSync();
        appendFileSyncDurable(this.filePath, `${JSON.stringify(record)}\n`);
      });

      return id;
    } catch (error) {
      this.emitWarning({
        code: 'EC_LOCAL_EVENT_STORE_WRITE_FAILED',
        message: 'Local event store write failed; webhook payload was not queued.',
        cause: error,
        context: { path: this.filePath, errno: (error as NodeJS.ErrnoException | null)?.code }
      });
      return null;
    }
  }

  public readAll(): LocalEventStoreRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      return fs
        .readFileSync(this.filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parseRecord(line))
        .filter((record): record is LocalEventStoreRecord => record !== null);
    } catch {
      return [];
    }
  }

  public remove(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    try {
      withLockSync(this.lockPath, () => {
        if (!fs.existsSync(this.filePath)) {
          return;
        }
        const kept = fs
          .readFileSync(this.filePath, 'utf8')
          .split('\n')
          .filter((line) => {
            if (line.trim().length === 0) {
              return false;
            }
            const record = parseRecord(line);
            return record === null || !idSet.has(record.id);
          });
        writeFileSyncDurable(
          this.filePath,
          kept.length === 0 ? '' : `${kept.join('\n')}\n`
        );
      });
    } catch {
    }
  }

  private rotateIfNeededSync(): void {
    try {
      const stats = fs.existsSync(this.filePath) ? fs.statSync(this.filePath) : null;
      if (stats === null || stats.size < this.maxSizeBytes) {
        return;
      }

      const rotatedPath = `${this.filePath}.${Date.now()}-${++this.rotateCounter}.bak`;
      fs.renameSync(this.filePath, rotatedPath);
      this.cleanupOldBackupsSync();
    } catch {
    }
  }

  private cleanupOldBackupsSync(): void {
    if (this.maxBackups < 0) {
      return;
    }

    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const backups = fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith('.bak'))
        .sort()
        .reverse();
      for (const backup of backups.slice(this.maxBackups)) {
        try {
          fs.unlinkSync(path.join(dir, backup));
        } catch {
        }
      }
    } catch {
    }
  }

  private emitWarning(warning: InternalWarning): void {
    try {
      this.onInternalWarning?.(warning);
    } catch {
    }
  }
}
