import { describe, expect, it } from 'vitest';

import {
  cloneAndLimit,
  STANDARD_LIMITS,
  TIGHT_LIMITS
} from '../../src/serialization/clone-and-limit';
import type { SerializationLimits } from '../../src/types';

function createLimits(overrides: Partial<SerializationLimits> = {}): SerializationLimits {
  return {
    ...STANDARD_LIMITS,
    ...overrides
  };
}

function createDepthFixture(depth: number): unknown {
  let current: Record<string, unknown> = { value: 'leaf' };

  for (let index = 0; index < depth; index += 1) {
    current = { child: current };
  }

  return current;
}

describe('limit profiles', () => {
  it('exports the configured limit profiles', () => {
    expect(STANDARD_LIMITS).toEqual({
      maxDepth: 8,
      maxArrayItems: 20,
      maxObjectKeys: 50,
      maxStringLength: 2048,
      maxPayloadSize: 32768,
      maxTotalPackageSize: 5242880
    });

    expect(TIGHT_LIMITS).toEqual({
      maxDepth: 4,
      maxArrayItems: 10,
      maxObjectKeys: 20,
      maxStringLength: 512,
      maxPayloadSize: 32768,
      maxTotalPackageSize: 5242880
    });
  });
});

describe('cloneAndLimit', () => {
  it('applies depth limiting at the exact boundary', () => {
    const input = createDepthFixture(9) as { child: unknown };
    const output = cloneAndLimit(input, STANDARD_LIMITS) as { child: unknown };

    expect(
      ((((((((output.child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child
    ).toBe('[Depth limit]');
  });

  it('truncates arrays with the original length marker', () => {
    const output = cloneAndLimit(
      [1, 2, 3, 4],
      createLimits({ maxArrayItems: 2 })
    );

    expect(output).toEqual({
      _items: [1, 2],
      _truncated: true,
      _originalLength: 4
    });
  });

  it('truncates object keys with the original key count marker', () => {
    const output = cloneAndLimit(
      { a: 1, b: 2, c: 3 },
      createLimits({ maxObjectKeys: 2 })
    );

    expect(output).toEqual({
      a: 1,
      b: 2,
      _truncated: true,
      _originalKeyCount: 3
    });
  });

  it('truncates strings with the original character count', () => {
    expect(cloneAndLimit('abcdef', createLimits({ maxStringLength: 4 }))).toBe(
      'abcd...[truncated, 6 chars]'
    );
  });

  it('detects self-references and multi-object cycles', () => {
    const selfRef: Record<string, unknown> = {};
    selfRef.self = selfRef;

    const first = cloneAndLimit(selfRef, STANDARD_LIMITS);

    expect(first).toEqual({ self: '[Circular]' });

    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', parent: a };
    a.child = b;

    const second = cloneAndLimit(a, STANDARD_LIMITS);

    expect(second).toEqual({
      name: 'a',
      child: {
        name: 'b',
        parent: '[Circular]'
      }
    });
  });

  it('serializes every documented type correctly', () => {
    function namedFunction(): void {}

    const date = new Date('2026-01-01T00:00:00.000Z');
    const regex = /abc/gi;
    const error = new TypeError('boom');
    error.stack = 'stack';
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [{ nested: true }, new Set([1, 2])]
    ]);
    const set = new Set<unknown>(['x', 2]);
    const typedArray = new Uint8Array([1, 2, 3, 4]);
    const arrayBuffer = new ArrayBuffer(8);
    const buffer = Buffer.from('hello world');

    expect(cloneAndLimit(undefined, STANDARD_LIMITS)).toBeNull();
    expect(cloneAndLimit(null, STANDARD_LIMITS)).toBeNull();
    expect(cloneAndLimit(true, STANDARD_LIMITS)).toBe(true);
    expect(cloneAndLimit(42, STANDARD_LIMITS)).toBe(42);
    expect(cloneAndLimit(10n, STANDARD_LIMITS)).toEqual({
      _type: 'BigInt',
      value: '10'
    });
    expect(cloneAndLimit('text', STANDARD_LIMITS)).toBe('text');
    expect(cloneAndLimit(Symbol('token'), STANDARD_LIMITS)).toBe(
      '[Symbol: token]'
    );
    expect(cloneAndLimit(namedFunction, STANDARD_LIMITS)).toBe(
      '[Function: namedFunction]'
    );
    expect(cloneAndLimit(date, STANDARD_LIMITS)).toBe(date.toISOString());
    expect(cloneAndLimit(regex, STANDARD_LIMITS)).toEqual({
      _type: 'RegExp',
      source: 'abc',
      flags: 'gi'
    });
    expect(cloneAndLimit(error, STANDARD_LIMITS)).toEqual({
      _type: 'Error',
      name: 'TypeError',
      message: 'boom',
      stack: 'stack'
    });
    expect(
      cloneAndLimit(buffer, createLimits({ maxStringLength: 8 }))
    ).toEqual({
      _type: 'Buffer',
      encoding: 'base64',
      data: 'aGVsbG8g...[truncated, 16 chars]',
      length: 11
    });
    expect(cloneAndLimit(map, STANDARD_LIMITS)).toEqual({
      _type: 'Map',
      size: 2,
      entries: [
        ['a', 1],
        [{ nested: true }, { _type: 'Set', size: 2, values: [1, 2] }]
      ]
    });
    expect(cloneAndLimit(set, STANDARD_LIMITS)).toEqual({
      _type: 'Set',
      size: 2,
      values: ['x', 2]
    });
    expect(cloneAndLimit(typedArray, createLimits({ maxArrayItems: 3 }))).toEqual({
      _type: 'Uint8Array',
      length: 4,
      sample: [1, 2, 3]
    });
    expect(cloneAndLimit(arrayBuffer, STANDARD_LIMITS)).toEqual({
      _type: 'ArrayBuffer',
      byteLength: 8
    });
    expect(cloneAndLimit([1, { nested: 'ok' }], STANDARD_LIMITS)).toEqual([
      1,
      { nested: 'ok' }
    ]);
    expect(cloneAndLimit({ nested: { ok: true } }, STANDARD_LIMITS)).toEqual({
      nested: { ok: true }
    });
  });

  it('replaces throwing getters and proxy traps with serialization error markers', () => {
    const withThrowingGetter = {
      ok: true,
      get boom(): unknown {
        throw new Error('getter failed');
      }
    };

    const proxy = new Proxy({ ok: true }, {
      get(target, property, receiver) {
        if (property === 'boom') {
          throw new Error('proxy failed');
        }

        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        return [...Reflect.ownKeys(target), 'boom'];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === 'boom') {
          return {
            configurable: true,
            enumerable: true,
            value: undefined,
            writable: false
          };
        }

        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });

    expect(cloneAndLimit(withThrowingGetter, STANDARD_LIMITS)).toEqual({
      ok: true,
      boom: '[Serialization error: getter failed]'
    });

    expect(cloneAndLimit(proxy, STANDARD_LIMITS)).toEqual({
      ok: true,
      boom: '[Serialization error: proxy failed]'
    });
  });

  it('normalizes NaN and infinities to null', () => {
    expect(cloneAndLimit(NaN, STANDARD_LIMITS)).toBeNull();
    expect(cloneAndLimit(Infinity, STANDARD_LIMITS)).toBeNull();
    expect(cloneAndLimit(-Infinity, STANDARD_LIMITS)).toBeNull();
  });

  it('handles empty and null-heavy structures', () => {
    expect(cloneAndLimit({}, STANDARD_LIMITS)).toEqual({});
    expect(cloneAndLimit([], STANDARD_LIMITS)).toEqual([]);
    expect(cloneAndLimit({ value: null, nested: [null] }, STANDARD_LIMITS)).toEqual({
      value: null,
      nested: [null]
    });
  });

  it('does not mutate the input graph', () => {
    const input = {
      text: 'abcdef',
      nested: { values: [1, 2, 3] }
    };

    const snapshot = JSON.stringify(input);

    cloneAndLimit(input, createLimits({ maxStringLength: 3, maxArrayItems: 2 }));

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('produces JSON-safe output', () => {
    const output = cloneAndLimit(
      {
        undef: undefined,
        fn: () => undefined,
        sym: Symbol('x'),
        nested: [undefined, { value: 1n }]
      },
      STANDARD_LIMITS
    );

    const serialized = JSON.stringify(output);

    expect(serialized).toBeTypeOf('string');
    expect(serialized).toContain('"undef":null');
    expect(serialized).toContain('"fn":"[Function: fn]"');
    expect(serialized).toContain('"sym":"[Symbol: x]"');
    expect(serialized).toContain('"_type":"BigInt"');
  });

  it('correctly limits a deep 1000-key object at standard limits', () => {
    const leaf: Record<string, number> = {};

    for (let index = 0; index < 1000; index += 1) {
      leaf[`key-${index}`] = index;
    }

    const fixture = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: leaf
            }
          }
        }
      }
    };

    const result = cloneAndLimit(fixture, STANDARD_LIMITS) as Record<string, unknown>;
    const level5 = ((((result.level1 as Record<string, unknown>).level2 as Record<
      string,
      unknown
    >).level3 as Record<string, unknown>).level4 as Record<string, unknown>).level5 as Record<
      string,
      unknown
    >;

    expect(typeof level5).toBe('object');
    expect(
      Object.keys(level5).filter((key) => !key.startsWith('_'))
    ).toHaveLength(STANDARD_LIMITS.maxObjectKeys);
    expect(level5._truncated).toBe(true);
    expect(level5._originalKeyCount).toBe(1000);
    expect(level5['key-0']).toBe(0);
    expect(level5['key-49']).toBe(49);
    expect(level5['key-50']).toBeUndefined();
  });
});
