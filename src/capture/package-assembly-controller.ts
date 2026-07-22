import { PackageAssemblyDispatcher } from './package-assembly-dispatcher';
import type { ErrorCapturer } from './error-capturer';
import type {
  ModeState,
  PackageAssemblyEncryptionConfig,
  ResolvedConfig
} from '../types';

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

interface ManagedPackageAssemblyDispatcher {
  isAvailable(): boolean;
  updateConfig(config: ResolvedConfig, options?: { timeoutMs?: number }): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

interface PackageAssemblyCapturer {
  setPackageAssemblyDispatcher(dispatcher: PackageAssemblyDispatcher | null): void;
}

export class PackageAssemblyController {
  private dispatcher: ManagedPackageAssemblyDispatcher | null;

  private idleTimer: NodeJS.Timeout | null = null;

  private readonly teardowns = new Set<Promise<void>>();

  private readonly createDispatcher: () => ManagedPackageAssemblyDispatcher;

  public constructor(input: {
    config: ResolvedConfig;
    encryption?: PackageAssemblyEncryptionConfig;
    workerAllowed: boolean;
    errorCapturer: ErrorCapturer | PackageAssemblyCapturer;
    dispatcher: PackageAssemblyDispatcher | null;
    idleShutdownMs?: number;
    dispatcherFactory?: () => ManagedPackageAssemblyDispatcher;
  }) {
    this.config = input.config;
    this.workerAllowed = input.workerAllowed;
    this.errorCapturer = input.errorCapturer;
    this.dispatcher = input.dispatcher;
    this.idleShutdownMs = input.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.createDispatcher = input.dispatcherFactory ?? (() => new PackageAssemblyDispatcher({
      config: this.config,
      ...(input.encryption === undefined ? {} : { encryption: input.encryption })
    }));
  }

  private readonly config: ResolvedConfig;

  private readonly workerAllowed: boolean;

  private readonly errorCapturer: PackageAssemblyCapturer;

  private readonly idleShutdownMs: number;

  public async applyModeState(next: ModeState): Promise<void> {
    if (!next.useWorkerAssembly) {
      this.scheduleIdleShutdown();
      return;
    }

    this.clearIdleTimer();
    if (!this.workerAllowed) {
      this.errorCapturer.setPackageAssemblyDispatcher(null);
      return;
    }

    if (this.dispatcher === null) {
      this.dispatcher = this.createDispatcher();
    }

    this.errorCapturer.setPackageAssemblyDispatcher(
      this.dispatcher as PackageAssemblyDispatcher
    );
    try {
      await this.dispatcher.updateConfig(this.config);
    } catch (error) {
      const failedDispatcher = this.dispatcher;
      this.dispatcher = null;
      this.errorCapturer.setPackageAssemblyDispatcher(null);
      this.trackTeardown(failedDispatcher);
      try {
        this.config.onInternalWarning?.({
          code: 'EC_PACKAGE_ASSEMBLY_WORKER_FAILED',
          message: 'Package assembly worker config refresh failed; using inline package assembly.',
          cause: error,
          context: { stage: 'config_update' }
        });
      } catch {
        // onInternalWarning must never crash the host.
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.clearIdleTimer();
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    this.errorCapturer.setPackageAssemblyDispatcher(null);
    if (dispatcher !== null) {
      this.trackTeardown(dispatcher);
    }
    await Promise.all([...this.teardowns]);
  }

  private scheduleIdleShutdown(): void {
    if (this.dispatcher === null || this.idleTimer !== null) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      const dispatcher = this.dispatcher;
      this.idleTimer = null;
      this.dispatcher = null;
      this.errorCapturer.setPackageAssemblyDispatcher(null);
      if (dispatcher !== null) {
        this.trackTeardown(dispatcher);
      }
    }, this.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private trackTeardown(dispatcher: ManagedPackageAssemblyDispatcher): void {
    const teardown = dispatcher
      .shutdown({ timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS })
      .catch(() => undefined);
    this.teardowns.add(teardown);
    void teardown.finally(() => this.teardowns.delete(teardown));
  }
}
