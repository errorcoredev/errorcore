import { describe, expect, it } from 'vitest';

import { Scrubber } from '../../../src/pii/scrubber';
import { resolveTestConfig } from '../../helpers/test-config';

describe('Scrubber infrastructure-key passthrough (§B1)', () => {
  const scrubber = new Scrubber(resolveTestConfig({}));

  // hrtime values can be 19 digits — long enough that the credit-card
  // regex's Luhn check can match by chance. Pre-fix, these were silently
  // [REDACTED] across hundreds of captures.
  const longDigitString = '4532015112830366'; // valid Luhn 16-digit
  const hrtimeStyle = '236367182713310042'; // 18-digit hrtime-shape

  it('does not redact hrtimeNs even when value is digit-heavy', () => {
    const out = scrubber.scrubObject({ hrtimeNs: hrtimeStyle }) as Record<string, unknown>;
    expect(out.hrtimeNs).toBe(hrtimeStyle);
  });

  it('does not redact startTime / endTime / wallClockMs', () => {
    const out = scrubber.scrubObject({
      startTime: '236367000000000',
      endTime: '236367500000000',
      wallClockMs: 1777905879942
    }) as Record<string, unknown>;
    expect(out.startTime).toBe('236367000000000');
    expect(out.endTime).toBe('236367500000000');
    expect(out.wallClockMs).toBe(1777905879942);
  });

  it('does not redact known SDK-internal keys: pid, fingerprint, eventId', () => {
    const out = scrubber.scrubObject({
      pid: 12345,
      fingerprint: '8273349a55aacff1',
      eventId: 'b8d6a18c-9f1d-4d4f-9b58-90f56dc6c0b1'
    }) as Record<string, unknown>;
    expect(out.pid).toBe(12345);
    expect(out.fingerprint).toBe('8273349a55aacff1');
    expect(out.eventId).toBe('b8d6a18c-9f1d-4d4f-9b58-90f56dc6c0b1');
  });

  it('still redacts a digit-shaped value at a non-infrastructure key', () => {
    const out = scrubber.scrubObject({ value: longDigitString }) as Record<string, unknown>;
    expect(out.value).toBe('[REDACTED]');
  });

  it('still redacts a credit-card under cardNumber even with longer infra siblings', () => {
    const out = scrubber.scrubObject({
      hrtimeNs: hrtimeStyle,
      cardNumber: longDigitString
    }) as Record<string, unknown>;
    expect(out.hrtimeNs).toBe(hrtimeStyle);
    expect(out.cardNumber).toBe('[REDACTED]');
  });
});

describe('Scrubber operational-header value passthrough', () => {
  const scrubber = new Scrubber(resolveTestConfig({}));

  it('preserves idempotency-key value in object form', () => {
    const out = scrubber.scrubObject({ 'idempotency-key': 'abc-123' }) as Record<string, unknown>;
    expect(out['idempotency-key']).toBe('abc-123');
  });

  it('preserves x-correlation-id value', () => {
    const out = scrubber.scrubObject({ 'x-correlation-id': 'req-7f3a' }) as Record<string, unknown>;
    expect(out['x-correlation-id']).toBe('req-7f3a');
  });

  it('still redacts authorization header value', () => {
    const out = scrubber.scrubObject({ authorization: 'Bearer abcdef' }) as Record<string, unknown>;
    expect(out.authorization).toBe('[REDACTED]');
  });

  it('preserves idempotency-key in form-urlencoded body bytes', () => {
    const buf = Buffer.from('idempotency-key=abc-123&password=hunter2', 'utf8');
    const out = scrubber.scrubBodyBuffer(buf, { 'content-type': 'application/x-www-form-urlencoded' });
    const decoded = out.toString('utf8');
    expect(decoded).toContain('idempotency-key=abc-123');
    expect(decoded).toContain('password=%5BREDACTED%5D');
  });
});
