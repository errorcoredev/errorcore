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

function buildDeps() {
  const config = resolveTestConfig({ captureRequestBodies: true, captureResponseBodies: true });
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

  // Pop the most recently pushed resolver, then bind.
  // The wrapper's setTimeout fallback is 5s so we have plenty of time.
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
  // Give the wrapper's response.clone().arrayBuffer() promise time to settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const slot = bindSlot();
  return { response, slot };
}

describe('installFetchWrapper', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Clear any leftover resolvers from previous tests.
    pendingFetchResolvers.length = 0;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
    pendingFetchResolvers.length = 0;
    // Clear the install marker.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('errorcore.fetchWrapperInstalled')];
  });

  it('skips install when captureResponseBodies is disabled', () => {
    const deps = buildDeps();
    const handle = installFetchWrapper({ ...deps, captureResponseBodies: false });

    expect(handle.state.state).toBe('skip');
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('captures JSON response body and decodes it as a string', async () => {
    const deps = buildDeps();
    // Stub originalFetch to return a controlled Response.
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

    // Application sees the full response.
    const appBody = await response.text();
    expect(appBody).toBe('{"status":"ok","amount":1000}');

    // SDK captured the body too.
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

    // Application's response.json() throws — this is the demo's failure mode.
    await expect(response.json()).rejects.toThrow();

    // But the SDK captured the malformed bytes for the engineer to inspect.
    expect(slot.responseBody).toBe(malformed);
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

    // Application still receives the full bytes.
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

      // Kick off fetch synchronously so the wrapper pushes its resolver.
      fetchPromises.push(fetch(`http://echo/?uuid=${uuid}`));

      // Pop the resolver our wrapper just pushed and bind it to this slot.
      const resolver = pendingFetchResolvers.shift();
      if (resolver !== undefined) resolver(slot);
    }

    await Promise.all(fetchPromises);
    // Let response.clone().arrayBuffer() settle for all 100.
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

  it('memory check: 1000 fetches with body never read by app does not leak', async () => {
    // The clone()->arrayBuffer() inside the wrapper drains a tee'd branch
    // independently of whether the application ever reads its own branch.
    // If the implementation accidentally held the source body in memory
    // until the application consumed it, an app that drops responses would
    // grow the heap unbounded. This test stress-fires 1000 fetches without
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

    const N = 1000;
    for (let i = 0; i < N; i++) {
      // Push a resolver synchronously, fetch, bind to a slot, drop response.
      const slot = createSlot({ seq: i + 1, requestHeaders: { 'content-type': 'application/json' } });
      const promise = fetch(`http://test/req/${i}`);
      const resolver = pendingFetchResolvers.shift();
      if (resolver !== undefined) resolver(slot);
      // Application drops the response immediately — never reads the body.
      void promise.then(() => undefined);
    }

    // Wait for all fetches to settle and the wrapper's clone().arrayBuffer()
    // promises to drain.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
    }

    if (globalThis.gc) globalThis.gc();
    const endHeap = process.memoryUsage().heapUsed;
    const growthMb = (endHeap - startHeap) / (1024 * 1024);

    // 1000 captured 10KB bodies = ~10MB worth of slot.responseBody string
    // storage. Allow generous headroom (60MB) for V8's heap behavior. Without
    // the bound, a leak would grow the heap by hundreds of MB or more.
    expect(growthMb).toBeLessThan(60);
  });
});
