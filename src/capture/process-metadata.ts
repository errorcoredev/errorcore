
import fs = require('node:fs');
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProcessMetadata as ProcessMetadataShape, ResolvedConfig, TimeAnchor } from '../types';

interface StartupMetadata {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  arch: string;
  pid: number;
  hostname: string;
  containerId?: string;
}

interface RuntimeMetadata {
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  activeHandles: number;
  activeRequests: number;
  activeResourceTypes?: Record<string, number>;
  eventLoopLagMs: number;
}

export class ProcessMetadata {
  private static readonly LAG_SAMPLE_INTERVAL_MS = 1000;

  private readonly config: ResolvedConfig;

  private startupMetadata: StartupMetadata | null = null;

  private timeAnchor: TimeAnchor = { wallClockMs: 0, hrtimeNs: '0' };

  private codeVersion: { gitSha?: string; packageVersion?: string } = {};

  private environment: Record<string, string> = {};

  private eventLoopLagMs = 0;

  private lagTimer: NodeJS.Timeout | null = null;

  public constructor(config: ResolvedConfig) {
    this.config = config;
    this.collectStartupMetadata();
  }

  public collectStartupMetadata(): void {
    this.timeAnchor = {
      wallClockMs: Date.now(),
      hrtimeNs: process.hrtime.bigint().toString()
    };
    this.startupMetadata = {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      hostname: this.readHostname(),
      containerId: this.readContainerId()
    };
    this.codeVersion = {
      gitSha:
        process.env.GIT_SHA ??
        process.env.COMMIT_SHA ??
        process.env.SOURCE_VERSION ??
        this.readGitHead(),
      packageVersion: process.env.npm_package_version
    };
    this.environment = this.filterEnvironment(process.env as Record<string, string | undefined>);
  }

  public getStartupMetadata(): StartupMetadata {
    if (this.startupMetadata === null) {
      this.collectStartupMetadata();
    }

    return { ...(this.startupMetadata as StartupMetadata) };
  }

  public getRuntimeMetadata(): RuntimeMetadata {
    const memoryUsage = process.memoryUsage();

    return {
      uptime: process.uptime(),
      memoryUsage: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      ...this.getActiveResourceCounts(),
      eventLoopLagMs: this.getEventLoopLag()
    };
  }

  public getEventLoopLag(): number {
    return this.eventLoopLagMs;
  }

  public startEventLoopLagMeasurement(): void {
    if (this.lagTimer !== null) {
      return;
    }

    const schedule = () => {
      const scheduledAt = Date.now();

      this.lagTimer = setTimeout(() => {
        this.eventLoopLagMs = Math.max(
          0,
          Date.now() - scheduledAt - ProcessMetadata.LAG_SAMPLE_INTERVAL_MS
        );
        this.lagTimer = null;
        schedule();
      }, ProcessMetadata.LAG_SAMPLE_INTERVAL_MS);
      this.lagTimer.unref();
    };

    schedule();
  }

  public getTimeAnchor(): TimeAnchor {
    return { ...this.timeAnchor };
  }

  public getCodeVersion(): { gitSha?: string; packageVersion?: string } {
    return { ...this.codeVersion };
  }

  public getEnvironment(): Record<string, string> {
    return { ...this.environment };
  }

  public getMergedMetadata(): ProcessMetadataShape {
    return {
      ...this.getStartupMetadata(),
      ...this.getRuntimeMetadata()
    };
  }

  public shutdown(): void {
    if (this.lagTimer !== null) {
      clearTimeout(this.lagTimer);
      this.lagTimer = null;
    }
  }

  private filterEnvironment(
    env: Record<string, string | undefined>
  ): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const key of this.config.envAllowlist) {
      const value = env[key];
      const blocked = this.config.envBlocklist.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(key);
      });

      if (!blocked && typeof value === 'string') {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  private readHostname(): string {
    try {
      return os.hostname();
    } catch {
      return '';
    }
  }

  private readContainerId(): string | undefined {
    const envHostname = process.env.HOSTNAME;

    if (typeof envHostname === 'string' && /^[0-9a-f]{12,64}$/i.test(envHostname)) {
      return envHostname;
    }

    if (process.platform !== 'linux') {
      return undefined;
    }

    try {
      const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');

      for (const line of cgroup.split('\n')) {
        const match = /[0-9a-f]{64}/.exec(line);

        if (match !== null) {
          return match[0];
        }
      }

      const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');

      for (const line of mountinfo.split('\n')) {
        const match = /[0-9a-f]{64}/.exec(line);

        if (match !== null) {
          return match[0];
        }
      }
    } catch {
      // Not in a container or no access to cgroup/mountinfo
    }

    return undefined;
  }

  private readGitHead(): string | undefined {
    try {
      const gitDir = path.join(process.cwd(), '.git');
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();

      if (!head.startsWith('ref: ')) {
        return head || undefined;
      }

      const refPath = head.slice(5);
      const refValue = fs.readFileSync(path.join(gitDir, refPath), 'utf8').trim();

      return refValue || undefined;
    } catch {
      return undefined;
    }
  }

  private getActiveResourceCounts(): Pick<RuntimeMetadata, 'activeHandles' | 'activeRequests' | 'activeResourceTypes'> {
    const processWithResources = process as typeof process & {
      getActiveResourcesInfo?: () => string[];
    };

    if (typeof processWithResources.getActiveResourcesInfo === 'function') {
      try {
        const resources = processWithResources.getActiveResourcesInfo();
        const typeMap: Record<string, number> = {};

        for (const type of resources) {
          typeMap[type] = (typeMap[type] ?? 0) + 1;
        }

        return {
          activeHandles: resources.length,
          activeRequests: 0,
          activeResourceTypes: typeMap
        };
      } catch {
      }
    }

    return {
      activeHandles: this.getLegacyActiveCount('_getActiveHandles'),
      activeRequests: this.getLegacyActiveCount('_getActiveRequests')
    };
  }

  private getLegacyActiveCount(methodName: '_getActiveHandles' | '_getActiveRequests'): number {
    try {
      const processWithInternals = process as typeof process & {
        _getActiveHandles?: () => unknown[];
        _getActiveRequests?: () => unknown[];
      };
      const method = processWithInternals[methodName];

      if (typeof method !== 'function') {
        return -1;
      }

      return method().length;
    } catch {
      return -1;
    }
  }
}
