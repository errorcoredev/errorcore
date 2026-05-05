
/**
 * SDK version, loaded once from package.json. Used by the encryption
 * envelope (sdk.version, AAD), the keyId header on transports, and the
 * startup banner. Falls back to "unknown" if package.json isn't
 * resolvable (some bundler setups strip it).
 */
let cached: string | null = null;

export function getSdkVersion(): string {
  if (cached !== null) return cached;
  try {
    cached = (require('../package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
