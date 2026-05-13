
import type { ErrorPackage } from '../../../types';
import { theme } from '../theme';
import { sectionHeader } from '../box';
import { parseStack } from '../stack-parser';

export function renderOrigin(pkg: ErrorPackage): string | null {
  if (pkg.errorOrigin?.appBoundaryFrame !== undefined) {
    const frame = pkg.errorOrigin.appBoundaryFrame;
    const location =
      theme.filePath(frame.filePath) + theme.dim(':') + theme.lineNumber(String(frame.lineNumber));
    const fn = theme.functionName(frame.functionName);
    const originLine =
      pkg.errorOrigin.origin === 'external' && pkg.errorOrigin.package !== undefined
        ? `    ${theme.dim('external library: ')}${theme.vendorFrame(pkg.errorOrigin.package)}`
        : null;
    const boundaryLine = '    ' + location + theme.dim(' in ') + fn;
    return [sectionHeader('Origin'), originLine, boundaryLine]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  const parsed = parseStack(pkg.error.stack);
  if (parsed.origin === null) return null;

  const { filePath, lineNumber, functionName } = parsed.origin;
  const location = theme.filePath(filePath) + theme.dim(':') + theme.lineNumber(String(lineNumber));
  const fn = theme.functionName(functionName);

  return sectionHeader('Origin') + '\n' + '    ' + location + theme.dim(' in ') + fn;
}
