
import type { IOEventSlot } from '../types';
import type { RecorderState } from '../sdk-diagnostics';
import { safeConsole } from '../debug-log';
import { pendingFetchResolvers } from './undici';

interface BodyCaptureLike {
  captureUndiciResponseBuffer(
    slot: IOEventSlot,
    body: Buffer,
    headers: Record<string, string> | null,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
}

interface IOEventBufferLike {
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface HeaderFilterLike {
  filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
}

interface FetchWrapperDeps {
  bodyCapture: BodyCaptureLike;
  buffer: IOEventBufferLike;
  headerFilter: HeaderFilterLike;
  captureResponseBodies: boolean;
}

interface FetchWrapperHandle {
  uninstall: () => void;
  state: RecorderState;
}

const SLOT_BIND_TIMEOUT_MS = 5000;

const FETCH_INSTALLED_MARKER = Symbol.for('errorcore.fetchWrapperInstalled');

/**
 * Monkey-patches `globalThis.fetch` to capture outbound response bodies and
 * response headers. Each fetch() call:
 *
 *  1. Pushes a slot resolver to {@link pendingFetchResolvers}.
 *  2. Calls the original fetch — undici's diagnostics_channel
 *     `undici:request:create` fires synchronously inside the original
 *     fetch and pops the resolver, binding it to the IOEventSlot.
 *  3. Awaits the response, then teescthe body via response.clone() and
 *     writes the bytes to the slot's responseBody. response.headers are
 *     normalized and filtered via the existing HeaderFilter.
 *
 * Scope: this catches any code path that goes through globalThis.fetch.
 * It does NOT catch direct `undici.request()` or `client.request()` —
 * those bypass the global fetch and currently don't get response-body
 * capture. Direct callers usually consume the body themselves and don't
 * have the parse-failure pattern that motivates Fix 3.
 */
export function installFetchWrapper(deps: FetchWrapperDeps): FetchWrapperHandle {
  if (!deps.captureResponseBodies) {
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'response-body-capture-disabled' }
    };
  }

  const target = globalThis as unknown as Record<symbol | string, unknown> & {
    fetch?: typeof globalThis.fetch;
  };

  if (target[FETCH_INSTALLED_MARKER] === true) {
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'already-installed' }
    };
  }

  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') {
    return {
      uninstall: () => undefined,
      state: { state: 'skip', reason: 'fetch-not-available' }
    };
  }

  const patched: typeof globalThis.fetch = async function patchedFetch(
    this: typeof globalThis | undefined,
    input,
    init
  ) {
    let resolveSlot: (slot: IOEventSlot | null) => void = () => undefined;
    const slotPromise = new Promise<IOEventSlot | null>((resolve) => {
      resolveSlot = resolve;
    });
    const timeoutHandle = setTimeout(() => resolveSlot(null), SLOT_BIND_TIMEOUT_MS);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    pendingFetchResolvers.push((slot) => {
      clearTimeout(timeoutHandle);
      resolveSlot(slot);
    });

    let response: Response;
    try {
      response = await originalFetch.call(this as unknown as typeof globalThis, input, init);
    } catch (err) {
      // Drain our resolver if it hasn't been popped yet (the dispatch never
      // fired, e.g., URL parse error). Otherwise the queue grows unbounded.
      resolveSlot(null);
      throw err;
    }

    const slot = await slotPromise;
    if (slot === null) {
      return response;
    }

    // Drain the body inline and reconstruct a fresh Response from the
    // buffered bytes. Earlier prototype used response.clone() + a
    // backgrounded arrayBuffer() so the wrapper returned the original
    // response immediately — but the parse-failure scenarios the SDK is
    // designed to observe (scenario 07: payments.json() throws) capture
    // synchronously after fetch returns, before the backgrounded drain
    // settles, so slot.responseBody stays null.
    //
    // Tradeoff: this buffers the entire body in memory before the
    // application sees it, breaking streaming-style response handling.
    // For the demo's content types (application/json, text/plain,
    // x-www-form-urlencoded) bounded by maxPayloadSize, this is
    // acceptable. Streaming consumers and very large bodies would need a
    // tee'd ReadableStream — out of scope for this pass.
    let buf: Buffer;
    try {
      const arrayBuffer = await response.arrayBuffer();
      buf = Buffer.from(arrayBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole.warn(`[ErrorCore] fetch wrapper drain failed: ${message}`);
      slot.responseBodyTruncated = true;
      return response;
    }

    // Always overwrite slot.responseHeaders from the Response object. The
    // undici diagnostics_channel handler in UndiciRecorder.handleRequestHeaders
    // sets responseHeaders by passing message.response.headers — which is
    // a Buffer[] of alternating name/value buffers — through HeaderFilter.
    // The filter's array branch only handles flat-pair-of-strings or
    // tuple-of-tuples, not Buffer[], so it returns {} for that shape. The
    // Response object on this side has a proper Headers instance, so we
    // get the real values.
    const headerObj: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      headerObj[name] = value;
    }
    slot.responseHeaders = deps.headerFilter.filterAndNormalizeHeaders(headerObj);
    if (typeof response.status === 'number') {
      slot.statusCode = response.status;
    }

    try {
      deps.bodyCapture.captureUndiciResponseBuffer(
        slot,
        buf,
        slot.responseHeaders,
        (oldBytes, newBytes) => {
          deps.buffer.updatePayloadBytes(oldBytes, newBytes);
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole.warn(`[ErrorCore] fetch wrapper capture failed: ${message}`);
    }

    // Reconstruct a Response so the application can still read the body
    // via .json() / .text() / .arrayBuffer(). Node Buffer extends
    // Uint8Array which is a valid BodyInit; the cast bypasses a TS lib
    // version mismatch where Buffer<ArrayBufferLike> is not narrowed
    // to BodyInit.
    return new Response(buf as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };

  target.fetch = patched;
  target[FETCH_INSTALLED_MARKER] = true;

  return {
    uninstall: () => {
      if (target.fetch === patched) {
        target.fetch = originalFetch;
        delete target[FETCH_INSTALLED_MARKER];
      }
    },
    state: { state: 'ok' }
  };
}

