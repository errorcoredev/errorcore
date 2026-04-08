
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

  private readonly salt: Buffer;

  private readonly derivedKey: Buffer;

  public constructor(encryptionKey: string) {
    if (encryptionKey.length === 0) {
      throw new Error('encryptionKey must not be empty');
    }

    this.encryptionKey = encryptionKey;
    this.salt = randomBytes(16);
    this.derivedKey = pbkdf2Sync(
      this.encryptionKey,
      this.salt,
      100000,
      32,
      'sha256'
    );
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
      salt: this.salt.toString('base64'),
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
    const derivedKey = pbkdf2Sync(this.encryptionKey, salt, 100000, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);

    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
  }
}
