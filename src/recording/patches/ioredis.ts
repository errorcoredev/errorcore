
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { IOEventSlot, RequestContext } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';
import { scrubCacheKey } from '../../pii/scrubber';
import { pushIOEvent } from '../utils';
import type { RecorderState } from '../../sdk-diagnostics';
import { detectBundler } from '../../sdk-diagnostics';
import { safeConsole } from '../../debug-log';
import { attachSupplementalLocals } from '../../capture/supplemental-locals';

// Resolve drivers from the *application's* require root, not the SDK's
// own node_modules. Otherwise drivers that exist only as the SDK's
// devDependencies (mongodb, ioredis) get patched in services that
// don't actually use them, producing phantom "ok" diagnostics.
const appRequire = createRequire(path.join(process.cwd(), 'noop.js'));
const PIPELINE_PATCHED = Symbol('errorcore.ioredis.pipelinePatched');
const recordingDepth = new WeakMap<object, number>();
const REDIS_COMMAND_METHODS = [
  'get',
  'set',
  'del',
  'exists',
  'expire',
  'ping',
  'hget',
  'hset',
  'hmset',
  'zincrby',
  'zrevrange',
  'xadd',
  'xread'
];

interface RedisCommandLike {
  name?: string;
  args?: unknown[];
}

interface ParsedRedisCommand {
  name: string;
  args: unknown[];
}

function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === 'function';
}

function getTarget(instance: Record<string, unknown>): string {
  const options = (instance.options as Record<string, unknown> | undefined) ?? instance;
  const host = typeof options.host === 'string' ? options.host : 'localhost';
  const port =
    typeof options.port === 'number' || typeof options.port === 'string'
      ? String(options.port)
      : '6379';

  return `redis://${host}:${port}`;
}

function getRecordingKey(instance: unknown): object | null {
  return typeof instance === 'object' && instance !== null ? instance : null;
}

function isRecording(instance: unknown): boolean {
  const key = getRecordingKey(instance);
  return key !== null && (recordingDepth.get(key) ?? 0) > 0;
}

function withRecording<T>(instance: unknown, run: () => T): T {
  const key = getRecordingKey(instance);
  if (key === null) {
    return run();
  }

  const depth = recordingDepth.get(key) ?? 0;
  recordingDepth.set(key, depth + 1);
  try {
    return run();
  } finally {
    if (depth === 0) {
      recordingDepth.delete(key);
    } else {
      recordingDepth.set(key, depth);
    }
  }
}

function commandFromSendCommand(command: RedisCommandLike | undefined): ParsedRedisCommand {
  return {
    name: typeof command?.name === 'string' ? command.name : 'UNKNOWN',
    args: Array.isArray(command?.args) ? command.args : []
  };
}

function scrubRedisCommand(input: ParsedRedisCommand): {
  query: string;
  collection: string | undefined;
} {
  // AUTH and HELLO can carry credentials in different argument positions.
  // Record the command name but never retain any argument for them.
  const nameUpper = input.name.toUpperCase();
  const isCredentialCommand = nameUpper === 'AUTH' || nameUpper === 'HELLO';
  const rawKey = typeof input.args[0] === 'string' ? input.args[0] : undefined;
  const key =
    isCredentialCommand || rawKey === undefined
      ? undefined
      : scrubCacheKey(rawKey);

  return {
    query: isCredentialCommand
      ? `${input.name} [REDACTED]`
      : key === undefined
        ? input.name
        : `${input.name} ${key}`,
    collection: key
  };
}

function createRedisEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  instance: Record<string, unknown>,
  command: ParsedRedisCommand,
  startTime: bigint
): Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'> {
  const scrubbed = scrubRedisCommand(command);
  return {
    phase: 'active',
    startTime,
    endTime: null,
    durationMs: null,
    type: 'db-query',
    direction: 'outbound',
    requestId: context?.requestId ?? null,
    contextLost: context === undefined,
    target: getTarget(instance),
    method: command.name,
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
      query: scrubbed.query,
      collection: scrubbed.collection
    }
  };
}

function finalizeRedisEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>,
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
        functionName: 'redis.command input',
        filePath: '',
        lineNumber: 0,
        columnNumber: 0,
        locals: {
          redisCommand: event.method ?? 'unknown',
          redisKey: event.dbMeta?.collection ?? null,
          redisQuery: event.dbMeta?.query ?? event.method ?? 'unknown',
          redisTarget: event.target ?? null
        }
      }
    ]);
  }

  if (context !== undefined) {
    deps.als.ensureTraceMaterialized?.(context);
  }
  const { slot } = deps.buffer.push(event);
  pushIOEvent(context, slot, deps.config.bufferSize);
}

function recordRedisOperation<T>(
  deps: PatchInstallDeps,
  instance: unknown,
  command: ParsedRedisCommand,
  invoke: () => T
): T {
  if (isRecording(instance)) {
    return invoke();
  }

  const context = deps.als.getContext();
  const event = createRedisEvent(
    deps,
    context,
    instance as Record<string, unknown>,
    command,
    process.hrtime.bigint()
  );
  let finished = false;
  const finish = (error?: Error): void => {
    if (finished) {
      return;
    }

    finished = true;
    finalizeRedisEvent(deps, context, event, error);
  };

  try {
    const result = withRecording(instance, invoke);

    if (isPromiseLike(result)) {
      return result.then(
        (resolved) => {
          finish();
          return resolved;
        },
        (error) => {
          finish(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      ) as T;
    }

    finish();
    return result;
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

function parsePipelineQueueEntry(entry: unknown): ParsedRedisCommand | null {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }

  const candidate = entry as RedisCommandLike;
  if (typeof candidate.name === 'string') {
    return {
      name: candidate.name,
      args: Array.isArray(candidate.args) ? candidate.args : []
    };
  }

  const command = (entry as { command?: RedisCommandLike }).command;
  if (typeof command?.name === 'string') {
    return {
      name: command.name,
      args: Array.isArray(command.args) ? command.args : []
    };
  }

  return null;
}

function readPipelineCommands(
  pipeline: Record<string | symbol, unknown>,
  queuedByWrapper: ParsedRedisCommand[]
): ParsedRedisCommand[] {
  const nativeQueue = pipeline._queue;
  if (Array.isArray(nativeQueue) && nativeQueue.length > 0) {
    return nativeQueue
      .map(parsePipelineQueueEntry)
      .filter((entry): entry is ParsedRedisCommand => entry !== null);
  }

  return queuedByWrapper.slice();
}

function patchPipelineInstance(
  deps: PatchInstallDeps,
  redisInstance: unknown,
  pipeline: unknown
): void {
  if (pipeline === null || typeof pipeline !== 'object') {
    return;
  }

  const target = pipeline as Record<string | symbol, unknown>;
  if (target[PIPELINE_PATCHED] === true) {
    return;
  }

  Object.defineProperty(target, PIPELINE_PATCHED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const pipelineContext = deps.als.getContext();
  const queuedByWrapper: ParsedRedisCommand[] = [];

  for (const methodName of REDIS_COMMAND_METHODS) {
    const original = target[methodName];
    if (typeof original !== 'function') {
      continue;
    }

    target[methodName] = function patchedPipelineCommand(this: unknown, ...args: unknown[]) {
      queuedByWrapper.push({ name: methodName, args });
      return (original as Function).apply(this, args);
    };
  }

  const originalExec = target.exec;
  if (typeof originalExec !== 'function') {
    return;
  }

  target.exec = function patchedPipelineExec(this: unknown, ...args: unknown[]) {
    const context = deps.als.getContext() ?? pipelineContext;
    const commands = readPipelineCommands(target, queuedByWrapper);
    const startTime = process.hrtime.bigint();
    const events = commands.map((command) =>
      createRedisEvent(
        deps,
        context,
        redisInstance as Record<string, unknown>,
        command,
        startTime
      )
    );
    let finished = false;
    const finish = (result: unknown, error?: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      const resultRows = Array.isArray(result) ? result : [];
      for (let index = 0; index < events.length; index += 1) {
        const row = resultRows[index];
        const rowError = Array.isArray(row) && row[0] instanceof Error ? row[0] : undefined;
        finalizeRedisEvent(deps, context, events[index], error ?? rowError);
      }
    };

    try {
      const result = (originalExec as Function).apply(this, args);
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
    const Redis = (deps.explicitDriver ?? appRequire('ioredis')) as { prototype?: object };

    let wrappedMethods = 0;

    if (
      Redis.prototype !== undefined &&
      typeof (Redis.prototype as Record<string, unknown>).sendCommand === 'function'
    ) {
      wrapMethod(Redis.prototype, 'sendCommand', (original) => {
        return function patchedSendCommand(this: unknown, command: RedisCommandLike) {
          return recordRedisOperation(
            deps,
            this,
            commandFromSendCommand(command),
            () => original.apply(this, [command])
          );
        };
      });
      wrappedMethods += 1;
    }

    if (Redis.prototype !== undefined) {
      for (const methodName of REDIS_COMMAND_METHODS) {
        if (typeof (Redis.prototype as Record<string, unknown>)[methodName] !== 'function') {
          continue;
        }

        wrapMethod(Redis.prototype, methodName, (original) => {
          return function patchedRedisCommand(this: unknown, ...args: unknown[]) {
            return recordRedisOperation(
              deps,
              this,
              { name: methodName, args },
              () => original.apply(this, args)
            );
          };
        });
        wrappedMethods += 1;
      }

      if (typeof (Redis.prototype as Record<string, unknown>).pipeline === 'function') {
        wrapMethod(Redis.prototype, 'pipeline', (original) => {
          return function patchedPipeline(this: unknown, ...args: unknown[]) {
            const pipeline = original.apply(this, args);
            patchPipelineInstance(deps, this, pipeline);
            return pipeline;
          };
        });
        wrappedMethods += 1;
      }
    }

    const uninstall = () => {
      if (Redis.prototype !== undefined) {
        unwrapMethod(Redis.prototype, 'sendCommand');
        unwrapMethod(Redis.prototype, 'pipeline');
        for (const methodName of REDIS_COMMAND_METHODS) {
          unwrapMethod(Redis.prototype, methodName);
        }
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
    safeConsole.warn('[ErrorCore] Failed to install ioredis patch');
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'install-failed' }
    };
  }
}
