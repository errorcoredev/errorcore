
import { theme } from './theme';

const DASH = '\u2500'; // ─
const LINE_WIDTH = 76;

export function sectionHeader(label: string): string {
  const prefix = '  ' + DASH + DASH + ' ';
  const suffix = ' ';
  const contentLength = prefix.length + label.length + suffix.length;
  const remaining = Math.max(0, LINE_WIDTH - contentLength);
  const trail = DASH.repeat(remaining);
  return theme.sectionLabel(prefix + label + suffix + trail);
}

export function grid(rows: Array<[string, string]>, indent: number = 4): string {
  if (rows.length === 0) return '';

  let maxLabelWidth = 0;
  for (const [label] of rows) {
    if (label.length > maxLabelWidth) maxLabelWidth = label.length;
  }

  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [label, value] of rows) {
    const paddedLabel = label.padEnd(maxLabelWidth + 2);
    lines.push(pad + theme.label(paddedLabel) + theme.value(value));
  }
  return lines.join('\n');
}

export function indentBlock(text: string, indent: number = 4): string {
  const pad = ' '.repeat(indent);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}
