
import { createRequire } from 'node:module';

import type { IOEventSlot, RequestContext } from '../../types';
import type { PatchInstallDeps } from './patch-manager';
import { wrapMethod, unwrapMethod } from './patch-manager';

const nodeRequire = createRequire(__filename);

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

function pushEvent(
  deps: PatchInstallDeps,
  context: RequestContext | undefined,
  event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>
): void {
  const { slot } = deps.buffer.push(event);
  context?.ioEvents.push(slot);
}

export function install(deps: PatchInstallDeps): () => void {
  try {
    const Redis = nodeRequire('ioredis') as { prototype?: object };

    if (Redis.prototype !== undefined) {
      wrapMethod(Redis.prototype, 'sendCommand', (original) => {
        return function patchedSendCommand(this: unknown, command: {
          name?: string;
          args?: unknown[];
        }) {
          const context = deps.als.getContext();
          const startTime = process.hrtime.bigint();
          const name = typeof command?.name === 'string' ? command.name : 'UNKNOWN';
          const key =
            Array.isArray(command?.args) && typeof command.args[0] === 'string'
              ? command.args[0]
              : undefined;
          const event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'> = {
            phase: 'active',
            startTime,
            endTime: null,
            durationMs: null,
            type: 'db-query',
            direction: 'outbound',
            requestId: context?.requestId ?? null,
            contextLost: context === undefined,
            target: getTarget(this as Record<string, unknown>),
            method: name,
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
              query: key === undefined ? name : `${name} ${key}`,
              collection: key
            }
          };
          let finished = false;
          const finish = (error?: Error): void => {
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
            pushEvent(deps, context, event);
          };

          try {
            const result = original.apply(this, [command]);

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
              );
            }

            finish();
            return result;
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        };
      });
    }

    return () => {
      if (Redis.prototype !== undefined) {
        unwrapMethod(Redis.prototype, 'sendCommand');
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      console.warn('[ErrorCore] Failed to install ioredis patch');
    }

    return () => undefined;
  }
}
