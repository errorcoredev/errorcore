
import { homedir } from 'node:os';

import type { ResolvedConfig, SerializationLimits } from '../types';
import { safeConsole } from '../debug-log';
import {
  AWS_ACCESS_KEY_REGEX,
  BASIC_AUTH_REGEX,
  BEARER_REGEX,
  COMBINED_QUICK_TEST_REGEX,
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
} from './patterns';

const REDACTED = '[REDACTED]';
const DEPTH_LIMIT = '[DEPTH_LIMIT]';
const MULTIPART_REDACTED = '[MULTIPART BODY OMITTED]';

function isPrivateOrInfrastructureIp(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 (this network), 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 multicast, 100.64.0.0/10 CGNAT.
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224 && a <= 239) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function replacePattern(value: string, pattern: RegExp): string {
  // .replace() with a /g regex resets lastIndex internally per ECMAScript spec.
  return value.replace(pattern, REDACTED);
}

function replaceCreditCards(value: string): string {
  return value.replace(CREDIT_CARD_REGEX, (match) =>
    isValidLuhn(match) ? REDACTED : match
  );
}

function matchesRegex(pattern: RegExp, value: string): boolean {
  // Reset lastIndex: .test() on a /g regex uses and advances it. Caller must be synchronous.
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchesSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();

  if (SENSITIVE_KEY_EXACT_MATCHES.has(normalizedKey)) {
    return true;
  }

  return matchesRegex(SENSITIVE_KEY_REGEX, normalizedKey);
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[truncated, ${value.length} chars]`;
}

function shannonEntropy(value: string): number {
  const length = value.length;
  if (length === 0) {
    return 0;
  }

  const counts = new Uint32Array(128);
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 128) {
      counts[code] += 1;
    }
  }

  let entropy = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const count = counts[index];
    if (count === 0) {
      continue;
    }

    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

export function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < 24 || value.length > 4096) {
    return false;
  }

  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return false;
  }

  const entropy = shannonEntropy(value);
  return entropy >= 4.2;
}

export function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('x-www-form-urlencoded')
  );
}

export function getBodyEncoding(contentType: string | undefined): BufferEncoding {
  if (!contentType) {
    return 'utf8';
  }
  if (contentType.includes('charset=latin1') || contentType.includes('charset=iso-8859-1')) {
    return 'latin1';
  }
  return 'utf8';
}

function isMultipartContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'multipart/form-data';
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  // application/json, application/vnd.api+json, text/json, etc.
  const head = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return head === 'application/json' || head === 'text/json' || head.endsWith('+json');
}

function isFormUrlEncodedContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

const detectBodyEncoding = getBodyEncoding;

const SENSITIVE_SQL_QUICK_TEST =
  /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*(ALTER\s+(?:USER|ROLE|LOGIN)|CREATE\s+(?:USER|ROLE|LOGIN)|DROP\s+(?:USER|ROLE|LOGIN)|SET\s+PASSWORD|SET\s+SESSION\s+AUTHORIZATION|GRANT\b|REVOKE\b)/i;

const SENSITIVE_SQL_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*ALTER\s+(?:USER|ROLE|LOGIN)/i, 'ALTER USER/ROLE'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*CREATE\s+(?:USER|ROLE|LOGIN)/i, 'CREATE USER/ROLE'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*DROP\s+(?:USER|ROLE|LOGIN)/i, 'DROP USER/ROLE'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*SET\s+PASSWORD/i, 'SET PASSWORD'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*SET\s+SESSION\s+AUTHORIZATION/i, 'SET SESSION AUTHORIZATION'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*GRANT\b/i, 'GRANT'],
  [/^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n]*\n\s*)*REVOKE\b/i, 'REVOKE'],
];

export function redactSensitiveQueryText(query: string): string {
  if (!SENSITIVE_SQL_QUICK_TEST.test(query)) {
    return query;
  }

  for (const [pattern, label] of SENSITIVE_SQL_LABELS) {
    if (pattern.test(query)) {
      return `[REDACTED: ${label} statement]`;
    }
  }

  return query;
}

export class Scrubber {
  private readonly config: ResolvedConfig;

  private readonly homeDirectory: string;

  public constructor(config: ResolvedConfig) {
    this.config = config;
    this.homeDirectory = homedir();
  }

  public scrubObject(obj: object): object {
    try {
      const scrubbed = this.scrubValue('', obj);
      return typeof scrubbed === 'object' && scrubbed !== null ? (scrubbed as object) : {};
    } catch {
      return {};
    }
  }

  public scrubValue(key: string, value: unknown): unknown {
    try {
      const defaultScrubbed = this.applyDefaultScrubber(key, value);

      if (this.config.piiScrubber === undefined) {
        return defaultScrubbed;
      }

      return this.applyCustomScrubber(key, defaultScrubbed, () => defaultScrubbed);
    } catch {
      return REDACTED;
    }
  }

  public scrubDbParams(params: unknown[]): string[] {
    try {
      return params.map((_, index) => `[PARAM_${index + 1}]`);
    } catch {
      return [];
    }
  }

  public scrubFilePath(path: string): string {
    try {
      const isExactMatch = path === this.homeDirectory;
      const hasPathPrefix =
        path.startsWith(`${this.homeDirectory}/`) ||
        path.startsWith(`${this.homeDirectory}\\`);

      if (!isExactMatch && !hasPathPrefix) {
        return path;
      }

      const suffix = path.slice(this.homeDirectory.length).replace(/^[/\\]/, '');
      return suffix.length === 0 ? '/~/' : `/~/${suffix}`;
    } catch {
      return path;
    }
  }

  public scrubEnv(env: Record<string, string>): Record<string, string> {
    const scrubbed: Record<string, string> = {};

    try {
      for (const [key, value] of Object.entries(env)) {
        const allowed = this.config.envAllowlist.includes(key);
        const blocked = this.config.envBlocklist.some((pattern) =>
          matchesRegex(pattern, key)
        );

        if (allowed && !blocked) {
          scrubbed[key] = String(this.scrubValue(key, value));
        }
      }
    } catch {
      return scrubbed;
    }

    return scrubbed;
  }

  public scrubUrl(rawUrl: string): string {
    if (rawUrl === '' || !rawUrl.includes('?')) {
      return rawUrl;
    }

    try {
      const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawUrl);
      if (!hasScheme) {
        return this.scrubRelativeUrl(rawUrl);
      }

      const parsed = new URL(rawUrl);

      for (const [key, value] of parsed.searchParams.entries()) {
        parsed.searchParams.set(key, String(this.scrubValue(key, value)));
      }

      return parsed.toString();
    } catch {
      return this.scrubString(rawUrl);
    }
  }

  public scrubBodyBuffer(
    buffer: Buffer,
    headers: Record<string, string> | null | undefined
  ): Buffer {
    const contentType = headers?.['content-type'];
    if (isMultipartContentType(contentType)) {
      return Buffer.from(MULTIPART_REDACTED, 'utf8');
    }

    if (isTextualContentType(contentType)) {
      const encoding = detectBodyEncoding(contentType);
      const decoded = buffer.toString(encoding);

      // application/json: parse, walk via cloneAndScrub for key-aware
      // redaction (catches `cvc: "123"` and other short opaque values that
      // no value-pattern regex would match), re-stringify, then run
      // scrubString as a belt-and-suspenders pass over CC numbers / JWTs
      // that survived in non-sensitive keys. cloneAndScrub honors the
      // configured serialization caps (depth 8, array 20, object 50,
      // string 2048) — PII below those depths is redacted; PII at deeper
      // nesting falls through to the string pass below.
      if (isJsonContentType(contentType)) {
        try {
          const parsed = JSON.parse(decoded);
          const walked = this.applyDefaultScrubber('', parsed);
          const reserialized = JSON.stringify(walked);
          const finalString = this.scrubString(reserialized);
          if (finalString === decoded) {
            return buffer;
          }
          return Buffer.from(finalString, encoding);
        } catch {
          // Parse failed — fall through to plain string scrub below.
        }
      }

      // application/x-www-form-urlencoded: parse keys, redact sensitive
      // values via the same key-aware check used for JSON objects.
      if (isFormUrlEncodedContentType(contentType)) {
        try {
          const params = new URLSearchParams(decoded);
          const out = new URLSearchParams();
          for (const [key, value] of params.entries()) {
            const scrubbedValue = matchesSensitiveKey(key)
              ? REDACTED
              : this.scrubString(value);
            out.append(key, scrubbedValue);
          }
          const reserialized = out.toString();
          if (reserialized === decoded) {
            return buffer;
          }
          return Buffer.from(reserialized, encoding);
        } catch {
          // URLSearchParams.toString edge cases — fall through.
        }
      }

      const scrubbed = this.scrubString(decoded);

      if (scrubbed === decoded) {
        return buffer;
      }

      return Buffer.from(scrubbed, encoding);
    }

    // Non-textual content (octet-stream, image/*, application/pdf, etc.)
    // is mostly binary, but may carry ASCII subsequences containing PII
    // (a credit card number embedded in a multipart-disguised payload, a
    // JWT in a binary protocol's metadata, etc.). The previous "secure
    // by accident" behavior was relying on the byte-sample cap to
    // truncate before reaching such patterns. Now: if the lossy UTF-8
    // decode of the buffer matches a high-confidence PII pattern (CC
    // with Luhn-check, JWT-shape), redact those bytes in place. Other
    // binary content remains untouched.
    const lossyDecoded = buffer.toString('utf8');
    const scrubbed = this.scrubString(lossyDecoded);
    if (scrubbed === lossyDecoded) {
      return buffer;
    }
    return Buffer.from(scrubbed, 'utf8');
  }

  private applyCustomScrubber(
    key: string,
    value: unknown,
    getFallback: () => unknown
  ): unknown {
    try {
      return this.config.piiScrubber?.(key, value) ?? value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeConsole.warn(`[ErrorCore] Custom PII scrubber failed: ${message}`);
      return getFallback();
    }
  }

  private applyDefaultScrubber(key: string, value: unknown): unknown {
    try {
      return this.cloneAndScrub(
        key,
        value,
        0,
        new WeakSet<object>(),
        this.config.serialization
      );
    } catch {
      return REDACTED;
    }
  }

  private cloneAndScrub(
    key: string,
    value: unknown,
    depth: number,
    visited: WeakSet<object>,
    limits: SerializationLimits
  ): unknown {
    if (depth > Math.max(limits.maxDepth, 10)) {
      return DEPTH_LIMIT;
    }

    if (matchesSensitiveKey(key)) {
      return REDACTED;
    }

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return truncateString(this.scrubString(value), limits.maxStringLength);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return {
        _type: 'BigInt',
        value: value.toString()
      };
    }

    if (typeof value === 'symbol') {
      return `[Symbol: ${value.description ?? ''}]`;
    }

    if (typeof value === 'function') {
      return `[Function: ${value.name || 'anonymous'}]`;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof RegExp) {
      return {
        _type: 'RegExp',
        source: value.source,
        flags: value.flags
      };
    }

    if (value instanceof Error) {
      return {
        _type: 'Error',
        name: value.name,
        message: this.scrubString(value.message),
        stack: truncateString(this.scrubString(value.stack ?? ''), limits.maxStringLength)
      };
    }

    if (Buffer.isBuffer(value)) {
      return {
        _type: 'Buffer',
        encoding: 'base64',
        data: truncateString(value.toString('base64'), limits.maxStringLength),
        length: value.length
      };
    }

    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const sample: number[] = [];
      const typedArray = value as unknown as ArrayLike<number>;
      const sampleCount = Math.min(
        typedArray.length ?? limits.maxArrayItems,
        limits.maxArrayItems
      );

      for (let index = 0; index < sampleCount; index += 1) {
        sample.push(Number(typedArray[index]));
      }

      return {
        _type: value.constructor.name,
        length: (value as unknown as ArrayLike<unknown>).length ?? 0,
        sample
      };
    }

    if (value instanceof ArrayBuffer) {
      return {
        _type: 'ArrayBuffer',
        byteLength: value.byteLength
      };
    }

    if (Array.isArray(value)) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);
      try {
        const itemCount = Math.min(value.length, limits.maxArrayItems);
        const items = new Array<unknown>(itemCount);

        for (let index = 0; index < itemCount; index += 1) {
          items[index] = this.cloneAndScrub(
            String(index),
            value[index],
            depth + 1,
            visited,
            limits
          );
        }

        if (value.length <= limits.maxArrayItems) {
          return items;
        }

        return {
          _items: items,
          _truncated: true,
          _originalLength: value.length
        };
      } finally {
        visited.delete(value);
      }
    }

    if (value instanceof Map) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);
      try {
        const entries: Array<[unknown, unknown]> = [];
        let index = 0;

        for (const [entryKey, entryValue] of value.entries()) {
          if (index >= limits.maxArrayItems) {
            break;
          }

          entries.push([
            this.cloneAndScrub(String(index), entryKey, depth + 1, visited, limits),
            this.cloneAndScrub(String(index), entryValue, depth + 1, visited, limits)
          ]);
          index += 1;
        }

        return {
          _type: 'Map',
          size: value.size,
          entries
        };
      } finally {
        visited.delete(value);
      }
    }

    if (value instanceof Set) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);
      try {
        const values: unknown[] = [];
        let index = 0;

        for (const entryValue of value.values()) {
          if (index >= limits.maxArrayItems) {
            break;
          }

          values.push(
            this.cloneAndScrub(String(index), entryValue, depth + 1, visited, limits)
          );
          index += 1;
        }

        return {
          _type: 'Set',
          size: value.size,
          values
        };
      } finally {
        visited.delete(value);
      }
    }

    if (typeof value === 'object') {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);
      try {
        const scrubbed: Record<string, unknown> = {};
        const keys = Object.keys(value as Record<string, unknown>);
        const keyCount = Math.min(keys.length, limits.maxObjectKeys);

        for (let index = 0; index < keyCount; index += 1) {
          const objectKey = keys[index] as string;
          scrubbed[objectKey] = this.cloneAndScrub(
            objectKey,
            (value as Record<string, unknown>)[objectKey],
            depth + 1,
            visited,
            limits
          );
        }

        if (keys.length > limits.maxObjectKeys) {
          scrubbed._truncated = true;
          scrubbed._originalKeyCount = keys.length;
        }

        return scrubbed;
      } finally {
        visited.delete(value);
      }
    }

    return null;
  }

  private scrubString(value: string): string {
    // Reset lastIndex before .test() on the global COMBINED_QUICK_TEST_REGEX.
    // This function is synchronous end-to-end — do not introduce await between here and the .test() below.
    COMBINED_QUICK_TEST_REGEX.lastIndex = 0;
    if (!COMBINED_QUICK_TEST_REGEX.test(value)) {
      return looksLikeHighEntropySecret(value) ? REDACTED : value;
    }

    let scrubbed = value;

    scrubbed = replacePattern(scrubbed, EMAIL_REGEX);
    scrubbed = replaceCreditCards(scrubbed);
    scrubbed = replacePattern(scrubbed, SSN_REGEX);
    scrubbed = replacePattern(scrubbed, JWT_REGEX);
    scrubbed = replacePattern(scrubbed, BEARER_REGEX);
    scrubbed = replacePattern(scrubbed, BASIC_AUTH_REGEX);
    scrubbed = replacePattern(scrubbed, AWS_ACCESS_KEY_REGEX);
    scrubbed = replacePattern(scrubbed, GITHUB_TOKEN_REGEX);
    scrubbed = replacePattern(scrubbed, STRIPE_KEY_REGEX);
    scrubbed = replacePattern(scrubbed, GENERIC_SK_KEY_REGEX);
    scrubbed = replacePattern(scrubbed, PHONE_REGEX);
    // IPv4 redaction: only scrub public/routable IPs. Loopback, private,
    // link-local, and multicast addresses are infrastructure metadata,
    // not PII; redacting them produces noise like host: "[REDACTED]:3000"
    // (was 127.0.0.1:3000) that buries real signal.
    scrubbed = scrubbed.replace(IPV4_REGEX, (match) =>
      isPrivateOrInfrastructureIp(match) ? match : REDACTED
    );

    if (looksLikeHighEntropySecret(scrubbed)) {
      return REDACTED;
    }

    return scrubbed;
  }

  private scrubRelativeUrl(rawUrl: string): string {
    const hashIndex = rawUrl.indexOf('#');
    const hash = hashIndex === -1 ? '' : rawUrl.slice(hashIndex);
    const beforeHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
    const queryIndex = beforeHash.indexOf('?');

    if (queryIndex === -1) {
      return rawUrl;
    }

    const pathname = beforeHash.slice(0, queryIndex);
    const rawQuery = beforeHash.slice(queryIndex + 1);
    const rawSegments = rawQuery.split('&');
    const scrubbedSegments = new Array<string>(rawSegments.length);
    let changed = false;

    for (let index = 0; index < rawSegments.length; index += 1) {
      const segment = rawSegments[index];

      if (segment === '') {
        scrubbedSegments[index] = segment;
        continue;
      }

      const equalsIndex = segment.indexOf('=');
      const rawKey = equalsIndex === -1 ? segment : segment.slice(0, equalsIndex);
      const rawValue = equalsIndex === -1 ? '' : segment.slice(equalsIndex + 1);
      const key = decodeQueryComponent(rawKey);
      const value = decodeQueryComponent(rawValue);
      const scrubbedValue = String(this.scrubValue(key, value));

      if (scrubbedValue === value) {
        scrubbedSegments[index] = segment;
        continue;
      }

      changed = true;
      scrubbedSegments[index] = `${encodeURIComponent(key)}=${encodeURIComponent(scrubbedValue)}`;
    }

    if (!changed) {
      return rawUrl;
    }

    return `${pathname}?${scrubbedSegments.join('&')}${hash}`;
  }
}
