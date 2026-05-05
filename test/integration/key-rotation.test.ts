import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeadLetterStore,
  createHmacVerifier
} from '../../src/transport/dead-letter-store';
import { Encryption } from '../../src/security/encryption';

const PRIMARY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PREV    = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('dead-letter store key rotation', () => {
  let dir: string;
  let dlqPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-rot-'));
    dlqPath = path.join(dir, 'dl.ndjson');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes under PREV, then verifies and drains under PRIMARY+PREV chain', () => {
    const oldStore = new DeadLetterStore(dlqPath, { integrityKey: PREV });
    expect(oldStore.appendPayloadSync('{"err":"old"}')).toBe(true);
    expect(oldStore.getPendingCount()).toBe(1);

    // Rotation gotcha: handing PRIMARY+PREV to a fresh Encryption won't
    // verify the old entry. Encryption derives HMAC keys via PBKDF2, but
    // the legacy store wrote a raw HMAC over PREV. We chain two raw-HMAC
    // verifiers to bridge that until reSignAll runs.
    const verifier = {
      sign: (p: string) => createHmacVerifier(PRIMARY).sign(p),
      verifyKeyIndex: (p: string, m: string) => {
        const primaryIdx = createHmacVerifier(PRIMARY).verifyKeyIndex(p, m);
        if (primaryIdx !== null) return 0;
        const prevIdx = createHmacVerifier(PREV).verifyKeyIndex(p, m);
        if (prevIdx !== null) return 1;
        return null;
      }
    };
    const newStore = new DeadLetterStore(dlqPath, { verifier });
    const result = newStore.drain();
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.payload).toBe('{"err":"old"}');
  });

  it('reSignAll converts every entry to use the primary key', () => {
    // Use a chain of raw-HMAC verifiers since the old store uses raw HMAC.
    const oldStore = new DeadLetterStore(dlqPath, { integrityKey: PREV });
    expect(oldStore.appendPayloadSync('{"a":1}')).toBe(true);
    expect(oldStore.appendPayloadSync('{"b":2}')).toBe(true);

    const verifier = {
      sign: (p: string) => createHmacVerifier(PRIMARY).sign(p),
      verifyKeyIndex: (p: string, m: string) => {
        const primaryIdx = createHmacVerifier(PRIMARY).verifyKeyIndex(p, m);
        if (primaryIdx !== null) return 0;
        const prevIdx = createHmacVerifier(PREV).verifyKeyIndex(p, m);
        if (prevIdx !== null) return 1;
        return null;
      }
    };
    const rotStore = new DeadLetterStore(dlqPath, { verifier });
    const counts = rotStore.reSignAll();
    expect(counts.resigned).toBe(2);
    expect(counts.dropped).toBe(0);

    // After reSignAll, an SDK that knows ONLY the primary key should
    // verify every entry (no need for PREV in the chain).
    const primaryOnlyStore = new DeadLetterStore(dlqPath, {
      verifier: createHmacVerifier(PRIMARY)
    });
    const drained = primaryOnlyStore.drain();
    expect(drained.entries.length).toBe(2);
  });

  it('reSignAll drops entries that fail verification under any chain key', () => {
    // Hand-craft a junk envelope with a bogus MAC.
    fs.writeFileSync(
      dlqPath,
      JSON.stringify({
        version: 1,
        kind: 'payload',
        storedAt: new Date().toISOString(),
        payload: '{"x":1}',
        mac: 'AAAAAA=='
      }) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );

    const enc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const store = new DeadLetterStore(dlqPath, {
      verifier: {
        sign: (p) => enc.sign(p),
        verifyKeyIndex: (p, m) => {
          const r = enc.verify(p, m);
          return r.ok ? r.keyIndex : null;
        }
      }
    });
    const counts = store.reSignAll();
    expect(counts.resigned).toBe(0);
    expect(counts.dropped).toBe(1);
  });

  it('Encryption-derived verifier verifies and drains entries written through it', () => {
    // End-to-end SDK-style flow: an Encryption-derived verifier writes
    // an entry under PREV, then a verifier with PRIMARY+PREV reads it.
    const oldEnc = new Encryption(PREV);
    const oldStore = new DeadLetterStore(dlqPath, {
      verifier: {
        sign: (p) => oldEnc.sign(p),
        verifyKeyIndex: (p, m) => {
          const r = oldEnc.verify(p, m);
          return r.ok ? r.keyIndex : null;
        }
      }
    });
    expect(oldStore.appendPayloadSync('{"sdk":"old"}')).toBe(true);

    const newEnc = new Encryption(PRIMARY, { previousEncryptionKeys: [PREV] });
    const newStore = new DeadLetterStore(dlqPath, {
      verifier: {
        sign: (p) => newEnc.sign(p),
        verifyKeyIndex: (p, m) => {
          const r = newEnc.verify(p, m);
          return r.ok ? r.keyIndex : null;
        }
      }
    });
    const drained = newStore.drain();
    expect(drained.entries.length).toBe(1);
    expect(drained.entries[0]!.payload).toBe('{"sdk":"old"}');

    // Now reSignAll, then read with PRIMARY-only encryption.
    const counts = newStore.reSignAll();
    expect(counts.resigned).toBe(1);
    expect(counts.dropped).toBe(0);

    const primaryOnly = new Encryption(PRIMARY);
    const primaryOnlyStore = new DeadLetterStore(dlqPath, {
      verifier: {
        sign: (p) => primaryOnly.sign(p),
        verifyKeyIndex: (p, m) => {
          const r = primaryOnly.verify(p, m);
          return r.ok ? r.keyIndex : null;
        }
      }
    });
    const drainedAfter = primaryOnlyStore.drain();
    expect(drainedAfter.entries.length).toBe(1);
  });
});
