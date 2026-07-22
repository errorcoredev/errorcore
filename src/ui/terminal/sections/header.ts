
import type { ErrorPackage } from '../../../types';
import { theme } from '../theme';
import { formatTimestamp } from '../format';

export function renderHeader(pkg: ErrorPackage): string {
  const typeLine = theme.errorType(pkg.error.type) + theme.dim(': ') + theme.errorMessage(pkg.error.message);
  const timeLine = theme.timestamp(formatTimestamp(pkg.capturedAt));
  return '\n' + typeLine + '\n' + timeLine;
}
