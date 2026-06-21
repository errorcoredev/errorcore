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

function encryptedPayload(payload: unknown, key = 'ingest-secret'): string {
  const eventId =
    typeof payload === 'object' && payload !== null && 'eventId' in payload
      ? String((payload as { eventId: unknown }).eventId)
      : 'evt';
  const envelope = new Encryption(key, { sdkVersion: '0.2.0' })
    .encryptToEnvelope(Buffer.from(JSON.stringify(payload), 'utf8'), { eventId });
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

  it('rejects encrypted envelopes when no encryption key is configured', () => {
    expect(() => receiveIngestEnvelope(encryptedPayload(minimalErrorPackage())))
      .toThrow(/EC_INGEST_ENCRYPTION_KEY_MISSING/);
  });

  it('rejects transparent envelopes unless explicitly allowed', () => {
    const envelope = buildTransparentEnvelope(
      Buffer.from(JSON.stringify(minimalErrorPackage()), 'utf8'),
      { eventId: 'evt-error', sdkVersion: '0.2.0' }
    );

    expect(() => receiveIngestEnvelope(JSON.stringify(envelope)))
      .toThrow(/EC_INGEST_UNENCRYPTED_REJECTED/);
  });

  it('accepts transparent envelopes when allowUnencrypted is true', () => {
    const envelope = buildTransparentEnvelope(
      Buffer.from(JSON.stringify(minimalErrorPackage()), 'utf8'),
      { eventId: 'evt-error', sdkVersion: '0.2.0' }
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
      { eventId: 'evt-error', sdkVersion: '0.2.0' }
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
