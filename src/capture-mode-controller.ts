import { resolveCaptureMode, resolveModeState } from './capture-mode';
import type {
  AdaptiveCaptureHealth,
  CaptureMode,
  ModeState,
  ModeSwitchResult,
  ResolvedConfig
} from './types';

export type SDKLifecycleState = 'created' | 'active' | 'shutting_down' | 'shutdown';

/**
 * Runtime resources controlled by a capture-mode transition.
 *
 * The controller deliberately knows nothing about recorder, inspector, spool,
 * or transport implementations. SDKInstance owns those long-lived objects and
 * exposes only the lifecycle operations needed for a serialized transition.
 */
export interface CaptureModeResourceCallbacks {
  getLifecycleState(): SDKLifecycleState;
  setHttpServerRecorderEnabled(enabled: boolean): void;
  updateChannelSubscriptions(recorders: ModeState['recorders']): void;
  setFetchRecorderEnabled(enabled: boolean, modeState: ModeState): void;
  setNetDnsRecorderEnabled(enabled: boolean): void;
  setDatabaseRecordersEnabled(enabled: boolean): void;
  setProcessHandlersEnabled(enabled: boolean): void;
  setEventLoopLagMonitorEnabled(enabled: boolean): void;
  applyResolvedConfig(modeState: ModeState): void;
  applyRuntimeResources(modeState: ModeState): Promise<void> | void;
  applyInspectorModeState(modeState: ModeState): void;
  setLocalVariablesCaptureEnabled(enabled: boolean): void;
  flushBeforeTimerRestart(): Promise<void>;
  restartFlushTimer(): void;
  rearmAfterAdaptiveGuard(): void;
}

const MODE_STATE_TOP_LEVEL_KEYS: Array<keyof ModeState> = [
  'captureMode',
  'localVariablesMode',
  'captureLocalVariables',
  'captureDbBindParams',
  'captureRequestBodies',
  'captureResponseBodies',
  'captureBody',
  'captureBodyDigest',
  'useWorkerAssembly',
  'flushIntervalMs',
  'resolveSourceMaps',
  'maxLocalsCollectionsPerSecond',
  'maxCachedLocals',
  'maxLocalsFrames',
  'maxLocalsObjectProperties'
];

function diffModeStates(previous: ModeState, next: ModeState): string[] {
  const changed: string[] = [];
  for (const key of MODE_STATE_TOP_LEVEL_KEYS) {
    if (previous[key] !== next[key]) {
      changed.push(key);
    }
  }

  for (const key of Object.keys(previous.recorders) as Array<keyof ModeState['recorders']>) {
    if (previous.recorders[key] !== next.recorders[key]) {
      changed.push(`recorders.${key}`);
    }
  }
  for (const key of Object.keys(previous.capabilities) as Array<keyof ModeState['capabilities']>) {
    if (previous.capabilities[key] !== next.capabilities[key]) {
      changed.push(`capabilities.${key}`);
    }
  }
  for (const key of Object.keys(previous.payloadSpool) as Array<keyof ModeState['payloadSpool']>) {
    if (previous.payloadSpool[key] !== next.payloadSpool[key]) {
      changed.push(`payloadSpool.${key}`);
    }
  }
  if (JSON.stringify(previous.localsGuard) !== JSON.stringify(next.localsGuard)) {
    changed.push('localsGuard');
  }

  return changed;
}

function cloneModeState(modeState: ModeState): ModeState {
  return {
    ...modeState,
    capabilities: { ...modeState.capabilities },
    recorders: { ...modeState.recorders },
    localsGuard: { ...modeState.localsGuard },
    payloadSpool: { ...modeState.payloadSpool }
  };
}

export class CaptureModeController {
  private modeState: ModeState;

  private modeSwitchTail: Promise<void> = Promise.resolve();

  private switchCount = 0;

  private adaptiveTimer: NodeJS.Timeout | null = null;

  private adaptivePhase: AdaptiveCaptureHealth['phase'];

  private adaptiveLastEscalationAt: number | null = null;

  private adaptiveLastCaptureAt: number | null = null;

  private adaptiveSwitchTimestamps: number[] = [];

  private adaptiveEscalationGeneration: number | null = null;

  /**
   * Invalidates adaptive work admitted before a newer public mode choice.
   * The transition queue still provides serialization; this generation keeps
   * an older capture-triggered microtask from winning after that manual choice.
   */
  private adaptiveIntentGeneration = 0;

  private adaptiveSwitchRateWarningEmitted = false;

  public constructor(
    private readonly config: ResolvedConfig,
    private readonly resources: CaptureModeResourceCallbacks
  ) {
    this.modeState = config.modeState;
    this.adaptivePhase = config.adaptiveCapture.enabled ? 'base' : 'inactive';
  }

  /** Starts adaptive evaluation after SDK activation. */
  public activate(): void {
    if (!this.config.adaptiveCapture.enabled || this.adaptiveTimer !== null) {
      return;
    }

    this.adaptiveTimer = setInterval(() => {
      void this.evaluateAdaptiveDeescalation();
    }, 1000);
    this.adaptiveTimer.unref();
  }

  /**
   * Closes controller-owned activity and waits for an admitted transition to
   * settle before SDKInstance tears down the resources that transition owns.
   */
  public async shutdown(): Promise<void> {
    if (this.adaptiveTimer !== null) {
      clearInterval(this.adaptiveTimer);
      this.adaptiveTimer = null;
    }

    await this.modeSwitchTail;
  }

  public getModeState(): ModeState {
    return cloneModeState(this.modeState);
  }

  public getCaptureMode(): CaptureMode {
    return this.modeState.captureMode;
  }

  public getAdaptiveHealth(): AdaptiveCaptureHealth {
    return {
      active: this.config.adaptiveCapture.enabled,
      phase: this.adaptivePhase,
      lastEscalationAt: this.adaptiveLastEscalationAt,
      switchCount: this.switchCount
    };
  }

  public handleAdmittedCapture(modeAtCapture: ModeState): void {
    if (!this.config.adaptiveCapture.enabled) {
      return;
    }

    this.adaptiveLastCaptureAt = Date.now();
    if (
      this.adaptivePhase === 'base' &&
      modeAtCapture.captureMode === this.config.adaptiveCapture.base &&
      this.adaptiveEscalationGeneration === null
    ) {
      const generation = this.adaptiveIntentGeneration;
      this.adaptiveEscalationGeneration = generation;
      Promise.resolve().then(() => {
        if (this.adaptiveEscalationGeneration === generation) {
          this.adaptiveEscalationGeneration = null;
        }
        void this.switchAdaptiveMode(this.config.adaptiveCapture.escalated, generation);
      });
    }
  }

  public setCaptureMode(mode: CaptureMode): Promise<ModeSwitchResult> {
    const lifecycleState = this.resources.getLifecycleState();
    if (!this.canSwitchMode(lifecycleState)) {
      return Promise.reject(this.createLifecycleError(lifecycleState));
    }

    const target = resolveCaptureMode(mode);
    if (this.config.adaptiveCapture.enabled) {
      this.adaptiveIntentGeneration += 1;
      this.adaptiveEscalationGeneration = null;
    }

    const run = this.modeSwitchTail.then(() => this.applyManualCaptureMode(target));
    this.modeSwitchTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyManualCaptureMode(mode: CaptureMode): Promise<ModeSwitchResult> {
    const previousPhase = this.adaptivePhase;
    const result = await this.applyCaptureMode(mode);
    this.reconcileManualAdaptiveState(mode, previousPhase);
    return result;
  }

  private async applyCaptureMode(mode: CaptureMode): Promise<ModeSwitchResult> {
    const lifecycleState = this.resources.getLifecycleState();
    if (!this.canSwitchMode(lifecycleState)) {
      throw this.createLifecycleError(lifecycleState);
    }

    const from = this.modeState.captureMode;
    const next = resolveModeState(this.config.userConfig, this.config, mode);
    const changed = diffModeStates(this.modeState, next);
    if (changed.length === 0) {
      return { from, to: next.captureMode, appliedInMs: 0, changed };
    }

    const startedAt = Date.now();
    const previous = this.modeState;
    await this.applyModeState(previous, next);
    this.switchCount += 1;

    return {
      from,
      to: next.captureMode,
      appliedInMs: Math.max(0, Date.now() - startedAt),
      changed
    };
  }

  private async applyModeState(previous: ModeState, next: ModeState): Promise<void> {
    const lifecycleState = this.resources.getLifecycleState();
    const wasActive = lifecycleState === 'active';

    // Buffered modes rely on the interval to deliver captures. Drain while
    // the previous mode and timer are still active before a zero-interval
    // transition removes that delivery path (notably safe -> fast).
    if (
      wasActive &&
      previous.flushIntervalMs > 0 &&
      next.flushIntervalMs === 0
    ) {
      await this.resources.flushBeforeTimerRestart().catch(() => undefined);
    }

    if (wasActive && previous.recorders.httpServer !== next.recorders.httpServer) {
      this.resources.setHttpServerRecorderEnabled(next.recorders.httpServer);
    }
    if (wasActive) {
      this.resources.updateChannelSubscriptions(next.recorders);
    }
    if (
      wasActive &&
      (previous.recorders.fetch !== next.recorders.fetch ||
        (next.recorders.fetch &&
          previous.captureResponseBodies !== next.captureResponseBodies))
    ) {
      this.resources.setFetchRecorderEnabled(next.recorders.fetch, next);
    }
    if (wasActive && previous.recorders.netDns !== next.recorders.netDns) {
      this.resources.setNetDnsRecorderEnabled(next.recorders.netDns);
    }
    if (wasActive && previous.recorders.database !== next.recorders.database) {
      this.resources.setDatabaseRecordersEnabled(next.recorders.database);
    }
    if (wasActive && previous.recorders.processHandlers !== next.recorders.processHandlers) {
      this.resources.setProcessHandlersEnabled(next.recorders.processHandlers);
    }
    if (
      wasActive &&
      !this.config.serverless &&
      previous.capabilities.eventLoopLagMonitor !== next.capabilities.eventLoopLagMonitor
    ) {
      this.resources.setEventLoopLagMonitorEnabled(next.capabilities.eventLoopLagMonitor);
    }

    this.modeState = next;
    this.resources.applyResolvedConfig(next);
    await this.resources.applyRuntimeResources(next);
    this.resources.applyInspectorModeState(next);

    if (wasActive) {
      const shouldFlushBeforeIntervalRestart =
        (previous.flushIntervalMs === 0 && next.flushIntervalMs !== 0) ||
        (previous.captureMode === 'fast' && next.captureMode !== 'fast') ||
        (previous.captureMode !== 'fast' && next.captureMode === 'fast');
      if (shouldFlushBeforeIntervalRestart) {
        await this.resources.flushBeforeTimerRestart().catch(() => undefined);
      }
      this.resources.restartFlushTimer();
      this.resources.setLocalVariablesCaptureEnabled(
        next.captureLocalVariables && next.localVariablesMode !== 'none'
      );
    }
  }

  private async evaluateAdaptiveDeescalation(): Promise<void> {
    if (
      !this.config.adaptiveCapture.enabled ||
      this.adaptivePhase !== 'escalated' ||
      this.adaptiveLastEscalationAt === null ||
      this.adaptiveLastCaptureAt === null
    ) {
      return;
    }

    const now = Date.now();
    const quietMs = now - this.adaptiveLastCaptureAt;
    const dwellMs = now - this.adaptiveLastEscalationAt;
    if (
      quietMs >= this.config.adaptiveCapture.deescalateAfterMs &&
      dwellMs >= this.config.adaptiveCapture.minDwellMs
    ) {
      await this.switchAdaptiveMode(
        this.config.adaptiveCapture.base,
        this.adaptiveIntentGeneration
      );
    }
  }

  private async switchAdaptiveMode(target: CaptureMode, generation: number): Promise<void> {
    if (this.resources.getLifecycleState() !== 'active') {
      return;
    }

    const run = this.modeSwitchTail.then(() =>
      this.applyAdaptiveCaptureMode(target, generation)
    );
    this.modeSwitchTail = run.then(
      () => undefined,
      () => undefined
    );
    await run.catch(() => undefined);
  }

  private async applyAdaptiveCaptureMode(
    target: CaptureMode,
    generation: number
  ): Promise<void> {
    if (
      generation !== this.adaptiveIntentGeneration ||
      this.resources.getLifecycleState() !== 'active' ||
      !this.isCurrentAdaptiveTransition(target)
    ) {
      return;
    }

    const now = Date.now();
    this.adaptiveSwitchTimestamps = this.adaptiveSwitchTimestamps.filter(
      (timestamp) => now - timestamp < 60 * 60 * 1000
    );
    if (this.adaptiveSwitchTimestamps.length >= this.config.adaptiveCapture.maxSwitchesPerHour) {
      this.warnAdaptiveSwitchRateOnce();
      this.adaptivePhase = 'pinned';
      if (target !== this.config.adaptiveCapture.escalated) {
        return;
      }
    }

    const result = await this.applyCaptureMode(target);
    if (result.changed.length === 0) {
      return;
    }

    this.adaptiveSwitchTimestamps.push(now);
    if (target === this.config.adaptiveCapture.escalated) {
      this.adaptivePhase = this.adaptivePhase === 'pinned' ? 'pinned' : 'escalated';
      this.adaptiveLastEscalationAt = now;
      this.resources.rearmAfterAdaptiveGuard();
    } else {
      this.adaptivePhase = 'base';
    }
  }

  private isCurrentAdaptiveTransition(target: CaptureMode): boolean {
    if (target === this.config.adaptiveCapture.escalated) {
      return (
        this.adaptivePhase === 'base' &&
        this.modeState.captureMode === this.config.adaptiveCapture.base
      );
    }

    if (target === this.config.adaptiveCapture.base) {
      return (
        this.adaptivePhase === 'escalated' &&
        this.modeState.captureMode === this.config.adaptiveCapture.escalated
      );
    }

    return false;
  }

  private reconcileManualAdaptiveState(
    target: CaptureMode,
    previousPhase: AdaptiveCaptureHealth['phase']
  ): void {
    if (!this.config.adaptiveCapture.enabled) {
      return;
    }

    if (target === this.config.adaptiveCapture.base) {
      this.adaptivePhase = 'base';
      return;
    }

    if (target === this.config.adaptiveCapture.escalated) {
      const now = Date.now();
      this.adaptivePhase = 'escalated';
      this.adaptiveLastEscalationAt = now;
      // A manual escalation starts its own quiet window so it can return to
      // base even when no error was captured immediately beforehand.
      this.adaptiveLastCaptureAt = now;
      if (
        previousPhase !== 'escalated' &&
        this.resources.getLifecycleState() === 'active'
      ) {
        this.resources.rearmAfterAdaptiveGuard();
      }
      return;
    }

    // Adaptive evaluation is suspended for an explicit mode that is neither
    // configured endpoint. Choosing base or escalated resumes it.
    this.adaptivePhase = 'manual';
  }

  private warnAdaptiveSwitchRateOnce(): void {
    if (this.adaptiveSwitchRateWarningEmitted) {
      return;
    }
    this.adaptiveSwitchRateWarningEmitted = true;
    try {
      this.config.onInternalWarning?.({
        code: 'EC_ADAPTIVE_CAPTURE_SWITCH_RATE_LIMITED',
        message: 'Adaptive capture exceeded maxSwitchesPerHour; staying in escalated mode.',
        context: {
          maxSwitchesPerHour: this.config.adaptiveCapture.maxSwitchesPerHour
        }
      });
    } catch {
      // onInternalWarning must never crash the host.
    }
  }

  private canSwitchMode(lifecycleState: SDKLifecycleState): boolean {
    return lifecycleState === 'created' || lifecycleState === 'active';
  }

  private createLifecycleError(lifecycleState: SDKLifecycleState): Error {
    return new Error(
      lifecycleState === 'shutting_down' ? 'SDK is shutting down' : 'SDK is shut down'
    );
  }
}
