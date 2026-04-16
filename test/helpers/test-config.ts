import { resolveConfig } from '../../src/config';
import type { ResolvedConfig, SDKConfig } from '../../src/types';

// Tests exercising SDK internals should not have to set the two "I
// accept the consequences" flags (allowUnencrypted, a stdout transport)
// on every call. Production default safety is verified by the dedicated
// tests in test/unit/types-and-config.test.ts.
export function resolveTestConfig(overrides: Partial<SDKConfig> = {}): ResolvedConfig {
  return resolveConfig({
    transport: { type: 'stdout' },
    allowUnencrypted: true,
    ...overrides
  });
}
