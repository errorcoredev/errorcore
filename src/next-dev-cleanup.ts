import type { InternalWarning } from './types';

export interface NextDevHotLike {
  dispose(callback: () => void): void;
}

interface CleanupInstanceLike {
  shutdown(): Promise<void>;
}

interface RegisterNextDevHmrCleanupInput<TInstance extends CleanupInstanceLike> {
  env?: Record<string, string | undefined>;
  hot?: NextDevHotLike | null;
  instance: TInstance;
  getGlobalInstance(): unknown;
  setGlobalInstance(instance: TInstance | null): void;
  onInternalWarning?: (warning: InternalWarning) => void;
}

export function isNextJsDevRuntime(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.NEXT_RUNTIME === 'nodejs' && env.NODE_ENV !== 'production';
}

export function getCurrentHotModule(): NextDevHotLike | null {
  try {
    const maybeHot = (module as NodeJS.Module & { hot?: unknown }).hot;
    if (
      maybeHot !== null &&
      typeof maybeHot === 'object' &&
      typeof (maybeHot as { dispose?: unknown }).dispose === 'function'
    ) {
      return maybeHot as NextDevHotLike;
    }
  } catch {
  }

  return null;
}

function emitCleanupWarning(
  onInternalWarning: ((warning: InternalWarning) => void) | undefined,
  cause: unknown
): void {
  try {
    onInternalWarning?.({
      code: 'EC_NEXT_HMR_CLEANUP_FAILED',
      message: 'Next.js dev HMR cleanup failed; stale errorcore resources may remain until process restart.',
      cause
    });
  } catch {
    // onInternalWarning must never crash the host.
  }
}

export function registerNextDevHmrCleanup<TInstance extends CleanupInstanceLike>(
  input: RegisterNextDevHmrCleanupInput<TInstance>
): boolean {
  if (!isNextJsDevRuntime(input.env ?? process.env)) {
    return false;
  }

  const hot = input.hot === undefined ? getCurrentHotModule() : input.hot;
  if (hot === null || typeof hot.dispose !== 'function') {
    return false;
  }

  try {
    hot.dispose(() => {
      try {
        if (input.getGlobalInstance() === input.instance) {
          input.setGlobalInstance(null);
        }
      } catch (error) {
        emitCleanupWarning(input.onInternalWarning, error);
      }

      try {
        void input.instance.shutdown().catch((error) => {
          emitCleanupWarning(input.onInternalWarning, error);
        });
      } catch (error) {
        emitCleanupWarning(input.onInternalWarning, error);
      }
    });
    return true;
  } catch (error) {
    emitCleanupWarning(input.onInternalWarning, error);
    return false;
  }
}
