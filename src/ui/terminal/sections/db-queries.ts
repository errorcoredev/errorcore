
import type { ErrorPackage } from '../../../types';
import { theme, colorForDuration } from '../theme';
import { sectionHeader } from '../box';
import { formatDuration } from '../format';

function formatCapturedValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

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

  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function renderDbQueries(pkg: ErrorPackage): string | null {
  const dbEvents = pkg.ioTimeline.filter((ev) => ev.type === 'db-query');
  if (dbEvents.length === 0) return null;

  const sorted = [...dbEvents].sort((a, b) => {
    if (a.startTime < b.startTime) return -1;
    if (a.startTime > b.startTime) return 1;
    return 0;
  });

  const lines: string[] = [sectionHeader('DB Queries')];

  for (const ev of sorted) {
    const query = formatCapturedValue(ev.dbMeta?.query ?? ev.target);
    const truncated = query.length > 120 ? query.slice(0, 119) + '\u2026' : query;
    const duration = ev.durationMs !== null
      ? colorForDuration(ev.durationMs)(formatDuration(ev.durationMs))
      : theme.dim('?');

    let line = '    ' + duration + '  ' + theme.value(truncated);

    if (ev.dbMeta?.collection) {
      line += theme.dim(` [${formatCapturedValue(ev.dbMeta.collection)}]`);
    }

    if (ev.dbMeta?.rowCount !== undefined && ev.dbMeta.rowCount !== null) {
      line += theme.dim(` (${ev.dbMeta.rowCount} rows)`);
    }

    lines.push(line);
  }

  return lines.join('\n');
}
