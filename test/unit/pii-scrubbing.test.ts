import { homedir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeaderFilter } from '../../src/pii/header-filter';
import { looksLikeHighEntropySecret, redactSensitiveQueryText, Scrubber } from '../../src/pii/scrubber';
import { isValidLuhn } from '../../src/pii/patterns';
import { resolveTestConfig as resolveConfig } from '../helpers/test-config';

function createDepthFixture(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { value: 'leaf' };

  for (let index = 0; index < depth; index += 1) {
    current = { child: current };
  }

  return current;
}

function referenceShannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

describe('Scrubber', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts all documented sensitive keys', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    for (const key of [
      'password',
      'apiKey',
      'secret_token',
      'auth',
      'credential',
      'cvv',
      'expiry_date'
    ]) {
      expect(scrubber.scrubValue(key, 'visible')).toBe('[REDACTED]');
    }
  });

  it('redacts emails in string values', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubValue('message', 'Contact john@example.com today')).toBe(
      'Contact [REDACTED] today'
    );
  });

  it('redacts only Luhn-valid credit card numbers', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(isValidLuhn('4111111111111111')).toBe(true);
    expect(isValidLuhn('4111111111111112')).toBe(false);
    expect(
      scrubber.scrubValue('message', 'Card 4111111111111111 was charged')
    ).toBe('Card [REDACTED] was charged');
    expect(
      scrubber.scrubValue('message', 'Card 4111111111111112 was charged')
    ).toBe('Card 4111111111111112 was charged');
  });

  it('redacts SSNs, JWTs, and bearer tokens', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubValue('message', 'SSN 123-45-6789')).toBe(
      'SSN [REDACTED]'
    );
    expect(
      scrubber.scrubValue(
        'message',
        'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
      )
    ).toBe('JWT [REDACTED]');
    expect(scrubber.scrubValue('authHeader', 'Bearer abc.def/ghi+123=')).toBe(
      '[REDACTED]'
    );
  });

  it.each([
    ['clean strings', 'Nothing to redact here', 'Nothing to redact here'],
    ['email addresses', 'Contact john@example.com today', 'Contact [REDACTED] today'],
    ['SSNs', 'SSN 123-45-6789', 'SSN [REDACTED]'],
    [
      'JWTs',
      'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
      'JWT [REDACTED]'
    ],
    ['Bearer tokens', 'Bearer abc.def/ghi+123=', '[REDACTED]='],
    ['Basic auth headers', 'Basic dXNlcjpwYXNz', '[REDACTED]'],
    [
      'AWS access keys',
      'Key AKIAIOSFODNN7EXAMPLE is active',
      'Key [REDACTED] is active'
    ],
    [
      'GitHub tokens',
      'Use ghp_abcdefghijklmnopqrstuvwxyz1234567890 for auth',
      'Use [REDACTED] for auth'
    ],
    [
      'Stripe keys',
      'Charge sk_live_abcdefghijklmnopqrstuvwxyz123456',
      'Charge [REDACTED]'
    ],
    ['generic sk keys', 'Token sk-abcdefghijklmno', 'Token [REDACTED]'],
    ['phone numbers', 'Call +1 (555) 123-4567 now', 'Call [REDACTED] now'],
    ['IPv4 addresses', 'Connect to 192.168.1.1', 'Connect to [REDACTED]'],
    [
      'valid credit cards',
      'Card 4111111111111111 was charged',
      'Card [REDACTED] was charged'
    ],
    [
      'invalid credit cards',
      'Card 4111111111111112 was charged',
      'Card 4111111111111112 was charged'
    ],
    [
      'high-entropy strings',
      'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/_=',
      '[REDACTED]'
    ]
  ])('preserves documented string scrubbing output for %s', (_label, input, expected) => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubValue('message', input)).toBe(expected);
  });

  it('recursively scrubs nested objects', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(
      scrubber.scrubObject({
        profile: {
          email: 'jane@example.com',
          password: 'secret'
        }
      })
    ).toEqual({
      profile: {
        email: '[REDACTED]',
        password: '[REDACTED]'
      }
    });
  });

  it('enforces the scrubber depth limit at level 10', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const output = scrubber.scrubValue('root', createDepthFixture(11)) as {
      child: unknown;
    };

    expect(
      ((((((((((output.child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child
    ).toBe('[DEPTH_LIMIT]');
  });

  it('handles circular references without throwing', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;

    expect(scrubber.scrubValue('root', circular)).toEqual({
      name: 'root',
      self: '[Circular]'
    });
  });

  it('scrubs file paths by replacing the home directory prefix', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const home = homedir();

    expect(scrubber.scrubFilePath(`${home}/app/src/handler.js`)).toBe(
      '/~/app/src/handler.js'
    );
    expect(scrubber.scrubFilePath('/var/app/src/handler.js')).toBe(
      '/var/app/src/handler.js'
    );
  });

  it('returns positional placeholders for database parameters', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubDbParams(['secret', 42, null])).toEqual([
      '[PARAM_1]',
      '[PARAM_2]',
      '[PARAM_3]'
    ]);
  });

  it('fast-paths URL scrubbing when no query string is present', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubUrl('/health')).toBe('/health');
    expect(scrubber.scrubUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('scrubs relative query strings without URL parsing and preserves fragments', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubUrl('/login?email=john@example.com&next=/home#done')).toBe(
      '/login?email=%5BREDACTED%5D&next=/home#done'
    );
  });

  it('scrubs environment variables using allowlist and blocklist precedence', () => {
    const scrubber = new Scrubber(
      resolveConfig({
        envAllowlist: ['NODE_ENV', 'API_KEY', 'PUBLIC_EMAIL'],
        envBlocklist: [/KEY/i]
      })
    );

    expect(
      scrubber.scrubEnv({
        NODE_ENV: 'production',
        API_KEY: 'super-secret',
        PUBLIC_EMAIL: 'ops@example.com',
        EXTRA: 'ignored'
      })
    ).toEqual({
      NODE_ENV: 'production',
      PUBLIC_EMAIL: '[REDACTED]'
    });
  });

  it('integrates a custom scrubber after the default scrubber', () => {
    const scrubber = new Scrubber(
      resolveConfig({
        piiScrubber: (_key, value) =>
          typeof value === 'string' ? `${value}::custom` : value
      })
    );

    expect(scrubber.scrubValue('email', 'john@example.com')).toBe(
      '[REDACTED]::custom'
    );
  });

  it('keeps built-in scrubbing active even when replaceDefaultScrubber is requested', () => {
    const additive = new Scrubber(
      resolveConfig({
        piiScrubber: (_key, value) =>
          typeof value === 'string' ? `${value}::custom` : value,
        replaceDefaultScrubber: true
      })
    );
    const throwing = new Scrubber(
      resolveConfig({
        piiScrubber: () => {
          throw new Error('boom');
        },
        replaceDefaultScrubber: true
      })
    );

    expect(additive.scrubValue('email', 'john@example.com')).toBe('[REDACTED]::custom');
    expect(throwing.scrubValue('email', 'john@example.com')).toBe('[REDACTED]');
  });

  it('never returns raw multipart body bytes', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(
      scrubber.scrubBodyBuffer(Buffer.from('raw multipart secret'), {
        'content-type': 'multipart/form-data; boundary=abc123'
      }).toString('utf8')
    ).toBe('[MULTIPART BODY OMITTED]');
  });

  it('does not mutate the input object passed to scrubObject', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const input = {
      profile: {
        email: 'jane@example.com',
        password: 'secret'
      }
    };
    const snapshot = JSON.stringify(input);

    scrubber.scrubObject(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.each([
    ['repeated ASCII', 'AAAAAAAAAAAAAAAAAAAAAAAA', false],
    ['hex-like repetition', 'ABABABABABABABABABABABAB', false],
    ['random-looking base64', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/_=', true],
    ['mixed token alphabet', 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=', true]
  ])('matches the reference entropy classifier for %s', (_label, input, expected) => {
    expect(referenceShannonEntropy(input) >= 4.2).toBe(expected);
    expect(looksLikeHighEntropySecret(input)).toBe(expected);
  });
});

describe('HeaderFilter', () => {
  it('filters allowed headers, removes blocked headers, and lets blocklist win', () => {
    const filter = new HeaderFilter(
      resolveConfig({
        headerAllowlist: ['x-request-id', 'authorization', 'user-agent']
      })
    );

    expect(
      filter.filterHeaders({
        'X-Request-ID': 'req-1',
        Authorization: 'Bearer secret',
        'User-Agent': 'curl/8.0',
        Host: 'localhost'
      })
    ).toEqual({
      'x-request-id': 'req-1',
      'user-agent': 'curl/8.0'
    });
  });

  it('normalizes and filters tuple and map header inputs in one pass', () => {
    const filter = new HeaderFilter(
      resolveConfig({
        headerAllowlist: ['content-type', 'content-length', 'x-request-id']
      })
    );

    expect(
      filter.filterAndNormalizeHeaders([
        ['Content-Type', 'application/json'],
        ['Content-Length', 128],
        ['Authorization', 'Bearer secret'],
        ['X-Request-ID', ['req-1', 'req-2']]
      ])
    ).toEqual({
      'content-type': 'application/json',
      'content-length': '128',
      'x-request-id': 'req-1, req-2'
    });

    expect(
      filter.filterAndNormalizeHeaders(
        new Map<string, unknown>([
          ['Content-Type', 'application/xml'],
          ['Authorization', 'Bearer secret'],
          ['X-Request-ID', 'req-map']
        ])
      )
    ).toEqual({
      'content-type': 'application/xml',
      'x-request-id': 'req-map'
    });
  });

  it('filters response headers through getHeaderNames and getHeader without copying all headers', () => {
    const filter = new HeaderFilter(
      resolveConfig({
        headerAllowlist: ['content-type', 'x-request-id', 'authorization']
      })
    );
    const response = {
      getHeaderNames: () => ['content-type', 'authorization', 'x-request-id'],
      getHeader: (name: string) =>
        ({
          'content-type': 'application/json',
          authorization: 'Bearer secret',
          'x-request-id': 'req-1'
        })[name]
    } as const;

    expect(filter.filterResponseHeaders(response as never)).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1'
    });
  });
});

describe('redactSensitiveQueryText', () => {

  it.each([
    ['SELECT * FROM users', 'SELECT * FROM users'],
    ['INSERT INTO logs VALUES ($1, $2)', 'INSERT INTO logs VALUES ($1, $2)'],
    ['UPDATE users SET name = $1', 'UPDATE users SET name = $1'],
    ['DELETE FROM sessions WHERE expired = true', 'DELETE FROM sessions WHERE expired = true'],
    ['CREATE TABLE users (id SERIAL)', 'CREATE TABLE users (id SERIAL)'],
    ['ALTER TABLE users ADD COLUMN email TEXT', 'ALTER TABLE users ADD COLUMN email TEXT'],
    ['DROP TABLE temp_data', 'DROP TABLE temp_data'],
    ['CREATE INDEX idx_name ON users (name)', 'CREATE INDEX idx_name ON users (name)'],
    ['', ''],
  ])('passes through safe query: %s', (input, expected) => {
    expect(redactSensitiveQueryText(input)).toBe(expected);
  });

  it.each([
    ["ALTER USER admin WITH PASSWORD 'secret123'", '[REDACTED: ALTER USER/ROLE statement]'],
    ["CREATE USER 'newuser' IDENTIFIED BY 'pass'", '[REDACTED: CREATE USER/ROLE statement]'],
    ["ALTER ROLE myuser WITH PASSWORD 'secret'", '[REDACTED: ALTER USER/ROLE statement]'],
    ["CREATE ROLE dba WITH LOGIN PASSWORD 'x'", '[REDACTED: CREATE USER/ROLE statement]'],
    ['DROP USER olduser', '[REDACTED: DROP USER/ROLE statement]'],
    ['DROP ROLE testrole', '[REDACTED: DROP USER/ROLE statement]'],
    ["SET PASSWORD = 'newsecret'", '[REDACTED: SET PASSWORD statement]'],
    ['SET SESSION AUTHORIZATION admin', '[REDACTED: SET SESSION AUTHORIZATION statement]'],
    ['GRANT SELECT ON users TO readonly', '[REDACTED: GRANT statement]'],
    ['REVOKE ALL ON users FROM public', '[REDACTED: REVOKE statement]'],
  ])('redacts sensitive query: %s', (input, expected) => {
    expect(redactSensitiveQueryText(input)).toBe(expected);
  });

  it('redacts with leading whitespace', () => {
    expect(redactSensitiveQueryText("  ALTER USER admin PASSWORD 'x'"))
      .toBe('[REDACTED: ALTER USER/ROLE statement]');
  });

  it('redacts with leading SQL block comment', () => {
    expect(redactSensitiveQueryText("/* prisma */ CREATE USER test IDENTIFIED BY 'y'"))
      .toBe('[REDACTED: CREATE USER/ROLE statement]');
  });

  it('redacts with leading SQL line comment', () => {
    expect(redactSensitiveQueryText("-- comment\nGRANT ALL ON schema TO admin"))
      .toBe('[REDACTED: GRANT statement]');
  });

  it('does not redact GRANT-like strings that appear mid-query', () => {
    expect(redactSensitiveQueryText("SELECT * FROM users WHERE role = 'GRANT_ADMIN'"))
      .toBe("SELECT * FROM users WHERE role = 'GRANT_ADMIN'");
  });
});
