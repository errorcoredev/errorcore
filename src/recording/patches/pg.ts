
import { createRequire } from 'node:module';

import type { IOEventSlot, RequestContext, ResolvedConfig } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';
import {
  Scrubber,
  redactSensitiveQueryText,
  scrubKeyValueAssignments
} from '../../pii/scrubber';
import { pushIOEvent } from '../utils';
import type { RecorderState } from '../../sdk-diagnostics';
import { detectBundler } from '../../sdk-diagnostics';
import { safeConsole } from '../../debug-log';
import { attachSupplementalLocals } from '../../capture/supplemental-locals';

const nodeRequire = createRequire(__filename);

interface PgQueryDetails {
  text: string;
  values: unknown[];
  callbackIndex: number | null;
}

type PgQuerySource = 'client' | 'pool';

const activePoolQueriesByContext = new WeakMap<RequestContext, Map<string, number>>();
const activePoolQueriesWithoutContext = new Map<string, number>();

function stringifyParam(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function scrubParam(value: unknown, scrubber: Scrubber): unknown {
  const scrubbed = scrubber.scrubValue('', value);
  if (typeof scrubbed === 'string') {
    return scrubKeyValueAssignments(scrubbed);
  }

  return scrubbed;
}

function formatParams(values: unknown[], config: ResolvedConfig): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  if (!config.captureDbBindParams) {
    return values.map((_, index) => `[PARAM_${index + 1}]`).join(', ');
  }

  const scrubber = new Scrubber(config);
  return values
    .map((value) => stringifyParam(scrubParam(value, scrubber)))
    .join(', ');
}

function querySignature(query: PgQueryDetails): string {
  return `${query.text}\u0000${query.values.map(stringifyParam).join('\u0000')}`;
}

function getActivePoolQueryMap(context: RequestContext | undefined): Map<string, number> {
  if (context === undefined) {
    return activePoolQueriesWithoutContext;
  }

  let map = activePoolQueriesByContext.get(context);
  if (map === undefined) {
    map = new Map<string, number>();
    activePoolQueriesByContext.set(context, map);
  }
  return map;
}

function hasActivePoolQuery(context: RequestContext | undefined, signature: string): boolean {
  return getActivePoolQueryMap(context).has(signature);
}

function markActivePoolQuery(context: RequestContext | undefined, signature: string): () => void {
  const map = getActivePoolQueryMap(context);
  map.set(signature, (map.get(signature) ?? 0) + 1);
  return () => {
    const count = map.get(signature);
    if (count === undefined) {
      return;
    }
    if (count <= 1) {
      map.delete(signature);
    } else {
      map.set(signature, count - 1);
    }
  };
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
  event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>
): void {
  if (context !== undefined) {
    deps.als.ensureTraceMaterialized?.(context);
  }
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
): Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'> {
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
      params: formatParams(input.params, deps.config),
      rowCount: null
    }
  };
}

function finalizeEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>,
  result: unknown,
  error?: Error
): void {
  const endTime = process.hrtime.bigint();

  event.endTime = endTime;
  event.durationMs = toDurationMs(event.startTime, endTime);
  event.phase = 'done';
  event.error =
    error === undefined ? null : { type: error.name, message: error.message };

  if (error !== undefined) {
    attachSupplementalLocals(error, [
      {
        functionName: 'pg.query input',
        filePath: '',
        lineNumber: 0,
        columnNumber: 0,
        locals: {
          input: {
            query: event.dbMeta?.query,
            params: event.dbMeta?.params
          }
        }
      }
    ]);
  }

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
  original: Function,
  source: PgQuerySource
): Function {
  return function patchedQuery(this: unknown, ...args: unknown[]) {
    const query = parseQueryArguments(args);
    const context = deps.als.getContext();
    const signature = querySignature(query);
    if (source === 'client' && hasActivePoolQuery(context, signature)) {
      return original.apply(this, args);
    }

    let releasePoolQuery: (() => void) | null =
      source === 'pool' ? markActivePoolQuery(context, signature) : null;
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
      releasePoolQuery?.();
      releasePoolQuery = null;
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
        releasePoolQuery?.();
        releasePoolQuery = null;
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

function instrumentConnection(
  deps: PatchInstallDeps,
  methodName: string,
  original: Function
): Function {
  return function patchedConnection(this: unknown, ...args: unknown[]) {
    const context = deps.als.getContext();
    const startTime = process.hrtime.bigint();
    const event = createBaseEvent(deps, context, {
      startTime,
      target: getPgTarget(this as Record<string, unknown>),
      method: methodName,
      query: methodName,
      params: []
    });
    const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
    let finished = false;
    const finish = (result: unknown, error?: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      finalizeEvent(deps, context, event, result, error);
    };

    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as Function;
      args[callbackIndex] = function wrappedConnectionCallback(
        this: unknown,
        error: Error | null,
        ...callbackArgs: unknown[]
      ) {
        finish(callbackArgs[0], error ?? undefined);
        return callback.apply(this, [error, ...callbackArgs]);
      };
    }

    try {
      const result = original.apply(this, args);

      if (callbackIndex >= 0) {
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

export function install(deps: PatchInstallDeps): { uninstall: () => void; state: RecorderState } {
  if (deps.explicitDriver === undefined && detectBundler() === 'webpack') {
    return {
      uninstall: () => undefined,
      state: { state: 'warn', reason: 'bundled-unpatched' }
    };
  }
  try {
    const pg = (deps.explicitDriver ?? nodeRequire('pg')) as {
      Client?: { prototype?: object };
      Pool?: { prototype?: object };
    };

    let wrappedMethods = 0;

    if (
      pg.Client?.prototype !== undefined &&
      typeof (pg.Client.prototype as Record<string, unknown>).query === 'function'
    ) {
      wrapMethod(pg.Client.prototype, 'query', (original) =>
        instrumentQuery(deps, 'query', original, 'client')
      );
      wrappedMethods += 1;
    }

    if (
      pg.Client?.prototype !== undefined &&
      typeof (pg.Client.prototype as Record<string, unknown>).connect === 'function'
    ) {
      wrapMethod(pg.Client.prototype, 'connect', (original) =>
        instrumentConnection(deps, 'connect', original)
      );
      wrappedMethods += 1;
    }

    if (
      pg.Pool?.prototype !== undefined &&
      typeof (pg.Pool.prototype as Record<string, unknown>).query === 'function'
    ) {
      wrapMethod(pg.Pool.prototype, 'query', (original) =>
        instrumentQuery(deps, 'query', original, 'pool')
      );
      wrappedMethods += 1;
    }

    if (
      pg.Pool?.prototype !== undefined &&
      typeof (pg.Pool.prototype as Record<string, unknown>).connect === 'function'
    ) {
      wrapMethod(pg.Pool.prototype, 'connect', (original) =>
        instrumentConnection(deps, 'connect', original)
      );
      wrappedMethods += 1;
    }

    if (
      pg.Pool?.prototype !== undefined &&
      typeof (pg.Pool.prototype as Record<string, unknown>).acquire === 'function'
    ) {
      wrapMethod(pg.Pool.prototype, 'acquire', (original) =>
        instrumentConnection(deps, 'acquire', original)
      );
      wrappedMethods += 1;
    }

    const uninstall = () => {
      if (pg.Client?.prototype !== undefined) {
        unwrapMethod(pg.Client.prototype, 'query');
        unwrapMethod(pg.Client.prototype, 'connect');
      }

      if (pg.Pool?.prototype !== undefined) {
        unwrapMethod(pg.Pool.prototype, 'query');
        unwrapMethod(pg.Pool.prototype, 'connect');
        unwrapMethod(pg.Pool.prototype, 'acquire');
      }
    };

    if (wrappedMethods === 0) {
      return { uninstall, state: { state: 'warn', reason: 'no-supported-methods' } };
    }

    return { uninstall, state: { state: 'ok' } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return {
        uninstall: () => undefined,
        state: { state: 'skip', reason: 'not-installed' }
      };
    }
    safeConsole.warn('[ErrorCore] Failed to install pg patch');
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'install-failed' }
    };
  }
}
