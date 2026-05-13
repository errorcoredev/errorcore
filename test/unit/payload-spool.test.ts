import { describe, expect, it, vi } from 'vitest';

import { PayloadSpool } from '../../src/spool/payload-spool';

describe('PayloadSpool', () => {
  it('stores scrubbed payload bytes under global and per-request caps', () => {
    const spool = new PayloadSpool({
      globalMaxBytes: 64,
      perRequestMaxBytes: 64,
      perBlobMaxBytes: 32,
      previewBytes: 4,
      completedTtlMs: 1000,
      now: () => 100
    });

    const result = spool.store({
      requestId: 'req-1',
      lineageId: 'req-1',
      mimeType: 'application/json',
      bytes: Buffer.from('{"email":"[REDACTED]"}'),
      originalSize: 22,
      sha256: 'hash'
    });

    expect(result.ref).toMatchObject({
      blobId: expect.stringMatching(/^blob_/),
      storage: 'spool',
      requestId: 'req-1',
      lineageId: 'req-1',
      mimeType: 'application/json',
      size: 22,
      sha256: 'hash'
    });
    expect(result.preview.toString()).toBe('{"em');
    expect(spool.get(result.ref.blobId)?.bytes.toString()).toBe(
      '{"email":"[REDACTED]"}'
    );
    expect(spool.getStats()).toMatchObject({
      blobCount: 1,
      usedBytes: 22,
      previewOnlyCount: 0
    });
  });

  it('falls back to preview-only when the original payload exceeds the per-blob cap', () => {
    const spool = new PayloadSpool({
      globalMaxBytes: 128,
      perRequestMaxBytes: 128,
      perBlobMaxBytes: 8,
      previewBytes: 4,
      completedTtlMs: 1000,
      now: () => 100
    });

    const result = spool.store({
      requestId: 'req-1',
      lineageId: 'req-1',
      mimeType: 'text/plain',
      bytes: Buffer.from('abcdefghijkl'),
      originalSize: 12,
      sha256: 'hash'
    });

    expect(result.ref.storage).toBe('preview');
    expect(result.ref.reason).toBe('per_blob_cap');
    expect(result.preview.toString()).toBe('abcd');
    expect(spool.get(result.ref.blobId)).toBeNull();
    expect(spool.getStats().previewOnlyCount).toBe(1);
  });

  it('marks request blobs sweepable and removes them after the completion TTL', () => {
    let now = 100;
    const spool = new PayloadSpool({
      globalMaxBytes: 128,
      perRequestMaxBytes: 128,
      perBlobMaxBytes: 64,
      previewBytes: 8,
      completedTtlMs: 50,
      now: () => now
    });

    const result = spool.store({
      requestId: 'req-1',
      lineageId: 'req-1',
      mimeType: 'text/plain',
      bytes: Buffer.from('hello'),
      originalSize: 5,
      sha256: 'hash'
    });

    spool.markRequestComplete('req-1');
    expect(spool.get(result.ref.blobId)?.state).toBe('sweepable');

    now = 151;
    spool.sweep();

    expect(spool.get(result.ref.blobId)).toBeNull();
    expect(spool.getStats().blobCount).toBe(0);
  });

  it('uses preview-only capture under critical pressure and emits diagnostics', () => {
    const onWarning = vi.fn();
    const spool = new PayloadSpool({
      globalMaxBytes: 128,
      perRequestMaxBytes: 128,
      perBlobMaxBytes: 64,
      previewBytes: 4,
      completedTtlMs: 1000,
      now: () => 100,
      getTransportQueueDepth: () => 0,
      memoryUsage: () => ({
        rss: 1,
        heapTotal: 100,
        heapUsed: 90,
        external: 0,
        arrayBuffers: 0
      }),
      onWarning
    });

    const result = spool.store({
      requestId: 'req-1',
      lineageId: 'req-1',
      mimeType: 'text/plain',
      bytes: Buffer.from('abcdef'),
      originalSize: 6,
      sha256: 'hash'
    });

    expect(result.ref.storage).toBe('preview');
    expect(result.ref.reason).toBe('pressure');
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EC_PAYLOAD_SPOOL_PRESSURE' })
    );
  });
});
