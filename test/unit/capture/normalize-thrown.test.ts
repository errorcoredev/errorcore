import { describe, expect, it } from 'vitest';

import { normalizeThrown } from '../../../src/capture/normalize-thrown';
import { resolveTestConfig } from '../../helpers/test-config';

describe('normalizeThrown', () => {
  it('includes a scrubbed preview for string throws', () => {
    const error = normalizeThrown(
      'secret=super-secret user=alice',
      resolveTestConfig()
    ) as Error & { thrownType?: string; thrownValue?: unknown };

    expect(error.name).toBe('NonErrorThrown');
    expect(error.thrownType).toBe('string');
    expect(error.thrownValue).toBe('secret=[REDACTED]');
    expect(error.message).toBe('Non-Error thrown (string): "secret=[REDACTED]"');
    expect(error.message).not.toContain('super-secret');
  });

  it('includes a value preview for number throws', () => {
    const error = normalizeThrown(42, resolveTestConfig()) as Error & {
      thrownType?: string;
      thrownValue?: unknown;
    };

    expect(error.name).toBe('NonErrorThrown');
    expect(error.thrownType).toBe('number');
    expect(error.thrownValue).toBe(42);
    expect(error.message).toBe('Non-Error thrown (number): 42');
  });

  it('keeps null, undefined, and object throw messages type-focused', () => {
    const config = resolveTestConfig();
    const cases: Array<[unknown, string]> = [
      [null, 'Non-Error thrown (null)'],
      [undefined, 'Non-Error thrown (undefined)'],
      [{ token: 'secret-token', visible: true }, 'Non-Error thrown (object)']
    ];

    for (const [value, message] of cases) {
      expect(normalizeThrown(value, config).message).toBe(message);
    }
  });
});
