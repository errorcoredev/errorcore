
import { createRequire } from 'node:module';

import type { IOEventSlot, RequestContext } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';
import { pushIOEvent } from '../utils';
import type { RecorderState } from '../../sdk-diagnostics';
import { detectBundler } from '../../sdk-diagnostics';

const nodeRequire = createRequire(__filename);

const COLLECTION_METHODS = [
  'find',
  'findOne',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'aggregate'
] as const;

function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === 'function';
}

function isCursorLike(value: unknown): boolean {
  return typeof (value as { toArray?: unknown } | undefined)?.toArray === 'function';
}

function summarizeKeys(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const keys = value.flatMap((entry) =>
      typeof entry === 'object' && entry !== null ? Object.keys(entry) : []
    );

    return keys.length === 0 ? undefined : `[ ${keys.join(', ')} ]`;
  }

  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);

    return keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`;
  }

  return undefined;
}

function resolveRowCount(result: unknown): number | null {
  const candidate = result as
    | {
        insertedCount?: unknown;
        modifiedCount?: unknown;
        deletedCount?: unknown;
      }
    | undefined;

  if (typeof candidate?.insertedCount === 'number') {
    return candidate.insertedCount;
  }

  if (typeof candidate?.modifiedCount === 'number') {
    return candidate.modifiedCount;
  }

  if (typeof candidate?.deletedCount === 'number') {
    return candidate.deletedCount;
  }

  return null;
}

function pushEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>
): void {
  const { slot } = deps.buffer.push(event);
  pushIOEvent(context, slot, deps.config.bufferSize);
}

function instrumentMethod(
  deps: PatchInstallDeps,
  methodName: string,
  original: Function
): Function {
  return function patchedCollectionMethod(this: unknown, ...args: unknown[]) {
    const collection = this as {
      collectionName?: string;
      db?: { databaseName?: string };
    };
    const context = deps.als.getContext();
    const event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'> = {
      phase: 'active',
      startTime: process.hrtime.bigint(),
      endTime: null,
      durationMs: null,
      type: 'db-query',
      direction: 'outbound',
      requestId: context?.requestId ?? null,
      contextLost: context === undefined,
      target: `mongodb://${collection.db?.databaseName ?? 'mongodb'}`,
      method: methodName,
      url: null,
      statusCode: null,
      fd: null,
      requestHeaders: null,
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyTruncated: false,
      responseBodyTruncated: false,
      requestBodyOriginalSize: null,
      responseBodyOriginalSize: null,
      error: null,
      aborted: false,
      dbMeta: {
        query: summarizeKeys(args[0]),
        collection: collection.collectionName
      }
    };
    let finished = false;
    const finish = (result: unknown, error?: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      const endTime = process.hrtime.bigint();

      event.endTime = endTime;
      event.durationMs = toDurationMs(event.startTime, endTime);
      event.phase = 'done';
      event.error =
        error === undefined ? null : { type: error.name, message: error.message };
      event.dbMeta = {
        ...event.dbMeta,
        rowCount: resolveRowCount(result)
      };
      pushEvent(deps, context, event);
    };

    try {
      const result = original.apply(this, args);

      if (isPromiseLike(result)) {
        return result.then(
          (resolved) => {
            finish(resolved);
            return resolved;
          },
          (error) => {
            finish(undefined, error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        );
      }

      if (isCursorLike(result)) {
        pushEvent(deps, context, event);
        finished = true;
        return result;
      }

      finish(result);
      return result;
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
}

export function install(deps: PatchInstallDeps): { uninstall: () => void; state: RecorderState } {
  if (deps.explicitDriver === undefined && detectBundler() === 'webpack') {
    return {
      uninstall: () => undefined,
      state: { state: 'warn', reason: 'bundled-unpatched' }
    };
  }
  try {
    const mongodb = (deps.explicitDriver ?? nodeRequire('mongodb')) as {
      Collection?: { prototype?: object };
    };

    if (mongodb.Collection?.prototype !== undefined) {
      for (const methodName of COLLECTION_METHODS) {
        wrapMethod(mongodb.Collection.prototype, methodName, (original) =>
          instrumentMethod(deps, methodName, original)
        );
      }
    }

    const uninstall = () => {
      if (mongodb.Collection?.prototype !== undefined) {
        for (const methodName of COLLECTION_METHODS) {
          unwrapMethod(mongodb.Collection.prototype, methodName);
        }
      }
    };
    return { uninstall, state: { state: 'ok' } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return {
        uninstall: () => undefined,
        state: { state: 'skip', reason: 'not-installed' }
      };
    }
    console.warn('[ErrorCore] Failed to install mongodb patch');
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'install-failed' }
    };
  }
}
