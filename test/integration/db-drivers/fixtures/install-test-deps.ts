import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);

/**
 * Lazy require with no-throw fallback. Used so a missing optional driver
 * (developer ran `npm install --omit=optional`) skips the suite cleanly
 * instead of failing the whole test run.
 */
export function tryRequire<T>(name: string): T | null {
  try {
    return localRequire(name) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

/** True if the env flag is set to a truthy value. */
export function envFlag(name: string): boolean {
  const val = process.env[name];
  return val !== undefined && val !== '' && val !== '0' && val.toLowerCase() !== 'false';
}
