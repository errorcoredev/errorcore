
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import type { EncryptedEnvelope } from '../types';
import { maybeCompress, maybeDecompress } from './compression';

interface EncryptionOptions {
  derivedKey?: Buffer;
  previousEncryptionKeys?: string[];
  /** Optional explicit MAC key (32+ bytes). When unset, derived from DEK. */
  macKey?: string | Buffer;
  /** SDK version used in AAD binding and envelope.sdk.version. */
  sdkVersion?: string;
}

interface KeyMaterial {
  derivationSecret: Buffer;
  derivedKey: Buffer;
  macKey: Buffer;
  keyId: string;
}

const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const MAC_DERIVATION_SALT = Buffer.from('errorcore-v1-mac-key', 'utf8');
const AAD_VERSION = 1;
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
  return Buffer.from(input, 'utf8');
}

function deriveMacKey(
  dekSecret: Buffer,
  explicit?: string | Buffer
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
  return pbkdf2Sync(dekSecret, MAC_DERIVATION_SALT, 100000, 32, 'sha256');
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

function deriveKeys(encryptionKey: string | Buffer, options?: { macKey?: string | Buffer; derivedKey?: Buffer }): KeyMaterial {
  const derivationSecret = readKeyMaterial(encryptionKey);
  const derivedKey =
    options?.derivedKey ??
    pbkdf2Sync(derivationSecret, STATIC_KEY_SALT, 100000, 32, 'sha256');
  if (derivedKey.length !== 32) {
    throw new Error('Pre-derived key must be exactly 32 bytes');
  }
  const macKey = deriveMacKey(derivationSecret, options?.macKey);
  return {
    derivationSecret,
    derivedKey,
    macKey,
    keyId: computeKeyId(derivedKey)
  };
}

function buildAad(eventId: string, sdkVersion: string, keyId: string): Buffer {
  return Buffer.from(`${AAD_VERSION}|${keyId}|${sdkVersion}|${eventId}`, 'utf8');
}

export interface EnvelopeEncryptOptions {
  eventId: string;
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

  public constructor(encryptionKey: string | Buffer, options?: EncryptionOptions) {
    const primary = deriveKeys(encryptionKey, {
      macKey: options?.macKey,
      derivedKey: options?.derivedKey
    });
    const previous = (options?.previousEncryptionKeys ?? []).map((k) => deriveKeys(k));
    this.chain = [primary, ...previous];
    this.sdkVersion = options?.sdkVersion ?? 'unknown';
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
    const primary = this.chain[0]!;
    const aad = buildAad(opts.eventId, this.sdkVersion, primary.keyId);
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

    // Best-effort plaintext zeroing. Only zero buffers we own — never the
    // caller's input if compression returned it unchanged AND we did
    // mutate state by reading it.
    plaintext.fill(0);
    if (compressed) {
      working.fill(0);
    }

    return {
      v: 1,
      eventId: opts.eventId,
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
   * Decrypt an envelope. Tries the primary first, then any previous
   * keys whose keyId matches the envelope's keyId. Throws structured
   * errors for the two distinct failure modes (HMAC vs GCM authTag) so
   * callers can diagnose tampering vs key-mismatch.
   */
  public decryptEnvelope(envelope: EncryptedEnvelope): EncryptionDecryptResult {
    if (envelope.v !== 1) {
      throw new Error(`EC_DECRYPT_UNKNOWN_VERSION: envelope version ${String(envelope.v)} is not supported`);
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
      const aad = buildAad(envelope.eventId, this.sdkVersion, km.keyId);
      const computedHmac = createHmac('sha256', km.macKey)
        .update(iv)
        .update(ciphertext)
        .update(authTag)
        .update(aad)
        .digest();

      if (
        computedHmac.length !== expectedHmac.length ||
        !timingSafeEqual(computedHmac, expectedHmac)
      ) {
        if (firstFailure === null) firstFailure = 'hmac';
        continue;
      }

      try {
        const decipher = createDecipheriv('aes-256-gcm', km.derivedKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        const plaintextBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const plaintext = maybeDecompress(plaintextBuf, envelope.compressed).toString('utf8');
        const keyIndex = this.chain.indexOf(km);
        return { ok: true, plaintext, keyIndex };
      } catch {
        if (firstFailure === null) firstFailure = 'authTag';
        continue;
      }
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
  public decrypt(envelope: EncryptedEnvelope): string {
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
  opts: { eventId: string; sdkVersion: string }
): EncryptedEnvelope {
  return {
    v: 1,
    eventId: opts.eventId,
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

export function isTransparentEnvelope(envelope: EncryptedEnvelope): boolean {
  return envelope.iv === TRANSPARENT_MARKER && envelope.authTag === TRANSPARENT_MARKER;
}

export { TRANSPARENT_MARKER };
