import { describe, expect, it, vi } from 'vitest';

import {
  isNextJsDevRuntime,
  registerNextDevHmrCleanup
} from '../../src/next-dev-cleanup';

describe('Next.js dev HMR cleanup', () => {
  it('detects Next.js node dev runtime without matching production or edge', () => {
    expect(isNextJsDevRuntime({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'development' })).toBe(true);
    expect(isNextJsDevRuntime({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production' })).toBe(false);
    expect(isNextJsDevRuntime({ NEXT_RUNTIME: 'edge', NODE_ENV: 'development' })).toBe(false);
    expect(isNextJsDevRuntime({ NODE_ENV: 'development' })).toBe(false);
  });

  it('registers an HMR dispose cleanup that clears only the active singleton', async () => {
    let disposeCallback: (() => void) | undefined;
    const instance = {
      shutdown: vi.fn(async () => undefined)
    };
    const otherInstance = {
      shutdown: vi.fn(async () => undefined)
    };
    const setGlobalInstance = vi.fn();

    const registered = registerNextDevHmrCleanup({
      env: { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'development' },
      hot: {
        dispose(callback) {
          disposeCallback = callback;
        }
      },
      instance,
      getGlobalInstance: () => otherInstance,
      setGlobalInstance
    });

    expect(registered).toBe(true);
    expect(disposeCallback).toBeDefined();

    disposeCallback?.();
    await Promise.resolve();

    expect(instance.shutdown).toHaveBeenCalledTimes(1);
    expect(setGlobalInstance).not.toHaveBeenCalled();
  });

  it('routes HMR cleanup failures through onInternalWarning without throwing', async () => {
    let disposeCallback: (() => void) | undefined;
    const cleanupError = new Error('cleanup failed');
    const onInternalWarning = vi.fn(() => {
      throw new Error('warning handler failed');
    });
    const instance = {
      shutdown: vi.fn(async () => {
        throw cleanupError;
      })
    };
    const setGlobalInstance = vi.fn();

    registerNextDevHmrCleanup({
      env: { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'development' },
      hot: {
        dispose(callback) {
          disposeCallback = callback;
        }
      },
      instance,
      getGlobalInstance: () => instance,
      setGlobalInstance,
      onInternalWarning
    });

    expect(() => disposeCallback?.()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(setGlobalInstance).toHaveBeenCalledWith(null);
    expect(onInternalWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'EC_NEXT_HMR_CLEANUP_FAILED',
        cause: cleanupError
      })
    );
  });
});
