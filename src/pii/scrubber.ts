
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

    if (!isTextualContentType(contentType)) {
      return buffer;
    }

    const encoding = detectBodyEncoding(contentType);
    const decoded = buffer.toString(encoding);
    const scrubbed = this.scrubString(decoded);

    if (scrubbed === decoded) {
      return buffer;
    }

    return Buffer.from(scrubbed, encoding);
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
    scrubbed = replacePattern(scrubbed, IPV4_REGEX);

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
