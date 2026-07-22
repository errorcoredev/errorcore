import { describe, expect, it } from 'vitest';

import {
  scrubInternalWarningValue,
  serializeCause
} from '../../src/capture/error-capturer';

describe('serializeCause', () => {
  it('returns a structured object for an Error with a stack', () => {
    const err = new TypeError('thing went wrong');
    const c = serializeCause(err);
    expect(c).toEqual(
      expect.objectContaining({
        name: 'TypeError',
        message: 'thing went wrong',
      })
    );
    expect(typeof c).toBe('object');
    expect((c as { stackHead?: string }).stackHead).toMatch(/TypeError: thing went wrong/);
  });

  it('handles errors without messages', () => {
    const err = new Error();
    const c = serializeCause(err);
    expect((c as { name: string }).name).toBe('Error');
    expect((c as { message: string }).message).toBe('');
  });

  it('truncates very long messages to 200 characters', () => {
    const long = 'x'.repeat(500);
    const err = new Error(long);
    const c = serializeCause(err);
    expect((c as { message: string }).message.length).toBe(200);
  });

  it('passes non-Error inputs through unchanged for back-compat', () => {
    expect(serializeCause('plain string')).toBe('plain string');
    expect(serializeCause(null)).toBe(null);
    expect(serializeCause(42)).toBe(42);
  });
});

describe('scrubInternalWarningValue', () => {
  it('redacts apiKey and authorization fields plus Bearer values', () => {
    const apiKey = 'ec_live_0123456789abcdef0123456789abcdef';

    expect(
      scrubInternalWarningValue({
        apiKey,
        authorization: `Bearer ${apiKey}`,
        detail: `collector rejected Bearer ${apiKey}`
      })
    ).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      detail: 'collector rejected Bearer [REDACTED]'
    });
  });
});
