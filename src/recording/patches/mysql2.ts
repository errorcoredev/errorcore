
import { createRequire } from 'node:module';

import type { IOEventSlot, RequestContext } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';
import { redactSensitiveQueryText } from '../../pii/scrubber';
import { pushIOEvent } from '../utils';

const nodeRequire = createRequire(__filename);

function formatParams(values: unknown[], captureActualValues: boolean): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  if (!captureActualValues) {
    return values.map((_, index) => `[PARAM_${index + 1}]`).join(', ');
  }

  return values
    .map((value) => {
      if (typeof value === 'string') {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(', ');
}

function getMysqlTarget(instance: Record<string, unknown>): string {
  const source =
    (instance.config as Record<string, unknown> | undefined) ??
    (instance.connectionConfig as Record<string, unknown> | undefined) ??
    instance;
  const host = typeof source.host === 'string' ? source.host : 'localhost';
  const port =
    typeof source.port === 'number' || typeof source.port === 'string'
      ? String(source.port)
      : '3306';
  const database =
    typeof source.database === 'string' ? source.database : 'mysql';

  return `mysql://${host}:${port}/${database}`;
}

function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === 'function';
}

function parseArgs(args: unknown[]): {
  sql: string;
  values: unknown[];
  callbackIndex: number | null;
} {
  return {
    sql: typeof args[0] === 'string' ? args[0] : '',
    values: Array.isArray(args[1]) ? (args[1] as unknown[]) : [],
    callbackIndex:
      typeof args[1] === 'function' ? 1 : typeof args[2] === 'function' ? 2 : null
  };
}

function resolveRowCount(result: unknown): number | null {
  if (typeof (result as { affectedRows?: unknown } | undefined)?.affectedRows === 'number') {
    return (result as { affectedRows: number }).affectedRows;
  }

  if (Array.isArray(result)) {
    return result.length;
  }

  if (
    Array.isArray((result as [unknown, unknown] | undefined)?.[0])
  ) {
    return ((result as [unknown[], unknown])[0]).length;
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
  return function patchedMysqlMethod(this: unknown, ...args: unknown[]) {
    const parsed = parseArgs(args);
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
      target: getMysqlTarget(this as Record<string, unknown>),
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
        query: redactSensitiveQueryText(parsed.sql),
        params: formatParams(parsed.values, deps.config.captureDbBindParams),
        rowCount: null
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

    if (parsed.callbackIndex !== null) {
      const callback = args[parsed.callbackIndex] as Function;

      args[parsed.callbackIndex] = function wrappedCallback(
        this: unknown,
        error: Error | null,
        result: unknown,
        fields: unknown
      ) {
        finish(result, error ?? undefined);
        return callback.apply(this, [error, result, fields]);
      };
    }

    try {
      const result = original.apply(this, args);

      if (parsed.callbackIndex !== null) {
        return result;
      }

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

      finish(result);
      return result;
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
}

export function install(deps: PatchInstallDeps): () => void {
  try {
    const mysql2 = (deps.explicitDriver ?? nodeRequire('mysql2')) as {
      Connection?: { prototype?: object };
    };

    if (mysql2.Connection?.prototype !== undefined) {
      wrapMethod(mysql2.Connection.prototype, 'query', (original) =>
        instrumentMethod(deps, 'query', original)
      );
      wrapMethod(mysql2.Connection.prototype, 'execute', (original) =>
        instrumentMethod(deps, 'execute', original)
      );
    }

    return () => {
      if (mysql2.Connection?.prototype !== undefined) {
        unwrapMethod(mysql2.Connection.prototype, 'query');
        unwrapMethod(mysql2.Connection.prototype, 'execute');
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      console.warn('[ErrorCore] Failed to install mysql2 patch');
    }

    return () => undefined;
  }
}
