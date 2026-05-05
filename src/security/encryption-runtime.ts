import { safeConsole } from '../debug-log';
import type { PackageAssemblyEncryptionConfig, ResolvedConfig } from '../types';
import { getSdkVersion } from '../version';
import { Encryption } from './encryption';

export function parseDerivedKeyFromEnv(): Buffer | undefined {
  const hex = process.env.ERRORCORE_DERIVED_KEY;
  if (hex === undefined || hex === '') return undefined;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    safeConsole.warn(
      '[errorcore] ERRORCORE_DERIVED_KEY must be a 64-character hex string (32 bytes). Falling back to runtime key derivation.'
    );
    return undefined;
  }
  return Buffer.from(hex, 'hex');
}

export function createPackageAssemblyEncryptionConfig(
  config: Pick<ResolvedConfig, 'encryptionKey' | 'macKey' | 'previousEncryptionKeys'>
): PackageAssemblyEncryptionConfig | undefined {
  if (config.encryptionKey === undefined) {
    return undefined;
  }

  const derivedKey = parseDerivedKeyFromEnv();

  return {
    encryptionKey: config.encryptionKey,
    ...(config.macKey === undefined ? {} : { macKey: config.macKey }),
    previousEncryptionKeys: [...config.previousEncryptionKeys],
    sdkVersion: getSdkVersion(),
    ...(derivedKey === undefined ? {} : { derivedKeyHex: derivedKey.toString('hex') })
  };
}

export function createEncryptionFromAssemblyConfig(
  config: PackageAssemblyEncryptionConfig | undefined
): Encryption | null {
  if (config === undefined) {
    return null;
  }

  return new Encryption(config.encryptionKey, {
    ...(config.derivedKeyHex === undefined
      ? {}
      : { derivedKey: Buffer.from(config.derivedKeyHex, 'hex') }),
    previousEncryptionKeys: config.previousEncryptionKeys,
    macKey: config.macKey,
    sdkVersion: config.sdkVersion
  });
}
