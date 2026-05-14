import { afterEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '../../src/security/encryption';
import {
  createEncryptionFromAssemblyConfig,
  createPackageAssemblyEncryptionConfig
} from '../../src/security/encryption-runtime';
import { RateLimiter } from '../../src/security/rate-limiter';
import type { EncryptedEnvelope } from '../../src/types';

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const MAC_DERIVATION_SALT = Buffer.from('errorcore-v1-mac-key', 'utf8');

function makeEnv(eventId = 'evt-test'): { eventId: string } {
  return { eventId };
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function asBuffer(value: Buffer | ArrayBuffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function buildLegacyPbkdf2Envelope(
  encryptionKey: string,
  plaintext: string,
  opts: { eventId: string; sdkVersion: string }
): EncryptedEnvelope {
  const {
    createCipheriv,
    createHash,
    createHmac,
    pbkdf2Sync
  } = require('node:crypto') as typeof import('node:crypto');

  const secret = Buffer.from(encryptionKey, 'utf8');
  const derivedKey = pbkdf2Sync(secret, STATIC_KEY_SALT, 100000, 32, 'sha256');
  const macKey = pbkdf2Sync(secret, MAC_DERIVATION_SALT, 100000, 32, 'sha256');
  const keyId = createHash('sha256').update(derivedKey).digest().slice(0, 8).toString('hex');
  const aad = Buffer.from(`1|${keyId}|${opts.sdkVersion}|${opts.eventId}`, 'utf8');
  const iv = Buffer.from('00112233445566778899aabb', 'hex');
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const hmac = createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .update(authTag)
    .update(aad)
    .digest('base64');

  return {
    v: 1,
    eventId: opts.eventId,
    sdk: { name: 'errorcore', version: opts.sdkVersion },
    keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    hmac,
    compressed: false,
    producedAt: 1
  };
}

describe('Encryption', () => {
  it('round-trips plaintext through encryptToEnvelope and decrypt', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf('hello world'), makeEnv());

    expect(encryption.decrypt(env)).toBe('hello world');
  });

  it('produces different envelopes for different keys', () => {
    const first = new Encryption('key-one', { sdkVersion: '0.3.0' })
      .encryptToEnvelope(buf('same plaintext'), makeEnv('evt-1'));
    const second = new Encryption('key-two', { sdkVersion: '0.3.0' })
      .encryptToEnvelope(buf('same plaintext'), makeEnv('evt-1'));

    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.keyId).not.toEqual(second.keyId);
  });

  it('fails to decrypt with the wrong key', () => {
    const env = new Encryption('right-key', { sdkVersion: '0.3.0' })
      .encryptToEnvelope(buf('secret'), makeEnv());
    const wrongEncryption = new Encryption('wrong-key', { sdkVersion: '0.3.0' });

    expect(() => wrongEncryption.decrypt(env)).toThrow(/EC_DECRYPT_HMAC_MISMATCH/);
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf('secret'), makeEnv());

    expect(() =>
      encryption.decrypt({
        ...env,
        ciphertext: `${env.ciphertext.slice(0, -2)}AA`
      })
    ).toThrow(/EC_DECRYPT/);
  });

  it('rejects an envelope tampered in the outer HMAC before the GCM authTag is consulted', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf('secret'), makeEnv());

    expect(() =>
      encryption.decrypt({
        ...env,
        hmac: Buffer.alloc(32, 0).toString('base64')
      })
    ).toThrow(/EC_DECRYPT_HMAC_MISMATCH/);
  });

  it('binds AAD: corrupting eventId fails decryption', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf('secret'), makeEnv('orig-id'));

    expect(() => encryption.decrypt({ ...env, eventId: 'tampered-id' })).toThrow();
  });

  it('encrypts and decrypts an empty string', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf(''), makeEnv());

    expect(encryption.decrypt(env)).toBe('');
  });

  it('returns all required envelope fields', () => {
    const env = new Encryption('top-secret-key', { sdkVersion: '0.3.0' })
      .encryptToEnvelope(buf('payload'), makeEnv('evt-x'));

    expect(env.v).toBe(1);
    expect(env.eventId).toBe('evt-x');
    expect(env.sdk).toEqual({ name: 'errorcore', version: '0.3.0' });
    expect(env.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(env.iv).toMatch(BASE64_REGEX);
    expect(env.ciphertext).toMatch(BASE64_REGEX);
    expect(env.authTag).toMatch(BASE64_REGEX);
    expect(env.hmac).toMatch(BASE64_REGEX);
    expect(env.compressed).toBe(false);
    expect(typeof env.producedAt).toBe('number');
  });

  it('rejects an empty encryption key', () => {
    expect(() => new Encryption('')).toThrow('encryptionKey must not be empty');
  });

  it('produces different IVs and ciphertexts for the same plaintext on the same instance', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const first = encryption.encryptToEnvelope(buf('identical plaintext'), makeEnv('a'));
    const second = encryption.encryptToEnvelope(buf('identical plaintext'), makeEnv('b'));

    expect(first.keyId).toBe(second.keyId);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);

    expect(encryption.decrypt(first)).toBe('identical plaintext');
    expect(encryption.decrypt(second)).toBe('identical plaintext');
  });

  it('compresses payloads above the 8 KB threshold', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const small = encryption.encryptToEnvelope(buf('x'.repeat(100)), makeEnv('s'));
    const large = encryption.encryptToEnvelope(buf('x'.repeat(20_000)), makeEnv('l'));

    expect(small.compressed).toBe(false);
    expect(large.compressed).toBe(true);
    // Compressed envelope of highly-redundant input MUST be smaller than
    // the raw plaintext base64'd.
    const rawBase64Length = Buffer.from('x'.repeat(20_000)).toString('base64').length;
    expect(large.ciphertext.length).toBeLessThan(rawBase64Length);
    expect(encryption.decrypt(large)).toBe('x'.repeat(20_000));
  });

  it('signs payloads deterministically and without exposing the HMAC key', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });

    const first = encryption.sign('hello');
    const second = encryption.sign('hello');
    const different = encryption.sign('hello!');

    expect(first).toMatch(BASE64_REGEX);
    expect(first).toBe(second);
    expect(first).not.toBe(different);

    // The HMAC key must not be reachable from outside the class.
    expect((encryption as unknown as { getHmacKeyHex?: unknown }).getHmacKeyHex)
      .toBeUndefined();
    expect((Encryption.prototype as unknown as { getHmacKeyHex?: unknown }).getHmacKeyHex)
      .toBeUndefined();
  });

  it('verifies sign against Node createHmac using HKDF and the v1 mac salt', async () => {
    const { createHmac, hkdfSync } = await import('node:crypto');

    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const expectedKey = asBuffer(hkdfSync(
      'sha256',
      Buffer.from('top-secret-key', 'utf8'),
      Buffer.from('errorcore-v1-mac-key', 'utf8'),
      Buffer.alloc(0),
      32
    ));
    const expectedSig = createHmac('sha256', expectedKey)
      .update('payload')
      .digest('base64');

    expect(encryption.sign('payload')).toBe(expectedSig);
  });

  it('treats 64-character hex encryption keys as 32 random bytes for HKDF', async () => {
    const { createHash, hkdfSync } = await import('node:crypto');
    const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const expectedDerivedKey = asBuffer(hkdfSync(
      'sha256',
      Buffer.from(hexKey, 'hex'),
      Buffer.from('errorcore-v1-key-derivation', 'utf8'),
      Buffer.alloc(0),
      32
    ));
    const expectedKeyId = createHash('sha256')
      .update(expectedDerivedKey)
      .digest()
      .slice(0, 8)
      .toString('hex');

    const encryption = new Encryption(hexKey, { sdkVersion: '0.3.0' });

    expect(encryption.primaryKeyId).toBe(expectedKeyId);
  });

  it('decrypts envelopes produced by the legacy PBKDF2 key derivation', () => {
    const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const envelope = buildLegacyPbkdf2Envelope(hexKey, 'legacy secret', {
      eventId: 'evt-legacy',
      sdkVersion: '0.2.0'
    });
    const encryption = new Encryption(hexKey, { sdkVersion: '0.2.0' });

    expect(encryption.decrypt(envelope)).toBe('legacy secret');
  });

  it('verifies payload MACs produced by the legacy PBKDF2 derivation', () => {
    const { createHmac, pbkdf2Sync } = require('node:crypto') as typeof import('node:crypto');
    const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const legacyMacKey = pbkdf2Sync(
      Buffer.from(hexKey, 'utf8'),
      Buffer.from('errorcore-v1-mac-key', 'utf8'),
      100000,
      32,
      'sha256'
    );
    const legacyMac = createHmac('sha256', legacyMacKey)
      .update('payload')
      .digest('base64');
    const encryption = new Encryption(hexKey, { sdkVersion: '0.3.0' });

    expect(encryption.verify('payload', legacyMac)).toEqual({ ok: true, keyIndex: 0 });
  });

  it('rejects an explicit MAC key shorter than 32 bytes', () => {
    expect(() => new Encryption('top-secret-key', { macKey: 'short' }))
      .toThrow(/EC_MAC_KEY_TOO_SHORT/);
  });

  it('rejects unknown envelope versions', () => {
    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const env = encryption.encryptToEnvelope(buf('hi'), makeEnv());

    expect(() => encryption.decrypt({ ...env, v: 2 as 1 }))
      .toThrow(/EC_DECRYPT_UNKNOWN_VERSION/);
  });
});

describe('Encryption runtime config', () => {
  it('does not let ERRORCORE_DERIVED_KEY replace configured key material', () => {
    const originalDerivedKey = process.env.ERRORCORE_DERIVED_KEY;

    try {
      process.env.ERRORCORE_DERIVED_KEY = '00'.repeat(32);

      const assemblyConfig = createPackageAssemblyEncryptionConfig({
        encryptionKey: 'configured-runtime-key',
        macKey: undefined,
        previousEncryptionKeys: []
      });

      expect(assemblyConfig).not.toHaveProperty('derivedKeyHex');

      const runtimeEncryption = createEncryptionFromAssemblyConfig(assemblyConfig);
      expect(runtimeEncryption).not.toBeNull();

      const env = runtimeEncryption!.encryptToEnvelope(buf('configured only'), makeEnv('evt-runtime'));
      const configuredEncryption = new Encryption('configured-runtime-key', { sdkVersion: env.sdk.version });

      expect(configuredEncryption.decrypt(env)).toBe('configured only');
    } finally {
      if (originalDerivedKey === undefined) {
        delete process.env.ERRORCORE_DERIVED_KEY;
      } else {
        process.env.ERRORCORE_DERIVED_KEY = originalDerivedKey;
      }
    }
  });
});

describe('RateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows up to maxCaptures in the window and rejects the next', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 2, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);

    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(false);
  });

  it('allows again after the window expires', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 2, windowMs: 1000 });
    let now = 1000;

    vi.spyOn(Date, 'now').mockImplementation(() => now);

    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(false);

    now = 2000;

    expect(rateLimiter.tryAcquire()).toBe(true);
  });

  it('increments droppedCount on rejection', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);

    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(false);
    expect(rateLimiter.getDroppedCount()).toBe(1);
  });

  it('resets its state', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);

    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(false);

    rateLimiter.reset();

    expect(rateLimiter.getDroppedCount()).toBe(0);
    expect(rateLimiter.tryAcquire()).toBe(true);
  });

  it('works correctly with maxCaptures set to 1 and at the window boundary', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });
    let now = 1000;

    vi.spyOn(Date, 'now').mockImplementation(() => now);

    expect(rateLimiter.tryAcquire()).toBe(true);
    expect(rateLimiter.tryAcquire()).toBe(false);

    now = 2000;

    expect(rateLimiter.tryAcquire()).toBe(true);
  });

  it('always rejects when maxCaptures is 0', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 0, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);

    expect(rateLimiter.tryAcquire()).toBe(false);
    expect(rateLimiter.getDroppedCount()).toBe(1);
  });

  it('getAndResetDropSummary returns null when no drops occurred', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 5, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);
    rateLimiter.tryAcquire();

    expect(rateLimiter.getAndResetDropSummary()).toBeNull();
  });

  it('getAndResetDropSummary returns summary after drops and resets', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });
    let now = 1000;

    vi.spyOn(Date, 'now').mockImplementation(() => now);

    rateLimiter.tryAcquire();
    now = 1100;
    rateLimiter.tryAcquire();
    now = 1200;
    rateLimiter.tryAcquire();

    now = 2100;
    rateLimiter.tryAcquire();
    const summary = rateLimiter.getAndResetDropSummary();

    expect(summary).toEqual({
      droppedCount: 2,
      firstDropMs: 1100,
      lastDropMs: 1200
    });

    expect(rateLimiter.getAndResetDropSummary()).toBeNull();
  });

  it('reset clears drop summary state', () => {
    const rateLimiter = new RateLimiter({ maxCaptures: 1, windowMs: 1000 });

    vi.spyOn(Date, 'now').mockReturnValue(1000);

    rateLimiter.tryAcquire();
    rateLimiter.tryAcquire();
    rateLimiter.reset();

    expect(rateLimiter.getAndResetDropSummary()).toBeNull();
  });
});
