import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync
} from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { decryptErrorcoreEnvelope } from '../decrypt.mjs';

const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const MAC_DERIVATION_SALT = Buffer.from('errorcore-v1-mac-key', 'utf8');

function hkdf(secret, salt) {
  return Buffer.from(hkdfSync('sha256', secret, salt, Buffer.alloc(0), 32));
}

function buildEnvelope({ key, sdkVersion, eventId, plaintext, compressed = false }) {
  const secret = Buffer.from(key, /^[0-9a-f]{64}$/i.test(key) ? 'hex' : 'utf8');
  const derivedKey = hkdf(secret, STATIC_KEY_SALT);
  const macKey = hkdf(secret, MAC_DERIVATION_SALT);
  const keyId = createHash('sha256').update(derivedKey).digest().subarray(0, 8).toString('hex');
  const aad = Buffer.from(`1|${keyId}|${sdkVersion}|${eventId}`, 'utf8');
  const iv = Buffer.from('00112233445566778899aabb', 'hex');
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  cipher.setAAD(aad);
  const input = compressed
    ? deflateRawSync(Buffer.from(plaintext, 'utf8'))
    : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const hmac = createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .update(authTag)
    .update(aad)
    .digest('base64');

  return {
    v: 1,
    eventId,
    sdk: { name: 'errorcore', version: sdkVersion },
    keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    hmac,
    compressed,
    producedAt: 1
  };
}

describe('errorcore sink decryptor', () => {
  it('decrypts benchmark envelopes with the configured DEK', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const envelope = buildEnvelope({
      key,
      sdkVersion: '0.2.0',
      eventId: 'evt-bench',
      plaintext: JSON.stringify({ ok: true, scenarioId: 'S1' })
    });

    assert.deepEqual(JSON.parse(decryptErrorcoreEnvelope(envelope, { encryptionKey: key })), {
      ok: true,
      scenarioId: 'S1'
    });
  });

  it('inflates raw-deflate compressed envelopes', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const envelope = buildEnvelope({
      key,
      sdkVersion: '0.2.0',
      eventId: 'evt-compressed',
      plaintext: JSON.stringify({ message: 'x'.repeat(20_000) }),
      compressed: true
    });

    assert.equal(
      JSON.parse(decryptErrorcoreEnvelope(envelope, { encryptionKey: key })).message.length,
      20_000
    );
  });
});
