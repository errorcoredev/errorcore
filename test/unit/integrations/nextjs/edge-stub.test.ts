import { describe, expect, it } from 'vitest';

const EDGE_MODULE = '../../../../src/integrations/nextjs/edge.mts';

describe('errorcore/nextjs edge stub', () => {
  it('exposes all expected named exports as functions', async () => {
    const m = await import(EDGE_MODULE);
    expect(typeof m.init).toBe('function');
    expect(typeof m.captureError).toBe('function');
    expect(typeof m.trackState).toBe('function');
    expect(typeof m.withContext).toBe('function');
    expect(typeof m.flush).toBe('function');
    expect(typeof m.shutdown).toBe('function');
    expect(typeof m.getTraceparent).toBe('function');
    expect(typeof m.withErrorcore).toBe('function');
    expect(typeof m.withServerAction).toBe('function');
  });

  it('init() is a no-op and returns undefined', async () => {
    const m = await import(EDGE_MODULE);
    expect(m.init()).toBeUndefined();
    expect(m.init({ transport: { type: 'stdout' } })).toBeUndefined();
  });

  it('captureError() is a no-op and returns undefined', async () => {
    const m = await import(EDGE_MODULE);
    expect(m.captureError(new Error('boom'))).toBeUndefined();
  });

  it('trackState() returns the container unchanged', async () => {
    const m = await import(EDGE_MODULE);
    const obj = { a: 1 };
    const map = new Map<string, number>([['k', 1]]);
    expect(m.trackState('obj', obj)).toBe(obj);
    expect(m.trackState('map', map)).toBe(map);
  });

  it('withContext(fn) invokes fn and returns its result', async () => {
    const m = await import(EDGE_MODULE);
    expect(m.withContext(() => 42)).toBe(42);
    expect(m.withContext(() => 'hello')).toBe('hello');
  });

  it('flush() and shutdown() resolve to undefined', async () => {
    const m = await import(EDGE_MODULE);
    await expect(m.flush()).resolves.toBeUndefined();
    await expect(m.shutdown()).resolves.toBeUndefined();
  });

  it('getTraceparent() returns null', async () => {
    const m = await import(EDGE_MODULE);
    expect(m.getTraceparent()).toBeNull();
  });

  it('withErrorcore returns the handler unwrapped (pass-through)', async () => {
    const m = await import(EDGE_MODULE);
    const handler = async (_req: unknown, _ctx: unknown) => ({ status: 200 });
    const wrapped = m.withErrorcore(handler);
    const result = await wrapped(
      { method: 'GET', url: '/x', headers: { forEach() {} } },
      {},
    );
    expect(result).toEqual({ status: 200 });
  });

  it('withServerAction returns the action unwrapped (pass-through)', async () => {
    const m = await import(EDGE_MODULE);
    const action = async (x: number) => x + 1;
    const wrapped = m.withServerAction(action);
    expect(await wrapped(41)).toBe(42);
  });

  it('withNextMiddleware is passthrough in Edge stub', async () => {
    const inner = async (req: { ok: boolean }) => req.ok;
    const { withNextMiddleware } = await import(EDGE_MODULE);
    const wrapped = withNextMiddleware(inner);
    await expect(wrapped({ ok: true })).resolves.toBe(true);
  });
});
