import { describe, expect, it } from 'vitest';

import {
  AWS_ACCESS_KEY_REGEX,
  BASIC_AUTH_REGEX,
  BEARER_REGEX,
  CREDIT_CARD_REGEX,
  EMAIL_REGEX,
  GENERIC_SK_KEY_REGEX,
  GITHUB_TOKEN_REGEX,
  IPV4_REGEX,
  JWT_REGEX,
  PHONE_REGEX,
  SENSITIVE_KEY_EXACT_MATCHES,
  SENSITIVE_KEY_REGEX,
  SSN_REGEX,
  STRIPE_KEY_REGEX,
  isValidLuhn
} from '../../src/pii/patterns';

function testRegex(regex: RegExp, input: string): string[] {
  regex.lastIndex = 0;
  return Array.from(input.matchAll(regex), (m) => m[0]);
}

describe('isValidLuhn', () => {
  it.each([
    ['valid Visa', '4111111111111111', true],
    ['valid Amex', '378282246310005', true],
    ['invalid check digit', '4111111111111112', false],
    ['too short (12 digits)', '411111111111', false],
    ['too long (20 digits)', '41111111111111111111', false],
    ['non-digits', '4111abcd11111111', false],
    ['empty string', '', false]
  ])('%s -> %s', (_label, input, expected) => {
    expect(isValidLuhn(input)).toBe(expected);
  });
});

describe('EMAIL_REGEX', () => {
  it.each([
    'user@example.com',
    'first.last@sub.domain.co',
    'a+tag@host.io',
    'test_123@foo.bar.baz'
  ])('matches valid email: %s', (email) => {
    expect(testRegex(EMAIL_REGEX, email)).toEqual([email]);
  });

  it.each(['plaintext', '@missinglocal.com', 'no-at-sign', 'user@'])(
    'rejects non-email: %s',
    (input) => {
      expect(testRegex(EMAIL_REGEX, input)).toEqual([]);
    }
  );
});

describe('CREDIT_CARD_REGEX', () => {
  it('matches 13-digit sequence', () => {
    expect(testRegex(CREDIT_CARD_REGEX, 'num 1234567890123 end')).toEqual([
      '1234567890123'
    ]);
  });

  it('matches 16-digit sequence', () => {
    expect(testRegex(CREDIT_CARD_REGEX, 'card 4111111111111111')).toEqual([
      '4111111111111111'
    ]);
  });

  it('matches 19-digit sequence', () => {
    expect(testRegex(CREDIT_CARD_REGEX, '1234567890123456789')).toEqual([
      '1234567890123456789'
    ]);
  });

  it('rejects 12-digit sequence', () => {
    expect(testRegex(CREDIT_CARD_REGEX, '123456789012')).toEqual([]);
  });
});

describe('SSN_REGEX', () => {
  it('matches NNN-NN-NNNN', () => {
    expect(testRegex(SSN_REGEX, 'ssn 123-45-6789 end')).toEqual([
      '123-45-6789'
    ]);
  });

  it('rejects wrong format', () => {
    expect(testRegex(SSN_REGEX, '123456789')).toEqual([]);
    expect(testRegex(SSN_REGEX, '123-456-789')).toEqual([]);
  });
});

describe('JWT_REGEX', () => {
  it('matches a JWT-shaped token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_-XYZ';
    expect(testRegex(JWT_REGEX, `token ${jwt} end`)).toEqual([jwt]);
  });

  it('rejects non-JWT', () => {
    expect(testRegex(JWT_REGEX, 'eyJnotajwt')).toEqual([]);
  });
});

describe('BEARER_REGEX', () => {
  it('matches Bearer token', () => {
    const matches = testRegex(BEARER_REGEX, 'Authorization: Bearer abc123XYZ');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/^Bearer\s+abc123XYZ$/i);
  });

  it('is case-insensitive', () => {
    expect(testRegex(BEARER_REGEX, 'bearer mytoken')).toHaveLength(1);
  });
});

describe('BASIC_AUTH_REGEX', () => {
  it('matches Basic base64 value', () => {
    const matches = testRegex(BASIC_AUTH_REGEX, 'Authorization: Basic dXNlcjpwYXNz');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/^Basic\s+dXNlcjpwYXNz$/i);
  });

  it('matches with padding', () => {
    expect(testRegex(BASIC_AUTH_REGEX, 'Basic abc123==')).toHaveLength(1);
  });
});

describe('AWS_ACCESS_KEY_REGEX', () => {
  it('matches AKIA key', () => {
    expect(testRegex(AWS_ACCESS_KEY_REGEX, 'key AKIAIOSFODNN7EXAMPLE')).toEqual([
      'AKIAIOSFODNN7EXAMPLE'
    ]);
  });

  it('matches ASIA key', () => {
    expect(
      testRegex(AWS_ACCESS_KEY_REGEX, 'ASIA1234567890ABCDEF')
    ).toEqual(['ASIA1234567890ABCDEF']);
  });

  it('rejects wrong prefix', () => {
    expect(testRegex(AWS_ACCESS_KEY_REGEX, 'AKZA1234567890ABCDEF')).toEqual([]);
  });
});

describe('GITHUB_TOKEN_REGEX', () => {
  it.each([
    ['ghp_ prefix', `ghp_${'a'.repeat(36)}`],
    ['gho_ prefix', `gho_${'B'.repeat(20)}`],
    ['github_pat_ prefix', `github_pat_${'c1d2e3f4g5'.repeat(3)}`]
  ])('matches %s', (_label, token) => {
    expect(testRegex(GITHUB_TOKEN_REGEX, token)).toHaveLength(1);
  });

  it('rejects unknown prefix', () => {
    expect(testRegex(GITHUB_TOKEN_REGEX, `ghx_${'a'.repeat(36)}`)).toEqual([]);
  });
});

describe('STRIPE_KEY_REGEX', () => {
  it.each([
    ['sk_live_', `sk_live_${'a'.repeat(24)}`],
    ['sk_test_', `sk_test_${'b'.repeat(16)}`],
    ['rk_test_', `rk_test_${'c'.repeat(20)}`]
  ])('matches %s', (_label, key) => {
    expect(testRegex(STRIPE_KEY_REGEX, key)).toHaveLength(1);
  });

  it('rejects wrong prefix', () => {
    expect(testRegex(STRIPE_KEY_REGEX, `pk_live_${'a'.repeat(24)}`)).toEqual([]);
  });
});

describe('GENERIC_SK_KEY_REGEX', () => {
  it('matches sk- followed by 10+ chars', () => {
    expect(testRegex(GENERIC_SK_KEY_REGEX, 'sk-abcdefghij')).toHaveLength(1);
  });

  it('rejects sk- with fewer than 10 chars', () => {
    expect(testRegex(GENERIC_SK_KEY_REGEX, 'sk-short')).toEqual([]);
  });
});

describe('PHONE_REGEX', () => {
  it.each([
    ['international', '+1 555 123 4567'],
    ['parenthesized area code', '(212) 555-1234'],
    ['plain US format', '555-123-4567'],
    ['dotted format', '555.123.4567']
  ])('matches %s: %s', (_label, phone) => {
    expect(testRegex(PHONE_REGEX, phone).length).toBeGreaterThanOrEqual(1);
  });

  it('completes adversarial input in under 50 ms (ReDoS safety)', () => {
    const adversarial = '+1' + '(.'.repeat(50) + '9'.repeat(20);
    const start = performance.now();
    testRegex(PHONE_REGEX, adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('IPV4_REGEX', () => {
  it.each(['192.168.1.1', '10.0.0.1', '255.255.255.0'])(
    'matches %s',
    (ip) => {
      expect(testRegex(IPV4_REGEX, ip)).toEqual([ip]);
    }
  );

  it('rejects incomplete address', () => {
    expect(testRegex(IPV4_REGEX, '192.168.1')).toEqual([]);
  });
});

describe('SENSITIVE_KEY_EXACT_MATCHES', () => {
  it.each([
    'password',
    'secret',
    'token',
    'key',
    'auth',
    'credential',
    'ssn',
    'cvv',
    'cvc',
    'phone',
    'session',
    'cookie',
    'oauth',
    'private'
  ])('contains "%s"', (key) => {
    expect(SENSITIVE_KEY_EXACT_MATCHES.has(key)).toBe(true);
  });

  it('does not contain arbitrary keys', () => {
    expect(SENSITIVE_KEY_EXACT_MATCHES.has('username')).toBe(false);
  });
});

describe('SENSITIVE_KEY_REGEX', () => {
  it.each([
    'password',
    'secret',
    'token',
    'auth',
    'credential',
    'ssn',
    'cvv',
    'cvc',
    'expir',
    'phone',
    'session',
    'cookie',
    'oauth',
    'private'
  ])('matches single-word key "%s"', (key) => {
    expect(SENSITIVE_KEY_REGEX.test(key)).toBe(true);
  });

  it.each([
    'social_security_number',
    'credit_card',
    'card_number'
  ])('matches multi-word key "%s"', (key) => {
    expect(SENSITIVE_KEY_REGEX.test(key)).toBe(true);
  });

  it('rejects non-sensitive key', () => {
    expect(SENSITIVE_KEY_REGEX.test('username')).toBe(false);
  });
});
