
import type { ServerResponse } from 'node:http';

import type { ResolvedConfig } from '../types';

function matchesRegex(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    let joined = '';

    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }

      joined = joined === '' ? entry : `${joined}, ${entry}`;
    }

    return joined;
  }

  return null;
}

export class HeaderFilter {
  private readonly effectiveAllowlist: Set<string>;

  public constructor(config: ResolvedConfig) {
    this.effectiveAllowlist = new Set(
      config.headerAllowlist
        .map((header) => header.toLowerCase())
        .filter(
          (header) =>
            !config.headerBlocklist.some((pattern) => matchesRegex(pattern, header))
        )
    );
  }

  public filterHeaders(headers: Record<string, unknown>): Record<string, string> {
    return this.filterAndNormalizeHeaders(headers);
  }

  public filterResponseHeaders(response: ServerResponse): Record<string, string> {
    const filtered: Record<string, string> = {};

    try {
      if (
        typeof response.getHeaderNames === 'function' &&
        typeof response.getHeader === 'function'
      ) {
        for (const headerName of response.getHeaderNames()) {
          if (!this.effectiveAllowlist.has(headerName)) {
            continue;
          }

          this.appendFilteredHeader(filtered, headerName, response.getHeader(headerName));
        }

        return filtered;
      }

      if (typeof response.getHeaders === 'function') {
        return this.filterHeaders(response.getHeaders() as Record<string, unknown>);
      }
    } catch {
      return filtered;
    }

    return filtered;
  }

  public filterAndNormalizeHeaders(headers: unknown): Record<string, string> {
    const filtered: Record<string, string> = {};

    try {
      this.appendFilteredHeaders(filtered, headers);
    } catch {
      return filtered;
    }

    return filtered;
  }

  private appendFilteredHeaders(
    filtered: Record<string, string>,
    headers: unknown
  ): void {
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
          this.appendFilteredHeader(filtered, entry[0], entry[1]);
        }
      }

      return;
    }

    if (headers instanceof Map) {
      for (const [key, value] of headers.entries()) {
        if (typeof key === 'string') {
          this.appendFilteredHeader(filtered, key, value);
        }
      }

      return;
    }

    if (typeof headers !== 'object' || headers === null) {
      return;
    }

    const headerRecord = headers as Record<string, unknown>;

    for (const headerName in headerRecord) {
      this.appendFilteredHeader(filtered, headerName, headerRecord[headerName]);
    }
  }

  private appendFilteredHeader(
    filtered: Record<string, string>,
    headerName: string,
    headerValue: unknown
  ): void {
    const normalizedName = headerName.toLowerCase();
    const normalizedValue = normalizeHeaderValue(headerValue);

    if (normalizedValue === null || !this.effectiveAllowlist.has(normalizedName)) {
      return;
    }

    filtered[normalizedName] = normalizedValue;
  }
}
