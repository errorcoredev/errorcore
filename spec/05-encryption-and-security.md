# Module 05: Encryption and Security

> **Spec status:** LOCKED
> **Source files:** `src/security/encryption.ts`, `src/security/rate-limiter.ts`
> **Dependencies:** Module 01 (types, config)
> **Build order position:** 5

---

## Module Contract Header

```typescript
/**
 * @module 05-encryption-and-security
 * @spec spec/05-encryption-and-security.md
 * @dependencies types.ts, config.ts
 */
```

---

## Purpose

Provide AES-256-GCM encryption for error packages and a sliding-window rate limiter to prevent capture amplification under high error rates.

---

## Scope

- `encryption.ts`: `Encryption` class with `encrypt()` and `decrypt()` methods
- `rate-limiter.ts`: `RateLimiter` class with `tryAcquire()` and `getDroppedCount()`

---

## Non-Goals

- Does not decide WHEN to encrypt (callers decide).
- Does not manage transport-level TLS (that is the transport module's responsibility).
- Does not perform PII scrubbing.

---

## Dependencies

- Module 01: `ResolvedConfig`

---

## Node.js APIs Used

### encryption.ts
- `require('node:crypto')`
- `crypto.createCipheriv('aes-256-gcm', key, iv)`
- `crypto.createDecipheriv('aes-256-gcm', key, iv)`
- `crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256')`
- `crypto.randomBytes(12)` — IV (96 bits for GCM)
- `crypto.randomBytes(16)` — salt for PBKDF2

### rate-limiter.ts
- `Date.now()` for timestamp tracking

---

## Data Structures

### Encryption class

```typescript
class Encryption {
  constructor(encryptionKey: string);
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}

interface EncryptedPayload {
  salt: string;      // base64
  iv: string;        // base64
  ciphertext: string; // base64
  authTag: string;    // base64
}
```

### RateLimiter class

```typescript
class RateLimiter {
  constructor(config: { maxCaptures: number; windowMs: number });
  tryAcquire(): boolean;
  getDroppedCount(): number;
  reset(): void;
}
```

---

## Implementation Notes

### Encryption

1. At construction time, generate a random salt and derive the key via PBKDF2: `crypto.pbkdf2Sync(encryptionKey, salt, 100000, 32, 'sha256')`. Cache the derived key and salt for the SDK's lifetime.
2. `encrypt(plaintext)`:
   - Generate random 12-byte IV via `crypto.randomBytes(12)`
   - Create cipher: `crypto.createCipheriv('aes-256-gcm', derivedKey, iv)`
   - Encrypt plaintext, get ciphertext + authTag
   - Return `{ salt, iv, ciphertext, authTag }` all base64-encoded
3. `decrypt(payload)`:
   - Re-derive key from `encryptionKey` + payload salt (supports payloads encrypted with different salts if needed)
   - Create decipher with IV and authTag
   - Decrypt and return plaintext
   - If authTag verification fails, throw an error

### Key derivation caching

The PBKDF2 derivation uses 100,000 iterations, which takes ~50-100ms. The derived key is cached at construction time. The same salt is reused for all encryptions during this SDK instance's lifetime. Decryption re-derives from the payload's salt to support cross-instance decryption.

### Rate Limiter

Implementation: sliding window using a fixed-size array of timestamps.

- Store an array of at most `maxCaptures` timestamps.
- `tryAcquire()`:
  1. Discard timestamps older than `Date.now() - windowMs`
  2. If remaining count < `maxCaptures`: push `Date.now()`, return `true`
  3. Else: increment `droppedCount`, return `false`
- `getDroppedCount()`: returns lifetime count of rejected acquisitions
- `reset()`: clear timestamps array and droppedCount

Default config: `maxCaptures: 10, windowMs: 60000`

---

## Security Considerations

- The encryption key is derived via PBKDF2 with 100,000 iterations and a random salt. This is resistant to brute force.
- AES-256-GCM provides both confidentiality and integrity (authenticated encryption). Tampered ciphertext is rejected.
- The derived key is stored in memory for the SDK's lifetime. It is NOT written to disk or included in error packages.
- The encryption key string from user config MUST NOT appear in any error package or log output.
- IV MUST be unique per encryption call. Using `crypto.randomBytes(12)` provides sufficient uniqueness.

---

## Edge Cases

- Encryption key is empty string: constructor should throw a validation error.
- Plaintext is empty string: encrypt should still produce valid output.
- Tampered ciphertext: decrypt throws (GCM auth tag verification fails).
- Wrong decryption key: decrypt throws.
- Rate limiter with `maxCaptures: 0`: `tryAcquire()` always returns false.
- Rate limiter called at exact window boundary: edge timestamps are correctly discarded.
- Rapid calls to `tryAcquire()` within the same millisecond: all counted correctly.

---

## Testing Requirements

### Encryption
- Encrypt then decrypt round-trip produces original plaintext
- Different encryption keys produce different ciphertext
- Wrong key fails to decrypt (throws)
- Tampered ciphertext fails to decrypt (GCM auth tag)
- Empty string encrypts and decrypts correctly
- Output format has all four base64 fields

### Rate Limiter
- Allow up to `maxCaptures` in window, reject next
- After window expires, allow again
- `getDroppedCount()` increments on rejection
- `reset()` clears state
- Works correctly with `maxCaptures: 1`

---

## Completion Criteria

- `Encryption` class exported with `encrypt()` and `decrypt()`.
- `RateLimiter` class exported with `tryAcquire()`, `getDroppedCount()`, `reset()`.
- Encryption uses AES-256-GCM with PBKDF2 key derivation.
- Rate limiter correctly enforces sliding window.
- All unit tests pass.
- No encryption key leakage in any output.
