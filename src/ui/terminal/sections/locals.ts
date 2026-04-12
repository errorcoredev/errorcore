
import type { ErrorPackage, CapturedFrame } from '../../../types';
import { theme } from '../theme';
import { sectionHeader } from '../box';

export function renderLocals(pkg: ErrorPackage): string | null {
  if (pkg.localVariables === undefined || pkg.localVariables.length === 0) return null;

  const lines: string[] = [sectionHeader('Local Variables')];

  for (const frame of pkg.localVariables) {
    lines.push('    ' + theme.dim(frameLabel(frame)));

    const entries = Object.entries(frame.locals);
    if (entries.length === 0) {
      lines.push('      ' + theme.dim('(no variables captured)'));
      continue;
    }

    for (const [key, value] of entries) {
      lines.push('      ' + theme.localKey(key) + theme.dim(': ') + prettyPrint(value, 6, 3));
    }
  }

  return lines.join('\n');
}

function frameLabel(frame: CapturedFrame): string {
  const fn = frame.functionName || '<anonymous>';
  return `${fn} (${frame.filePath}:${frame.lineNumber})`;
}

function prettyPrint(value: unknown, baseIndent: number, maxDepth: number): string {
  return formatValue(value, baseIndent, 0, maxDepth);
}

function formatValue(value: unknown, baseIndent: number, depth: number, maxDepth: number): string {
  if (value === null) return theme.localNull('null');
  if (value === undefined) return theme.localNull('undefined');

  switch (typeof value) {
    case 'string':
      return theme.localString('"' + truncateStr(value, 200) + '"');
    case 'number':
      return theme.localNumber(String(value));
    case 'boolean':
      return theme.localBoolean(String(value));
    case 'bigint':
      return theme.localNumber(String(value) + 'n');
    case 'symbol':
      return theme.dim(String(value));
    case 'function':
      return theme.dim('[Function]');
  }

  if (depth >= maxDepth) {
    if (Array.isArray(value)) return theme.dim(`[Array(${value.length})]`);
    return theme.dim('[Object]');
  }

  if (Array.isArray(value)) {
    return formatArray(value, baseIndent, depth, maxDepth);
  }

  // Handle serialization markers from clone-and-limit
  const obj = value as Record<string, unknown>;
  if (obj._type === 'Map' || obj._type === 'Set') {
    return theme.dim(`[${obj._type as string}(${obj.size as number})]`);
  }
  if (obj._truncated === true) {
    return theme.dim('[truncated]');
  }

  return formatObject(obj, baseIndent, depth, maxDepth);
}

function formatArray(arr: unknown[], baseIndent: number, depth: number, maxDepth: number): string {
  if (arr.length === 0) return theme.dim('[]');

  const showCount = Math.min(arr.length, 5);
  const items: string[] = [];
  for (let i = 0; i < showCount; i++) {
    items.push(formatValue(arr[i], baseIndent + 2, depth + 1, maxDepth));
  }

  const oneLine = '[' + items.join(', ') + (arr.length > 5 ? `, \u2026${arr.length - 5} more` : '') + ']';
  if (oneLine.length <= 80) return theme.localValue(oneLine);

  const pad = ' '.repeat(baseIndent + 2);
  const formattedItems = items.map((item) => pad + item);
  if (arr.length > 5) {
    formattedItems.push(pad + theme.dim(`\u2026${arr.length - 5} more`));
  }
  return '[\n' + formattedItems.join(',\n') + '\n' + ' '.repeat(baseIndent) + ']';
}

function formatObject(obj: Record<string, unknown>, baseIndent: number, depth: number, maxDepth: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return theme.dim('{}');

  const entries: string[] = [];
  const pad = ' '.repeat(baseIndent + 2);

  for (const key of keys) {
    const val = formatValue(obj[key], baseIndent + 2, depth + 1, maxDepth);
    entries.push(pad + theme.localKey(key) + theme.dim(': ') + val);
  }

  return '{\n' + entries.join('\n') + '\n' + ' '.repeat(baseIndent) + '}';
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
