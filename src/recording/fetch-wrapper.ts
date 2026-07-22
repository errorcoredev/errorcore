
import type { IOEventSlot, RequestContext, TraceHeaders } from '../types';
import type { RecorderState } from '../sdk-diagnostics';
import { safeConsole } from '../debug-log';
import { pendingFetchResolvers } from './undici';
import { pushIOEvent, toDurationMs } from './utils';

interface BodyCaptureLike {
  captureUndiciResponseStream(
    slot: IOEventSlot,
    body: ReadableStream<Uint8Array> | null,
    headers: Record<string, string> | null,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): Promise<void>;
  captureUndiciResponseBuffer(
    slot: IOEventSlot,
    body: Buffer,
    headers: Record<string, string> | null,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
}

interface IOEventBufferLike {
  push?(event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number, slot?: IOEventSlot): void;
}

interface HeaderFilterLike {
  filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
  getTraceHeaders?(): TraceHeaders | null;
  ensureTraceMaterialized?(context: RequestContext): void;
}

interface FetchWrapperDeps {
  als?: ALSManagerLike;
  bodyCapture: BodyCaptureLike;
  buffer: IOEventBufferLike;
  headerFilter: HeaderFilterLike;
  captureResponseBodies: boolean;
}

export interface FetchWrapperHandle {
  uninstall: () => void;
  updateCaptureResponseBodies: (enabled: boolean) => void;
  isCurrent: () => boolean;
  state: RecorderState;
}

interface PreparedFetchArgs {
  input: Parameters<typeof globalThis.fetch>[0];
  init: Parameters<typeof globalThis.fetch>[1];
  requestHeaders: Record<string, string> | null;
}

const SLOT_BIND_TIMEOUT_MS = 5000;

const FETCH_INSTALLED_MARKER = Symbol.for('errorcore.fetchWrapperInstalled');
const FETCH_PATCHED_REF = Symbol.for('errorcore.fetchWrapperPatchedFetch');

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    out[name] = value;
  }
  return out;
}

function applyTraceHeaders(headers: Headers, traceHeaders: TraceHeaders | null): void {
  if (traceHeaders === null) {
    return;
  }

  if (!headers.has('traceparent')) {
    headers.set('traceparent', traceHeaders.traceparent);
  }
  if (traceHeaders.tracestate !== undefined && !headers.has('tracestate')) {
    headers.set('tracestate', traceHeaders.tracestate);
  }
}

function prepareFetchArgs(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  traceHeaders: TraceHeaders | null
): PreparedFetchArgs {
  if (traceHeaders === null) {
    return { input, init, requestHeaders: null };
  }

  if (typeof Request === 'function' && input instanceof Request) {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    applyTraceHeaders(headers, traceHeaders);
    return {
      input: new Request(request, { headers }),
      init: undefined,
      requestHeaders: headersToRecord(headers)
    };
  }

  const headers = new Headers(init?.headers);
  applyTraceHeaders(headers, traceHeaders);
  return {
    input,
    init: { ...(init ?? {}), headers },
    requestHeaders: headersToRecord(headers)
  };
}

function attachContextToSlot(
  slot: IOEventSlot,
  context: RequestContext | undefined
): void {
  if (context === undefined) {
    return;
  }

  if (slot.requestId !== null && slot.contextLost === false) {
    return;
  }

  slot.requestId = context.requestId;
  slot.contextLost = false;
  pushIOEvent(context, slot);
}

function extractFetchInfo(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1]
): {
  method: string;
  target: string;
  url: string | null;
} {
  const method =
    typeof init?.method === 'string'
      ? init.method
      : typeof Request === 'function' && input instanceof Request
        ? input.method
        : 'GET';
  let url: string | null = null;

  if (typeof input === 'string') {
    url = input;
  } else if (typeof URL === 'function' && input instanceof URL) {
    url = input.href;
  } else if (typeof Request === 'function' && input instanceof Request) {
    url = input.url;
  } else {
    url = String(input);
  }

  let target = url ?? 'fetch';
  if (url !== null) {
    try {
      target = new URL(url).origin;
    } catch {
      target = url;
    }
  }

  return {
    method: method.toUpperCase(),
    target,
    url
  };
}

function mergePreparedRequestHeaders(
  slot: IOEventSlot,
  deps: FetchWrapperDeps,
  requestHeaders: Record<string, string> | null
): void {
  if (requestHeaders === null) {
    return;
  }

  slot.requestHeaders = deps.headerFilter.filterAndNormalizeHeaders({
    ...(slot.requestHeaders ?? {}),
    ...requestHeaders
  });
}

function createFallbackFetchSlot(
  deps: FetchWrapperDeps,
  context: RequestContext | undefined,
  prepared: PreparedFetchArgs,
  startTime: bigint
): IOEventSlot | null {
  if (typeof deps.buffer.push !== 'function') {
    return null;
  }

  const info = extractFetchInfo(prepared.input, prepared.init);
  if (context !== undefined) {
    deps.als?.ensureTraceMaterialized?.(context);
  }
  const { slot } = deps.buffer.push({
    phase: 'active',
    startTime,
    endTime: null,
    durationMs: null,
    type: 'undici',
    direction: 'outbound',
    requestId: context?.requestId ?? null,
    contextLost: context === undefined,
    target: info.target,
    method: info.method,
    url: info.url,
    statusCode: null,
    fd: null,
    requestHeaders:
      prepared.requestHeaders === null
        ? null
        : deps.headerFilter.filterAndNormalizeHeaders(prepared.requestHeaders),
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false
  });
  pushIOEvent(context, slot);
  return slot;
}

function findMatchingContextSlot(
  context: RequestContext | undefined,
  prepared: PreparedFetchArgs
): IOEventSlot | null {
  if (context === undefined) {
    return null;
  }

  const info = extractFetchInfo(prepared.input, prepared.init);
  for (let index = context.ioEvents.length - 1; index >= 0; index -= 1) {
    const slot = context.ioEvents[index];
    if (
      slot.type === 'undici' &&
      slot.direction === 'outbound' &&
      slot.method === info.method &&
      slot.url === info.url &&
      slot.target === info.target
    ) {
      return slot;
    }
  }

  return null;
}

function resolveRecordedFetchSlot(
  deps: FetchWrapperDeps,
  context: RequestContext | undefined,
  prepared: PreparedFetchArgs,
  startTime: bigint,
  boundSlot: IOEventSlot | null
): IOEventSlot | null {
  if (boundSlot !== null) {
    return boundSlot;
  }

  return (
    findMatchingContextSlot(context, prepared) ??
    createFallbackFetchSlot(deps, context, prepared, startTime)
  );
}

function finishSlotAt(slot: IOEventSlot, endTime: bigint): void {
  if (slot.endTime !== null) {
    return;
  }

  slot.endTime = endTime;
  slot.durationMs = toDurationMs(slot.startTime, endTime);
  slot.phase = 'done';
}

function markSlotError(slot: IOEventSlot, err: unknown): void {
  const error = err instanceof Error
    ? err
    : new Error(String(err));
  slot.error = {
    type: error.name,
    message: error.message
  };
  const errCode = (err as { code?: unknown } | null)?.code;
  if (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    errCode === 'UND_ERR_ABORTED'
  ) {
    slot.aborted = true;
  }
  finishSlotAt(slot, process.hrtime.bigint());
}

/**
 * Monkey-patches `globalThis.fetch` to capture outbound response bodies and
 * response headers. Each fetch() call:
 *
 *  1. Pushes a slot resolver to {@link pendingFetchResolvers}.
 *  2. Calls the original fetch - undici's diagnostics_channel
 *     `undici:request:create` fires synchronously inside the original
 *     fetch and pops the resolver, binding it to the IOEventSlot.
 *  3. Awaits the response, then teescthe body via response.clone() and
 *     writes the bytes to the slot's responseBody. response.headers are
 *     normalized and filtered via the existing HeaderFilter.
 *
 * Scope: this catches any code path that goes through globalThis.fetch.
 * It does NOT catch direct `undici.request()` or `client.request()` -
 * those bypass the global fetch and currently don't get response-body
 * capture. Direct callers usually consume the body themselves and don't
 * have the parse-failure pattern that motivates Fix 3.
 */
export function installFetchWrapper(deps: FetchWrapperDeps): FetchWrapperHandle {
  const target = globalThis as unknown as Record<symbol | string, unknown> & {
    fetch?: typeof globalThis.fetch;
  };

  if (
    target[FETCH_INSTALLED_MARKER] === true &&
    target[FETCH_PATCHED_REF] === target.fetch
  ) {
    return {
      uninstall: () => undefined,
      updateCaptureResponseBodies: () => undefined,
      isCurrent: () => false,
      state: { state: 'skip', reason: 'already-installed' }
    };
  }

  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') {
    return {
      uninstall: () => undefined,
      updateCaptureResponseBodies: () => undefined,
      isCurrent: () => false,
      state: { state: 'skip', reason: 'fetch-not-available' }
    };
  }

  // Keep SDK-owned dependencies behind a nullable indirection. A framework
  // can retain this function by wrapping it, so restoring globalThis.fetch is
  // not sufficient to release the SDK or prevent duplicate recording.
  let activeDeps: FetchWrapperDeps | null = deps;
  let captureResponseBodies = deps.captureResponseBodies;

  const patched: typeof globalThis.fetch = async function patchedFetch(
    this: typeof globalThis | undefined,
    input,
    init
  ) {
    const invocationDeps = activeDeps;
    if (invocationDeps === null) {
      return originalFetch.call(
        this as unknown as typeof globalThis,
        input,
        init
      );
    }
    const captureBodiesForInvocation = captureResponseBodies;
    let boundSlot: IOEventSlot | null | undefined;
    const startTime = process.hrtime.bigint();
    const bindFetchSlot = (slot: IOEventSlot | null) => {
      clearTimeout(timeoutHandle);
      boundSlot = slot;
    };
    const removePendingResolver = () => {
      const resolverIndex = pendingFetchResolvers.indexOf(bindFetchSlot);
      if (resolverIndex !== -1) {
        pendingFetchResolvers.splice(resolverIndex, 1);
      }
      clearTimeout(timeoutHandle);
    };
    const timeoutHandle = setTimeout(() => {
      if (boundSlot === undefined) {
        boundSlot = null;
      }
      removePendingResolver();
    }, SLOT_BIND_TIMEOUT_MS);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
    pendingFetchResolvers.push(bindFetchSlot);

    const context = invocationDeps.als?.getContext();
    const traceHeaders =
      context === undefined ? null : invocationDeps.als?.getTraceHeaders?.() ?? null;
    const prepared = prepareFetchArgs(input, init, traceHeaders);

    let response: Response;
    try {
      response = await originalFetch.call(
        this as unknown as typeof globalThis,
        prepared.input,
        prepared.init
      );
    } catch (err) {
      // Drain our resolver if it hasn't been popped yet (the dispatch never
      // fired, e.g., URL parse error). Otherwise the queue grows unbounded.
      if (boundSlot === undefined) {
        boundSlot = null;
      }
      removePendingResolver();
      const slot = resolveRecordedFetchSlot(
        invocationDeps,
        context,
        prepared,
        startTime,
        boundSlot
      );
      if (slot !== null) {
        attachContextToSlot(slot, context);
        mergePreparedRequestHeaders(slot, invocationDeps, prepared.requestHeaders);
        markSlotError(slot, err);
      }
      throw err;
    }

    if (boundSlot === undefined) {
      boundSlot = null;
    }
    removePendingResolver();

    const slot = resolveRecordedFetchSlot(
      invocationDeps,
      context,
      prepared,
      startTime,
      boundSlot
    );
    if (slot === null) {
      return response;
    }

    attachContextToSlot(slot, context);
    mergePreparedRequestHeaders(slot, invocationDeps, prepared.requestHeaders);

    // Always overwrite slot.responseHeaders from the Response object. The
    // undici diagnostics_channel handler in UndiciRecorder.handleRequestHeaders
    // sets responseHeaders by passing message.response.headers - which is
    // a Buffer[] of alternating name/value buffers - through HeaderFilter.
    // The filter's array branch only handles flat-pair-of-strings or
    // tuple-of-tuples, not Buffer[], so it returns {} for that shape. The
    // Response object on this side has a proper Headers instance, so we
    // get the real values.
    const headerObj: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      headerObj[name] = value;
    }
    slot.responseHeaders = invocationDeps.headerFilter.filterAndNormalizeHeaders(headerObj);
    if (typeof response.status === 'number') {
      slot.statusCode = response.status;
    }
    finishSlotAt(slot, process.hrtime.bigint());

    if (!captureBodiesForInvocation) {
      return response;
    }

    let captureResponse: Response;
    try {
      captureResponse = response.clone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole.warn(`[ErrorCore] fetch wrapper clone failed: ${message}`);
      slot.responseBodyTruncated = true;
      return response;
    }

    try {
      await invocationDeps.bodyCapture.captureUndiciResponseStream(
        slot,
        captureResponse.body,
        slot.responseHeaders,
        (oldBytes, newBytes) => {
          invocationDeps.buffer.updatePayloadBytes(oldBytes, newBytes, slot);
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole.warn(`[ErrorCore] fetch wrapper capture failed: ${message}`);
    }

    return response;
  };

  target.fetch = patched;
  target[FETCH_INSTALLED_MARKER] = true;
  target[FETCH_PATCHED_REF] = patched;

  return {
    updateCaptureResponseBodies: (enabled) => {
      if (activeDeps !== null) {
        captureResponseBodies = enabled;
      }
    },
    isCurrent: () =>
      activeDeps !== null &&
      target.fetch === patched &&
      target[FETCH_INSTALLED_MARKER] === true &&
      target[FETCH_PATCHED_REF] === patched,
    uninstall: () => {
      activeDeps = null;
      captureResponseBodies = false;

      if (target.fetch === patched) {
        target.fetch = originalFetch;
      }

      if (target[FETCH_PATCHED_REF] === patched) {
        delete target[FETCH_INSTALLED_MARKER];
        delete target[FETCH_PATCHED_REF];
      }
    },
    state: { state: 'ok' }
  };
}

