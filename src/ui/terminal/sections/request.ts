
import type { ErrorPackage } from '../../../types';
import { theme, colorForMethod, colorForStatus } from '../theme';
import { sectionHeader } from '../box';

function formatHeaderValue(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    'meta' in value
  ) {
    const field = value as { mode: string; meta?: { type?: string; bytes?: number } };
    const type = field.meta?.type ?? 'unknown';
    const bytes = field.meta?.bytes;
    return bytes === undefined
      ? `[${field.mode} ${type}]`
      : `[${field.mode} ${type}, ${bytes} bytes]`;
  }

  return String(value);
}

export function renderRequest(pkg: ErrorPackage): string | null {
  if (pkg.request === undefined) return null;

  const { method, url } = pkg.request;
  const lines: string[] = [sectionHeader('Request Context')];

  let statusCode: number | null = null;
  for (const ev of pkg.ioTimeline) {
    if (ev.type === 'http-server' && ev.statusCode !== null) {
      statusCode = ev.statusCode;
      break;
    }
  }

  let requestLine = '    ' + colorForMethod(method)(method.toUpperCase()) + ' ' + theme.value(url);
  if (statusCode !== null) {
    requestLine += ' ' + colorForStatus(statusCode)(String(statusCode));
  }
  lines.push(requestLine);

  const headers = pkg.request.headers;
  if (headers !== undefined && Object.keys(headers).length > 0) {
    for (const [key, value] of Object.entries(headers)) {
      lines.push('    ' + theme.dim(`${key}: ${formatHeaderValue(value)}`));
    }
  }

  return lines.join('\n');
}
