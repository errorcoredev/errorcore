import { describe, expect, it } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { EventClock } from '../../src/context/event-clock';
import { parseTracestate, formatTracestate } from '../../src/context/tracestate';
import { createSDK } from '../../src/sdk';

describe('parseTracestate', () => {
  it('parses a well-formed header with our vendor entry first', () => {
    const r = parseTracestate('ec=clk:42,vendor1=foo,vendor2=bar', 'ec');
    expect(r.receivedSeq).toBe(42);
    expect(r.inheritedEntries).toEqual(['vendor1=foo', 'vendor2=bar']);
  });

  it('parses well-formed header with our vendor entry in the middle', () => {
    const r = parseTracestate('vendor1=foo,ec=clk:7,vendor2=bar', 'ec');
    expect(r.receivedSeq).toBe(7);
    expect(r.inheritedEntries).toEqual(['vendor1=foo', 'vendor2=bar']);
  });

  it('returns null receivedSeq when our vendor key is absent', () => {
    const r = parseTracestate('vendor1=foo,vendor2=bar', 'ec');
    expect(r.receivedSeq).toBeNull();
    expect(r.inheritedEntries).toEqual(['vendor1=foo', 'vendor2=bar']);
  });

  it('returns clean empty result for empty / undefined / whitespace input', () => {
    expect(parseTracestate('', 'ec')).toEqual({ receivedSeq: null, inheritedEntries: [] });
    expect(parseTracestate(undefined, 'ec')).toEqual({ receivedSeq: null, inheritedEntries: [] });
    expect(parseTracestate('   ', 'ec')).toEqual({ receivedSeq: null, inheritedEntries: [] });
  });

  it('silently ignores entries with missing key, missing =, or empty key', () => {
    const r = parseTracestate('not-a-pair,=missing-key,=empty,ec=clk:9,vendor=ok', 'ec');
    expect(r.receivedSeq).toBe(9);
    expect(r.inheritedEntries).toEqual(['vendor=ok']);
  });

  it('drops own-vendor-key entries even when malformed clk: payload', () => {
    const r = parseTracestate('ec=garbage,vendor=ok', 'ec');
    expect(r.receivedSeq).toBeNull();
    // Own-key entry is dropped regardless — we re-emit our own on egress.
    expect(r.inheritedEntries).toEqual(['vendor=ok']);
  });

  it('rejects non-positive / non-safe-integer clk: payloads', () => {
    expect(parseTracestate('ec=clk:0,v=ok', 'ec')).toEqual({
      receivedSeq: null,
      inheritedEntries: ['v=ok']
    });
    expect(parseTracestate('ec=clk:99999999999999999999,v=ok', 'ec')).toEqual({
      receivedSeq: null,
      inheritedEntries: ['v=ok']
    });
  });

  it('uses the first valid clk: payload when our key appears multiple times', () => {
    const r = parseTracestate('ec=clk:5,ec=clk:10,vendor=ok', 'ec');
    expect(r.receivedSeq).toBe(5);
    expect(r.inheritedEntries).toEqual(['vendor=ok']);
  });

  it('parses oversized headers without throwing', () => {
    const big = ['ec=clk:1', ...Array.from({ length: 100 }, (_, i) => `v${i}=x`)].join(',');
    const r = parseTracestate(big, 'ec');
    expect(r.receivedSeq).toBe(1);
    expect(r.inheritedEntries).toHaveLength(100);
  });

  it('does not throw on hostile input', () => {
    expect(() => parseTracestate(',,,,,', 'ec')).not.toThrow();
    expect(() => parseTracestate('a'.repeat(10_000), 'ec')).not.toThrow();
    expect(() => parseTracestate('=,==,===', 'ec')).not.toThrow();
  });

  it('respects a custom vendor key', () => {
    const r = parseTracestate('errorcore=clk:3,ec=foreign,vendor=x', 'errorcore');
    expect(r.receivedSeq).toBe(3);
    // ec=foreign is treated as a foreign vendor entry (not our key) and preserved.
    expect(r.inheritedEntries).toEqual(['ec=foreign', 'vendor=x']);
  });
});

describe('public W3C trace propagation helpers', () => {
  it('getTraceHeaders returns traceparent and tracestate inside withTraceContext', () => {
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'stdout' },
      silent: true,
      traceContext: { vendorKey: 'ec' }
    });

    const inboundTraceId = 'a'.repeat(32);
    const inboundParentId = 'b'.repeat(16);
    const headers = sdk.withTraceContext({
      traceparent: `00-${inboundTraceId}-${inboundParentId}-0a`,
      tracestate: 'vendor1=foo'
    }, () => sdk.getTraceHeaders());

    expect(headers).not.toBeNull();
    expect(headers?.traceparent).toMatch(new RegExp(`^00-${inboundTraceId}-[0-9a-f]{16}-0a$`));
    expect(headers?.tracestate).toBe('ec=clk:0,vendor1=foo');
  });

  it('withTraceContext preserves an existing ALS context instead of overwriting it', () => {
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: { type: 'stdout' },
      silent: true
    });

    const firstTraceId = 'c'.repeat(32);
    const secondTraceId = 'd'.repeat(32);

    const observed = sdk.withTraceContext({
      traceparent: `00-${firstTraceId}-${'1'.repeat(16)}-01`
    }, () =>
      sdk.withTraceContext({
        traceparent: `00-${secondTraceId}-${'2'.repeat(16)}-01`
      }, () => sdk.getTraceHeaders())
    );

    expect(observed?.traceparent).toContain(firstTraceId);
    expect(observed?.traceparent).not.toContain(secondTraceId);
  });

  it('module-level getTraceHeaders returns null before init', async () => {
    const errorcore = await import('../../src/index');

    expect(errorcore.getTraceHeaders()).toBeNull();
  });
});

describe('formatTracestate', () => {
  it('puts our vendor entry leftmost (most recent) per W3C §3.3.1', () => {
    expect(formatTracestate(5, ['vendor1=foo'], 'ec')).toBe('ec=clk:5,vendor1=foo');
  });

  it('emits our entry alone when no inherited entries are present', () => {
    expect(formatTracestate(7, undefined, 'ec')).toBe('ec=clk:7');
    expect(formatTracestate(7, [], 'ec')).toBe('ec=clk:7');
  });

  it('caps to 32 entries by dropping the rightmost first', () => {
    const inherited = Array.from({ length: 50 }, (_, i) => `v${i}=x`);
    const out = formatTracestate(1, inherited, 'ec');
    const parts = out.split(',');
    expect(parts).toHaveLength(32);
    expect(parts[0]).toBe('ec=clk:1');
    expect(parts[31]).toBe('v30=x'); // v0..v30 survive; v31..v49 evicted
  });

  it('caps total length to 512 chars', () => {
    const big = Array.from({ length: 40 }, (_, i) => `v${i}=${'x'.repeat(20)}`);
    const out = formatTracestate(1, big, 'ec');
    expect(out.length).toBeLessThanOrEqual(512);
    expect(out.startsWith('ec=clk:1')).toBe(true);
  });

  it('preserves at least our own entry under extreme length pressure', () => {
    const huge = ['x'.repeat(2000)];
    const out = formatTracestate(1, huge, 'ec');
    expect(out).toBe('ec=clk:1');
  });

  it('respects a custom vendor key', () => {
    expect(formatTracestate(3, [], 'errorcore')).toBe('errorcore=clk:3');
  });
});

describe('ALSManager — tracestate ingest and egress (module 21)', () => {
  it('merges peer clk: into the local EventClock on ingress', () => {
    const eventClock = new EventClock();
    const als = new ALSManager({
      eventClock,
      config: { traceContext: { vendorKey: 'ec' } }
    });
    eventClock.tick(); // value=1
    als.createRequestContext({
      method: 'GET',
      url: '/',
      headers: {},
      tracestate: 'ec=clk:100,foreign=x'
    });
    // After merge(100), value -> max(1, 100) + 1 = 101.
    expect(eventClock.current()).toBe(101);
  });

  it('preserves foreign vendor entries on the request context', () => {
    const als = new ALSManager({
      eventClock: new EventClock(),
      config: { traceContext: { vendorKey: 'ec' } }
    });
    const ctx = als.createRequestContext({
      method: 'GET',
      url: '/',
      headers: {},
      tracestate: 'ec=clk:5,vendor1=foo,vendor2=bar'
    });
    expect(ctx.inheritedTracestate).toEqual(['vendor1=foo', 'vendor2=bar']);
  });

  it('leaves inheritedTracestate undefined when only own-vendor entry was present', () => {
    const als = new ALSManager({
      eventClock: new EventClock(),
      config: { traceContext: { vendorKey: 'ec' } }
    });
    const ctx = als.createRequestContext({
      method: 'GET',
      url: '/',
      headers: {},
      tracestate: 'ec=clk:5'
    });
    expect(ctx.inheritedTracestate).toBeUndefined();
  });

  it('formatOutboundTracestate returns null outside ALS context', () => {
    const als = new ALSManager({
      eventClock: new EventClock(),
      config: { traceContext: { vendorKey: 'ec' } }
    });
    expect(als.formatOutboundTracestate()).toBeNull();
  });

  it('formatOutboundTracestate emits our entry plus inherited entries inside context', () => {
    const eventClock = new EventClock();
    const als = new ALSManager({
      eventClock,
      config: { traceContext: { vendorKey: 'ec' } }
    });
    const ctx = als.createRequestContext({
      method: 'GET',
      url: '/',
      headers: {},
      tracestate: 'foreign1=a,foreign2=b'
    });
    eventClock.tick();
    eventClock.tick(); // value=2
    const out = als.runWithContext(ctx, () => als.formatOutboundTracestate());
    expect(out).toBe('ec=clk:2,foreign1=a,foreign2=b');
  });

  it('chains across two simulated services: B sees seq strictly greater than A', () => {
    // Service A
    const clockA = new EventClock();
    const alsA = new ALSManager({
      eventClock: clockA,
      config: { traceContext: { vendorKey: 'ec' } }
    });
    const ctxA = alsA.createRequestContext({ method: 'GET', url: '/a', headers: {} });
    // Simulate some events stamped during the request.
    clockA.tick();
    clockA.tick();
    clockA.tick(); // value=3
    const egress = alsA.runWithContext(ctxA, () => alsA.formatOutboundTracestate());
    expect(egress).toBe('ec=clk:3');

    // Service B receives.
    const clockB = new EventClock();
    const alsB = new ALSManager({
      eventClock: clockB,
      config: { traceContext: { vendorKey: 'ec' } }
    });
    alsB.createRequestContext({
      method: 'GET',
      url: '/b',
      headers: {},
      tracestate: egress ?? undefined
    });
    // After merge(3), B's clock is max(0, 3) + 1 = 4.
    expect(clockB.current()).toBe(4);
    // Any subsequent tick on B is strictly greater than A's egress value.
    expect(clockB.tick()).toBeGreaterThan(3);
  });
});
