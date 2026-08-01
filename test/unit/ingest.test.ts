import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  IngestError,
  receiveIngestEnvelope,
  receiveWebhookBatch,
  verifyWebhookSignature
} from '../../src/ingest';
import { Encryption, buildTransparentEnvelope } from '../../src/security/encryption';
import type { ErrorPackage, PayloadBlobEnvelope } from '../../src/types';

function minimalErrorPackage(eventId = 'evt-error'): ErrorPackage {
  return {
    schemaVersion: '1.2.0',
    eventId,
    service: 'orders',
    capturedAt: '2026-05-28T00:00:00.000Z',
    errorEventSeq: 1,
    errorEventHrtimeNs: '1',
    eventClockRange: { min: 1, max: 1 },
    timeAnchor: { wallClockMs: 1, hrtimeNs: '1' },
    error: { type: 'Error', message: 'boom', stack: 'Error: boom', properties: {} },
    ioTimeline: [],
    evictionLog: [],
    stateReads: [],
    stateWrites: [],
    concurrentRequests: [],
    processMetadata: {
      nodeVersion: 'v20.0.0',
      v8Version: '11.0',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      hostname: 'host',
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 0,
      activeRequests: 0,
      eventLoopLagMs: 0,
      processStartAnchor: { wallClockMs: 1, hrtimeNs: '1' }
    },
    codeVersion: {},
    environment: {},
    completeness: {
      requestCaptured: false,
      requestBodyTruncated: false,
      ioTimelineCaptured: true,
      usedAmbientEvents: false,
      ioEventsDropped: 0,
      ioPayloadsTruncated: 0,
      alsContextAvailable: false,
      localVariablesCaptured: false,
      localVariablesTruncated: false,
      stateTrackingEnabled: false,
      stateReadsCaptured: false,
      concurrentRequestsCaptured: false,
      piiScrubbed: true,
      encrypted: true,
      captureFailures: []
    }
  };
}

function minimalBlob(eventId = 'evt-error'): PayloadBlobEnvelope {
  return {
    schemaVersion: '1.2.0',
    kind: 'payload_blob',
    eventId,
    blobId: 'blob-1',
    requestId: null,
    lineageId: null,
    mimeType: 'text/plain',
    size: 4,
    capturedSize: 4,
    sha256: 'hash',
    bodyEncoding: 'base64',
    body: Buffer.from('body').toString('base64'),
    createdAt: '2026-05-28T00:00:00.000Z'
  };
}

function encryptedPayload(
  payload: unknown,
  key = 'ingest-secret',
  overrides: { eventId?: string; kind?: 'error' | 'payload_blob'; blobId?: string } = {}
): string {
  const record = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
  const eventId = overrides.eventId
    ?? ('eventId' in record ? String(record.eventId) : 'evt');
  const kind = overrides.kind
    ?? (record.kind === 'payload_blob' ? 'payload_blob' : 'error');
  const blobId = kind === 'payload_blob'
    ? overrides.blobId ?? (typeof record.blobId === 'string' ? record.blobId : 'blob-1')
    : undefined;
  const envelope = new Encryption(key, { sdkVersion: '0.2.0' })
    .encryptToEnvelope(Buffer.from(JSON.stringify(payload), 'utf8'), {
      eventId,
      kind,
      ...(blobId === undefined ? {} : { blobId })
    });
  return JSON.stringify(envelope);
}

describe('ingest receiver', () => {
  it('decrypts and classifies Errorcore error envelopes', () => {
    const received = receiveIngestEnvelope(encryptedPayload(minimalErrorPackage()), {
      encryptionKey: 'ingest-secret'
    });

    expect(received.kind).toBe('error');
    expect(received.encrypted).toBe(true);
    expect(received.envelope.eventId).toBe('evt-error');
    expect(received.payload).toMatchObject({
      schemaVersion: '1.2.0',
      eventId: 'evt-error',
      service: 'orders'
    });
  });

  it('classifies the current 1.3.0 error package schema', () => {
    const payload: ErrorPackage = {
      ...minimalErrorPackage(),
      schemaVersion: '1.3.0'
    };
    const received = receiveIngestEnvelope(encryptedPayload(payload), {
      encryptionKey: 'ingest-secret'
    });

    expect(received.kind).toBe('error');
    expect(received.payload).toMatchObject({ schemaVersion: '1.3.0' });
  });

  it('rejects decrypted plaintext that exceeds the configured cap', () => {
    expect(() => receiveIngestEnvelope(encryptedPayload({
      ...minimalErrorPackage(),
      error: {
        type: 'Error',
        message: 'x'.repeat(20_000),
        stack: 'Error: large',
        properties: {}
      }
    }), {
      encryptionKey: 'ingest-secret',
      maxPlaintextBytes: 1_024
    })).toThrow(/EC_INGEST_PLAINTEXT_TOO_LARGE/);
  });

  it('decrypts and classifies payload blob envelopes', () => {
    const received = receiveIngestEnvelope(encryptedPayload(minimalBlob()), {
      encryptionKey: 'ingest-secret'
    });

    expect(received.kind).toBe('payload_blob');
    expect(received.payload).toMatchObject({
      kind: 'payload_blob',
      blobId: 'blob-1'
    });
  });

  it('rejects envelopes whose inner eventId differs from the envelope eventId', () => {
    // The envelope identity is authenticated (AAD), so a re-wrapped inner
    // payload with a different eventId must be rejected, not silently
    // accepted under the envelope's identity.
    const payload = minimalErrorPackage('evt-inner');
    const body = encryptedPayload(payload, 'ingest-secret', { eventId: 'evt-outer' });

    expect(() => receiveIngestEnvelope(body, { encryptionKey: 'ingest-secret' }))
      .toThrow(/EC_ENVELOPE_IDENTITY_MISMATCH/);
  });

  it('rejects blob envelopes whose inner blobId differs from the envelope blobId', () => {
    const body = encryptedPayload(minimalBlob(), 'ingest-secret', { blobId: 'blob-9' });

    expect(() => receiveIngestEnvelope(body, { encryptionKey: 'ingest-secret' }))
      .toThrow(/EC_ENVELOPE_IDENTITY_MISMATCH/);
  });

  it('rejects envelopes whose kind contradicts the inner payload kind', () => {
    const body = encryptedPayload(minimalErrorPackage(), 'ingest-secret', {
      kind: 'payload_blob',
      blobId: 'blob-1'
    });

    expect(() => receiveIngestEnvelope(body, { encryptionKey: 'ingest-secret' }))
      .toThrow(/EC_ENVELOPE_IDENTITY_MISMATCH/);
  });

  it('rejects v2 envelopes with incoherent kind/blobId shape', () => {
    const envelope = JSON.parse(encryptedPayload(minimalErrorPackage())) as Record<string, unknown>;

    expect(() => receiveIngestEnvelope(
      JSON.stringify({ ...envelope, kind: 'payload_blob' }),
      { encryptionKey: 'ingest-secret' }
    )).toThrow(/EC_INGEST_INVALID_ENVELOPE/);
    expect(() => receiveIngestEnvelope(
      JSON.stringify({ ...envelope, blobId: 'blob-1' }),
      { encryptionKey: 'ingest-secret' }
    )).toThrow(/EC_INGEST_INVALID_ENVELOPE/);
    expect(() => receiveIngestEnvelope(
      JSON.stringify({ ...envelope, kind: undefined }),
      { encryptionKey: 'ingest-secret' }
    )).toThrow(/EC_INGEST_INVALID_ENVELOPE/);
  });

  it('still accepts legacy v1 envelopes on the local read path', () => {
    const payload = minimalErrorPackage();
    // Recreate the exact v1 wire shape (SDK 0.3 format, AAD v1) with the
    // same crypto primitives so old local spools keep draining.
    const { createCipheriv, createHash, createHmac: hmac, hkdfSync } =
      require('node:crypto') as typeof import('node:crypto');
    const secret = Buffer.from('ingest-secret', 'utf8');
    const derivedKey = Buffer.from(hkdfSync(
      'sha256', secret, Buffer.from('errorcore-v1-key-derivation', 'utf8'), Buffer.alloc(0), 32
    ));
    const macKey = Buffer.from(hkdfSync(
      'sha256', secret, Buffer.from('errorcore-v1-mac-key', 'utf8'), Buffer.alloc(0), 32
    ));
    const keyId = createHash('sha256').update(derivedKey).digest().slice(0, 8).toString('hex');
    const aad = Buffer.from(`1|${keyId}|0.2.0|evt-error`, 'utf8');
    const iv = Buffer.from('00112233445566778899aabb', 'hex');
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    const v1 = {
      v: 1,
      eventId: 'evt-error',
      sdk: { name: 'errorcore', version: '0.2.0' },
      keyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
      hmac: hmac('sha256', macKey)
        .update(iv).update(ciphertext).update(authTag).update(aad)
        .digest('base64'),
      compressed: false,
      producedAt: 1
    };

    const received = receiveIngestEnvelope(JSON.stringify(v1), {
      encryptionKey: 'ingest-secret'
    });

    expect(received.kind).toBe('error');
    expect(received.encrypted).toBe(true);
  });

  it('bounds decompression during inflation with the default 10 MiB cap', () => {
    // ~24 MB of repeated JSON inflates far past the default cap while the
    // wire body stays tiny - the reader must throw during inflation.
    const bomb = {
      ...minimalErrorPackage(),
      error: {
        type: 'Error',
        message: 'a'.repeat(24 * 1024 * 1024),
        stack: 'Error: bomb',
        properties: {}
      }
    };

    expect(() => receiveIngestEnvelope(encryptedPayload(bomb), {
      encryptionKey: 'ingest-secret'
    })).toThrow(/EC_INGEST_PLAINTEXT_TOO_LARGE/);
  });

  it('rejects encrypted envelopes when no encryption key is configured', () => {
    expect(() => receiveIngestEnvelope(encryptedPayload(minimalErrorPackage())))
      .toThrow(/EC_INGEST_ENCRYPTION_KEY_MISSING/);
  });

  it('rejects transparent envelopes unless explicitly allowed', () => {
    const envelope = buildTransparentEnvelope(
      Buffer.from(JSON.stringify(minimalErrorPackage()), 'utf8'),
      { eventId: 'evt-error', sdkVersion: '0.2.0', kind: 'error' }
    );

    expect(() => receiveIngestEnvelope(JSON.stringify(envelope)))
      .toThrow(/EC_INGEST_UNENCRYPTED_REJECTED/);
  });

  it('accepts transparent envelopes when allowUnencrypted is true', () => {
    const envelope = buildTransparentEnvelope(
      Buffer.from(JSON.stringify(minimalErrorPackage()), 'utf8'),
      { eventId: 'evt-error', sdkVersion: '0.2.0', kind: 'error' }
    );
    const received = receiveIngestEnvelope(JSON.stringify(envelope), {
      allowUnencrypted: true
    });

    expect(received.kind).toBe('error');
    expect(received.encrypted).toBe(false);
  });

  it('rejects transparent envelopes with inconsistent markers', () => {
    const envelope = buildTransparentEnvelope(
      Buffer.from(JSON.stringify(minimalErrorPackage()), 'utf8'),
      { eventId: 'evt-error', sdkVersion: '0.2.0', kind: 'error' }
    );

    expect(() => receiveIngestEnvelope(JSON.stringify({ ...envelope, hmac: 'tampered' }), {
      allowUnencrypted: true
    })).toThrow(/EC_INGEST_INVALID_ENVELOPE/);
  });

  it('accepts watchdog payloads without envelope decryption', () => {
    const received = receiveIngestEnvelope({
      watchdogPayloadVersion: '1.0.0',
      capturedAt: '2026-05-28T00:00:00.000Z',
      source: 'watchdog',
      error: { message: 'Function timed out' },
      invocation: {
        functionName: 'worker',
        startedAt: '2026-05-28T00:00:00.000Z',
        durationMs: 9000,
        timeoutMs: 10000
      }
    });

    expect(received.kind).toBe('watchdog');
    expect(received.encrypted).toBe(false);
  });

  it('verifies webhook signatures against the exact raw body', () => {
    const body = JSON.stringify({ version: 1, kind: 'errorcore.webhook_batch', sentAt: 'now', events: [] });
    const signature = 'sha256=' + createHmac('sha256', 'webhook-secret').update(body).digest('hex');

    expect(verifyWebhookSignature(body, {
      secret: 'webhook-secret',
      headers: { 'x-errorcore-webhook-signature': signature }
    })).toBe(true);
    expect(verifyWebhookSignature(`${body} `, {
      secret: 'webhook-secret',
      headers: { 'x-errorcore-webhook-signature': signature }
    })).toBe(false);
  });

  it('verifies and ingests webhook batches', () => {
    const envelope = JSON.parse(encryptedPayload(minimalErrorPackage()));
    const body = JSON.stringify({
      version: 1,
      kind: 'errorcore.webhook_batch',
      sentAt: '2026-05-28T00:00:00.000Z',
      events: [{ kind: 'error', payload: envelope }]
    });
    const signature = 'sha256=' + createHmac('sha256', 'webhook-secret').update(body).digest('hex');

    const batch = receiveWebhookBatch(body, {
      encryptionKey: 'ingest-secret',
      secret: 'webhook-secret',
      headers: { 'X-Errorcore-Webhook-Signature': signature }
    });

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.payload.kind).toBe('error');
  });

  it('rejects webhook batches with an invalid signature', () => {
    const body = JSON.stringify({ version: 1, kind: 'errorcore.webhook_batch', sentAt: 'now', events: [] });

    expect(() => receiveWebhookBatch(body, {
      secret: 'webhook-secret',
      headers: { 'x-errorcore-webhook-signature': 'sha256=bad' }
    })).toThrow(IngestError);
  });
});
