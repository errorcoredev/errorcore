
import dns = require('node:dns');
import net = require('node:net');
import type { Socket } from 'node:net';

import type { IOEventSlot, RequestContext } from '../types';
import { installOwnedWrapper } from './patches/patch-manager';
import { isInternalCallActive, runAsInternal } from './internal';
import { extractFd, pushIOEvent, toDurationMs } from './utils';
import type { RecorderState } from '../sdk-diagnostics';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
}

type RestoreFn = () => void;

export { runAsInternal };

function buildNetTarget(args: unknown[]): string {
  const first = args[0];

  if (typeof first === 'object' && first !== null) {
    const options = first as Record<string, unknown>;

    if (typeof options.path === 'string') {
      return options.path;
    }

    const host = typeof options.host === 'string' ? options.host : 'localhost';
    const port =
      typeof options.port === 'number' || typeof options.port === 'string'
        ? String(options.port)
        : '';

    return port === '' ? host : `${host}:${port}`;
  }

  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${first}`;
  }

  if (typeof first === 'string') {
    return first;
  }

  return 'tcp';
}

export class NetDnsRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly restores: RestoreFn[] = [];

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.patchNet();
    this.patchDns();
  }

  public handleNetConnect(message: {
    target?: string;
    socket?: Socket;
    startTime?: bigint;
    endTime?: bigint;
    context?: RequestContext;
    error?: Error;
  }): void {
    try {
      if (isInternalCallActive()) {
        return;
      }

      const context = message.context;
      const startTime = message.startTime ?? process.hrtime.bigint();
      const endTime = message.endTime ?? process.hrtime.bigint();
      const { slot } = this.buffer.push({
        phase: 'done',
        startTime,
        endTime,
        durationMs: toDurationMs(startTime, endTime),
        type: 'tcp',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: message.target ?? 'tcp',
        method: null,
        url: null,
        statusCode: null,
        fd: extractFd(message.socket),
        requestHeaders: null,
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error:
          message.error === undefined
            ? null
            : { type: message.error.name, message: message.error.message },
        aborted: false
      });

      pushIOEvent(context, slot);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Failed to record TCP connect: ${messageText}`);
    }
  }

  public handleDnsLookup(message: {
    hostname?: string;
    startTime?: bigint;
    endTime?: bigint;
    durationMs?: number;
    context?: RequestContext;
    error?: Error | null;
  }): void {
    try {
      const context = message.context;
      const startTime = message.startTime ?? process.hrtime.bigint();
      const endTime = message.endTime ?? process.hrtime.bigint();
      const { slot } = this.buffer.push({
        phase: 'done',
        startTime,
        endTime,
        durationMs: message.durationMs ?? toDurationMs(startTime, endTime),
        type: 'dns',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: message.hostname ?? 'unknown',
        method: null,
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
        error:
          message.error === null || message.error === undefined
            ? null
            : { type: message.error.name, message: message.error.message },
        aborted: false
      });

      pushIOEvent(context, slot);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ErrorCore] Failed to record DNS lookup: ${messageText}`);
    }
  }

  public shutdown(): void {
    while (this.restores.length > 0) {
      this.restores.pop()?.();
    }
  }

  public getState(): RecorderState {
    return { state: 'ok' };
  }

  private patchNet(): void {
    this.patchNetMethod('connect');
    this.patchNetMethod('createConnection');
  }

  private patchNetMethod(methodName: 'connect' | 'createConnection'): void {
    const recorder = this;
    const installation = installOwnedWrapper(net, methodName, (original) =>
      function ownedNetConnect(this: typeof net, ...args: unknown[]) {
        if (isInternalCallActive()) {
          return original.apply(net, args);
        }

        const startTime = process.hrtime.bigint();
        const target = buildNetTarget(args);
        const context = recorder.als.getContext();
        const socket = original.apply(net, args) as Socket | undefined;

        if (socket === undefined || typeof socket.once !== 'function') {
          return socket;
        }

        let finished = false;
        const finalize = (error?: Error): void => {
          if (finished) {
            return;
          }

          finished = true;
          recorder.handleNetConnect({
            target,
            socket,
            startTime,
            endTime: process.hrtime.bigint(),
            context,
            error
          });
        };

        socket.once('connect', () => {
          finalize();
        });

        socket.once('error', (error) => {
          finalize(error instanceof Error ? error : new Error(String(error)));
        });

        return socket;
      }
    );

    if (installation !== null) {
      this.restores.push(installation.restore);
    }
  }

  private patchDns(): void {
    this.patchDnsMethod('lookup');
    this.patchDnsMethod('resolve');
    this.patchDnsMethod('resolve4');
    this.patchDnsMethod('resolve6');
  }

  private patchDnsMethod(
    methodName: 'lookup' | 'resolve' | 'resolve4' | 'resolve6'
  ): void {
    const recorder = this;
    const installation = installOwnedWrapper(dns, methodName, (original) =>
      function ownedDnsMethod(this: typeof dns, ...args: unknown[]) {
        if (isInternalCallActive()) {
          return original.apply(dns, args);
        }

        const startTime = process.hrtime.bigint();
        const context = recorder.als.getContext();
        const hostname = typeof args[0] === 'string' ? args[0] : 'unknown';
        const callback = args[args.length - 1];

        if (typeof callback !== 'function') {
          return original.apply(dns, args);
        }

        const wrappedCallback = (...callbackArgs: unknown[]) => {
          const error =
            callbackArgs[0] instanceof Error
              ? callbackArgs[0]
              : callbackArgs[0] === null || callbackArgs[0] === undefined
                ? null
                : new Error(String(callbackArgs[0]));
          const endTime = process.hrtime.bigint();

          recorder.handleDnsLookup({
            hostname,
            startTime,
            endTime,
            durationMs: toDurationMs(startTime, endTime),
            context,
            error
          });

          return (callback as (...input: unknown[]) => unknown)(...callbackArgs);
        };

        const nextArgs = [...args.slice(0, -1), wrappedCallback];

        return original.apply(dns, nextArgs);
      }
    );

    if (installation !== null) {
      this.restores.push(installation.restore);
    }
  }
}
