
import type { ErrorPackage } from '../../../types';
import { theme } from '../theme';
import { sectionHeader } from '../box';
import { parseStack } from '../stack-parser';

export function renderOrigin(pkg: ErrorPackage): string | null {
  const parsed = parseStack(pkg.error.stack);
  if (parsed.origin === null) return null;

  const { filePath, lineNumber, functionName } = parsed.origin;
  const location = theme.filePath(filePath) + theme.dim(':') + theme.lineNumber(String(lineNumber));
  const fn = theme.functionName(functionName);

  return sectionHeader('Origin') + '\n' + '    ' + location + theme.dim(' in ') + fn;
}
