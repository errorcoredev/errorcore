
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes
} from 'node:crypto';

export interface EncryptedPayload {
  salt: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export class Encryption {
  private readonly encryptionKey: string;

  private readonly derivedKey: Buffer;

  private readonly keySalt: Buffer;

  private readonly hmacKey: Buffer;

  public constructor(encryptionKey: string, options?: { derivedKey?: Buffer }) {
    if (encryptionKey.length === 0) {
      throw new Error('encryptionKey must not be empty');
    }

    this.encryptionKey = encryptionKey;

    // Derive the AES key once at construction using a deterministic salt.
    // The encryption key is already a 32-byte hex secret, so a single PBKDF2
    // derivation at init is sufficient. Per-message uniqueness comes from the
    // random IV, not from per-message key derivation.
    this.keySalt = Buffer.from('errorcore-v1-key-derivation', 'utf8');

    if (options?.derivedKey !== undefined) {
      if (options.derivedKey.length !== 32) {
        throw new Error('Pre-derived key must be exactly 32 bytes');
      }
      this.derivedKey = options.derivedKey;
    } else {
      this.derivedKey = pbkdf2Sync(
        this.encryptionKey,
        this.keySalt,
        100000,
        32,
        'sha256'
      );
    }

    // Derive a separate HMAC key using a different salt to maintain
    // proper key separation between encryption and integrity signing.
    this.hmacKey = pbkdf2Sync(
      this.encryptionKey,
      Buffer.from('errorcore-v1-hmac-key', 'utf8'),
      100000,
      32,
      'sha256'
    );
  }

  public getHmacKeyHex(): string {
    return this.hmacKey.toString('hex');
  }

  public encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derivedKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
      salt: this.keySalt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  public decrypt(payload: EncryptedPayload): string {
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');

    // Support decrypting payloads from both the old per-message salt scheme
    // and the new static salt scheme.
    const needsPerMessageDerivation = !salt.equals(this.keySalt);
    const derivedKey = needsPerMessageDerivation
      ? pbkdf2Sync(this.encryptionKey, salt, 100000, 32, 'sha256')
      : this.derivedKey;

    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
  }
}
