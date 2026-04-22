import { createHmac, timingSafeEqual } from 'node:crypto';
import fs = require('node:fs');
import path = require('node:path');

export interface DeadLetterDrainEntry {
  lineNumber: number;
  payload: string;
}

export interface DrainResult {
  entries: DeadLetterDrainEntry[];
  lineCount: number;
}

interface DeadLetterEnvelopeBase {
  version: 1;
  kind: 'payload' | 'marker';
  storedAt: string;
}

interface DeadLetterPayloadEnvelope extends DeadLetterEnvelopeBase {
  kind: 'payload';
  payload: string;
  mac: string;
}

interface DeadLetterMarkerEnvelope extends DeadLetterEnvelopeBase {
  kind: 'marker';
  code: string;
  mac: string;
}

type DeadLetterEnvelope = DeadLetterPayloadEnvelope | DeadLetterMarkerEnvelope;

interface DeadLetterStoreOptions {
  integrityKey: string;
  maxSizeBytes?: number;
  maxPayloadBytes?: number;
  requireEncryptedPayload?: boolean;
  // Optional callback invoked with a short diagnostic code when the
  // store fails at a point that was previously swallowed silently.
  // Intended to be wired into config.onInternalWarning by the SDK.
  onInternalError?: (code: string, message: string) => void;
}

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isEncryptedPayloadFormat(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    return (
      typeof parsed.salt === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ciphertext === 'string' &&
      typeof parsed.authTag === 'string'
    );
  } catch {
    return false;
  }
}

export class DeadLetterStore {
  private readonly filePath: string;

  private readonly integrityKey: string;

  private readonly maxSizeBytes: number;

  private readonly maxPayloadBytes: number;

  private readonly requireEncryptedPayload: boolean;

  private readonly onInternalError?: (code: string, message: string) => void;

  // Serialize concurrent clearSent calls inside the same process. Each
  // call takes the latest promise and chains its work. This removes the
  // in-process portion of the rename/read/append race. Cross-process
  // races (the CLI drain running while the SDK runtime appends) remain
  // best-effort: operators should not run `errorcore drain` concurrently
  // with a live SDK process against the same file.
  private clearChain: Promise<void> = Promise.resolve();

  // In-memory pending-payload count. null means "not yet initialized" —
  // the first getPendingCount() / hasPending() call after construction
  // lazily scans the backing file. Writers then maintain it in-place.
  // Markers are not counted here: they're diagnostics, not payloads to
  // retry.
  private pendingPayloadCount: number | null = null;

  public constructor(filePath: string, options: DeadLetterStoreOptions) {
    this.filePath = filePath;
    this.integrityKey = options.integrityKey;
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.requireEncryptedPayload = options.requireEncryptedPayload ?? false;
    this.onInternalError = options.onInternalError;
  }

  private reportError(code: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.onInternalError !== undefined) {
      try { this.onInternalError(code, message); } catch { /* never break on telemetry */ }
    } else {
      console.warn(`[ErrorCore] Dead-letter store ${code}: ${message}`);
    }
  }

  public appendPayloadSync(payload: string): boolean {
    if (getUtf8ByteLength(payload) > this.maxPayloadBytes) {
      console.warn('[ErrorCore] Dead-letter payload exceeds maximum size; dropping payload');
      return false;
    }

    // Initialize the in-memory count before writing so the lazy scan
    // doesn't read the newly-appended line as if it were pre-existing
    // state. Order matters: init, then append, then increment.
    this.ensurePendingCountInitialized();

    const ok = this.appendEnvelopeSync({
      version: 1,
      kind: 'payload',
      storedAt: new Date().toISOString(),
      payload
    });

    if (ok) {
      this.pendingPayloadCount = (this.pendingPayloadCount ?? 0) + 1;
    }

    return ok;
  }

  public appendFailureMarkerSync(code: string): boolean {
    return this.appendEnvelopeSync({
      version: 1,
      kind: 'marker',
      storedAt: new Date().toISOString(),
      code
    });
  }

  public drain(): DrainResult {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { entries: [], lineCount: 0 };
      }

      const stats = fs.statSync(this.filePath);
      if (stats.size > 10 * 1024 * 1024) {
        console.warn(
          `[ErrorCore] Dead-letter store is ${Math.round(stats.size / 1024 / 1024)}MB; ` +
          'skipping automatic drain at startup. Run `errorcore drain` to process manually.'
        );
        return { entries: [], lineCount: 0 };
      }

      const content = fs.readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.length > 0);
      const entries: DeadLetterDrainEntry[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        const envelope = this.parseEnvelope(line);

        if (envelope === null) {
          console.warn('[ErrorCore] Rejected malformed dead-letter entry');
          continue;
        }

        if (envelope.kind === 'marker') {
          continue;
        }

        entries.push({
          lineNumber: index + 1,
          payload: envelope.payload
        });
      }

      return { entries, lineCount: lines.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Dead-letter store drain failed: ${message}`);
      return { entries: [], lineCount: 0 };
    }
  }

  public clear(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
      this.pendingPayloadCount = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Dead-letter store clear failed: ${message}`);
    }
  }

  public clearSent(sentLineCount: number): void {
    const tempPath = this.filePath + '.clearing';

    try {
      // Atomically rename the file so new appendPayloadSync calls create a
      // fresh file instead of racing with our read-modify-write.
      try {
        fs.renameSync(this.filePath, tempPath);
      } catch (renameError) {
        // File gone (already cleared or never existed) — nothing to do.
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
          this.pendingPayloadCount = 0;
          return;
        }
        throw renameError;
      }

      const content = fs.readFileSync(tempPath, 'utf8');
      const lines = content.split('\n').filter((line) => line.length > 0);

      if (lines.length > sentLineCount) {
        const remaining = lines.slice(sentLineCount).join('\n') + '\n';
        // Write remaining lines back. If a new file was created by
        // appendPayloadSync in the meantime, append to it.
        fs.appendFileSync(this.filePath, remaining, {
          encoding: 'utf8',
          mode: 0o600
        });
      }

      // A successful clearSent invalidates our in-memory counter.
      // Lazy recount on next getPendingCount() is O(lines) and only
      // runs rarely (drain-after-failed-send).
      this.pendingPayloadCount = null;

      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkError) {
        const code = (unlinkError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.reportError('clearSent_unlink_failed', unlinkError);
        }
      }
    } catch (error) {
      // If we renamed but failed to process, try to restore the original.
      try {
        if (fs.existsSync(tempPath) && !fs.existsSync(this.filePath)) {
          fs.renameSync(tempPath, this.filePath);
        }
      } catch (restoreError) {
        this.reportError('clearSent_restore_failed', restoreError);
      }

      this.reportError('clearSent_failed', error);
    }
  }

  public hasPending(): boolean {
    try {
      const stats = fs.statSync(this.filePath);
      return stats.size > 0;
    } catch {
      return false;
    }
  }

  public getPendingCount(): number {
    this.ensurePendingCountInitialized();
    return this.pendingPayloadCount ?? 0;
  }

  private ensurePendingCountInitialized(): void {
    if (this.pendingPayloadCount !== null) {
      return;
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        this.pendingPayloadCount = 0;
        return;
      }

      const content = fs.readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.length > 0);

      let payloadCount = 0;
      for (const line of lines) {
        const envelope = this.parseEnvelope(line);
        if (envelope !== null && envelope.kind === 'payload') {
          payloadCount += 1;
        }
      }

      this.pendingPayloadCount = payloadCount;
    } catch {
      this.pendingPayloadCount = 0;
    }
  }

  private appendEnvelopeSync(
    input:
      | Omit<DeadLetterPayloadEnvelope, 'mac'>
      | Omit<DeadLetterMarkerEnvelope, 'mac'>
  ): boolean {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      if (this.exceedsMaxSize()) {
        console.warn('[ErrorCore] Dead-letter store at capacity; dropping payload');
        return false;
      }

      const envelope: DeadLetterEnvelope =
        input.kind === 'payload'
          ? {
              ...input,
              mac: this.signEnvelope(input)
            }
          : {
              ...input,
              mac: this.signEnvelope(input)
            };

      fs.appendFileSync(this.filePath, JSON.stringify(envelope) + '\n', {
        encoding: 'utf8',
        mode: 0o600
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Dead-letter store append failed: ${message}`);
      return false;
    }
  }

  private parseEnvelope(line: string): DeadLetterEnvelope | null {
    try {
      const parsed = JSON.parse(line) as unknown;

      if (!isRecordObject(parsed)) {
        return null;
      }

      if (
        parsed.version !== 1 ||
        (parsed.kind !== 'payload' && parsed.kind !== 'marker') ||
        typeof parsed.storedAt !== 'string' ||
        !isIsoTimestamp(parsed.storedAt) ||
        typeof parsed.mac !== 'string'
      ) {
        return null;
      }

      if (parsed.kind === 'payload') {
        if (
          typeof parsed.payload !== 'string' ||
          getUtf8ByteLength(parsed.payload) === 0 ||
          getUtf8ByteLength(parsed.payload) > this.maxPayloadBytes
        ) {
          return null;
        }

        if (this.requireEncryptedPayload && !isEncryptedPayloadFormat(parsed.payload)) {
          return null;
        }
      } else if (typeof parsed.code !== 'string' || parsed.code.length === 0) {
        return null;
      }

      const unsigned =
        parsed.kind === 'payload'
          ? {
              version: 1 as const,
              kind: 'payload' as const,
              storedAt: parsed.storedAt,
              payload: parsed.payload as string
            }
          : {
              version: 1 as const,
              kind: 'marker' as const,
              storedAt: parsed.storedAt,
              code: parsed.code as string
            };

      if (!this.verifyMac(unsigned, parsed.mac)) {
        return null;
      }

      return parsed.kind === 'payload'
        ? {
            version: 1,
            kind: 'payload',
            storedAt: parsed.storedAt,
            payload: parsed.payload as string,
            mac: parsed.mac
          }
        : {
            version: 1,
            kind: 'marker',
            storedAt: parsed.storedAt,
            code: parsed.code as string,
            mac: parsed.mac
          };
    } catch {
      return null;
    }
  }

  private signEnvelope(
    envelope:
      | Omit<DeadLetterPayloadEnvelope, 'mac'>
      | Omit<DeadLetterMarkerEnvelope, 'mac'>
  ): string {
    return createHmac('sha256', this.integrityKey)
      .update(JSON.stringify(envelope))
      .digest('base64');
  }

  private verifyMac(
    envelope:
      | Omit<DeadLetterPayloadEnvelope, 'mac'>
      | Omit<DeadLetterMarkerEnvelope, 'mac'>,
    mac: string
  ): boolean {
    try {
      const expected = Buffer.from(this.signEnvelope(envelope), 'base64');
      const actual = Buffer.from(mac, 'base64');

      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  private exceedsMaxSize(): boolean {
    try {
      const stats = fs.statSync(this.filePath);
      return stats.size >= this.maxSizeBytes;
    } catch {
      return false;
    }
  }
}
