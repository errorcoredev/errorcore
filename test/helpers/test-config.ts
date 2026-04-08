import { resolveConfig } from '../../src/config';
import type { ResolvedConfig, SDKConfig } from '../../src/types';

export function resolveTestConfig(overrides: Partial<SDKConfig> = {}): ResolvedConfig {
  return resolveConfig({
    transport: { type: 'stdout' },
    ...overrides
  });
}
