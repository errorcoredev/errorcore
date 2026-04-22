import { describe, expect, it } from 'vitest';
import { computeFingerprint } from '../../../src/capture/fingerprint';
import type { CapturedFrame } from '../../../src/types';

function makeFrame(overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return {
    functionName: 'testFn',
    filePath: '/app/src/foo.ts',
    lineNumber: 42,
    columnNumber: 5,
    locals: {},
    ...overrides
  };
}

describe('computeFingerprint', () => {
  it('is stable for the same error from the same line', () => {
    const frame = makeFrame();
    const a = computeFingerprint(new Error('boom'), [frame]);
    const b = computeFingerprint(new Error('boom'), [frame]);
    expect(a).toBe(b);
  });

  it('differs when the same error class is thrown from different lines', () => {
    const a = computeFingerprint(new Error('boom'), [makeFrame({ lineNumber: 42 })]);
    const b = computeFingerprint(new Error('boom'), [makeFrame({ lineNumber: 99 })]);
    expect(a).not.toBe(b);
  });

  it('differs when different error classes are thrown at the same line', () => {
    const frame = makeFrame();
    const a = computeFingerprint(new Error('boom'), [frame]);
    const b = computeFingerprint(new TypeError('boom'), [frame]);
    expect(a).not.toBe(b);
  });

  it('normalizes numeric variance in messages', () => {
    const frame = makeFrame();
    const a = computeFingerprint(new Error('user 123'), [frame]);
    const b = computeFingerprint(new Error('user 456'), [frame]);
    expect(a).toBe(b);
  });

  it('is exactly 16 lowercase hex characters', () => {
    const fp = computeFingerprint(new Error('boom'), [makeFrame()]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
