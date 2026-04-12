
import type { ErrorPackage } from '../../../types';
import { theme, colorForMethod, colorForStatus } from '../theme';
import { sectionHeader } from '../box';

export function renderRequest(pkg: ErrorPackage): string | null {
  if (pkg.request === undefined) return null;

  const { method, url } = pkg.request;
  const lines: string[] = [sectionHeader('Request Context')];

  // Find a matching IO event to get the status code
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
      lines.push('    ' + theme.dim(`${key}: ${value}`));
    }
  }

  return lines.join('\n');
}
