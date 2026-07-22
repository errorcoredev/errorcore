import { describe, expect, it } from 'vitest';

import { Scrubber } from '../../../src/pii/scrubber';
import { resolveTestConfig } from '../../helpers/test-config';

describe('Scrubber concurrent scrubbing (lastIndex race regression)', () => {
  it('redacts every PII match across 100 concurrent scrub calls', async () => {
    const scrubber = new Scrubber(resolveTestConfig({}));

    const inputs = Array.from({ length: 100 }, (_, index) => ({
      email: `user${index}@example.com`,
      text: `Contact user${index}@example.com for details`
    }));

    const results = await Promise.all(
      inputs.map((input) =>
        Promise.resolve(scrubber.scrubValue('message', input.text) as string)
      )
    );

    expect(results).toHaveLength(inputs.length);

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const originalEmail = inputs[index].email;

      expect(result).toBe(`Contact [REDACTED] for details`);
      expect(result).not.toContain(originalEmail);
      expect(result).not.toContain('@example.com');
    }
  });

  it('redacts PII even when module-scope regex lastIndex is pre-sabotaged', async () => {
    const scrubber = new Scrubber(resolveTestConfig({}));
    const input = 'Contact victim@example.com now';

    const patterns = await import('../../../src/pii/patterns');
    patterns.COMBINED_QUICK_TEST_REGEX.lastIndex = 9999;

    const result = scrubber.scrubValue('message', input);

    expect(result).toBe('Contact [REDACTED] now');
  });
});
