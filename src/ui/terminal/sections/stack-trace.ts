
import type { ErrorPackage } from '../../../types';
import { theme } from '../theme';
import { sectionHeader } from '../box';
import { parseStack, collapseNodeModulesFrames } from '../stack-parser';

export function renderStackTrace(pkg: ErrorPackage): string {
  const parsed = parseStack(pkg.error.stack);
  const collapsed = collapseNodeModulesFrames(parsed.frames);
  const lines: string[] = [sectionHeader('Stack Trace')];

  for (const entry of collapsed) {
    if ('collapsed' in entry) {
      const noun = entry.collapsed === 1 ? 'frame' : 'frames';
      lines.push('    ' + theme.collapsedFrames(`(${entry.collapsed} node_modules ${noun})`));
    } else {
      const loc = `${entry.filePath}:${entry.lineNumber}:${entry.columnNumber}`;
      if (entry.isNodeModules) {
        lines.push('    ' + theme.vendorFrame(`at ${entry.functionName} (${loc})`));
      } else {
        lines.push('    ' + theme.appFrame(`at ${entry.functionName} (${loc})`));
      }
    }
  }

  if (collapsed.length === 0) {
    lines.push('    ' + theme.dim('(no stack frames)'));
  }

  return lines.join('\n');
}
