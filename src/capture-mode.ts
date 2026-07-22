import type {
  AdaptiveCaptureConfig,
  CaptureCapabilities,
  CaptureMode,
  ModeState,
  RecorderSettings,
  ResolvedAdaptiveCaptureConfig,
  ResolvedConfig,
  SDKConfig
} from './types';

const CAPTURE_MODES = new Set<CaptureMode>([
  'safe',
  'balanced',
  'forensic',
  'fast'
]);

interface ModeDefaults {
  captureLocalVariables: boolean;
  captureDbBindParams: boolean;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureBodyDigest: boolean;
  resolveSourceMaps: boolean;
  payloadSpoolEnabled: boolean;
  useWorkerAssembly: boolean;
  flushIntervalMs: number;
  recorders: RecorderSettings;
}

const ALL_RECORDERS: RecorderSettings = {
  httpServer: true,
  httpClient: true,
  undici: true,
  fetch: true,
  netDns: true,
  database: true,
  processHandlers: true,
  transport: true
};

const MODE_DEFAULTS: Record<CaptureMode, ModeDefaults> = {
  safe: {
    // Low-overhead default: fast-path chassis plus shallow locals. Safe runs
    // no standing recorders; the inbound http-server event is synthesized
    // from the ALS request context at capture time.
    captureLocalVariables: true,
    captureDbBindParams: false,
    captureRequestBodies: false,
    captureResponseBodies: false,
    captureBodyDigest: false,
    resolveSourceMaps: true,
    payloadSpoolEnabled: false,
    useWorkerAssembly: false,
    flushIntervalMs: 5000,
    recorders: {
      httpServer: false,
      httpClient: false,
      undici: false,
      fetch: false,
      netDns: false,
      database: false,
      processHandlers: true,
      transport: true
    }
  },
  balanced: {
    captureLocalVariables: true,
    captureDbBindParams: false,
    captureRequestBodies: false,
    captureResponseBodies: false,
    captureBodyDigest: false,
    resolveSourceMaps: true,
    payloadSpoolEnabled: true,
    useWorkerAssembly: true,
    flushIntervalMs: 5000,
    recorders: ALL_RECORDERS
  },
  forensic: {
    captureLocalVariables: true,
    captureDbBindParams: true,
    captureRequestBodies: true,
    captureResponseBodies: true,
    captureBodyDigest: true,
    resolveSourceMaps: true,
    payloadSpoolEnabled: true,
    useWorkerAssembly: true,
    flushIntervalMs: 5000,
    recorders: ALL_RECORDERS
  },
  fast: {
    captureLocalVariables: false,
    captureDbBindParams: false,
    captureRequestBodies: false,
    captureResponseBodies: false,
    captureBodyDigest: false,
    resolveSourceMaps: false,
    payloadSpoolEnabled: false,
    useWorkerAssembly: false,
    flushIntervalMs: 0,
    recorders: {
      httpServer: false,
      httpClient: false,
      undici: false,
      fetch: false,
      netDns: false,
      database: false,
      processHandlers: false,
      transport: true
    }
  }
};

const DEFAULT_ADAPTIVE_CAPTURE: ResolvedAdaptiveCaptureConfig = {
  enabled: false,
  base: 'safe',
  escalated: 'forensic',
  deescalateAfterMs: 120000,
  minDwellMs: 10000,
  maxSwitchesPerHour: 60
};

export type ModeRelevantUserConfig = Pick<
  Partial<SDKConfig>,
  | 'captureLocalVariables'
  | 'captureDbBindParams'
  | 'captureRequestBodies'
  | 'captureResponseBodies'
  | 'captureBody'
  | 'captureBodyDigest'
  | 'payloadSpool'
  | 'useWorkerAssembly'
  | 'flushIntervalMs'
  | 'resolveSourceMaps'
  | 'maxLocalsCollectionsPerSecond'
  | 'maxCachedLocals'
  | 'maxLocalsFrames'
  | 'localsGuard'
>;

export interface ModeResolutionBaseConfig {
  serverless: boolean;
  payloadSpool: Omit<ResolvedConfig['payloadSpool'], 'enabled'> & {
    enabled?: boolean;
  };
  maxLocalsCollectionsPerSecond: number;
  maxCachedLocals: number;
}

export interface CaptureModeSelection {
  adaptiveCapture: ResolvedAdaptiveCaptureConfig;
  captureMode: CaptureMode;
}

function assertPositiveInteger(
  value: number,
  fieldName: string,
  extraConstraint?: (candidate: number) => string | null
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  const message = extraConstraint?.(value) ?? null;
  if (message !== null) {
    throw new Error(message);
  }
}

export function resolveCaptureMode(mode: SDKConfig['captureMode']): CaptureMode {
  const resolved = mode ?? 'safe';
  if (!CAPTURE_MODES.has(resolved)) {
    throw new Error("captureMode must be one of 'safe' | 'balanced' | 'forensic' | 'fast'");
  }
  return resolved;
}

export function pickModeRelevantUserConfig(
  userConfig: Partial<SDKConfig>
): ModeRelevantUserConfig {
  const picked: ModeRelevantUserConfig = {};
  for (const key of [
    'captureLocalVariables',
    'captureDbBindParams',
    'captureRequestBodies',
    'captureResponseBodies',
    'captureBody',
    'captureBodyDigest',
    'payloadSpool',
    'useWorkerAssembly',
    'flushIntervalMs',
    'resolveSourceMaps',
    'maxLocalsCollectionsPerSecond',
    'maxCachedLocals',
    'maxLocalsFrames',
    'localsGuard'
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(userConfig, key)) {
      (picked as Record<string, unknown>)[key] = userConfig[key];
    }
  }
  return picked;
}

function validateAdaptiveCaptureConfig(input: AdaptiveCaptureConfig | undefined): void {
  if (input === undefined) {
    return;
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('adaptiveCapture.enabled must be a boolean');
  }
  if (input.base !== undefined) {
    resolveCaptureMode(input.base);
  }
  if (input.escalated !== undefined) {
    resolveCaptureMode(input.escalated);
  }
  for (const key of ['deescalateAfterMs', 'minDwellMs', 'maxSwitchesPerHour'] as const) {
    const value = input[key];
    if (value !== undefined) {
      assertPositiveInteger(value, `adaptiveCapture.${key}`);
    }
  }
}

export function resolveAdaptiveCaptureConfig(
  input: AdaptiveCaptureConfig | undefined
): ResolvedAdaptiveCaptureConfig {
  validateAdaptiveCaptureConfig(input);
  const resolved: ResolvedAdaptiveCaptureConfig = {
    ...DEFAULT_ADAPTIVE_CAPTURE,
    enabled: input?.enabled ?? false,
    base: resolveCaptureMode(input?.base ?? DEFAULT_ADAPTIVE_CAPTURE.base),
    escalated: resolveCaptureMode(input?.escalated ?? DEFAULT_ADAPTIVE_CAPTURE.escalated),
    deescalateAfterMs: input?.deescalateAfterMs ?? DEFAULT_ADAPTIVE_CAPTURE.deescalateAfterMs,
    minDwellMs: input?.minDwellMs ?? DEFAULT_ADAPTIVE_CAPTURE.minDwellMs,
    maxSwitchesPerHour: input?.maxSwitchesPerHour ?? DEFAULT_ADAPTIVE_CAPTURE.maxSwitchesPerHour
  };

  if (resolved.enabled && resolved.base === resolved.escalated) {
    throw new Error('adaptiveCapture.escalated must differ from adaptiveCapture.base');
  }

  return resolved;
}

function emitAdaptiveModeOverrideWarning(userConfig: Partial<SDKConfig>): void {
  if (
    userConfig.adaptiveCapture?.enabled !== true ||
    userConfig.captureMode === undefined ||
    userConfig.onInternalWarning === undefined
  ) {
    return;
  }

  try {
    userConfig.onInternalWarning({
      code: 'EC_ADAPTIVE_CAPTURE_OVERRIDES_MODE',
      message:
        'adaptiveCapture.enabled ignores captureMode at init; use adaptiveCapture.base to choose the base mode.',
      context: {
        captureMode: userConfig.captureMode,
        base: userConfig.adaptiveCapture.base ?? DEFAULT_ADAPTIVE_CAPTURE.base
      }
    });
  } catch {
    // onInternalWarning must never crash config resolution.
  }
}

export function resolveCaptureModeSelection(
  userConfig: Partial<SDKConfig>
): CaptureModeSelection {
  const adaptiveCapture = resolveAdaptiveCaptureConfig(userConfig.adaptiveCapture);
  emitAdaptiveModeOverrideWarning(userConfig);

  return {
    adaptiveCapture,
    captureMode: adaptiveCapture.enabled
      ? adaptiveCapture.base
      : resolveCaptureMode(userConfig.captureMode)
  };
}

function validateModeUserConfig(userConfig: Partial<SDKConfig>): void {
  for (const key of [
    'maxLocalsCollectionsPerSecond',
    'maxCachedLocals',
    'maxLocalsFrames'
  ] as const) {
    const value = userConfig[key];
    if (value !== undefined) {
      assertPositiveInteger(value, key);
    }
  }

  const localsGuard = userConfig.localsGuard;
  if (typeof localsGuard !== 'object' || localsGuard === null) {
    return;
  }
  if (localsGuard.maxPausesPerSecond !== undefined) {
    assertPositiveInteger(localsGuard.maxPausesPerSecond, 'localsGuard.maxPausesPerSecond');
  }
  if (localsGuard.maxPauseMsPerMinute !== undefined) {
    assertPositiveInteger(localsGuard.maxPauseMsPerMinute, 'localsGuard.maxPauseMsPerMinute');
  }
}

function deriveCapabilities(
  captureMode: CaptureMode,
  useWorkerAssembly: boolean,
  captureRequestBodies: boolean,
  captureResponseBodies: boolean,
  captureBodyDigest: boolean
): CaptureCapabilities {
  const lowOverheadChassis = captureMode === 'fast' || captureMode === 'safe';
  return {
    deferredDelivery: lowOverheadChassis && !useWorkerAssembly,
    materializeBodies: captureRequestBodies || captureResponseBodies || captureBodyDigest,
    syntheticInboundFallback: lowOverheadChassis,
    eventLoopLagMonitor: captureMode !== 'fast'
  };
}

export function resolveModeState(
  userConfig: Partial<SDKConfig>,
  baseConfig: ModeResolutionBaseConfig,
  mode: CaptureMode
): ModeState {
  validateModeUserConfig(userConfig);

  const captureMode = resolveCaptureMode(mode);
  const modeDefaults = MODE_DEFAULTS[captureMode];
  const recorders: RecorderSettings = { ...modeDefaults.recorders };
  const isFast = captureMode === 'fast';
  const payloadSpoolConfig = userConfig.payloadSpool ?? {};
  const payloadSpoolEnabled = isFast
    ? false
    : payloadSpoolConfig.enabled ?? modeDefaults.payloadSpoolEnabled;
  const useWorkerAssembly = isFast
    ? false
    : userConfig.useWorkerAssembly ?? (baseConfig.serverless ? false : modeDefaults.useWorkerAssembly);
  const flushIntervalMs = isFast
    ? 0
    : userConfig.flushIntervalMs ?? (baseConfig.serverless ? 0 : modeDefaults.flushIntervalMs);

  if (flushIntervalMs !== 0) {
    assertPositiveInteger(flushIntervalMs, 'flushIntervalMs', (candidate) => {
      if (candidate < 1000) {
        return 'flushIntervalMs must be at least 1000 (1 second) or 0 to disable';
      }
      return null;
    });
  }

  const explicitBodyControlsProvided =
    userConfig.captureRequestBodies !== undefined ||
    userConfig.captureResponseBodies !== undefined;
  const captureRequestBodies = isFast
    ? false
    : explicitBodyControlsProvided
      ? userConfig.captureRequestBodies ?? modeDefaults.captureRequestBodies
      : userConfig.captureBody ?? modeDefaults.captureRequestBodies;
  const captureResponseBodies = isFast
    ? false
    : explicitBodyControlsProvided
      ? userConfig.captureResponseBodies ?? modeDefaults.captureResponseBodies
      : userConfig.captureBody ?? modeDefaults.captureResponseBodies;
  const captureLocalVariables = isFast
    ? false
    : userConfig.captureLocalVariables ?? modeDefaults.captureLocalVariables;
  const captureDbBindParams = isFast
    ? false
    : userConfig.captureDbBindParams ?? modeDefaults.captureDbBindParams;
  const captureBodyDigest = isFast
    ? false
    : userConfig.captureBodyDigest ?? modeDefaults.captureBodyDigest;
  const resolveSourceMaps = isFast
    ? false
    : userConfig.resolveSourceMaps ?? modeDefaults.resolveSourceMaps;
  const localVariablesMode = !captureLocalVariables
    ? 'none'
    : captureMode === 'forensic'
      ? 'deep'
      : 'shallow';
  const localsGuardInput = userConfig.localsGuard;
  const localsGuard = {
    enabled: captureLocalVariables && localsGuardInput !== 'off',
    maxPausesPerSecond:
      (typeof localsGuardInput === 'object' ? localsGuardInput?.maxPausesPerSecond : undefined) ?? 50,
    maxPauseMsPerMinute:
      (typeof localsGuardInput === 'object' ? localsGuardInput?.maxPauseMsPerMinute : undefined) ?? 250
  };
  const capabilities = deriveCapabilities(
    captureMode,
    useWorkerAssembly,
    captureRequestBodies,
    captureResponseBodies,
    captureBodyDigest
  );

  return {
    captureMode,
    localVariablesMode,
    capabilities,
    recorders,
    captureLocalVariables,
    localsGuard,
    captureDbBindParams,
    captureRequestBodies,
    captureResponseBodies,
    captureBody: captureRequestBodies && captureResponseBodies,
    captureBodyDigest,
    payloadSpool: {
      ...baseConfig.payloadSpool,
      enabled: payloadSpoolEnabled
    },
    useWorkerAssembly,
    flushIntervalMs,
    resolveSourceMaps,
    maxLocalsCollectionsPerSecond:
      userConfig.maxLocalsCollectionsPerSecond ?? baseConfig.maxLocalsCollectionsPerSecond,
    maxCachedLocals: userConfig.maxCachedLocals ?? baseConfig.maxCachedLocals,
    maxLocalsFrames: userConfig.maxLocalsFrames ?? (captureMode === 'forensic' ? 10 : 5),
    maxLocalsObjectProperties: captureMode === 'forensic' ? 20 : 8
  };
}
