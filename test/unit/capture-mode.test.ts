import { describe, expect, it, vi } from 'vitest';

import {
  pickModeRelevantUserConfig,
  resolveCaptureMode,
  resolveCaptureModeSelection,
  resolveModeState
} from '../../src/capture-mode';
import {
  resolveCaptureMode as resolveCaptureModeFromConfig,
  resolveModeState as resolveModeStateFromConfig
} from '../../src/config';

const baseConfig = {
  serverless: false,
  payloadSpool: {
    globalMaxBytes: 64 * 1024 * 1024,
    perRequestMaxBytes: 2 * 1024 * 1024,
    perBlobMaxBytes: 512 * 1024,
    previewBytes: 8 * 1024,
    completedTtlMs: 60_000
  },
  maxLocalsCollectionsPerSecond: 20,
  maxCachedLocals: 50
};

describe('capture-mode module', () => {
  it('keeps the config module compatibility exports', () => {
    expect(resolveCaptureModeFromConfig).toBe(resolveCaptureMode);
    expect(resolveModeStateFromConfig).toBe(resolveModeState);
  });

  it('resolves adaptive selection and emits the mode override warning once', () => {
    const onInternalWarning = vi.fn();
    const selection = resolveCaptureModeSelection({
      captureMode: 'balanced',
      adaptiveCapture: { enabled: true, base: 'safe', escalated: 'forensic' },
      onInternalWarning
    });

    expect(selection.captureMode).toBe('safe');
    expect(selection.adaptiveCapture).toMatchObject({
      enabled: true,
      base: 'safe',
      escalated: 'forensic'
    });
    expect(onInternalWarning).toHaveBeenCalledOnce();
  });

  it('retains only overrides needed by runtime mode switches', () => {
    const picked = pickModeRelevantUserConfig({
      captureMode: 'balanced',
      captureBody: true,
      maxLocalsFrames: 7,
      encryptionKey: 'secret',
      transport: { type: 'stdout' }
    });

    expect(picked).toEqual({ captureBody: true, maxLocalsFrames: 7 });
  });

  it('applies mode validation through the runtime state resolver', () => {
    expect(() =>
      resolveModeState({ maxLocalsFrames: 0 }, baseConfig, 'safe')
    ).toThrow(/maxLocalsFrames/);
    expect(() =>
      resolveModeState(
        { localsGuard: { maxPauseMsPerMinute: 0 } },
        baseConfig,
        'safe'
      )
    ).toThrow(/localsGuard.maxPauseMsPerMinute/);
    expect(() =>
      resolveModeState({ flushIntervalMs: 999 }, baseConfig, 'safe')
    ).toThrow(/flushIntervalMs/);
  });
});
