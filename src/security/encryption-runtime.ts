import type { PackageAssemblyEncryptionConfig, ResolvedConfig } from '../types';
import { getSdkVersion } from '../version';
import { Encryption } from './encryption';

export function createPackageAssemblyEncryptionConfig(
  config: Pick<ResolvedConfig, 'encryptionKey' | 'macKey' | 'previousEncryptionKeys'>
): PackageAssemblyEncryptionConfig | undefined {
  if (config.encryptionKey === undefined) {
    return undefined;
  }

  return {
    encryptionKey: config.encryptionKey,
    ...(config.macKey === undefined ? {} : { macKey: config.macKey }),
    previousEncryptionKeys: [...config.previousEncryptionKeys],
    sdkVersion: getSdkVersion()
  };
}

export function createEncryptionFromAssemblyConfig(
  config: PackageAssemblyEncryptionConfig | undefined
): Encryption | null {
  if (config === undefined) {
    return null;
  }

  return new Encryption(config.encryptionKey, {
    previousEncryptionKeys: config.previousEncryptionKeys,
    macKey: config.macKey,
    sdkVersion: config.sdkVersion
  });
}
