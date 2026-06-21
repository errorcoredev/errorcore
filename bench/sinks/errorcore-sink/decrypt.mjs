import {
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  timingSafeEqual
} from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const STATIC_KEY_SALT = Buffer.from('errorcore-v1-key-derivation', 'utf8');
const MAC_DERIVATION_SALT = Buffer.from('errorcore-v1-mac-key', 'utf8');

function readKeyMaterial(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('encryptionKey must not be empty');
  }
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return Buffer.from(input, 'hex');
  }
  return Buffer.from(input, 'utf8');
}

function readLegacyKeyMaterial(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('encryptionKey must not be empty');
  }
  return Buffer.from(input, 'utf8');
}

function hkdfSha256(secret, salt) {
  return Buffer.from(hkdfSync('sha256', secret, salt, Buffer.alloc(0), 32));
}

function pbkdf2Sha256(secret, salt) {
  return pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
}

function deriveMacKey(secret, explicitMacKey, mode) {
  if (explicitMacKey !== undefined) {
    const candidate = Buffer.isBuffer(explicitMacKey)
      ? explicitMacKey
      : Buffer.from(
          explicitMacKey,
          /^[0-9a-f]+$/i.test(explicitMacKey) && explicitMacKey.length % 2 === 0 ? 'hex' : 'utf8'
        );
    if (candidate.length < 32) {
      throw new Error('macKey must be at least 32 bytes');
    }
    return candidate;
  }
  return mode === 'legacy' ? pbkdf2Sha256(secret, MAC_DERIVATION_SALT) : hkdfSha256(secret, MAC_DERIVATION_SALT);
}

function materialForKey(key, macKey) {
  const secret = readKeyMaterial(key);
  const derivedKey = hkdfSha256(secret, STATIC_KEY_SALT);
  return {
    derivedKey,
    macKey: deriveMacKey(secret, macKey, 'hkdf'),
    keyId: createHash('sha256').update(derivedKey).digest().subarray(0, 8).toString('hex')
  };
}

function legacyMaterialForKey(key, macKey) {
  const secret = readLegacyKeyMaterial(key);
  const derivedKey = pbkdf2Sha256(secret, STATIC_KEY_SALT);
  return {
    derivedKey,
    macKey: deriveMacKey(secret, macKey, 'legacy'),
    keyId: createHash('sha256').update(derivedKey).digest().subarray(0, 8).toString('hex')
  };
}

function aadFor(envelope, keyId) {
  return Buffer.from(`1|${keyId}|${envelope.sdk?.version ?? 'unknown'}|${envelope.eventId}`, 'utf8');
}

function verifyHmac(material, envelope, iv, ciphertext, authTag, expectedHmac) {
  const aad = aadFor(envelope, material.keyId);
  const actual = createHmac('sha256', material.macKey)
    .update(iv)
    .update(ciphertext)
    .update(authTag)
    .update(aad)
    .digest();
  return actual.length === expectedHmac.length && timingSafeEqual(actual, expectedHmac);
}

function decryptWithMaterial(material, envelope, iv, ciphertext, authTag) {
  const decipher = createDecipheriv('aes-256-gcm', material.derivedKey, iv);
  decipher.setAAD(aadFor(envelope, material.keyId));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return envelope.compressed === true ? inflateRawSync(plaintext).toString('utf8') : plaintext.toString('utf8');
}

export function decryptErrorcoreEnvelope(envelope, options) {
  if (envelope?.v !== 1) {
    throw new Error(`unsupported envelope version: ${String(envelope?.v)}`);
  }
  if (envelope.iv === 'unencrypted' && envelope.authTag === 'unencrypted') {
    return Buffer.from(envelope.ciphertext, 'base64').toString('utf8');
  }

  const keys = [options.encryptionKey, ...(options.previousEncryptionKeys ?? [])].filter(Boolean);
  const materials = [
    ...keys.map((key) => materialForKey(key, options.macKey)),
    ...keys.map((key) => legacyMaterialForKey(key, options.macKey))
  ].sort((a, b) => {
    if (a.keyId === envelope.keyId) return -1;
    if (b.keyId === envelope.keyId) return 1;
    return 0;
  });
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const expectedHmac = Buffer.from(envelope.hmac, 'base64');

  let hmacMatched = false;
  for (const material of materials) {
    if (!verifyHmac(material, envelope, iv, ciphertext, authTag, expectedHmac)) {
      continue;
    }
    hmacMatched = true;
    try {
      return decryptWithMaterial(material, envelope, iv, ciphertext, authTag);
    } catch {
      throw new Error('EC_DECRYPT_AUTH_TAG_MISMATCH');
    }
  }

  throw new Error(hmacMatched ? 'EC_DECRYPT_AUTH_TAG_MISMATCH' : 'EC_DECRYPT_HMAC_MISMATCH');
}
