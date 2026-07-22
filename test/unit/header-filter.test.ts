import { describe, expect, it } from 'vitest';

import { HeaderFilter } from '../../src/pii/header-filter';
import { resolveConfig } from '../../src/config';
import type { ResolvedConfig } from '../../src/types';

function createConfig(
  overrides: { headerAllowlist?: string[]; headerBlocklist?: RegExp[] } = {}
): ResolvedConfig {
  return resolveConfig({
    transport: { type: 'stdout' },
    headerAllowlist: overrides.headerAllowlist ?? [
      'content-type',
      'content-length',
      'accept',
      'user-agent',
      'x-request-id',
      'x-correlation-id',
      'host'
    ],
    headerBlocklist: overrides.headerBlocklist ?? [
      /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
      /auth|token|key|secret|password|credential/i
    ]
  });
}

describe('HeaderFilter', () => {
  describe('constructor - effective allowlist', () => {
    it('builds an effective allowlist from config', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterHeaders({
        'content-type': 'application/json',
        'accept': 'text/html'
      });

      expect(result).toEqual({
        'content-type': 'application/json',
        'accept': 'text/html'
      });
    });

    it('removes allowlisted headers that match the blocklist', () => {
      const filter = new HeaderFilter(
        createConfig({
          headerAllowlist: ['content-type', 'authorization', 'x-auth-token'],
          headerBlocklist: [/authorization|x-auth-token/i]
        })
      );

      const result = filter.filterHeaders({
        'content-type': 'text/plain',
        'authorization': 'Bearer abc',
        'x-auth-token': 'tok123'
      });

      expect(result).toEqual({ 'content-type': 'text/plain' });
    });

    it('lowercases allowlist entries for case-insensitive matching', () => {
      const filter = new HeaderFilter(
        createConfig({
          headerAllowlist: ['Content-Type', 'ACCEPT', 'Host'],
          headerBlocklist: []
        })
      );

      const result = filter.filterHeaders({
        'content-type': 'text/html',
        'accept': '*/*',
        'host': 'example.com'
      });

      expect(result).toEqual({
        'content-type': 'text/html',
        'accept': '*/*',
        'host': 'example.com'
      });
    });

    it('applies blocklist regex patterns against lowercased header names', () => {
      const filter = new HeaderFilter(
        createConfig({
          headerAllowlist: ['x-secret-key', 'x-password-hash', 'content-type'],
          headerBlocklist: [/secret|password/i]
        })
      );

      const result = filter.filterHeaders({
        'x-secret-key': 'val1',
        'x-password-hash': 'val2',
        'content-type': 'application/json'
      });

      expect(result).toEqual({ 'content-type': 'application/json' });
    });

    it('handles an empty allowlist', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: [], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({
        'content-type': 'text/html',
        'accept': '*/*'
      });

      expect(result).toEqual({});
    });

    it('handles an empty blocklist', () => {
      const filter = new HeaderFilter(
        createConfig({
          headerAllowlist: ['content-type', 'authorization'],
          headerBlocklist: []
        })
      );

      const result = filter.filterHeaders({
        'content-type': 'text/html',
        'authorization': 'Bearer xyz'
      });

      expect(result).toEqual({
        'content-type': 'text/html',
        'authorization': 'Bearer xyz'
      });
    });

    it('resets regex lastIndex before testing (sticky regex safety)', () => {
      const stickyPattern = /secret/gi;
      stickyPattern.lastIndex = 999;

      const filter = new HeaderFilter(
        createConfig({
          headerAllowlist: ['x-secret-value', 'content-type'],
          headerBlocklist: [stickyPattern]
        })
      );

      const result = filter.filterHeaders({
        'x-secret-value': 'hidden',
        'content-type': 'text/html'
      });

      expect(result).toEqual({ 'content-type': 'text/html' });
    });
  });

  describe('filterHeaders', () => {
    it('returns only headers present in the effective allowlist', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterHeaders({
        'content-type': 'application/json',
        'x-custom-header': 'should-be-dropped',
        'accept': '*/*'
      });

      expect(result).toEqual({
        'content-type': 'application/json',
        'accept': '*/*'
      });
      expect(result).not.toHaveProperty('x-custom-header');
    });

    it('ignores headers not on the allowlist', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterHeaders({
        'x-unknown': 'value',
        'x-another': 'value2'
      });

      expect(result).toEqual({});
    });

    it('matches header names case-insensitively', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterHeaders({
        'Content-Type': 'text/html',
        'ACCEPT': 'application/xml',
        'Host': 'example.com'
      });

      expect(result).toEqual({
        'content-type': 'text/html',
        'accept': 'application/xml',
        'host': 'example.com'
      });
    });

    it('normalizes header names to lowercase in the output', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterHeaders({ 'Content-Type': 'text/plain' });

      expect(Object.keys(result)).toEqual(['content-type']);
    });

    it('returns an empty object for empty input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterHeaders({})).toEqual({});
    });
  });

  describe('filterResponseHeaders', () => {
    it('uses getHeaderNames and getHeader when both are available', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {
        getHeaderNames: () => ['content-type', 'x-request-id', 'x-custom'],
        getHeader: (name: string) => {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-request-id': 'req-123',
            'x-custom': 'dropped'
          };
          return headers[name];
        }
      };

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({
        'content-type': 'application/json',
        'x-request-id': 'req-123'
      });
      expect(result).not.toHaveProperty('x-custom');
    });

    it('falls back to getHeaders when getHeaderNames is missing', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {
        getHeaders: () => ({
          'content-type': 'text/html',
          'host': 'example.com',
          'x-private': 'dropped'
        })
      };

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({
        'content-type': 'text/html',
        'host': 'example.com'
      });
    });

    it('falls back to getHeaders when getHeader is missing', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {
        getHeaderNames: () => ['content-type'],
        getHeaders: () => ({
          'content-type': 'text/html',
          'accept': 'application/json'
        })
      };

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({
        'content-type': 'text/html',
        'accept': 'application/json'
      });
    });

    it('returns empty object when neither method set is available', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {};

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({});
    });

    it('catches exceptions from getHeaderNames and returns partial result', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {
        getHeaderNames: () => { throw new Error('boom'); },
        getHeader: () => 'value'
      };

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({});
    });

    it('catches exceptions from getHeaders and returns empty object', () => {
      const filter = new HeaderFilter(createConfig());

      const mockResponse = {
        getHeaders: () => { throw new Error('boom'); }
      };

      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toEqual({});
    });

    it('catches exceptions from getHeader for individual headers', () => {
      const filter = new HeaderFilter(createConfig());

      let callCount = 0;
      const mockResponse = {
        getHeaderNames: () => ['content-type', 'accept'],
        getHeader: () => {
          callCount += 1;
          if (callCount === 1) return 'application/json';
          throw new Error('header read failed');
        }
      };

      // The whole try/catch wraps the loop, so an exception mid-iteration
      // returns whatever was collected so far.
      const result = filter.filterResponseHeaders(mockResponse as any);

      expect(result).toHaveProperty('content-type', 'application/json');
    });
  });

  describe('filterAndNormalizeHeaders', () => {
    it('handles a plain object', () => {
      const filter = new HeaderFilter(createConfig());

      const result = filter.filterAndNormalizeHeaders({
        'content-type': 'text/plain',
        'host': 'localhost'
      });

      expect(result).toEqual({
        'content-type': 'text/plain',
        'host': 'localhost'
      });
    });

    it('handles a Map', () => {
      const filter = new HeaderFilter(createConfig());

      const headers = new Map<string, string>([
        ['content-type', 'application/json'],
        ['accept', '*/*'],
        ['x-private', 'hidden']
      ]);

      const result = filter.filterAndNormalizeHeaders(headers);

      expect(result).toEqual({
        'content-type': 'application/json',
        'accept': '*/*'
      });
      expect(result).not.toHaveProperty('x-private');
    });

    it('handles an array of tuples', () => {
      const filter = new HeaderFilter(createConfig());

      const headers = [
        ['content-type', 'text/html'],
        ['host', 'example.com'],
        ['x-unknown', 'dropped']
      ];

      const result = filter.filterAndNormalizeHeaders(headers);

      expect(result).toEqual({
        'content-type': 'text/html',
        'host': 'example.com'
      });
    });

    it('skips tuples with non-string first element', () => {
      const filter = new HeaderFilter(createConfig());

      const headers = [
        [123, 'number-key'],
        [null, 'null-key'],
        ['content-type', 'text/plain']
      ];

      const result = filter.filterAndNormalizeHeaders(headers);

      expect(result).toEqual({ 'content-type': 'text/plain' });
    });

    it('skips tuples with fewer than 2 elements', () => {
      const filter = new HeaderFilter(createConfig());

      const headers = [
        ['content-type'],
        ['accept', 'text/html']
      ];

      const result = filter.filterAndNormalizeHeaders(headers);

      expect(result).toEqual({ 'accept': 'text/html' });
    });

    it('handles a Map with non-string keys', () => {
      const filter = new HeaderFilter(createConfig());

      const headers = new Map<unknown, string>([
        [42 as any, 'number-key'],
        ['content-type', 'text/html']
      ]);

      const result = filter.filterAndNormalizeHeaders(headers);

      expect(result).toEqual({ 'content-type': 'text/html' });
    });

    it('returns empty object for null input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterAndNormalizeHeaders(null)).toEqual({});
    });

    it('returns empty object for undefined input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterAndNormalizeHeaders(undefined)).toEqual({});
    });

    it('returns empty object for a primitive string input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterAndNormalizeHeaders('not-headers')).toEqual({});
    });

    it('returns empty object for a number input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterAndNormalizeHeaders(42)).toEqual({});
    });

    it('returns empty object for a boolean input', () => {
      const filter = new HeaderFilter(createConfig());

      expect(filter.filterAndNormalizeHeaders(true)).toEqual({});
    });

    it('catches errors thrown during header iteration and returns empty', () => {
      const filter = new HeaderFilter(createConfig());

      const poisoned = new Proxy({}, {
        ownKeys() { throw new Error('iteration failed'); }
      });

      const result = filter.filterAndNormalizeHeaders(poisoned);

      expect(result).toEqual({});
    });
  });

  describe('G2 — undici flat-array header normalization', () => {
    it('handles flat-array headers (undici native shape)', () => {
      const filter = new HeaderFilter(createConfig());
      const out = filter.filterAndNormalizeHeaders([
        'host', 'api.example.com',
        'user-agent', 'test/1.0',
        'accept', '*/*',
        'authorization', 'Bearer SECRET',  // blocklisted; should NOT appear
      ]);
      expect(out.host).toBe('api.example.com');
      expect(out['user-agent']).toBe('test/1.0');
      expect(out.accept).toBe('*/*');
      expect(out.authorization).toBeUndefined();
    });

    it('handles odd-length flat arrays gracefully (trailing lone key dropped)', () => {
      const filter = new HeaderFilter(createConfig());
      const out = filter.filterAndNormalizeHeaders(['host', 'x.example', 'trailing']);
      expect(out.host).toBe('x.example');
      expect(out.trailing).toBeUndefined();
    });

    it('continues to handle tuple-of-tuples form (backward compat)', () => {
      const filter = new HeaderFilter(createConfig());
      const out = filter.filterAndNormalizeHeaders([
        ['host', 'a.example'],
        ['user-agent', 'test'],
      ]);
      expect(out.host).toBe('a.example');
      expect(out['user-agent']).toBe('test');
    });

    it('treats empty array as empty headers', () => {
      const filter = new HeaderFilter(createConfig());
      expect(filter.filterAndNormalizeHeaders([])).toEqual({});
    });

    it('treats array whose first entry is non-string, non-array as empty (no crash)', () => {
      const filter = new HeaderFilter(createConfig());
      // Degenerate input — neither flat-pairs nor tuple-of-tuples.
      const out = filter.filterAndNormalizeHeaders([42 as unknown, 'x']);
      // We neither crash nor invent bogus keys.
      expect(Object.keys(out).length).toBe(0);
    });
  });

  describe('header value normalization', () => {
    it('passes through string values unchanged', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'x-test': 'hello world' });

      expect(result).toEqual({ 'x-test': 'hello world' });
    });

    it('converts number values to strings', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['content-length'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'content-length': 1024 as any });

      expect(result).toEqual({ 'content-length': '1024' });
    });

    it('converts zero to string', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['content-length'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'content-length': 0 as any });

      expect(result).toEqual({ 'content-length': '0' });
    });

    it('joins string array entries with comma-space', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['accept'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({
        'accept': ['text/html', 'application/json', 'text/plain'] as any
      });

      expect(result).toEqual({ 'accept': 'text/html, application/json, text/plain' });
    });

    it('handles a single-element string array', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['accept'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({
        'accept': ['text/html'] as any
      });

      expect(result).toEqual({ 'accept': 'text/html' });
    });

    it('skips non-string entries in arrays', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({
        'x-test': ['valid', 123, null, 'also-valid'] as any
      });

      expect(result).toEqual({ 'x-test': 'valid, also-valid' });
    });

    it('produces empty string from an array of all non-string entries', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({
        'x-test': [123, null, undefined] as any
      });

      expect(result).toEqual({ 'x-test': '' });
    });

    it('returns null for object values, excluding the header', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'x-test': { nested: true } as any });

      expect(result).toEqual({});
    });

    it('returns null for symbol values, excluding the header', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'x-test': Symbol('sym') as any });

      expect(result).toEqual({});
    });

    it('returns null for boolean values, excluding the header', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'x-test': true as any });

      expect(result).toEqual({});
    });

    it('handles an empty array value', () => {
      const filter = new HeaderFilter(
        createConfig({ headerAllowlist: ['x-test'], headerBlocklist: [] })
      );

      const result = filter.filterHeaders({ 'x-test': [] as any });

      expect(result).toEqual({ 'x-test': '' });
    });
  });

  describe('default blocklist — operational vs auth headers', () => {
    function createDefaultConfig(extraAllowlist: string[] = []): ResolvedConfig {
      return resolveConfig({
        transport: { type: 'stdout' },
        headerAllowlist: [
          'idempotency-key',
          'x-idempotency-key',
          'host',
          'traceparent',
          'content-type',
          'content-length',
          'accept',
          'x-request-id',
          'x-correlation-id',
          ...extraAllowlist
        ]
      });
    }

    it('keeps idempotency-key and x-idempotency-key in the effective allowlist', () => {
      const filter = new HeaderFilter(createDefaultConfig());

      const result = filter.filterHeaders({
        'idempotency-key': 'idem-1',
        'x-idempotency-key': 'idem-2',
        'content-type': 'application/json'
      });

      expect(result).toEqual({
        'idempotency-key': 'idem-1',
        'x-idempotency-key': 'idem-2',
        'content-type': 'application/json'
      });
    });

    it('keeps user-added operational headers without `key`/`token` substring damage', () => {
      const filter = new HeaderFilter(
        createDefaultConfig(['keystone', 'key-stone', 'keep-alive', 'oauth-state', 'x-tracking-key'])
      );

      const result = filter.filterHeaders({
        'keystone': 'monolith',
        'key-stone': 'split-name',
        'keep-alive': 'timeout=5',
        'oauth-state': 'csrf-foo',
        'x-tracking-key': 'analytics-1'
      });

      // `key-stone` is the regression marker. The audit's proposed
      // /\b(...|key|...)\b/i fix would have killed it because `\b` accepts
      // hyphen as a word boundary. The exact-match-then-compound design
      // saves it because `key-stone` doesn't match (api|auth|access|...)-key.
      expect(result).toEqual({
        'keystone': 'monolith',
        'key-stone': 'split-name',
        'keep-alive': 'timeout=5',
        'oauth-state': 'csrf-foo',
        'x-tracking-key': 'analytics-1'
      });
    });

    it("documents why the audit's proposed /\\b...\\b/i regex was rejected", () => {
      // Empirical record. If a future reviewer tries to "simplify" the
      // three-layer regex to /\b(auth|token|key|secret|password|credential)
      // \b/i, this test fails on every line, telling them why before they
      // ship the regression.
      const auditRegex = /\b(auth|token|key|secret|password|credential)\b/i;

      // The audit claimed these survive under the proposed regex; empirically
      // they don't (\bkey\b matches the trailing `key` because `-` is a
      // word boundary).
      expect(auditRegex.test('idempotency-key')).toBe(true);
      expect(auditRegex.test('x-idempotency-key')).toBe(true);
      expect(auditRegex.test('x-tracking-key')).toBe(true);
      expect(auditRegex.test('key-stone')).toBe(true);

      // The audit claimed these are blocked under the proposed regex;
      // empirically they survive — `\bauth\b` doesn't match the start of
      // `authorization` because the trailing `\b` fails before `o`. This
      // is the security regression the v3 plan caught.
      expect(auditRegex.test('authorization')).toBe(false);
      expect(auditRegex.test('cookie')).toBe(false);
    });

    it('still blocks well-known auth/cookie headers', () => {
      const filter = new HeaderFilter(
        createDefaultConfig([
          'authorization',
          'cookie',
          'set-cookie',
          'proxy-authorization',
          'x-api-key',
          'x-auth-token',
          'x-csrf-token',
          'x-secret-token'
        ])
      );

      const result = filter.filterHeaders({
        'authorization': 'Bearer xyz',
        'cookie': 'sid=abc',
        'set-cookie': 'sid=abc',
        'proxy-authorization': 'Basic abc',
        'x-api-key': 'k1',
        'x-auth-token': 't1',
        'x-csrf-token': 'c1',
        'x-secret-token': 's1',
        'content-type': 'application/json'
      });

      expect(result).toEqual({ 'content-type': 'application/json' });
    });

    it('blocks user-added auth-prefix compound headers', () => {
      const filter = new HeaderFilter(
        createDefaultConfig([
          'api-key',
          'auth_token',
          'secret-key',
          'session-secret',
          'private-token',
          'client-secret',
          'refresh-token',
          'bearer-token',
          'access-token'
        ])
      );

      const result = filter.filterHeaders({
        'api-key': 'a',
        'auth_token': 'b',
        'secret-key': 'c',
        'session-secret': 'd',
        'private-token': 'e',
        'client-secret': 'f',
        'refresh-token': 'g',
        'bearer-token': 'h',
        'access-token': 'i',
        'content-type': 'application/json'
      });

      expect(result).toEqual({ 'content-type': 'application/json' });
    });

    it('blocks standalone password/credential nouns including plurals', () => {
      const filter = new HeaderFilter(
        createDefaultConfig(['password', 'passwords', 'passwd', 'credential', 'credentials'])
      );

      const result = filter.filterHeaders({
        'password': 'p1',
        'passwords': 'p2',
        'passwd': 'p3',
        'credential': 'c1',
        'credentials': 'c2',
        'content-type': 'application/json'
      });

      expect(result).toEqual({ 'content-type': 'application/json' });
    });
  });
});
