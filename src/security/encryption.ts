
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import type { AnyEncryptedEnvelope, EncryptedEnvelope } from '../types';
import { DEFAULT_MAX_PLAINTEXT_BYTES, maybeCompress, maybeDecompress } from './compression';

interface EncryptionOptions {
  previousEncryptionKeys?: string[];
  /** Optional explicit MAC key (32+ bytes). When unset, derived from DEK. */
  macKey?: string | Buffer;
  /** SDK version used in AAD binding and envelope.sdk.version. */
  sdkVersion?: string;
  /**
   * Hard cap on decompressed plaintext, enforced DURING inflation.
   * Defaults to DEFAULT_MAX_PLAINTEXT_BYTES (10 MiB).
   */
  maxPlaintextBytes?: number;
}

interface KeyMaterial {
  legacyDerivationSecret: Buffer;
  derivedKey: Buffer;
  macKey: Buffer;
  keyId: string;
  explicitMacKey?: string | Buffer;
  legacy?: RuntimeKeyMaterial;
}

interface RuntimeKeyMaterial {
  derivedKey: Buffer;
  macKey: Buffer;
  keyId: string;
}

const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const MAC_DERIVATION_SALT = Buffer.from('errorcore-v1-mac-key', 'utf8');
// Envelope AAD format version (ADR-0001). v2 adds kind + blobId binding.
const AAD_VERSION = 2;
// Field-level AAD is a separate format that never carried kind/blobId;
// it stays at 1 so field blobs encrypted by earlier SDKs still decrypt.
const FIELD_AAD_VERSION = 1;
const KEY_ID_PREFIX_BYTES = 8;
const MIN_MAC_KEY_BYTES = 32;
const TRANSPARENT_MARKER = 'unencrypted';

function readKeyMaterial(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input.length === 0) {
    throw new Error('encryptionKey must not be empty');
  }
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return Buffer.from(input, 'hex');
  }
  return Buffer.from(input, 'utf8');
}

function readLegacyKeyMaterial(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input.length === 0) {
    throw new Error('encryptionKey must not be empty');
  }
  return Buffer.from(input, 'utf8');
}

function hkdfSha256(secret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, Buffer.alloc(0), 32));
}

function legacyPbkdf2Sha256(secret: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
}

function deriveMacKey(
  dekSecret: Buffer,
  explicit?: string | Buffer,
  mode: 'hkdf' | 'legacy-pbkdf2' = 'hkdf'
): Buffer {
  if (explicit !== undefined) {
    const candidate = typeof explicit === 'string'
      ? Buffer.from(explicit, /^[0-9a-f]+$/i.test(explicit) && explicit.length % 2 === 0 ? 'hex' : 'utf8')
      : explicit;
    if (candidate.length < MIN_MAC_KEY_BYTES) {
      throw new Error(
        `EC_MAC_KEY_TOO_SHORT: macKey must be at least ${MIN_MAC_KEY_BYTES} bytes (got ${candidate.length})`
      );
    }
    return candidate;
  }
  return mode === 'hkdf'
    ? hkdfSha256(dekSecret, MAC_DERIVATION_SALT)
    : legacyPbkdf2Sha256(dekSecret, MAC_DERIVATION_SALT);
}

/**
 * Compute a stable, non-secret identifier for a derived key. The first
 * 8 bytes of sha256(derivedKey) are sufficient to distinguish keys in a
 * rotation chain without leaking the key itself. Hex-encoded so it can
 * travel as a header value.
 */
function computeKeyId(derivedKey: Buffer): string {
  return createHash('sha256').update(derivedKey).digest().slice(0, KEY_ID_PREFIX_BYTES).toString('hex');
}

function deriveKeys(encryptionKey: string | Buffer, options?: { macKey?: string | Buffer }): KeyMaterial {
  const derivationSecret = readKeyMaterial(encryptionKey);
  const legacyDerivationSecret = readLegacyKeyMaterial(encryptionKey);
  const derivedKey = hkdfSha256(derivationSecret, STATIC_KEY_SALT);
  const macKey = deriveMacKey(derivationSecret, options?.macKey);
  return {
    legacyDerivationSecret,
    derivedKey,
    macKey,
    keyId: computeKeyId(derivedKey),
    explicitMacKey: options?.macKey
  };
}

function getLegacyKeyMaterial(km: KeyMaterial): RuntimeKeyMaterial {
  if (km.legacy !== undefined) {
    return km.legacy;
  }

  const derivedKey = legacyPbkdf2Sha256(km.legacyDerivationSecret, STATIC_KEY_SALT);
  const macKey = deriveMacKey(km.legacyDerivationSecret, km.explicitMacKey, 'legacy-pbkdf2');
  km.legacy = {
    derivedKey,
    macKey,
    keyId: computeKeyId(derivedKey)
  };
  return km.legacy;
}

/** AAD v2 (ADR-0001): `2|keyId|sdkVersion|eventId|kind|blobId-or-empty`. */
function buildAad(
  eventId: string,
  sdkVersion: string,
  keyId: string,
  kind: 'error' | 'payload_blob',
  blobId: string | undefined
): Buffer {
  return Buffer.from(
    `${AAD_VERSION}|${keyId}|${sdkVersion}|${eventId}|${kind}|${blobId ?? ''}`,
    'utf8'
  );
}

/** Legacy v1 AAD, accepted only when verifying v1 envelopes on local read paths. */
function buildAadV1(eventId: string, sdkVersion: string, keyId: string): Buffer {
  return Buffer.from(`1|${keyId}|${sdkVersion}|${eventId}`, 'utf8');
}

function buildEnvelopeAad(
  envelope: AnyEncryptedEnvelope,
  sdkVersion: string,
  keyId: string
): Buffer {
  const version = envelope.sdk?.version ?? sdkVersion;
  return envelope.v === 2
    ? buildAad(envelope.eventId, version, keyId, envelope.kind, envelope.blobId)
    : buildAadV1(envelope.eventId, version, keyId);
}

function buildFieldAad(sdkVersion: string, keyId: string): Buffer {
  return Buffer.from(`${FIELD_AAD_VERSION}|field|${keyId}|${sdkVersion}`, 'utf8');
}

function assertKindBlobIdCoherence(
  kind: 'error' | 'payload_blob',
  blobId: string | undefined
): void {
  if (kind === 'payload_blob' && (blobId === undefined || blobId.length === 0)) {
    throw new Error('EC_ENVELOPE_BLOB_ID_REQUIRED: kind=payload_blob requires a blobId');
  }
  if (kind === 'error' && blobId !== undefined) {
    throw new Error('EC_ENVELOPE_BLOB_ID_FORBIDDEN: kind=error must not carry a blobId');
  }
}

function tryDecryptWithMaterial(
  material: RuntimeKeyMaterial,
  envelope: AnyEncryptedEnvelope,
  sdkVersion: string,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
  expectedHmac: Buffer,
  maxPlaintextBytes: number
): { ok: true; plaintext: string } | { ok: false; failure: 'hmac' | 'authTag' } {
  const aad = buildEnvelopeAad(envelope, sdkVersion, material.keyId);
  const computedHmac = createHmac('sha256', material.macKey)
    .update(iv)
    .update(ciphertext)
    .update(authTag)
    .update(aad)
    .digest();

  if (
    computedHmac.length !== expectedHmac.length ||
    !timingSafeEqual(computedHmac, expectedHmac)
  ) {
    return { ok: false, failure: 'hmac' };
  }

  let plaintextBuf: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', material.derivedKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintextBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return { ok: false, failure: 'authTag' };
  }

  // Inflate OUTSIDE the authTag catch: at this point the ciphertext is
  // authenticated, so a decompression failure (bomb over the cap,
  // corrupt stream) must surface as its own EC_DECOMPRESSION_* error
  // rather than masquerading as a key mismatch.
  return {
    ok: true,
    plaintext: maybeDecompress(plaintextBuf, envelope.compressed, maxPlaintextBytes).toString('utf8')
  };
}

export interface EnvelopeEncryptOptions {
  eventId: string;
  kind: 'error' | 'payload_blob';
  /** Required iff kind === 'payload_blob'; forbidden otherwise. */
  blobId?: string;
}

export type EncryptionDecryptResult =
  | { ok: true; plaintext: string; keyIndex: number }
  | { ok: false };

/**
 * AES-256-GCM with AAD-bound authentication and an outer HMAC-SHA256
 * that covers iv|ciphertext|authTag|AAD. The outer HMAC lets a receiver
 * reject obviously-tampered envelopes without spinning up a decipher,
 * and binds the entire envelope's metadata (eventId, sdkVersion, keyId)
 * to the ciphertext. Plaintext is zlib-deflated when over the
 * compression threshold; the envelope's `compressed` flag tells the
 * receiver whether to inflate.
 */
export class Encryption {
  private readonly chain: KeyMaterial[];

  private readonly sdkVersion: string;

  private readonly maxPlaintextBytes: number;

  public constructor(encryptionKey: string | Buffer, options?: EncryptionOptions) {
    const primary = deriveKeys(encryptionKey, {
      macKey: options?.macKey
    });
    const previous = (options?.previousEncryptionKeys ?? []).map((k) => deriveKeys(k, {
      macKey: options?.macKey
    }));
    this.chain = [primary, ...previous];
    this.sdkVersion = options?.sdkVersion ?? 'unknown';
    this.maxPlaintextBytes = options?.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
  }

  /** Stable identifier for the primary key. Non-secret; safe to log. */
  public get primaryKeyId(): string {
    return this.chain[0]!.keyId;
  }

  /**
   * Encrypt a JSON-serialized package into the spec envelope. The caller
   * passes a Buffer it will not read after this returns; the buffer is
   * zero-filled on success so the plaintext does not survive in heap.
   */
  public encryptToEnvelope(
    plaintext: Buffer,
    opts: EnvelopeEncryptOptions
  ): EncryptedEnvelope {
    assertKindBlobIdCoherence(opts.kind, opts.blobId);
    const primary = this.chain[0]!;
    const aad = buildAad(opts.eventId, this.sdkVersion, primary.keyId, opts.kind, opts.blobId);
    const { buf: working, compressed } = maybeCompress(plaintext);

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', primary.derivedKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(working), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const hmac = createHmac('sha256', primary.macKey)
      .update(iv)
      .update(ciphertext)
      .update(authTag)
      .update(aad)
      .digest('base64');

    // Best-effort plaintext zeroing. Only zero buffers we own - never the
    // caller's input if compression returned it unchanged AND we did
    // mutate state by reading it.
    plaintext.fill(0);
    if (compressed) {
      working.fill(0);
    }

    return {
      v: 2,
      eventId: opts.eventId,
      kind: opts.kind,
      ...(opts.blobId === undefined ? {} : { blobId: opts.blobId }),
      sdk: { name: 'errorcore', version: this.sdkVersion },
      keyId: primary.keyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
      hmac,
      compressed,
      producedAt: Date.now()
    };
  }

  /**
   * Encrypt a single captured field. The returned `bytes` value is
   * ciphertext||authTag so it fits the Field Blob shape without a separate
   * auth-tag property. The nonce is returned separately for inline fields;
   * ref-backed fields prefix the nonce into the spooled blob.
   */
  public encryptField(input: Buffer | Uint8Array): { nonce: Uint8Array; bytes: Uint8Array } {
    const primary = this.chain[0]!;
    const plaintext = Buffer.from(input);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', primary.derivedKey, nonce);
    cipher.setAAD(buildFieldAad(this.sdkVersion, primary.keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    plaintext.fill(0);
    return {
      nonce: new Uint8Array(nonce),
      bytes: new Uint8Array(Buffer.concat([ciphertext, authTag]))
    };
  }

  public decryptField(
    bytes: Buffer | Uint8Array,
    nonce: Buffer | Uint8Array
  ): Buffer {
    const packed = Buffer.from(bytes);
    const iv = Buffer.from(nonce);

    if (iv.length !== 12 || packed.length < 17) {
      throw new Error('EC_FIELD_DECRYPT_INVALID_BLOB');
    }

    const ciphertext = packed.subarray(0, packed.length - 16);
    const authTag = packed.subarray(packed.length - 16);

    for (const km of this.chain) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', km.derivedKey, iv);
        decipher.setAAD(buildFieldAad(this.sdkVersion, km.keyId));
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
      }
    }

    for (const km of this.chain) {
      try {
        const legacy = getLegacyKeyMaterial(km);
        const decipher = createDecipheriv('aes-256-gcm', legacy.derivedKey, iv);
        decipher.setAAD(buildFieldAad(this.sdkVersion, legacy.keyId));
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
      }
    }

    throw new Error('EC_FIELD_DECRYPT_AUTH_TAG_MISMATCH');
  }

  /**
   * Decrypt an envelope. Tries the primary first, then any previous
   * keys whose keyId matches the envelope's keyId. Throws structured
   * errors for the two distinct failure modes (HMAC vs GCM authTag) so
   * callers can diagnose tampering vs key-mismatch.
   *
   * Accepts v2 (current emit) and v1 (legacy local spools only; the
   * ingestion wire contract is v2-only per ADR-0001).
   */
  public decryptEnvelope(envelope: AnyEncryptedEnvelope): EncryptionDecryptResult {
    const version: unknown = envelope.v;
    if (version !== 1 && version !== 2) {
      throw new Error(`EC_DECRYPT_UNKNOWN_VERSION: envelope version ${String(version)} is not supported`);
    }
    if (envelope.v === 2) {
      assertKindBlobIdCoherence(envelope.kind, envelope.blobId);
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const expectedHmac = Buffer.from(envelope.hmac, 'base64');

    // Prefer the matching keyId, then fall back to any other keys in
    // the chain (covers the case where the receiver rotates keys
    // mid-flight and an in-flight envelope references a still-cached
    // key by id even though the SDK has moved on).
    const keyOrder = this.chain.slice().sort((a, b) => {
      if (a.keyId === envelope.keyId) return -1;
      if (b.keyId === envelope.keyId) return 1;
      return 0;
    });

    let firstFailure: 'hmac' | 'authTag' | null = null;

    for (const km of keyOrder) {
      const attempt = tryDecryptWithMaterial(
        km,
        envelope,
        this.sdkVersion,
        iv,
        ciphertext,
        authTag,
        expectedHmac,
        this.maxPlaintextBytes
      );
      if (attempt.ok) {
        const keyIndex = this.chain.indexOf(km);
        return { ok: true, plaintext: attempt.plaintext, keyIndex };
      }
      if (firstFailure === null) firstFailure = attempt.failure;
    }

    const legacyKeyOrder = this.chain.slice().sort((a, b) => {
      if (getLegacyKeyMaterial(a).keyId === envelope.keyId) return -1;
      if (getLegacyKeyMaterial(b).keyId === envelope.keyId) return 1;
      return 0;
    });

    for (const km of legacyKeyOrder) {
      const attempt = tryDecryptWithMaterial(
        getLegacyKeyMaterial(km),
        envelope,
        this.sdkVersion,
        iv,
        ciphertext,
        authTag,
        expectedHmac,
        this.maxPlaintextBytes
      );
      if (attempt.ok) {
        const keyIndex = this.chain.indexOf(km);
        return { ok: true, plaintext: attempt.plaintext, keyIndex };
      }
      if (firstFailure === null) firstFailure = attempt.failure;
    }

    if (firstFailure === 'hmac') {
      throw new Error('EC_DECRYPT_HMAC_MISMATCH');
    }
    if (firstFailure === 'authTag') {
      throw new Error('EC_DECRYPT_AUTH_TAG_MISMATCH');
    }
    return { ok: false };
  }

  /**
   * Convenience wrapper: throws on any decryption failure.
   */
  public decrypt(envelope: AnyEncryptedEnvelope): string {
    const result = this.decryptEnvelope(envelope);
    if (!result.ok) {
      throw new Error('Unable to decrypt: no key in the chain matched');
    }
    return result.plaintext;
  }

  /**
   * Sign an arbitrary string with the primary MAC key. Used by the
   * dead-letter store for line-level integrity macs.
   */
  public sign(serialized: string): string {
    return createHmac('sha256', this.chain[0]!.macKey)
      .update(serialized)
      .digest('base64');
  }

  /**
   * Verify a base64 HMAC against any key in the chain. Constant-time
   * per attempt. Returns the matching key index (0 = primary) or null.
   */
  public verify(serialized: string, mac: string): { ok: true; keyIndex: number } | { ok: false } {
    let actual: Buffer;
    try {
      actual = Buffer.from(mac, 'base64');
    } catch {
      return { ok: false };
    }
    for (let i = 0; i < this.chain.length; i++) {
      const expected = createHmac('sha256', this.chain[i]!.macKey)
        .update(serialized)
        .digest();
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        return { ok: true, keyIndex: i };
      }
    }
    for (let i = 0; i < this.chain.length; i++) {
      const legacy = getLegacyKeyMaterial(this.chain[i]!);
      const expected = createHmac('sha256', legacy.macKey)
        .update(serialized)
        .digest();
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        return { ok: true, keyIndex: i };
      }
    }
    return { ok: false };
  }
}

/**
 * Build a transparent (unencrypted) envelope used in dev mode when no
 * DEK is configured. Marks the encryption fields with a literal
 * "unencrypted" string so receivers can detect and reject without
 * accidentally feeding plaintext into a decrypt pipeline.
 */
export function buildTransparentEnvelope(
  plaintext: Buffer,
  opts: {
    eventId: string;
    sdkVersion: string;
    kind: 'error' | 'payload_blob';
    blobId?: string;
  }
): EncryptedEnvelope {
  assertKindBlobIdCoherence(opts.kind, opts.blobId);
  return {
    v: 2,
    eventId: opts.eventId,
    kind: opts.kind,
    ...(opts.blobId === undefined ? {} : { blobId: opts.blobId }),
    sdk: { name: 'errorcore', version: opts.sdkVersion },
    keyId: TRANSPARENT_MARKER,
    iv: TRANSPARENT_MARKER,
    ciphertext: plaintext.toString('base64'),
    authTag: TRANSPARENT_MARKER,
    hmac: TRANSPARENT_MARKER,
    compressed: false,
    producedAt: Date.now()
  };
}

export function isTransparentEnvelope(envelope: AnyEncryptedEnvelope): boolean {
  return envelope.iv === TRANSPARENT_MARKER && envelope.authTag === TRANSPARENT_MARKER;
}

export { TRANSPARENT_MARKER };
