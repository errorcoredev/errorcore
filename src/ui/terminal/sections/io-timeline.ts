
import type { ErrorPackage, IOEventSerialized } from '../../../types';
import { theme, colorForMethod, colorForStatus, colorForDuration } from '../theme';
import { sectionHeader } from '../box';
import { formatTimestamp, formatDuration } from '../format';

export function renderIOTimeline(pkg: ErrorPackage): string | null {
  const events = pkg.ioTimeline.filter((ev) => ev.type !== 'db-query');
  if (events.length === 0) return null;

  const sorted = [...events].sort((a, b) => {
    if (a.startTime < b.startTime) return -1;
    if (a.startTime > b.startTime) return 1;
    return 0;
  });

  const lines: string[] = [sectionHeader('IO Timeline')];

  for (const ev of sorted) {
    lines.push('    ' + formatEventLine(ev));
  }

  return lines.join('\n');
}

function formatEventLine(ev: IOEventSerialized): string {
  const parts: string[] = [];

  parts.push(theme.timestamp(formatTimestamp(ev.startTime)));

  parts.push(theme.ioType(ev.type));

  if (ev.method !== null) {
    parts.push(colorForMethod(ev.method)(ev.method.toUpperCase()));
  }

  const target = ev.url ?? ev.target;
  parts.push(theme.dim(truncate(target, 50)));

  if (ev.statusCode !== null) {
    parts.push(colorForStatus(ev.statusCode)(String(ev.statusCode)));
  }

  if (ev.durationMs !== null) {
    parts.push(colorForDuration(ev.durationMs)(formatDuration(ev.durationMs)));
  }

  if (ev.error !== null) {
    parts.push(theme.errorMessage('ERR'));
  }

  return parts.join(' ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}
