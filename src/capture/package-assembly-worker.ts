
import { parentPort, workerData } from 'node:worker_threads';

import { buildPackageAssemblyResult } from './package-builder';
import { createEncryptionFromAssemblyConfig } from '../security/encryption-runtime';
import { resolveScrubberPolicy } from '../scrubber/policy';
import type {
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerRequest,
  PackageAssemblyWorkerResponse,
  ResolvedConfig
} from '../types';

function startPackageAssemblyWorker(data: PackageAssemblyWorkerData): void {
  const port = parentPort;

  if (port === null) {
    return;
  }

  const encryption = createEncryptionFromAssemblyConfig(data.encryption);
  let config = resolveWorkerConfig(data.config);

  port.on('message', (message: PackageAssemblyWorkerRequest) => {
    try {
      if (message.type === 'shutdown') {
        port.postMessage({
          id: message.id
        } satisfies PackageAssemblyWorkerResponse);
        port.close();
        return;
      }

      if (message.type === 'update_config') {
        config = resolveWorkerConfig(message.config);
        port.postMessage({ id: message.id } satisfies PackageAssemblyWorkerResponse);
        return;
      }

      port.postMessage({
        id: message.id,
        result: buildPackageAssemblyResult({
          parts: message.parts,
          config,
          encryption
        })
      } satisfies PackageAssemblyWorkerResponse);
    } catch (error) {
      // Send only name+message across the port. The stack trace can
      // contain file paths from the host process (and sometimes PII
      // interpolated into error messages by host code). The parent
      // logs this via emitSafeWarning which should not grow a PII
      // surface.
      port.postMessage({
        id: message.id,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
      } satisfies PackageAssemblyWorkerResponse);
    }
  });
}

function resolveWorkerConfig(
  config: PackageAssemblyWorkerData['config']
): ResolvedConfig {
  return {
    ...config,
    scrubberPolicy: resolveScrubberPolicy(config.scrubberPolicy)
  } as ResolvedConfig;
}

startPackageAssemblyWorker(workerData as PackageAssemblyWorkerData);
