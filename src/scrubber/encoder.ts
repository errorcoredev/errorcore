import { createHash } from 'node:crypto';

import type { Encryption } from '../security/encryption';
import type { Blob, Field, FieldSpool, Meta, Policy, Source } from './types';

const REF_NONCE_BYTES = 12;

function safeByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Buffer.isBuffer(value)) return 'buffer';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regexp';
  if (value instanceof Error) return 'error';
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  if (value instanceof ArrayBuffer) return 'arraybuffer';
  return typeof value;
}

function stringifyForBytes(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function encodeFieldPlaintext(value: unknown): Buffer {
  return Buffer.from(stringifyForBytes(value), 'utf8');
}

export function computeMeta(value: unknown, maxKeys: number): Meta {
  const type = typeOfValue(value);
  const text = stringifyForBytes(value);
  const meta: Meta = {
    type,
    bytes: safeByteLength(text)
  };

  if (typeof value === 'string' || Array.isArray(value)) {
    meta.len = value.length;
  } else if (Buffer.isBuffer(value)) {
    meta.len = value.length;
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    meta.len = (value as unknown as ArrayLike<unknown>).length;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    meta.keys = Object.keys(value as Record<string, unknown>).slice(0, maxKeys);
  }

  return meta;
}

function toInlineBlob(encryption: Encryption, plaintext: Buffer): Blob {
  const encrypted = encryption.encryptField(plaintext);
  return {
    type: 'inline',
    bytes: encrypted.bytes,
    nonce: encrypted.nonce
  };
}

function toRefBlob(input: {
  encryption: Encryption;
  spool: FieldSpool;
  plaintext: Buffer;
  name: string;
  source: Source;
}): Blob {
  const encrypted = input.encryption.encryptField(input.plaintext);
  const packed = Buffer.concat([
    Buffer.from(encrypted.nonce),
    Buffer.from(encrypted.bytes)
  ]);
  const stored = input.spool.store({
    bytes: packed,
    originalSize: input.plaintext.length,
    name: input.name,
    source: input.source
  });
  return {
    type: 'ref',
    id: stored.id,
    bytes: stored.bytes
  };
}

export function encodeNormal(input: {
  name: string;
  value: unknown;
  meta: Meta;
  source: Source;
  policy: Policy;
  encryption: Encryption;
  spool?: FieldSpool;
}): Field {
  const plaintext = encodeFieldPlaintext(input.value);

  if (input.source === 'http_incoming' && plaintext.length > input.policy.spoolBytes) {
    if (input.spool === undefined) {
      return { mode: 'meta', meta: input.meta };
    }

    return {
      mode: 'encrypted',
      meta: input.meta,
      cipher: toRefBlob({
        encryption: input.encryption,
        spool: input.spool,
        plaintext,
        name: input.name,
        source: input.source
      })
    };
  }

  if (plaintext.length > input.policy.maxField) {
    return { mode: 'meta', meta: input.meta };
  }

  return {
    mode: 'encrypted',
    meta: input.meta,
    cipher: toInlineBlob(input.encryption, plaintext)
  };
}

export function decryptFieldValue(
  field: Field,
  input: { encryption: Encryption; spool?: Pick<FieldSpool, 'get'> }
): Buffer {
  if (field.mode !== 'encrypted') {
    throw new Error('Cannot decrypt metadata-only field');
  }

  if (field.cipher.type === 'inline') {
    return input.encryption.decryptField(field.cipher.bytes, field.cipher.nonce);
  }

  const packed = input.spool?.get?.(field.cipher.id);
  if (packed === null || packed === undefined) {
    throw new Error(`Field spool ref not found: ${field.cipher.id}`);
  }

  if (packed.length < REF_NONCE_BYTES + 1) {
    throw new Error(`Field spool ref is invalid: ${field.cipher.id}`);
  }

  return input.encryption.decryptField(
    packed.subarray(REF_NONCE_BYTES),
    packed.subarray(0, REF_NONCE_BYTES)
  );
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
