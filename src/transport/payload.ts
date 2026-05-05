import type { EncryptedEnvelope, TransportPayload } from '../types';

export type TransportSendInput = TransportPayload | string | Buffer;

export function toTransportPayload(input: TransportSendInput): TransportPayload {
  if (typeof input === 'object' && input !== null && 'serialized' in input) {
    return input as TransportPayload;
  }

  return {
    serialized: input,
    envelope: parseEnvelopeMetadata(input)
  };
}

export function parseEnvelopeMetadata(
  serialized: string | Buffer
): TransportPayload['envelope'] | undefined {
  try {
    const text = Buffer.isBuffer(serialized) ? serialized.toString('utf8') : serialized;
    const parsed = JSON.parse(text) as Partial<EncryptedEnvelope>;
    if (
      parsed.v === 1 &&
      typeof parsed.eventId === 'string' &&
      typeof parsed.keyId === 'string' &&
      typeof parsed.sdk === 'object' &&
      parsed.sdk !== null &&
      parsed.sdk.name === 'errorcore' &&
      typeof parsed.sdk.version === 'string'
    ) {
      return {
        v: parsed.v,
        eventId: parsed.eventId,
        sdk: parsed.sdk,
        keyId: parsed.keyId
      };
    }
  } catch {
  }

  return undefined;
}

export function payloadBytes(payload: TransportSendInput): Buffer {
  const normalized = toTransportPayload(payload);
  return Buffer.isBuffer(normalized.serialized)
    ? normalized.serialized
    : Buffer.from(normalized.serialized);
}
