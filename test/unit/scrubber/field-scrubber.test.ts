import { describe, expect, it } from 'vitest';

import { Encryption } from '../../../src/security/encryption';
import { computeMeta, decryptFieldValue } from '../../../src/scrubber/encoder';
import { defaultPolicy, resolveScrubberPolicy } from '../../../src/scrubber/policy';
import { Scrubber } from '../../../src/scrubber/scrubber';

const FIELD_KEY =
  '0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98';

class MemoryFieldSpool {
  public readonly entries = new Map<string, Buffer>();

  private nextId = 0;

  public store(input: { bytes: Buffer; originalSize: number }): { id: string; bytes: number } {
    const id = `field_${++this.nextId}`;
    this.entries.set(id, Buffer.from(input.bytes));
    return { id, bytes: input.originalSize };
  }

  public get(id: string): Buffer | null {
    return this.entries.get(id) ?? null;
  }
}

describe('Field scrubber policy', () => {
  it('classifies credential names and invokes user detectors in order', () => {
    const calls: string[] = [];
    const policy = resolveScrubberPolicy({
      piiDetectors: [
        (value) => {
          calls.push(`first:${String(value)}`);
          return false;
        },
        (value) => {
          calls.push(`second:${String(value)}`);
          return value === 'customer-42';
        }
      ]
    });
    const scrubber = new Scrubber(policy, {
      encryption: new Encryption(FIELD_KEY)
    });

    expect(scrubber.process('api_token', 'safe-looking', 'app').mode).toBe('meta');
    expect(scrubber.process('customerId', 'customer-42', 'app').mode).toBe('meta');
    expect(calls).toEqual(['first:customer-42', 'second:customer-42']);
  });

  it('detects default email, phone, and credit-card values', () => {
    const scrubber = new Scrubber(defaultPolicy, {
      encryption: new Encryption(FIELD_KEY)
    });

    expect(scrubber.process('email', 'person@example.com', 'app').mode).toBe('meta');
    expect(scrubber.process('phone', '+1 415 555 2671', 'app').mode).toBe('meta');
    expect(scrubber.process('card', '4242424242424242', 'app').mode).toBe('meta');
  });

  it('computes shallow metadata with object keys capped by policy', () => {
    const meta = computeMeta(
      { a: 1, b: 'two', c: true, d: null },
      2
    );

    expect(meta.type).toBe('object');
    expect(meta.keys).toEqual(['a', 'b']);
    expect(meta.bytes).toBeGreaterThan(0);
  });
});

describe('Field scrubber encoding matrix', () => {
  it('returns encrypted inline fields for normal small app values', () => {
    const encryption = new Encryption(FIELD_KEY);
    const scrubber = new Scrubber(
      { ...defaultPolicy, spoolBytes: 64, maxField: 128 },
      { encryption }
    );

    const field = scrubber.process('message', { ok: true }, 'app');

    expect(field.mode).toBe('encrypted');
    if (field.mode !== 'encrypted') throw new Error('expected encrypted field');
    expect(field.cipher.type).toBe('inline');
    expect(JSON.parse(decryptFieldValue(field, { encryption }).toString('utf8'))).toEqual({
      ok: true
    });
  });

  it('spools normal large http_incoming values and keeps app values as metadata only', () => {
    const encryption = new Encryption(FIELD_KEY);
    const spool = new MemoryFieldSpool();
    const scrubber = new Scrubber(
      { ...defaultPolicy, credentialNames: /password/i, spoolBytes: 8, maxField: 32 },
      { encryption, spool }
    );

    const incoming = scrubber.process('body', 'a'.repeat(20), 'http_incoming');
    const app = scrubber.process('value', 'b'.repeat(40), 'app');
    const sensitiveLarge = scrubber.process('password', 'c'.repeat(40), 'http_incoming');

    expect(incoming.mode).toBe('encrypted');
    if (incoming.mode !== 'encrypted') throw new Error('expected encrypted field');
    expect(incoming.cipher).toMatchObject({ type: 'ref', bytes: incoming.meta.bytes });
    expect(decryptFieldValue(incoming, { encryption, spool }).toString('utf8')).toBe(
      JSON.stringify('a'.repeat(20))
    );
    expect(app.mode).toBe('meta');
    expect(sensitiveLarge.mode).toBe('meta');
  });
});
