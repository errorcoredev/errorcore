
import { createRequire } from 'node:module';

import type { IOEventSlot, RequestContext } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';
import { redactSensitiveQueryText } from '../../pii/scrubber';
import { pushIOEvent } from '../utils';

const nodeRequire = createRequire(__filename);

interface PgQueryDetails {
  text: string;
  values: unknown[];
  callbackIndex: number | null;
}

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

function parseQueryArguments(args: unknown[]): PgQueryDetails {
  const first = args[0];
  const second = args[1];
  const third = args[2];

  if (typeof first === 'object' && first !== null && 'text' in first) {
    const queryConfig = first as { text?: unknown; values?: unknown[] };

    return {
      text: typeof queryConfig.text === 'string' ? queryConfig.text : '',
      values: Array.isArray(queryConfig.values)
        ? queryConfig.values
        : Array.isArray(second)
          ? (second as unknown[])
          : [],
      callbackIndex:
        typeof second === 'function' ? 1 : typeof third === 'function' ? 2 : null
    };
  }

  return {
    text: typeof first === 'string' ? first : '',
    values: Array.isArray(second) ? second : [],
    callbackIndex:
      typeof second === 'function' ? 1 : typeof third === 'function' ? 2 : null
  };
}

function getPgTarget(instance: Record<string, unknown>): string {
  const source =
    (instance.connectionParameters as Record<string, unknown> | undefined) ??
    (instance.options as Record<string, unknown> | undefined) ??
    instance;
  const host = typeof source.host === 'string' ? source.host : 'localhost';
  const port =
    typeof source.port === 'number' || typeof source.port === 'string'
      ? String(source.port)
      : '5432';
  const database =
    typeof source.database === 'string' ? source.database : 'postgres';

  return `postgres://${host}:${port}/${database}`;
}

function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === 'function';
}

function isStreamLike(value: unknown): boolean {
  return typeof (value as { on?: unknown } | undefined)?.on === 'function';
}

function pushEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>
): void {
  const { slot } = deps.buffer.push(event);
  pushIOEvent(context, slot, deps.config.bufferSize);
}

function createBaseEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  input: {
    startTime: bigint;
    target: string;
    method: string;
    query: string;
    params: unknown[];
  }
): Omit<IOEventSlot, 'seq' | 'estimatedBytes'> {
  return {
    phase: 'active',
    startTime: input.startTime,
    endTime: null,
    durationMs: null,
    type: 'db-query',
    direction: 'outbound',
    requestId: context?.requestId ?? null,
    contextLost: context === undefined,
    target: input.target,
    method: input.method,
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
      query: input.query,
      params: formatParams(input.params, deps.config.captureDbBindParams),
      rowCount: null
    }
  };
}

function finalizeEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>,
  result: unknown,
  error?: Error
): void {
  const endTime = process.hrtime.bigint();

  event.endTime = endTime;
  event.durationMs = toDurationMs(event.startTime, endTime);
  event.phase = 'done';
  event.error =
    error === undefined ? null : { type: error.name, message: error.message };

  if (typeof (result as { rowCount?: unknown } | undefined)?.rowCount === 'number') {
    event.dbMeta = {
      ...event.dbMeta,
      rowCount: (result as { rowCount: number }).rowCount
    };
  }

  pushEvent(deps, context, event);
}

function instrumentQuery(
  deps: PatchInstallDeps,
  methodName: string,
  original: Function
): Function {
  return function patchedQuery(this: unknown, ...args: unknown[]) {
    const query = parseQueryArguments(args);
    const context = deps.als.getContext();
    const startTime = process.hrtime.bigint();
    const event = createBaseEvent(deps, context, {
      startTime,
      target: getPgTarget(this as Record<string, unknown>),
      method: methodName,
      query: redactSensitiveQueryText(query.text),
      params: query.values
    });
    let finished = false;
    const finish = (result: unknown, error?: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      finalizeEvent(deps, context, event, result, error);
    };

    if (query.callbackIndex !== null) {
      const callback = args[query.callbackIndex] as Function;

      args[query.callbackIndex] = function wrappedCallback(
        this: unknown,
        error: Error | null,
        result: unknown
      ) {
        finish(result, error ?? undefined);
        return callback.apply(this, [error, result]);
      };
    }

    try {
      const result = original.apply(this, args);

      if (query.callbackIndex !== null) {
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

      if (isStreamLike(result)) {
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

export function install(deps: PatchInstallDeps): () => void {
  try {
    const pg = (deps.explicitDriver ?? nodeRequire('pg')) as {
      Client?: { prototype?: object };
      Pool?: { prototype?: object };
    };

    if (pg.Client?.prototype !== undefined) {
      wrapMethod(pg.Client.prototype, 'query', (original) =>
        instrumentQuery(deps, 'query', original)
      );
    }

    if (pg.Pool?.prototype !== undefined) {
      wrapMethod(pg.Pool.prototype, 'query', (original) =>
        instrumentQuery(deps, 'query', original)
      );
    }

    return () => {
      if (pg.Client?.prototype !== undefined) {
        unwrapMethod(pg.Client.prototype, 'query');
      }

      if (pg.Pool?.prototype !== undefined) {
        unwrapMethod(pg.Pool.prototype, 'query');
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      console.warn('[ErrorCore] Failed to install pg patch');
    }

    return () => undefined;
  }
}
