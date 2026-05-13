
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import type { Encryption } from '../security/encryption';

function formatBoundaryFrame(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== 'object') {
    return undefined;
  }

  const value = frame as Record<string, unknown>;
  const filePath = typeof value.filePath === 'string' ? value.filePath : undefined;
  if (filePath === undefined || filePath === '') {
    return undefined;
  }

  const lineNumber = typeof value.lineNumber === 'number' ? value.lineNumber : undefined;
  const columnNumber = typeof value.columnNumber === 'number' ? value.columnNumber : undefined;
  const functionName =
    typeof value.functionName === 'string' && value.functionName !== ''
      ? `${value.functionName} `
      : '';
  const location =
    lineNumber === undefined
      ? filePath
      : `${filePath}:${lineNumber}${columnNumber === undefined ? '' : `:${columnNumber}`}`;

  return `${functionName}${location}`;
}

export interface ErrorSummary {
  id: string;
  capturedAt: string;
  errorType: string;
  errorMessage: string;
  url: string | undefined;
  stack: string;
  rawStack?: string;
  fingerprint?: string;
  originPackage?: string;
  appBoundary?: string;
}

export interface IndexEntry {
  offset: number;
  length: number;
  summary: ErrorSummary;
}

export class NdjsonReader {
  private readonly filePath: string;

  private readonly encryption: Encryption | null;

  private readonly index = new Map<string, IndexEntry>();

  private readonly blobIndex = new Map<string, unknown>();

  private watcher: fs.FSWatcher | null = null;

  private fileSize = 0;

  public constructor(filePath: string, encryption: Encryption | null) {
    this.filePath = filePath;
    this.encryption = encryption;
    this.buildIndex();
  }

  public getAll(options?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: string;
    sort?: 'newest' | 'oldest' | 'frequent';
  }): { entries: ErrorSummary[]; total: number } {
    let entries = [...this.index.values()].map((e) => e.summary);

    if (options?.search) {
      const term = options.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.errorMessage.toLowerCase().includes(term) ||
          e.errorType.toLowerCase().includes(term) ||
          (e.url?.toLowerCase().includes(term) ?? false)
      );
    }

    if (options?.type) {
      entries = entries.filter((e) => e.errorType === options.type);
    }

    const sort = options?.sort ?? 'newest';

    if (sort === 'newest') {
      entries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    } else if (sort === 'oldest') {
      entries.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    }

    const total = entries.length;
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 25;
    const start = (page - 1) * limit;

    return {
      entries: entries.slice(start, start + limit),
      total
    };
  }

  public getById(id: string): unknown | null {
    const entry = this.index.get(id);

    if (entry === undefined) {
      return null;
    }

    try {
      const fd = fs.openSync(this.filePath, 'r');
      const buffer = Buffer.alloc(entry.length);
      fs.readSync(fd, buffer, 0, entry.length, entry.offset);
      fs.closeSync(fd);

      const line = buffer.toString('utf8').trim();
      return this.parseLine(line);
    } catch {
      return null;
    }
  }

  public getBlob(eventId: string, blobId: string): unknown | null {
    return this.blobIndex.get(`${eventId}:${blobId}`) ?? null;
  }

  public getStats(): {
    total: number;
    byType: Record<string, number>;
    byHour: Record<string, number>;
    topErrors: Array<{ message: string; count: number }>;
  } {
    const byType: Record<string, number> = {};
    const byHour: Record<string, number> = {};
    const byMessage = new Map<string, { message: string; count: number }>();

    for (const entry of this.index.values()) {
      const { summary } = entry;

      byType[summary.errorType] = (byType[summary.errorType] ?? 0) + 1;

      const hour = summary.capturedAt.slice(0, 13);
      byHour[hour] = (byHour[hour] ?? 0) + 1;

      const message = `${summary.errorType}: ${summary.errorMessage.slice(0, 100)}`;
      const msgKey =
        summary.fingerprint ??
        `${message}:${summary.appBoundary ?? summary.originPackage ?? ''}`;
      const current = byMessage.get(msgKey);
      if (current === undefined) {
        byMessage.set(msgKey, { message, count: 1 });
      } else {
        current.count += 1;
      }
    }

    const topErrors = [...byMessage.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(({ message, count }) => ({ message, count }));

    return { total: this.index.size, byType, byHour, topErrors };
  }

  public refresh(): void {
    this.buildIndex();
  }

  public watch(): void {
    if (this.watcher !== null) {
      return;
    }

    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.buildIndex();
      });
    } catch {
      // file might not exist yet
    }
  }

  public close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private buildIndex(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const stat = fs.statSync(this.filePath);

    if (stat.size === this.fileSize && this.index.size > 0) {
      return;
    }

    this.index.clear();
    this.blobIndex.clear();
    this.fileSize = stat.size;

    const content = fs.readFileSync(this.filePath, 'utf8');
    let offset = 0;

    for (const line of content.split('\n')) {
      const lineBytes = Buffer.byteLength(line + '\n', 'utf8');

      if (line.trim().length > 0) {
        try {
          const parsed = this.parseLine(line.trim());

          if (parsed !== null && typeof parsed === 'object') {
            const pkg = parsed as Record<string, unknown>;
            if (pkg.kind === 'payload_blob') {
              const eventId = typeof pkg.eventId === 'string' ? pkg.eventId : '';
              const blobId = typeof pkg.blobId === 'string' ? pkg.blobId : '';
              if (eventId !== '' && blobId !== '') {
                this.blobIndex.set(`${eventId}:${blobId}`, pkg);
              }
              offset += lineBytes;
              continue;
            }
            const id = crypto
              .createHash('sha256')
              .update(line.trim())
              .digest('hex')
              .slice(0, 12);

            const error = pkg.error as Record<string, unknown> | undefined;
            const request = pkg.request as Record<string, unknown> | undefined;
            const errorOrigin = pkg.errorOrigin as Record<string, unknown> | undefined;
            const originPackage =
              typeof errorOrigin?.package === 'string'
                ? errorOrigin.package
                : undefined;

            this.index.set(id, {
              offset,
              length: lineBytes,
              summary: {
                id,
                capturedAt: (pkg.capturedAt as string) ?? '',
                errorType: (error?.type as string) ?? 'Error',
                errorMessage: (error?.message as string) ?? '',
                url: request?.url as string | undefined,
                stack: (error?.stack as string) ?? '',
                rawStack: error?.rawStack as string | undefined,
                fingerprint: typeof pkg.fingerprint === 'string' ? pkg.fingerprint : undefined,
                originPackage,
                appBoundary: formatBoundaryFrame(errorOrigin?.appBoundaryFrame)
              }
            });
          }
        } catch {
          // skip malformed lines
        }
      }

      offset += lineBytes;
    }
  }

  private parseLine(line: string): unknown | null {
    try {
      const parsed = JSON.parse(line);

      if (
        this.encryption !== null &&
        typeof parsed === 'object' &&
        parsed !== null &&
        'ciphertext' in parsed &&
        'v' in parsed
      ) {
        // New EncryptedEnvelope shape (v=1). The decrypt() method walks
        // the rotation chain via keyId; throws on HMAC/authTag failure.
        const decrypted = this.encryption.decrypt(parsed as import('../types').EncryptedEnvelope);
        return JSON.parse(decrypted);
      }

      if (
        this.encryption === null &&
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { v?: unknown }).v === 1 &&
        (parsed as { iv?: unknown }).iv === 'unencrypted' &&
        typeof (parsed as { ciphertext?: unknown }).ciphertext === 'string'
      ) {
        const plaintext = Buffer.from(
          (parsed as { ciphertext: string }).ciphertext,
          'base64'
        ).toString('utf8');
        return JSON.parse(plaintext);
      }

      return parsed;
    } catch {
      return null;
    }
  }
}
