import { describe, expect, it } from 'vitest';
import { Encryption } from '../../src/security/encryption';

const PRIMARY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PREV    = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('Encryption with key rotation', () => {
  it('signs with the primary key and verifies under primary (keyIndex 0)', () => {
    const enc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const payload = '{"hello":"world"}';
    const sig = enc.sign(payload);
    const result = enc.verify(payload, sig);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyIndex).toBe(0);
  });

  it('verifies a signature produced by a previous key (keyIndex 1)', () => {
    const oldEnc = new Encryption(PREV);
    const payload = '{"old":"entry"}';
    const oldSig = oldEnc.sign(payload);

    const newEnc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const result = newEnc.verify(payload, oldSig);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyIndex).toBe(1);
  });

  it('returns ok:false when no key in the chain matches', () => {
    const enc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const result = enc.verify('payload', 'aGVsbG8=');  // arbitrary base64
    expect(result.ok).toBe(false);
  });

  it('encrypts with the primary key and decrypts via tryDecrypt', () => {
    const enc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const env = enc.encrypt('hello');
    const result = enc.tryDecrypt(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plaintext).toBe('hello');
      expect(result.keyIndex).toBe(0);
    }
  });

  it('decrypts an envelope produced by a previous key', () => {
    const oldEnc = new Encryption(PREV);
    const env = oldEnc.encrypt('legacy payload');

    const newEnc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const result = newEnc.tryDecrypt(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plaintext).toBe('legacy payload');
      expect(result.keyIndex).toBe(1);
    }
  });

  it('preserves backward compatibility when called with a single key (no options)', () => {
    const enc = new Encryption(PRIMARY);  // no options
    const payload = 'plain';
    const sig = enc.sign(payload);
    const result = enc.verify(payload, sig);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyIndex).toBe(0);
  });
});
