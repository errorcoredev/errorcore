
import { parentPort, workerData } from 'node:worker_threads';

import { buildPackageAssemblyResult } from './package-builder';
import { Encryption } from '../security/encryption';
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

  const encryption = data.config.encryptionKey
    ? new Encryption(data.config.encryptionKey)
    : null;

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
      port.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      } satisfies PackageAssemblyWorkerResponse);
    }
  });
}

startPackageAssemblyWorker(workerData as PackageAssemblyWorkerData);
