import { describe, expect, it } from 'vitest';

// Drift guard: every public export added to one entry must be added to the
// other. If this test fails after you add or remove an export, mirror the
// change in the other file.
describe('errorcore/nextjs exports parity', () => {
  it('Node and Edge entries expose identical named exports', async () => {
    const node = await import('../../../../src/integrations/nextjs/index');
    const edge = await import('../../../../src/integrations/nextjs/edge.mts');

    const ignore = new Set(['default']);
    const nodeNames = Object.keys(node).filter((k) => !ignore.has(k)).sort();
    const edgeNames = Object.keys(edge).filter((k) => !ignore.has(k)).sort();

    expect(edgeNames).toEqual(nodeNames);
  });

  it('Node entry exports withNextMiddleware', async () => {
    const mod = await import('../../../../src/integrations/nextjs/index');
    expect(typeof mod.withNextMiddleware).toBe('function');
  });
});
