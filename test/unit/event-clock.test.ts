import { describe, expect, it } from 'vitest';

import { EventClock } from '../../src/context/event-clock';

describe('EventClock', () => {
  it('tick is monotonically increasing from 1', () => {
    const c = new EventClock();
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
    expect(c.tick()).toBe(3);
    expect(c.current()).toBe(3);
  });

  it('current does not bump', () => {
    const c = new EventClock();
    c.tick();
    c.tick();
    expect(c.current()).toBe(2);
    expect(c.current()).toBe(2);
    expect(c.current()).toBe(2);
  });

  it('merge with smaller value still bumps', () => {
    const c = new EventClock();
    c.tick();
    c.tick();
    c.tick();
    // value=3
    expect(c.merge(1)).toBe(4);
    expect(c.current()).toBe(4);
  });

  it('merge with larger value jumps then bumps', () => {
    const c = new EventClock();
    c.tick();
    // value=1
    expect(c.merge(100)).toBe(101);
    expect(c.current()).toBe(101);
  });

  it('merge with equal value bumps', () => {
    const c = new EventClock();
    c.tick();
    c.tick();
    // value=2
    expect(c.merge(2)).toBe(3);
    expect(c.current()).toBe(3);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative integer', -5],
    ['zero', 0],
    ['fractional number', 1.5],
    ['string', '42'],
    ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1],
    ['boolean', true],
    ['object', { value: 5 }],
  ])('merge with %s is treated as no-op merge but still ticks', (_label, val) => {
    const c = new EventClock();
    c.tick();
    // value=1
    expect(c.merge(val)).toBe(2);
    expect(c.current()).toBe(2);
  });

  it('does not exceed Number.MAX_SAFE_INTEGER on tick after near-max merge', () => {
    const c = new EventClock();
    c.merge(Number.MAX_SAFE_INTEGER - 1);
    expect(c.current()).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.tick()).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.tick()).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.current()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects merge of MAX_SAFE_INTEGER itself only via the > value guard, not isSafeInteger', () => {
    // MAX_SAFE_INTEGER is itself safe and positive; merge accepts it iff it
    // exceeds current. This documents the boundary.
    const c = new EventClock();
    c.tick();
    expect(c.merge(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(c.current()).toBe(Number.MAX_SAFE_INTEGER);
  });
});
