
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export interface EncryptedPayload {
  salt: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

interface EncryptionOptions {
  derivedKey?: Buffer;
  previousEncryptionKeys?: string[];
}

interface KeyMaterial {
  derivationSecret: Buffer;
  derivedKey: Buffer;
  hmacKey: Buffer;
  keySalt: Buffer;
}

const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const HMAC_SALT = Buffer.from('errorcore-v1-hmac-key', 'utf8');

function deriveKeys(encryptionKey: string, derivedKeyOverride?: Buffer): KeyMaterial {
  if (encryptionKey.length === 0) {
    throw new Error('encryptionKey must not be empty');
  }
  const derivationSecret = Buffer.from(encryptionKey, 'utf8');
  const derivedKey =
    derivedKeyOverride ??
    pbkdf2Sync(derivationSecret, STATIC_KEY_SALT, 100000, 32, 'sha256');
  if (derivedKey.length !== 32) {
    throw new Error('Pre-derived key must be exactly 32 bytes');
  }
  const hmacKey = pbkdf2Sync(derivationSecret, HMAC_SALT, 100000, 32, 'sha256');
  return {
    derivationSecret,
    derivedKey,
    hmacKey,
    keySalt: STATIC_KEY_SALT
  };
}

export type EncryptionVerifyResult =
  | { ok: true; keyIndex: number }
  | { ok: false };

export type EncryptionDecryptResult =
  | { ok: true; plaintext: string; keyIndex: number }
  | { ok: false };

export class Encryption {
  private readonly chain: KeyMaterial[];

  public constructor(encryptionKey: string, options?: EncryptionOptions) {
    const primary = deriveKeys(encryptionKey, options?.derivedKey);
    const previous = (options?.previousEncryptionKeys ?? []).map((k) =>
      deriveKeys(k)
    );
    this.chain = [primary, ...previous];
  }

  /**
   * Sign the serialized package with the primary HMAC key. The key never
   * leaves this instance. Signature is base64-encoded HMAC-SHA256.
   */
  public sign(serializedPackage: string): string {
    return createHmac('sha256', this.chain[0]!.hmacKey)
      .update(serializedPackage)
      .digest('base64');
  }

  /**
   * Verify a base64 HMAC against the key chain. Returns the index of
   * the matching key (0 = primary, 1+ = previous keys in declaration
   * order). Constant-time per attempt.
   */
  public verify(serializedPackage: string, mac: string): EncryptionVerifyResult {
    let actual: Buffer;
    try {
      actual = Buffer.from(mac, 'base64');
    } catch {
      return { ok: false };
    }
    for (let i = 0; i < this.chain.length; i++) {
      const expected = createHmac('sha256', this.chain[i]!.hmacKey)
        .update(serializedPackage)
        .digest();
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        return { ok: true, keyIndex: i };
      }
    }
    return { ok: false };
  }

  /** Encrypt with the primary key. */
  public encrypt(plaintext: string): EncryptedPayload {
    const primary = this.chain[0]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', primary.derivedKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
      salt: primary.keySalt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  /**
   * Try to decrypt against every key in the chain. Returns the
   * plaintext and the index of the matching key (0 = primary). Returns
   * `{ ok: false }` if no key in the chain matches.
   */
  public tryDecrypt(payload: EncryptedPayload): EncryptionDecryptResult {
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');

    for (let i = 0; i < this.chain.length; i++) {
      const km = this.chain[i]!;
      // Same legacy-vs-static-salt detection logic as the previous
      // single-key decrypt(), applied per chain entry. Comparison is
      // constant-time so the scheme detection cannot be used as a
      // timing oracle to distinguish keys.
      const needsPerMessageDerivation =
        salt.length !== km.keySalt.length ||
        !timingSafeEqual(salt, km.keySalt);
      const derivedKey = needsPerMessageDerivation
        ? pbkdf2Sync(km.derivationSecret, salt, 100000, 32, 'sha256')
        : km.derivedKey;

      try {
        const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]).toString('utf8');
        return { ok: true, plaintext, keyIndex: i };
      } catch {
        // GCM auth-tag mismatch => wrong key. Continue.
      }
    }
    return { ok: false };
  }

  /**
   * Single-key compatibility shim. Throws if no key matches; matches
   * the pre-rotation contract of the original `decrypt()` method.
   */
  public decrypt(payload: EncryptedPayload): string {
    const result = this.tryDecrypt(payload);
    if (!result.ok) {
      throw new Error('Unable to decrypt: no key in the chain matched');
    }
    return result.plaintext;
  }
}
