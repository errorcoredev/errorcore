
export function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

export function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .join(', ');
  }

  return null;
}

export function copyHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> {
  const copied: Record<string, string> = {};

  if (headers === undefined) {
    return copied;
  }

  for (const [key, value] of Object.entries(headers)) {
    const normalized = normalizeHeaderValue(value);

    if (normalized !== null) {
      copied[key] = normalized;
    }
  }

  return copied;
}

export function extractFd(socket: unknown): number | null {
  const maybeFd = (socket as { _handle?: { fd?: unknown } } | undefined)?._handle?.fd;

  return typeof maybeFd === 'number' ? maybeFd : null;
}
