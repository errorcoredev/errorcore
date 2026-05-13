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

  it('uses parsed application stack frames when captured locals are unavailable', () => {
    const first = new Error('same message');
    first.stack = [
      'Error: same message',
      '    at fromLibrary (/app/node_modules/pkg/index.js:1:1)',
      '    at firstHandler (/app/src/first.ts:12:3)'
    ].join('\n');

    const second = new Error('same message');
    second.stack = [
      'Error: same message',
      '    at fromLibrary (/app/node_modules/pkg/index.js:1:1)',
      '    at secondHandler (/app/src/second.ts:98:7)'
    ].join('\n');

    expect(computeFingerprint(first, [])).not.toBe(computeFingerprint(second, []));
  });

  it('prefers captured locals over parsed stack frames when locals are present', () => {
    const first = new Error('same message');
    first.stack = 'Error: same message\n    at firstHandler (/app/src/first.ts:12:3)';
    const second = new Error('same message');
    second.stack = 'Error: same message\n    at secondHandler (/app/src/second.ts:98:7)';

    const localsFrame = makeFrame({ filePath: '/app/src/shared.ts', lineNumber: 44 });

    expect(computeFingerprint(first, [localsFrame])).toBe(
      computeFingerprint(second, [localsFrame])
    );
  });

  it('groups library-only errors by package instead of internal line number', () => {
    const first = new Error('same message');
    first.stack = [
      'Error: same message',
      '    at parse (/app/node_modules/zod/index.js:12:3)'
    ].join('\n');

    const second = new Error('same message');
    second.stack = [
      'Error: same message',
      '    at run (/app/node_modules/zod/helpers.js:98:7)'
    ].join('\n');

    expect(computeFingerprint(first, [])).toBe(computeFingerprint(second, []));
  });

  it('keeps library-only errors from different packages in different groups', () => {
    const first = new Error('same message');
    first.stack = [
      'Error: same message',
      '    at parse (/app/node_modules/zod/index.js:12:3)'
    ].join('\n');

    const second = new Error('same message');
    second.stack = [
      'Error: same message',
      '    at request (/app/node_modules/@prisma/client/runtime.js:98:7)'
    ].join('\n');

    expect(computeFingerprint(first, [])).not.toBe(computeFingerprint(second, []));
  });
});
