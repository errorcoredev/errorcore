
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

  private codeVersion: { gitSha?: string; packageVersion?: string; functionVersion?: string; functionArn?: string } = {};

  private codeVersionResolved = false;

  private serverlessMeta: { functionName: string; functionVersion: string; invokedFunctionArn: string; lambdaRequestId: string } | null = null;

  private environment: Record<string, string> = {};

  private eventLoopLagMs = 0;

  private lagTimer: NodeJS.Timeout | null = null;

  private lagStopped = false;

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
      // Resolve package version eagerly at init so that readPackageVersion()
      // (which does synchronous directory walk-up) never runs on the error
      // capture hot path.
      packageVersion: process.env.npm_package_version || this.readPackageVersion() || undefined
    };
    this.codeVersionResolved = true;
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
    this.lagStopped = false;

    // setInterval instead of recursive setTimeout. Under a stalled event
    // loop, the recursive form queued new setTimeout callbacks inside a
    // callback that was itself delayed, amplifying the backlog exactly
    // when the measurement was least useful. setInterval lets Node
    // coalesce missed ticks into a single callback. unref() keeps the
    // timer from holding the process alive.
    let scheduledAt = Date.now();
    this.lagTimer = setInterval(() => {
      if (this.lagStopped) return;
      const now = Date.now();
      this.eventLoopLagMs = Math.max(
        0,
        now - scheduledAt - ProcessMetadata.LAG_SAMPLE_INTERVAL_MS
      );
      scheduledAt = now;
    }, ProcessMetadata.LAG_SAMPLE_INTERVAL_MS);
    this.lagTimer.unref();
  }

  public getTimeAnchor(): TimeAnchor {
    return { ...this.timeAnchor };
  }

  public getCodeVersion(): { gitSha?: string; packageVersion?: string; functionVersion?: string; functionArn?: string } {
    return { ...this.codeVersion };
  }

  public setServerlessMetadata(meta: {
    functionName: string;
    functionVersion: string;
    invokedFunctionArn: string;
    lambdaRequestId: string;
  }): void {
    this.serverlessMeta = meta;
    this.codeVersion = {
      ...this.codeVersion,
      functionVersion: meta.functionVersion,
      functionArn: meta.invokedFunctionArn
    };
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
    // lagStopped guards against a lag callback that Node has already
    // queued for this microtask; shutdown sets the flag, and the
    // callback returns without writing state.
    this.lagStopped = true;
    if (this.lagTimer !== null) {
      clearInterval(this.lagTimer);
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

    if (this.config.serverless) {
      return undefined;
    }

    if (process.platform !== 'linux') {
      return undefined;
    }

    // Cap the read. /proc/self/cgroup and /proc/self/mountinfo are
    // normally a few kB each. In pathological container configurations
    // these files can be multi-megabyte. Container-id detection is a
    // best-effort observability feature, not worth blocking the SDK
    // init on a large-file read.
    const readCappedProcFile = (filePath: string, capBytes: number): string | null => {
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(capBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, capBytes, 0);
        return buffer.slice(0, bytesRead).toString('utf8');
      } catch {
        return null;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* already closed */ }
        }
      }
    };

    const CONTAINER_ID_READ_CAP = 65536;
    const cgroup = readCappedProcFile('/proc/self/cgroup', CONTAINER_ID_READ_CAP);
    if (cgroup !== null) {
      for (const line of cgroup.split('\n')) {
        const match = /[0-9a-f]{64}/.exec(line);
        if (match !== null) {
          return match[0];
        }
      }
    }

    const mountinfo = readCappedProcFile('/proc/self/mountinfo', CONTAINER_ID_READ_CAP);
    if (mountinfo !== null) {
      for (const line of mountinfo.split('\n')) {
        const match = /[0-9a-f]{64}/.exec(line);
        if (match !== null) {
          return match[0];
        }
      }
    }

    return undefined;
  }

  private readGitHead(): string | undefined {
    if (this.config.serverless) {
      return undefined;
    }

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

  private readPackageVersion(): string | undefined {
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // package.json not found or not parseable at cwd
    }

    try {
      let dir = __dirname;
      for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, 'package.json');
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
          if (typeof pkg.version === 'string') {
            return pkg.version;
          }
        } catch {
          // Not found at this level, try parent
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // Walk failed
    }

    return undefined;
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
