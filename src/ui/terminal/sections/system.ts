
import type { ErrorPackage } from '../../../types';
import { sectionHeader, grid } from '../box';
import { formatMemory, formatUptime, formatDuration } from '../format';

export function renderSystem(pkg: ErrorPackage): string {
  const meta = pkg.processMetadata;

  const rows: Array<[string, string]> = [
    ['Hostname', meta.hostname],
    ['PID', String(meta.pid)],
    ['RSS', formatMemory(meta.memoryUsage.rss)],
    ['Heap Used', formatMemory(meta.memoryUsage.heapUsed)],
    ['Node', meta.nodeVersion],
    ['Platform', `${meta.platform} ${meta.arch}`],
    ['Event Loop', formatDuration(meta.eventLoopLagMs)],
    ['Uptime', formatUptime(meta.uptime)],
  ];

  return sectionHeader('System Snapshot') + '\n' + grid(rows);
}
