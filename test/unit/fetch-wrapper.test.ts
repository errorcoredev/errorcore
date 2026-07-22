import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyCapture } from '../../src/recording/body-capture';
import { HeaderFilter } from '../../src/pii/header-filter';
import { Scrubber } from '../../src/pii/scrubber';
import { installFetchWrapper } from '../../src/recording/fetch-wrapper';
import { pendingFetchResolvers } from '../../src/recording/undici';
import { resolveTestConfig } from '../helpers/test-config';
import type { IOEventSlot } from '../../src/types';

function createSlot(overrides: Partial<IOEventSlot> = {}): IOEventSlot {
  return {
    seq: 1,
    phase: 'active',
    startTime: 1n,
    endTime: null,
    durationMs: null,
    type: 'undici',
    direction: 'outbound',
    requestId: 'req-1',
    contextLost: false,
    target: 'http://stripe-mock',
    method: 'POST',
    url: 'http://stripe-mock/charge',
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
    estimatedBytes: 256,
    ...overrides
  };
}

function buildDeps(overrides: Parameters<typeof resolveTestConfig>[0] = {}) {
  const config = resolveTestConfig({
    captureRequestBodies: true,
    captureResponseBodies: true,
    ...overrides
  });
  const scrubber = new Scrubber(config);
  const bodyCapture = new BodyCapture({
    maxPayloadSize: config.maxPayloadSize,
    captureRequestBodies: true,
    captureResponseBodies: true,
    bodyCaptureContentTypes: config.bodyCaptureContentTypes,
    scrubber
  });
  const headerFilter = new HeaderFilter(config);
  const buffer = { updatePayloadBytes: vi.fn() };
  return { bodyCapture, headerFilter, buffer };
}

async function runFetchWrappedTest(
  scenario: () => Promise<Response>,
  bindSlot: () => IOEventSlot | null
): Promise<{ response: Response; slot: IOEventSlot | null }> {
  // The wrapper synchronously pushes a resolver onto pendingFetchResolvers
  // before calling the original fetch. We pop it in the same event loop turn
  // and bind it (or null to simulate non-bound). This mirrors what the
  // diagnostics_channel undici recorder does in production.
  const beforeLength = pendingFetchResolvers.length;
  const responsePromise = scenario();

  if (pendingFetchResolvers.length > beforeLength) {
    const resolver = pendingFetchResolvers.shift();
    const slot = bindSlot();
    if (resolver !== undefined && slot !== null) {
      resolver(slot);
    } else if (resolver !== undefined) {
      resolver(null as unknown as IOEventSlot);
    }
  }

  const response = await responsePromise;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const slot = bindSlot();
  return { response, slot };
}

describe('installFetchWrapper', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    pendingFetchResolvers.length = 0;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
    pendingFetchResolvers.length = 0;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('errorcore.fetchWrapperInstalled')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('errorcore.fetchWrapperPatchedFetch')];
  });

  it('records fetch metadata without cloning bodies when response body capture is disabled', async () => {
    const deps = buildDeps();
    const captureSpy = vi.spyOn(deps.bodyCapture, 'captureUndiciResponseStream');
    globalThis.fetch = vi.fn(async () => {
      return new Response('metadata only', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      });
    }) as typeof globalThis.fetch;

    const handle = installFetchWrapper({ ...deps, captureResponseBodies: false });

    expect(handle.state.state).toBe('ok');
    expect(globalThis.fetch).not.toBe(originalFetch);

    const slot = createSlot();
    const { response } = await runFetchWrappedTest(
      () => fetch('http://stripe-mock/charge', { method: 'POST' }),
      () => slot
    );

    expect(await response.text()).toBe('metadata only');
    expect(slot.phase).toBe('done');
    expect(slot.statusCode).toBe(200);
    expect(slot.responseHeaders?.['content-type']).toBe('text/plain');
    expect(slot.responseBody).toBeNull();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('captures JSON response body and decodes it as a string', async () => {
    const deps = buildDeps();
    globalThis.fetch = vi.fn(async () => {
      return new Response('{"status":"ok","amount":1000}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const slot = createSlot({ requestHeaders: { 'content-type': 'application/json' } });
    const { response } = await runFetchWrappedTest(
      () => fetch('http://stripe-mock/charge', { method: 'POST' }),
      () => slot
    );

    const appBody = await response.text();
    expect(appBody).toBe('{"status":"ok","amount":1000}');

    expect(slot.responseBody).toBe('{"status":"ok","amount":1000}');
    expect(slot.responseHeaders).not.toBeNull();
    expect(slot.responseHeaders?.['content-type']).toBe('application/json');
    expect(slot.statusCode).toBe(200);
  });

  it('captures malformed JSON response body verbatim (Fix 3 hero case)', async () => {
    const deps = buildDeps();
    const malformed = '{"status":"ok","amount":';
    globalThis.fetch = vi.fn(async () => {
      return new Response(malformed, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const slot = createSlot({ requestHeaders: { 'content-type': 'application/json' } });
    const { response } = await runFetchWrappedTest(
      () => fetch('http://stripe-mock/charge'),
      () => slot
    );

    await expect(response.json()).rejects.toThrow();

    expect(slot.responseBody).toBe(malformed);
  });

  it('reads only a capped clone before returning the application response', async () => {
    const maxPayloadSize = 1024;
    const deps = buildDeps({ maxPayloadSize });
    const chunks = Array.from({ length: 1200 }, () => 'a');
    const fullBody = chunks.join('');
    const capturedBody = fullBody.slice(0, maxPayloadSize);
    let nextChunk = 0;
    let pulls = 0;

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (nextChunk >= chunks.length) {
              controller.close();
              return;
            }

            pulls += 1;
            controller.enqueue(new TextEncoder().encode(chunks[nextChunk]));
            nextChunk += 1;
          }
        }),
        { headers: { 'content-type': 'text/plain' } }
      );
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const slot = createSlot({ requestHeaders: { 'content-type': 'text/plain' } });
    const responsePromise = fetch('http://stripe-mock/stream');
    const resolver = pendingFetchResolvers.shift();
    resolver?.(slot);

    const response = await responsePromise;
    const pullsBeforeApplicationRead = pulls;

    expect(pullsBeforeApplicationRead).toBeLessThan(chunks.length);
    expect(await response.text()).toBe(fullBody);
    expect(slot.responseBody).toBe(capturedBody);
    expect(slot.responseBodyTruncated).toBe(true);
  });

  it('does not break the application when no slot is bound', async () => {
    const deps = buildDeps();
    globalThis.fetch = vi.fn(async () => new Response('hello')) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    // Bind to null (simulate a fetch that bypasses diagnostics_channel).
    const { response } = await runFetchWrappedTest(
      () => fetch('http://stripe-mock/charge'),
      () => null
    );

    expect(await response.text()).toBe('hello');
  });

  it('injects trace headers and reattaches a context-lost bound slot at the fetch call site', async () => {
    const deps = buildDeps();
    const context = {
      requestId: 'req-next',
      ioEvents: []
    } as unknown as import('../../src/types').RequestContext;
    const traceHeaders = {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      tracestate: 'ec=clk:42'
    };
    const als = {
      getContext: vi.fn(() => context),
      getTraceHeaders: vi.fn(() => traceHeaders)
    };

    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('traceparent')).toBe(traceHeaders.traceparent);
      expect(headers.get('tracestate')).toBe(traceHeaders.tracestate);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, als, captureResponseBodies: true } as any);

    const slot = createSlot({
      requestId: null,
      contextLost: true,
      requestHeaders: { accept: 'application/json' }
    });

    await runFetchWrappedTest(
      () => fetch('http://fastify-svc:4003/lookup/42', {
        headers: { accept: 'application/json' }
      }),
      () => slot
    );

    expect(slot.requestId).toBe('req-next');
    expect(slot.contextLost).toBe(false);
    expect(context.ioEvents).toContain(slot);
    expect(slot.requestHeaders).toMatchObject({
      accept: 'application/json',
      traceparent: traceHeaders.traceparent,
      tracestate: traceHeaders.tracestate
    });
  });

  it('records a fallback outbound event when diagnostics does not bind a slot', async () => {
    const deps = buildDeps();
    const context = {
      requestId: 'req-next',
      ioEvents: []
    } as unknown as import('../../src/types').RequestContext;
    const traceHeaders = {
      traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`,
      tracestate: 'ec=clk:99'
    };
    const pushedSlots: IOEventSlot[] = [];
    const buffer = {
      updatePayloadBytes: vi.fn(),
      push: vi.fn((event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>) => {
        const slot = createSlot({
          ...event,
          seq: pushedSlots.length + 1,
          hrtimeNs: 1n,
          estimatedBytes: 256
        });
        pushedSlots.push(slot);
        return { slot, seq: slot.seq };
      })
    };
    const als = {
      getContext: vi.fn(() => context),
      getTraceHeaders: vi.fn(() => traceHeaders)
    };

    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('traceparent')).toBe(traceHeaders.traceparent);
      expect(headers.get('tracestate')).toBe(traceHeaders.tracestate);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({
      ...deps,
      buffer,
      als,
      captureResponseBodies: true
    } as any);

    const { response } = await runFetchWrappedTest(
      () => fetch('http://fastify-svc:4003/lookup/42', {
        headers: { accept: 'application/json' }
      }),
      () => null
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(pushedSlots).toHaveLength(1);
    expect(context.ioEvents).toContain(pushedSlots[0]);
    expect(pushedSlots[0]).toMatchObject({
      phase: 'done',
      type: 'undici',
      direction: 'outbound',
      requestId: 'req-next',
      contextLost: false,
      target: 'http://fastify-svc:4003',
      method: 'GET',
      url: 'http://fastify-svc:4003/lookup/42',
      statusCode: 200,
      requestHeaders: {
        accept: 'application/json',
        traceparent: traceHeaders.traceparent,
        tracestate: traceHeaders.tracestate
      },
      responseHeaders: {
        'content-type': 'application/json'
      },
      error: null
    });
    expect(pushedSlots[0].durationMs).not.toBeNull();
  });

  it('reuses a matching diagnostics event before creating a fallback event', async () => {
    const deps = buildDeps();
    const existingSlot = createSlot({
      requestId: 'req-next',
      contextLost: false,
      target: 'http://fastify-svc:4003',
      method: 'GET',
      url: 'http://fastify-svc:4003/lookup/42',
      requestHeaders: { accept: 'application/json' }
    });
    const context = {
      requestId: 'req-next',
      ioEvents: [existingSlot]
    } as unknown as import('../../src/types').RequestContext;
    const traceHeaders = {
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      tracestate: 'ec=clk:102'
    };
    const pushedSlots: IOEventSlot[] = [];
    const buffer = {
      updatePayloadBytes: vi.fn(),
      push: vi.fn((event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>) => {
        const slot = createSlot({
          ...event,
          seq: pushedSlots.length + 2,
          hrtimeNs: 2n,
          estimatedBytes: 256
        });
        pushedSlots.push(slot);
        return { slot, seq: slot.seq };
      })
    };
    const als = {
      getContext: vi.fn(() => context),
      getTraceHeaders: vi.fn(() => traceHeaders)
    };

    globalThis.fetch = vi.fn(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({
      ...deps,
      buffer,
      als,
      captureResponseBodies: true
    } as any);

    const { response } = await runFetchWrappedTest(
      () => fetch('http://fastify-svc:4003/lookup/42', {
        headers: { accept: 'application/json' }
      }),
      () => null
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(pushedSlots).toHaveLength(0);
    expect(context.ioEvents).toEqual([existingSlot]);
    expect(existingSlot).toMatchObject({
      statusCode: 200,
      requestHeaders: {
        accept: 'application/json',
        traceparent: traceHeaders.traceparent,
        tracestate: traceHeaders.tracestate
      },
      responseHeaders: {
        'content-type': 'application/json'
      },
      responseBody: '{"ok":true}'
    });
  });

  it('records a fallback outbound error when diagnostics does not bind a slot', async () => {
    const deps = buildDeps();
    const context = {
      requestId: 'req-next',
      ioEvents: []
    } as unknown as import('../../src/types').RequestContext;
    const traceHeaders = {
      traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`,
      tracestate: 'ec=clk:100'
    };
    const pushedSlots: IOEventSlot[] = [];
    const buffer = {
      updatePayloadBytes: vi.fn(),
      push: vi.fn((event: Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>) => {
        const slot = createSlot({
          ...event,
          seq: pushedSlots.length + 1,
          hrtimeNs: 1n,
          estimatedBytes: 256
        });
        pushedSlots.push(slot);
        return { slot, seq: slot.seq };
      })
    };
    const als = {
      getContext: vi.fn(() => context),
      getTraceHeaders: vi.fn(() => traceHeaders)
    };

    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('traceparent')).toBe(traceHeaders.traceparent);
      expect(headers.get('tracestate')).toBe(traceHeaders.tracestate);
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    installFetchWrapper({
      ...deps,
      buffer,
      als,
      captureResponseBodies: true
    } as any);

    const responsePromise = fetch('http://fastify-svc:4003/lookup/42', {
      headers: { accept: 'application/json' }
    });
    const resolver = pendingFetchResolvers.shift();
    resolver?.(null as unknown as IOEventSlot);

    await expect(responsePromise).rejects.toThrow('fetch failed');
    expect(pushedSlots).toHaveLength(1);
    expect(context.ioEvents).toContain(pushedSlots[0]);
    expect(pushedSlots[0]).toMatchObject({
      phase: 'done',
      type: 'undici',
      direction: 'outbound',
      requestId: 'req-next',
      contextLost: false,
      target: 'http://fastify-svc:4003',
      method: 'GET',
      url: 'http://fastify-svc:4003/lookup/42',
      statusCode: null,
      requestHeaders: {
        accept: 'application/json',
        traceparent: traceHeaders.traceparent,
        tracestate: traceHeaders.tracestate
      },
      responseHeaders: null,
      error: {
        type: 'TypeError',
        message: 'fetch failed'
      }
    });
    expect(pushedSlots[0].durationMs).not.toBeNull();
  });

  it('removes its pending resolver when the original fetch throws synchronously', async () => {
    const deps = buildDeps();
    globalThis.fetch = vi.fn(() => {
      throw new TypeError('invalid fetch input');
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    await expect(fetch('http://stripe-mock/charge')).rejects.toThrow(
      'invalid fetch input'
    );

    expect(pendingFetchResolvers).toHaveLength(0);
  });

  it('uninstalls cleanly and restores the original fetch', async () => {
    const deps = buildDeps();
    const stub = vi.fn(async () => new Response('x'));
    globalThis.fetch = stub as typeof globalThis.fetch;

    const handle = installFetchWrapper({ ...deps, captureResponseBodies: true });

    expect(globalThis.fetch).not.toBe(stub);

    handle.uninstall();

    expect(globalThis.fetch).toBe(stub);
  });

  it('does not double-install when called twice', () => {
    const deps = buildDeps();
    globalThis.fetch = vi.fn(async () => new Response('x')) as typeof globalThis.fetch;

    const first = installFetchWrapper({ ...deps, captureResponseBodies: true });
    const fetchAfterFirst = globalThis.fetch;

    const second = installFetchWrapper({ ...deps, captureResponseBodies: true });

    expect(second.state.state).toBe('skip');
    expect(globalThis.fetch).toBe(fetchAfterFirst);

    first.uninstall();
  });

  it('rewraps fetch when a framework replaces it after install', async () => {
    const deps = buildDeps();
    globalThis.fetch = vi.fn(async () => new Response('first')) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const context = {
      requestId: 'req-next',
      ioEvents: []
    } as unknown as import('../../src/types').RequestContext;
    const traceHeaders = {
      traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
      tracestate: 'ec=clk:101'
    };
    const als = {
      getContext: vi.fn(() => context),
      getTraceHeaders: vi.fn(() => traceHeaders)
    };
    const frameworkFetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('traceparent')).toBe(traceHeaders.traceparent);
      expect(headers.get('tracestate')).toBe(traceHeaders.tracestate);
      return new Response('second');
    }) as typeof globalThis.fetch;
    globalThis.fetch = frameworkFetch;

    const second = installFetchWrapper({
      ...deps,
      als,
      captureResponseBodies: true
    } as any);

    expect(second.state.state).toBe('ok');
    expect(globalThis.fetch).not.toBe(frameworkFetch);

    const response = await fetch('http://framework-fetch.local', {
      headers: { accept: 'text/plain' }
    });
    const resolver = pendingFetchResolvers.shift();
    resolver?.(null as unknown as IOEventSlot);

    expect(await response.text()).toBe('second');
    expect(frameworkFetch).toHaveBeenCalledTimes(1);
  });

  it('skips capture for content types not on the allowlist (binary blobs)', async () => {
    const deps = buildDeps();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
    globalThis.fetch = vi.fn(async () => {
      return new Response(bytes, {
        headers: { 'content-type': 'image/png' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const slot = createSlot({ requestHeaders: { 'content-type': 'image/png' } });
    const { response } = await runFetchWrappedTest(
      () => fetch('http://example/img.png'),
      () => slot
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    // Capture is skipped for content types outside the configured allowlist
    // (default: application/json, x-www-form-urlencoded, text/plain,
    // application/xml). The response headers ARE captured so engineers can
    // see the content type, but the body is not stored.
    expect(slot.responseBody).toBeNull();
    expect(slot.responseHeaders?.['content-type']).toBe('image/png');
  });

  it('FIFO sanity: 100 concurrent fetches each pair their unique UUID', async () => {
    // The fetch wrapper FIFO-pops slot resolvers from pendingFetchResolvers.
    // The model relies on fetch's synchronous prelude including the dispatcher
    // dispatch (which fires undici:request:create and pops the resolver)
    // before the next fetch's wrapper begins. If a future undici release
    // adds an async preamble inside fetch, this assertion fails — the canary.
    const deps = buildDeps();

    // Stub fetch to return a Response that echoes a UUID-tagged URL back as
    // the body. Each fetch URL contains the UUID; each response body contains
    // the same UUID. Mismatch ⇒ FIFO is broken.
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const m = /uuid=([a-zA-Z0-9-]+)/.exec(url);
      const uuid = m?.[1] ?? 'unknown';
      return new Response(JSON.stringify({ uuid }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    const N = 100;
    const slots: Array<{ uuid: string; slot: IOEventSlot }> = [];

    // Drive N concurrent fetches. The wrapper synchronously pushes a resolver
    // for each one; we synchronously bind a slot tagged with the UUID to each
    // resolver in the same FIFO order. After all settle, we check the captured
    // body's UUID against the slot's tagged UUID for every pair.
    const fetchPromises: Array<Promise<Response>> = [];
    for (let i = 0; i < N; i++) {
      const uuid = `req-${i.toString().padStart(3, '0')}`;
      const slot = createSlot({
        seq: i + 1,
        requestHeaders: { 'content-type': 'application/json' }
      });
      slots.push({ uuid, slot });

      fetchPromises.push(fetch(`http://echo/?uuid=${uuid}`));

      const resolver = pendingFetchResolvers.shift();
      if (resolver !== undefined) resolver(slot);
    }

    await Promise.all(fetchPromises);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    let mismatches = 0;
    for (const { uuid, slot } of slots) {
      const body = slot.responseBody;
      if (typeof body !== 'string') {
        mismatches += 1;
        continue;
      }
      const captured = JSON.parse(body) as { uuid: string };
      if (captured.uuid !== uuid) {
        mismatches += 1;
      }
    }

    expect(mismatches).toBe(0);
  });

  it('memory check: 300 fetches with body never read by app does not leak', async () => {
    // The clone()->arrayBuffer() inside the wrapper drains a tee'd branch
    // independently of whether the application ever reads its own branch.
    // If the implementation accidentally held the source body in memory
    // until the application consumed it, an app that drops responses would
    // grow the heap unbounded. This test stress-fires enough fetches without
    // touching the response body and asserts heap growth stays bounded.
    const deps = buildDeps();
    const bigPayload = JSON.stringify({ data: 'x'.repeat(10_000) });

    globalThis.fetch = vi.fn(async () => {
      return new Response(bigPayload, {
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof globalThis.fetch;

    installFetchWrapper({ ...deps, captureResponseBodies: true });

    if (globalThis.gc) globalThis.gc();
    const startHeap = process.memoryUsage().heapUsed;

    const N = 300;
    for (let i = 0; i < N; i++) {
      const slot = createSlot({ seq: i + 1, requestHeaders: { 'content-type': 'application/json' } });
      const promise = fetch(`http://test/req/${i}`);
      const resolver = pendingFetchResolvers.shift();
      if (resolver !== undefined) resolver(slot);
      void promise.then(() => undefined);
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
    }

    if (globalThis.gc) globalThis.gc();
    const endHeap = process.memoryUsage().heapUsed;
    const growthMb = (endHeap - startHeap) / (1024 * 1024);

    // 300 captured 10KB bodies = ~3MB worth of slot.responseBody string
    // storage. Allow generous headroom (35MB) for V8's heap behavior. Without
    // the bound, a leak would grow the heap by hundreds of MB or more.
    expect(growthMb).toBeLessThan(35);
  });
});
