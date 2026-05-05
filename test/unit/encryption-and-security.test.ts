import { afterEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '../../src/security/encryption';
import { RateLimiter } from '../../src/security/rate-limiter';

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

function makeEnv(eventId = 'evt-test'): { eventId: string } {
  return { eventId };
}

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
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

  it('verifies sign against Node createHmac using the v1 mac salt', async () => {
    const { createHmac, pbkdf2Sync } = await import('node:crypto');

    const encryption = new Encryption('top-secret-key', { sdkVersion: '0.3.0' });
    const expectedKey = pbkdf2Sync(
      Buffer.from('top-secret-key', 'utf8'),
      Buffer.from('errorcore-v1-mac-key', 'utf8'),
      100000,
      32,
      'sha256'
    );
    const expectedSig = createHmac('sha256', expectedKey)
      .update('payload')
      .digest('base64');

    expect(encryption.sign('payload')).toBe(expectedSig);
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
