import { createHmac, timingSafeEqual } from 'node:crypto';

import { Encryption, TRANSPARENT_MARKER, isTransparentEnvelope } from '../security/encryption';
import { DEFAULT_MAX_PLAINTEXT_BYTES } from '../security/compression';
import type { AnyEncryptedEnvelope, ErrorPackage, PayloadBlobEnvelope } from '../types';

export type IngestHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

export interface WatchdogPayload {
  watchdogPayloadVersion: '1.0.0';
  capturedAt: string;
  source: 'watchdog';
  error: {
    type?: string;
    name?: string;
    message: string;
    stack?: string;
  };
  invocation: {
    functionName: string;
    requestId?: string;
    lambdaRequestId?: string;
    traceId?: string;
    eventSource?: string;
    startedAt: string;
    durationMs: number;
    timeoutMs: number;
  };
}

export interface IngestEnvelopeOptions {
  encryptionKey?: string | Buffer;
  macKey?: string | Buffer;
  previousEncryptionKeys?: string[];
  allowUnencrypted?: boolean;
  /**
   * Hard cap on decrypted/inflated plaintext. Defaults to 10 MiB and is
   * always enforced - for compressed envelopes DURING inflation, so a
   * deflate bomb throws before allocating unbounded output.
   */
  maxPlaintextBytes?: number;
}

export interface WebhookSignatureOptions {
  secret: string;
  headers: IngestHeaders;
}

export interface ReceiveWebhookBatchOptions extends IngestEnvelopeOptions {
  secret?: string;
  headers?: IngestHeaders;
}

export type IngestedPayload =
  | {
      kind: 'error';
      payload: ErrorPackage;
      rawPayload: string;
      envelope: AnyEncryptedEnvelope;
      encrypted: boolean;
      keyIndex?: number;
    }
  | {
      kind: 'payload_blob';
      payload: PayloadBlobEnvelope;
      rawPayload: string;
      envelope: AnyEncryptedEnvelope;
      encrypted: boolean;
      keyIndex?: number;
    }
  | {
      kind: 'watchdog';
      payload: WatchdogPayload;
      rawPayload: string;
      encrypted: false;
    }
  | {
      kind: 'unknown';
      payload: unknown;
      rawPayload: string;
      envelope?: AnyEncryptedEnvelope;
      encrypted: boolean;
      keyIndex?: number;
    };

export interface IngestedWebhookBatch {
  version: 1;
  kind: 'errorcore.webhook_batch';
  sentAt: string;
  events: Array<{
    kind: 'error' | 'payload_blob';
    payload: IngestedPayload;
  }>;
}

export class IngestError extends Error {
  public readonly code: string;

  public readonly statusCode: number;

  public constructor(code: string, message: string, statusCode = 400) {
    super(`${code}: ${message}`);
    this.name = 'IngestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(input: string | Buffer | unknown, code: string): unknown {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    return input;
  }

  try {
    return JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : input);
  } catch {
    throw new IngestError(code, 'Ingest payload is not valid JSON');
  }
}

function rawJson(input: string | Buffer | unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (Buffer.isBuffer(input)) {
    return input.toString('utf8');
  }
  return JSON.stringify(input);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new IngestError(
      'EC_INGEST_INVALID_ENVELOPE',
      `Errorcore envelope is missing required string field ${field}`
    );
  }
  return value;
}

function parseEnvelope(input: unknown): AnyEncryptedEnvelope {
  if (!isRecord(input)) {
    throw new IngestError('EC_INGEST_INVALID_ENVELOPE', 'Errorcore envelope must be a JSON object');
  }

  const sdk = input.sdk;
  if (
    // v2 is the wire contract (ADR-0001); v1 is accepted only so local
    // spools written by pre-0.4 SDKs still drain through this reader.
    (input.v !== 1 && input.v !== 2) ||
    !isRecord(sdk) ||
    sdk.name !== 'errorcore' ||
    typeof sdk.version !== 'string' ||
    typeof input.compressed !== 'boolean' ||
    typeof input.producedAt !== 'number'
  ) {
    throw new IngestError('EC_INGEST_INVALID_ENVELOPE', 'Errorcore envelope shape is invalid');
  }

  const base = {
    eventId: requiredString(input, 'eventId'),
    sdk: { name: 'errorcore', version: sdk.version } as const,
    keyId: requiredString(input, 'keyId'),
    iv: requiredString(input, 'iv'),
    ciphertext: requiredString(input, 'ciphertext'),
    authTag: requiredString(input, 'authTag'),
    hmac: requiredString(input, 'hmac'),
    compressed: input.compressed,
    producedAt: input.producedAt
  };

  if (input.v === 1) {
    return { v: 1, ...base };
  }

  if (input.kind !== 'error' && input.kind !== 'payload_blob') {
    throw new IngestError(
      'EC_INGEST_INVALID_ENVELOPE',
      "Errorcore v2 envelope kind must be 'error' or 'payload_blob'"
    );
  }
  if (input.kind === 'payload_blob') {
    if (typeof input.blobId !== 'string' || input.blobId.length === 0) {
      throw new IngestError(
        'EC_INGEST_INVALID_ENVELOPE',
        'Errorcore v2 payload_blob envelope requires a blobId'
      );
    }
  } else if (input.blobId !== undefined) {
    throw new IngestError(
      'EC_INGEST_INVALID_ENVELOPE',
      'Errorcore v2 error envelope must not carry a blobId'
    );
  }

  return {
    v: 2,
    kind: input.kind,
    ...(input.kind === 'payload_blob' ? { blobId: input.blobId as string } : {}),
    ...base
  };
}

function isWatchdogPayload(value: unknown): value is WatchdogPayload {
  return (
    isRecord(value) &&
    value.source === 'watchdog' &&
    value.watchdogPayloadVersion === '1.0.0' &&
    typeof value.capturedAt === 'string' &&
    isRecord(value.error) &&
    typeof value.error.message === 'string' &&
    isRecord(value.invocation) &&
    typeof value.invocation.functionName === 'string' &&
    typeof value.invocation.startedAt === 'string' &&
    typeof value.invocation.durationMs === 'number' &&
    typeof value.invocation.timeoutMs === 'number'
  );
}

function classifyPayload(payload: unknown): IngestedPayload['kind'] {
  if (isWatchdogPayload(payload)) {
    return 'watchdog';
  }
  if (!isRecord(payload)) {
    return 'unknown';
  }
  if (payload.schemaVersion === '1.2.0' && payload.kind === 'payload_blob') {
    return 'payload_blob';
  }
  if (
    (
      payload.schemaVersion === '1.1.0' ||
      payload.schemaVersion === '1.2.0' ||
      payload.schemaVersion === '1.3.0'
    ) &&
    typeof payload.capturedAt === 'string' &&
    isRecord(payload.error)
  ) {
    return 'error';
  }
  return 'unknown';
}

function parseInnerPayload(rawPayload: string): unknown {
  try {
    return JSON.parse(rawPayload);
  } catch {
    throw new IngestError(
      'EC_INGEST_INVALID_PAYLOAD_JSON',
      'Decoded Errorcore envelope payload is not valid JSON'
    );
  }
}

function resolvePlaintextLimit(maxPlaintextBytes: number | undefined): number {
  if (maxPlaintextBytes === undefined) {
    return DEFAULT_MAX_PLAINTEXT_BYTES;
  }
  if (!Number.isFinite(maxPlaintextBytes) || maxPlaintextBytes <= 0) {
    throw new IngestError(
      'EC_INGEST_INVALID_PLAINTEXT_LIMIT',
      'maxPlaintextBytes must be a positive number'
    );
  }
  return maxPlaintextBytes;
}

function enforcePlaintextLimit(rawPayload: string, maxPlaintextBytes: number): void {
  const size = Buffer.byteLength(rawPayload, 'utf8');
  if (size > maxPlaintextBytes) {
    throw new IngestError(
      'EC_INGEST_PLAINTEXT_TOO_LARGE',
      `Decoded Errorcore envelope plaintext is ${size} bytes, above ${maxPlaintextBytes} bytes`,
      413
    );
  }
}

/**
 * Post-decrypt identity checks (ADR-0001): the authenticated envelope
 * metadata and the decrypted inner payload must agree on eventId, kind,
 * and (for blobs) blobId. A mismatch means the sender re-wrapped a
 * payload under a different identity; quarantine, never silently accept.
 */
function enforceEnvelopeIdentity(
  kind: IngestedPayload['kind'],
  payload: unknown,
  envelope: AnyEncryptedEnvelope
): void {
  if (kind !== 'error' && kind !== 'payload_blob') {
    return;
  }

  const record = isRecord(payload) ? payload : {};
  if (typeof record.eventId !== 'string' || record.eventId !== envelope.eventId) {
    throw new IngestError(
      'EC_ENVELOPE_IDENTITY_MISMATCH',
      'Inner payload eventId does not match the envelope eventId',
      422
    );
  }

  if (envelope.v !== 2) {
    // Legacy v1 envelopes carry no kind/blobId to compare.
    return;
  }

  if (envelope.kind !== kind) {
    throw new IngestError(
      'EC_ENVELOPE_IDENTITY_MISMATCH',
      `Envelope kind ${envelope.kind} does not match inner payload kind ${kind}`,
      422
    );
  }

  if (
    kind === 'payload_blob' &&
    (typeof record.blobId !== 'string' || record.blobId !== envelope.blobId)
  ) {
    throw new IngestError(
      'EC_ENVELOPE_IDENTITY_MISMATCH',
      'Inner payload blobId does not match the envelope blobId',
      422
    );
  }
}

function buildIngestedPayload(input: {
  payload: unknown;
  rawPayload: string;
  envelope?: AnyEncryptedEnvelope;
  encrypted: boolean;
  keyIndex?: number;
}): IngestedPayload {
  const kind = classifyPayload(input.payload);

  if (kind === 'watchdog' && isWatchdogPayload(input.payload)) {
    return {
      kind,
      payload: input.payload,
      rawPayload: input.rawPayload,
      encrypted: false
    };
  }

  if (kind === 'error' && input.envelope !== undefined) {
    return {
      kind,
      payload: input.payload as ErrorPackage,
      rawPayload: input.rawPayload,
      envelope: input.envelope,
      encrypted: input.encrypted,
      ...(input.keyIndex === undefined ? {} : { keyIndex: input.keyIndex })
    };
  }

  if (kind === 'payload_blob' && input.envelope !== undefined) {
    return {
      kind,
      payload: input.payload as PayloadBlobEnvelope,
      rawPayload: input.rawPayload,
      envelope: input.envelope,
      encrypted: input.encrypted,
      ...(input.keyIndex === undefined ? {} : { keyIndex: input.keyIndex })
    };
  }

  return {
    kind: 'unknown',
    payload: input.payload,
    rawPayload: input.rawPayload,
    ...(input.envelope === undefined ? {} : { envelope: input.envelope }),
    encrypted: input.encrypted,
    ...(input.keyIndex === undefined ? {} : { keyIndex: input.keyIndex })
  };
}

export function receiveIngestEnvelope(
  input: string | Buffer | unknown,
  options: IngestEnvelopeOptions = {}
): IngestedPayload {
  const parsed = parseJsonValue(input, 'EC_INGEST_INVALID_JSON');

  if (isWatchdogPayload(parsed)) {
    return buildIngestedPayload({
      payload: parsed,
      rawPayload: rawJson(input),
      encrypted: false
    });
  }

  const maxPlaintextBytes = resolvePlaintextLimit(options.maxPlaintextBytes);
  const envelope = parseEnvelope(parsed);
  let rawPayload: string;
  let keyIndex: number | undefined;
  let encrypted = true;

  if (isTransparentEnvelope(envelope)) {
    if (envelope.keyId !== TRANSPARENT_MARKER || envelope.hmac !== TRANSPARENT_MARKER) {
      throw new IngestError(
        'EC_INGEST_INVALID_ENVELOPE',
        'Transparent Errorcore envelope markers are inconsistent'
      );
    }
    if (options.allowUnencrypted !== true) {
      throw new IngestError(
        'EC_INGEST_UNENCRYPTED_REJECTED',
        'Unencrypted Errorcore envelopes are disabled for this ingestion endpoint',
        403
      );
    }
    rawPayload = Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
    encrypted = false;
  } else {
    if (options.encryptionKey === undefined) {
      throw new IngestError(
        'EC_INGEST_ENCRYPTION_KEY_MISSING',
        'An encryptionKey is required to ingest encrypted Errorcore envelopes',
        500
      );
    }
    const encryption = new Encryption(options.encryptionKey, {
      macKey: options.macKey,
      previousEncryptionKeys: options.previousEncryptionKeys,
      sdkVersion: envelope.sdk.version,
      // Enforced DURING inflation - a compression bomb throws before
      // any oversized plaintext buffer is allocated.
      maxPlaintextBytes
    });
    let decrypted: ReturnType<Encryption['decryptEnvelope']>;
    try {
      decrypted = encryption.decryptEnvelope(envelope);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes('EC_DECOMPRESSION_LIMIT_EXCEEDED')) {
        throw new IngestError(
          'EC_INGEST_PLAINTEXT_TOO_LARGE',
          `Decoded Errorcore envelope plaintext exceeds ${maxPlaintextBytes} bytes`,
          413
        );
      }
      throw new IngestError(
        'EC_INGEST_DECRYPT_FAILED',
        `Unable to decrypt Errorcore envelope: ${reason}`,
        400
      );
    }
    if (!decrypted.ok) {
      throw new IngestError('EC_INGEST_DECRYPT_FAILED', 'Unable to decrypt Errorcore envelope', 400);
    }
    rawPayload = decrypted.plaintext;
    keyIndex = decrypted.keyIndex;
  }

  enforcePlaintextLimit(rawPayload, maxPlaintextBytes);
  const innerPayload = parseInnerPayload(rawPayload);
  enforceEnvelopeIdentity(classifyPayload(innerPayload), innerPayload, envelope);
  return buildIngestedPayload({
    payload: innerPayload,
    rawPayload,
    envelope,
    encrypted,
    keyIndex
  });
}

function getHeader(headers: IngestHeaders, name: string): string | undefined {
  if ('get' in headers && typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }
  return undefined;
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  options: WebhookSignatureOptions
): boolean {
  const actual = getHeader(options.headers, 'x-errorcore-webhook-signature');
  if (actual === undefined || !actual.startsWith('sha256=')) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = `sha256=${createHmac('sha256', options.secret).update(body).digest('hex')}`;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseWebhookBatch(input: unknown): {
  version: 1;
  kind: 'errorcore.webhook_batch';
  sentAt: string;
  events: Array<{ kind: 'error' | 'payload_blob'; payload: unknown }>;
} {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    input.kind !== 'errorcore.webhook_batch' ||
    typeof input.sentAt !== 'string' ||
    !Array.isArray(input.events)
  ) {
    throw new IngestError('EC_INGEST_INVALID_WEBHOOK_BATCH', 'Webhook batch shape is invalid');
  }

  const events = input.events.map((event) => {
    if (
      !isRecord(event) ||
      (event.kind !== 'error' && event.kind !== 'payload_blob') ||
      !('payload' in event)
    ) {
      throw new IngestError('EC_INGEST_INVALID_WEBHOOK_BATCH', 'Webhook batch event shape is invalid');
    }
    const kind = event.kind as 'error' | 'payload_blob';
    return {
      kind,
      payload: event.payload
    };
  });

  return {
    version: 1,
    kind: 'errorcore.webhook_batch',
    sentAt: input.sentAt,
    events
  };
}

export function receiveWebhookBatch(
  rawBody: string | Buffer,
  options: ReceiveWebhookBatchOptions = {}
): IngestedWebhookBatch {
  if (options.secret !== undefined) {
    if (options.headers === undefined) {
      throw new IngestError(
        'EC_INGEST_WEBHOOK_SIGNATURE_MISSING',
        'Webhook signature headers are required when a secret is configured',
        401
      );
    }
    if (!verifyWebhookSignature(rawBody, { secret: options.secret, headers: options.headers })) {
      throw new IngestError(
        'EC_INGEST_WEBHOOK_SIGNATURE_INVALID',
        'Webhook signature verification failed',
        401
      );
    }
  }

  const batch = parseWebhookBatch(parseJsonValue(rawBody, 'EC_INGEST_INVALID_WEBHOOK_BATCH_JSON'));
  return {
    version: 1,
    kind: 'errorcore.webhook_batch',
    sentAt: batch.sentAt,
    events: batch.events.map((event) => ({
      kind: event.kind,
      payload: receiveIngestEnvelope(event.payload, options)
    }))
  };
}
