import { afterEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '../../src/security/encryption';
import { RateLimiter } from '../../src/security/rate-limiter';

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

describe('Encryption', () => {
  it('round-trips plaintext through encrypt and decrypt', () => {
    const encryption = new Encryption('top-secret-key');
    const payload = encryption.encrypt('hello world');

    expect(encryption.decrypt(payload)).toBe('hello world');
  });

  it('produces different encrypted payloads for different keys', () => {
    const first = new Encryption('key-one').encrypt('same plaintext');
    const second = new Encryption('key-two').encrypt('same plaintext');

    expect(first).not.toEqual(second);
  });

  it('fails to decrypt with the wrong key', () => {
    const payload = new Encryption('right-key').encrypt('secret');
    const wrongEncryption = new Encryption('wrong-key');

    expect(() => wrongEncryption.decrypt(payload)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encryption = new Encryption('top-secret-key');
    const payload = encryption.encrypt('secret');

    expect(() =>
      encryption.decrypt({
        ...payload,
        ciphertext: `${payload.ciphertext.slice(0, -2)}AA`
      })
    ).toThrow();
  });

  it('encrypts and decrypts an empty string', () => {
    const encryption = new Encryption('top-secret-key');
    const payload = encryption.encrypt('');

    expect(encryption.decrypt(payload)).toBe('');
  });

  it('returns all required base64 fields', () => {
    const payload = new Encryption('top-secret-key').encrypt('payload');

    expect(payload.salt).toMatch(BASE64_REGEX);
    expect(payload.iv).toMatch(BASE64_REGEX);
    expect(payload.ciphertext).toMatch(BASE64_REGEX);
    expect(payload.authTag).toMatch(BASE64_REGEX);
  });

  it('rejects an empty encryption key', () => {
    expect(() => new Encryption('')).toThrow('encryptionKey must not be empty');
  });

  it('produces different IVs and ciphertexts for the same plaintext on the same instance', () => {
    const encryption = new Encryption('top-secret-key');
    const first = encryption.encrypt('identical plaintext');
    const second = encryption.encrypt('identical plaintext');

    // Salt is static per instance (key derived once at construction).
    // Per-message uniqueness is ensured via random IVs.
    expect(first.salt).toBe(second.salt);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);

    expect(encryption.decrypt(first)).toBe('identical plaintext');
    expect(encryption.decrypt(second)).toBe('identical plaintext');
  });

  it('signs payloads deterministically and without exposing the HMAC key', () => {
    const encryption = new Encryption('top-secret-key');

    const first = encryption.sign('hello');
    const second = encryption.sign('hello');
    const different = encryption.sign('hello!');

    expect(first).toMatch(BASE64_REGEX);
    expect(first).toBe(second);
    expect(first).not.toBe(different);

    // The HMAC key must not be reachable from outside the class.
    // getHmacKeyHex() was removed to close the public key exposure.
    expect((encryption as unknown as { getHmacKeyHex?: unknown }).getHmacKeyHex)
      .toBeUndefined();
    expect((Encryption.prototype as unknown as { getHmacKeyHex?: unknown }).getHmacKeyHex)
      .toBeUndefined();
  });

  it('verifies sign against Node createHmac using a key derived the same way', async () => {
    // This test guarantees we did not accidentally change HMAC derivation.
    // If it breaks, existing dead-letter signatures on disk will stop
    // verifying.
    const { createHmac, pbkdf2Sync } = await import('node:crypto');

    const encryption = new Encryption('top-secret-key');
    const expectedKey = pbkdf2Sync(
      Buffer.from('top-secret-key', 'utf8'),
      Buffer.from('errorcore-v1-hmac-key', 'utf8'),
      100000,
      32,
      'sha256'
    );
    const expectedSig = createHmac('sha256', expectedKey)
      .update('payload')
      .digest('base64');

    expect(encryption.sign('payload')).toBe(expectedSig);
  });

  it('decrypts legacy per-message-salt payloads without a salt timing oracle', () => {
    // Old payload format used a random per-message salt; we must still
    // decrypt those. Comparison between the embedded salt and the static
    // keySalt is constant-time.
    const { pbkdf2Sync, createCipheriv, randomBytes } = require('node:crypto') as typeof import('node:crypto');

    const secret = 'legacy-key';
    const legacySalt = randomBytes(16); // pre-static-salt scheme
    const legacyDerivedKey = pbkdf2Sync(
      Buffer.from(secret, 'utf8'),
      legacySalt,
      100000,
      32,
      'sha256'
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyDerivedKey, iv);
    const ciphertext = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const legacyPayload = {
      salt: legacySalt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };

    const encryption = new Encryption(secret);
    expect(encryption.decrypt(legacyPayload)).toBe('legacy');
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
