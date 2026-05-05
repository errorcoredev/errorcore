
import { parentPort, workerData } from 'node:worker_threads';

import { buildPackageAssemblyResult } from './package-builder';
import { createEncryptionFromAssemblyConfig } from '../security/encryption-runtime';
import type {
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerRequest,
  PackageAssemblyWorkerResponse
} from '../types';

function startPackageAssemblyWorker(data: PackageAssemblyWorkerData): void {
  const port = parentPort;

  if (port === null) {
    return;
  }

  const encryption = createEncryptionFromAssemblyConfig(data.encryption);

  port.on('message', (message: PackageAssemblyWorkerRequest) => {
    try {
      if (message.type === 'shutdown') {
        port.postMessage({
          id: message.id
        } satisfies PackageAssemblyWorkerResponse);
        port.close();
        return;
      }

      port.postMessage({
        id: message.id,
        result: buildPackageAssemblyResult({
          parts: message.parts,
          config: data.config,
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

startPackageAssemblyWorker(workerData as PackageAssemblyWorkerData);
