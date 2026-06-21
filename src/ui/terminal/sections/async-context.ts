import type { ErrorPackage } from '../../../types';
import { theme } from '../theme';
import { sectionHeader } from '../box';

export function renderAsyncContext(pkg: ErrorPackage): string | null {
  const lines: string[] = [sectionHeader('Async Context')];

  if (pkg.request?.id !== undefined) {
    lines.push('    ' + theme.dim('requestId: ') + theme.value(pkg.request.id));
  }

  if (pkg.trace !== undefined) {
    lines.push('    ' + theme.dim('traceId:   ') + theme.value(pkg.trace.traceId));
    lines.push('    ' + theme.dim('spanId:    ') + theme.value(pkg.trace.spanId));
    if (pkg.trace.parentSpanId !== null) {
      lines.push('    ' + theme.dim('parent:    ') + theme.value(pkg.trace.parentSpanId));
    }
    if (pkg.trace.tracestate !== undefined) {
      lines.push('    ' + theme.dim('state:     ') + theme.value(pkg.trace.tracestate));
    }
  }

  if (pkg.completeness.alsContextAvailable) {
    lines.push('    ' + theme.dim('als:       ') + theme.value('available'));
  }

  if (pkg.stateReads.length > 0 || pkg.stateWrites.length > 0) {
    lines.push(
      '    ' +
      theme.dim('state:     ') +
      theme.value(`${pkg.stateReads.length} read(s), ${pkg.stateWrites.length} write(s)`)
    );
  }

  return lines.length === 1 ? null : lines.join('\n');
}
