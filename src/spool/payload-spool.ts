import type {
  InternalWarning,
  PayloadBlobEnvelope,
  PayloadBlobRef,
  PayloadPreviewReason
} from '../types';

export type PayloadPressureLevel = 'normal' | 'degraded' | 'critical';

export interface PayloadSpoolEntry {
  ref: PayloadBlobRef;
  bytes: Buffer;
  createdAtMs: number;
  completedAtMs: number | null;
  state: 'active' | 'sweepable';
}

export interface PayloadSpoolOptions {
  globalMaxBytes: number;
  perRequestMaxBytes: number;
  perBlobMaxBytes: number;
  previewBytes: number;
  completedTtlMs: number;
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  getTransportQueueDepth?: () => number;
  onWarning?: (warning: InternalWarning) => void;
}

export interface PayloadSpoolStoreInput {
  requestId: string | null;
  lineageId: string | null;
  mimeType: string | null;
  bytes: Buffer;
  originalSize: number;
  sha256: string;
  complete?: boolean;
}

export interface PayloadSpoolStoreResult {
  ref: PayloadBlobRef;
  preview: Buffer;
}

export interface PayloadSpoolStats {
  blobCount: number;
  usedBytes: number;
  globalMaxBytes: number;
  previewOnlyCount: number;
  pressure: PayloadPressureLevel;
}

const DEGRADED_HEAP_RATIO = 0.7;
const CRITICAL_HEAP_RATIO = 0.85;
const DEGRADED_SPOOL_RATIO = 0.8;
const CRITICAL_SPOOL_RATIO = 0.95;
const DEGRADED_TRANSPORT_QUEUE_DEPTH = 500;
const DEGRADED_PER_REQUEST_BYTES = 512 * 1024;

export class PayloadSpool {
  private readonly globalMaxBytes: number;

  private readonly perRequestMaxBytes: number;

  private readonly perBlobMaxBytes: number;

  private readonly previewBytes: number;

  private readonly completedTtlMs: number;

  private readonly now: () => number;

  private readonly memoryUsage: () => NodeJS.MemoryUsage;

  private readonly getTransportQueueDepth: () => number;

  private readonly onWarning: ((warning: InternalWarning) => void) | undefined;

  private readonly entries = new Map<string, PayloadSpoolEntry>();

  private readonly requestBytes = new Map<string, number>();

  private usedBytes = 0;

  private nextBlobId = 1;

  private previewOnlyCount = 0;

  public constructor(options: PayloadSpoolOptions) {
    this.globalMaxBytes = options.globalMaxBytes;
    this.perRequestMaxBytes = options.perRequestMaxBytes;
    this.perBlobMaxBytes = options.perBlobMaxBytes;
    this.previewBytes = options.previewBytes;
    this.completedTtlMs = options.completedTtlMs;
    this.now = options.now ?? (() => Date.now());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.getTransportQueueDepth = options.getTransportQueueDepth ?? (() => 0);
    this.onWarning = options.onWarning;
  }

  public getMaxCaptureBytes(): number {
    return this.perBlobMaxBytes;
  }

  public store(input: PayloadSpoolStoreInput): PayloadSpoolStoreResult {
    this.sweep();
    const pressure = this.getPressureLevel();
    const preview = input.bytes.subarray(0, Math.min(input.bytes.length, this.previewBytes));
    const blobId = this.createBlobId();
    const requestKey = input.requestId ?? '__ambient__';
    const effectivePerRequestCap =
      pressure === 'degraded'
        ? Math.min(this.perRequestMaxBytes, DEGRADED_PER_REQUEST_BYTES)
        : this.perRequestMaxBytes;
    const requestUsedBytes = this.requestBytes.get(requestKey) ?? 0;

    let previewReason: PayloadPreviewReason | null = null;
    if (pressure === 'critical') {
      previewReason = 'pressure';
    } else {
      if (pressure === 'degraded') {
        this.emitWarning(
          'EC_PAYLOAD_SPOOL_PRESSURE',
          'Payload spool entered degraded pressure; reducing full capture budget.',
          { pressure }
        );
      }
      if (input.originalSize > this.perBlobMaxBytes) {
        previewReason = 'per_blob_cap';
      } else if (input.complete === false) {
        previewReason = 'incomplete';
      } else if (requestUsedBytes + input.originalSize > effectivePerRequestCap) {
        previewReason = 'per_request_cap';
      } else if (this.usedBytes + input.originalSize > this.globalMaxBytes) {
        previewReason = 'global_cap';
      }
    }

    if (previewReason !== null) {
      this.previewOnlyCount += 1;
      this.emitWarning(
        previewReason === 'pressure' ? 'EC_PAYLOAD_SPOOL_PRESSURE' : 'EC_PAYLOAD_SPOOL_PREVIEW',
        `Payload stored as preview only (${previewReason}).`,
        { reason: previewReason, requestId: input.requestId, originalSize: input.originalSize }
      );
      return {
        preview,
        ref: this.buildRef(input, blobId, 'preview', preview.length, previewReason)
      };
    }

    const bytes = Buffer.from(input.bytes);
    const ref = this.buildRef(input, blobId, 'spool', preview.length);
    this.entries.set(blobId, {
      ref,
      bytes,
      createdAtMs: this.now(),
      completedAtMs: null,
      state: 'active'
    });
    this.usedBytes += bytes.length;
    this.requestBytes.set(requestKey, requestUsedBytes + bytes.length);

    return { ref, preview };
  }

  public get(blobId: string): PayloadSpoolEntry | null {
    return this.entries.get(blobId) ?? null;
  }

  public markRequestComplete(requestId: string): void {
    const completedAtMs = this.now();
    for (const entry of this.entries.values()) {
      if (entry.ref.requestId !== requestId) {
        continue;
      }
      entry.state = 'sweepable';
      entry.completedAtMs = completedAtMs;
    }
  }

  public sweep(): void {
    const now = this.now();
    for (const [blobId, entry] of this.entries.entries()) {
      if (
        entry.state === 'sweepable' &&
        entry.completedAtMs !== null &&
        now - entry.completedAtMs > this.completedTtlMs
      ) {
        this.deleteEntry(blobId, entry);
      }
    }
  }

  public getStats(): PayloadSpoolStats {
    return {
      blobCount: this.entries.size,
      usedBytes: this.usedBytes,
      globalMaxBytes: this.globalMaxBytes,
      previewOnlyCount: this.previewOnlyCount,
      pressure: this.getPressureLevel()
    };
  }

  public getPressureLevel(): PayloadPressureLevel {
    const usageRatio = this.globalMaxBytes <= 0 ? 1 : this.usedBytes / this.globalMaxBytes;
    const memory = this.memoryUsage();
    const heapRatio = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0;

    if (heapRatio >= CRITICAL_HEAP_RATIO || usageRatio >= CRITICAL_SPOOL_RATIO) {
      return 'critical';
    }

    if (
      heapRatio >= DEGRADED_HEAP_RATIO ||
      usageRatio >= DEGRADED_SPOOL_RATIO ||
      this.getTransportQueueDepth() >= DEGRADED_TRANSPORT_QUEUE_DEPTH
    ) {
      return 'degraded';
    }

    return 'normal';
  }

  public buildEnvelope(eventId: string, blobId: string): PayloadBlobEnvelope | null {
    const entry = this.entries.get(blobId);
    if (entry === undefined) {
      return null;
    }

    return {
      schemaVersion: '1.2.0',
      kind: 'payload_blob',
      eventId,
      blobId,
      requestId: entry.ref.requestId,
      lineageId: entry.ref.lineageId,
      mimeType: entry.ref.mimeType,
      size: entry.ref.size,
      capturedSize: entry.ref.capturedSize,
      sha256: entry.ref.sha256,
      bodyEncoding: 'base64',
      body: entry.bytes.toString('base64'),
      createdAt: new Date(entry.createdAtMs).toISOString()
    };
  }

  private createBlobId(): string {
    const id = `blob_${this.nextBlobId}`;
    this.nextBlobId += 1;
    return id;
  }

  private buildRef(
    input: PayloadSpoolStoreInput,
    blobId: string,
    storage: PayloadBlobRef['storage'],
    previewLength: number,
    reason?: PayloadPreviewReason
  ): PayloadBlobRef {
    return {
      blobId,
      storage,
      requestId: input.requestId,
      lineageId: input.lineageId,
      mimeType: input.mimeType,
      size: input.originalSize,
      capturedSize: storage === 'spool' ? input.bytes.length : previewLength,
      sha256: input.sha256,
      previewBytes: previewLength,
      previewTruncated: input.originalSize > previewLength,
      ...(reason === undefined ? {} : { reason })
    };
  }

  private deleteEntry(blobId: string, entry: PayloadSpoolEntry): void {
    this.entries.delete(blobId);
    this.usedBytes -= entry.bytes.length;
    const requestKey = entry.ref.requestId ?? '__ambient__';
    const current = this.requestBytes.get(requestKey) ?? 0;
    const next = Math.max(0, current - entry.bytes.length);
    if (next === 0) {
      this.requestBytes.delete(requestKey);
    } else {
      this.requestBytes.set(requestKey, next);
    }
  }

  private emitWarning(
    code: InternalWarning['code'],
    message: string,
    context?: Record<string, unknown>
  ): void {
    try {
      this.onWarning?.({
        code,
        message,
        ...(context === undefined ? {} : { context })
      });
    } catch {
    }
  }
}
