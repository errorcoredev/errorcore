# Module 02: Serialization System

> **Spec status:** LOCKED
> **Source files:** `src/serialization/clone-and-limit.ts`
> **Dependencies:** Module 01 (types)
> **Build order position:** 2

---

## Module Contract Header

```typescript
/**
 * @module 02-serialization
 * @spec spec/02-serialization.md
 * @dependencies types.ts (SerializationLimits)
 */
```

---

## Purpose

Provide a shared recursive function `cloneAndLimit()` that deep-clones any JavaScript value into a JSON-safe plain object graph, enforcing structural bounds on depth, array size, object key count, and string length. Used by every component that serializes arbitrary runtime values.

---

## Scope

- Implement `cloneAndLimit(value: unknown, limits: SerializationLimits, currentDepth?: number, visited?: Set<object>): unknown`
- Export two pre-configured limit profiles: `STANDARD_LIMITS` and `TIGHT_LIMITS`
- Handle all JavaScript built-in types

---

## Non-Goals

- Does not perform PII scrubbing (that is module 04).
- Does not handle encryption or transport formatting.
- Does not know about `IOEventSlot` or any other SDK-specific type.

---

## Dependencies

- Module 01: `SerializationLimits` interface

---

## Node.js APIs Used

- `Buffer.isBuffer()`, `Buffer.from().toString('base64')`
- No other Node.js APIs. Pure JavaScript type detection and recursion.

---

## Data Structures

### SerializationLimits (imported from types)

```
{ maxDepth, maxArrayItems, maxObjectKeys, maxStringLength, maxPayloadSize, maxTotalPackageSize }
```

### Pre-configured profiles

```typescript
const STANDARD_LIMITS: SerializationLimits = {
  maxDepth: 8,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxStringLength: 2048,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880,
};

const TIGHT_LIMITS: SerializationLimits = {
  maxDepth: 4,
  maxArrayItems: 10,
  maxObjectKeys: 20,
  maxStringLength: 512,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880,
};
```

### Truncation markers

- Truncated array: `{ _items: [...first N...], _truncated: true, _originalLength: number }`
- Truncated object: `{ ...first N keys..., _truncated: true, _originalKeyCount: number }`
- Truncated string: `value.slice(0, maxStringLength) + '...[truncated, ' + originalLength + ' chars]'`
- Depth limit: `'[Depth limit]'`
- Circular reference: `'[Circular]'`

---

## Implementation Notes

### Behavioral contract

- `cloneAndLimit` NEVER throws. Errors during traversal (getter throws, Proxy trap throws) are caught per-property and replaced with `'[Serialization error: ' + errorMessage + ']'`.
- `cloneAndLimit` NEVER mutates the input. It produces a new object graph.
- `visited` is a `Set<object>` (not `WeakSet` — need deterministic circular detection; the set is short-lived within a single call).
- `visited` is created internally on the first call and threaded through recursion. Callers do not pass it.

### Type-specific handling

| Input type | Output |
|------------|--------|
| `undefined` | `null` |
| `null` | `null` |
| `boolean` | same value |
| `number` | same value (but `NaN` -> `null`, `Infinity` -> `null`) |
| `bigint` | `{ _type: 'BigInt', value: string }` |
| `string` | same or truncated (see limits) |
| `symbol` | `'[Symbol: description]'` |
| `function` | `'[Function: name]'` |
| `Date` | ISO 8601 string |
| `RegExp` | `{ _type: 'RegExp', source: string, flags: string }` |
| `Error` | `{ _type: 'Error', name: string, message: string, stack: string }` |
| `Buffer` | `{ _type: 'Buffer', encoding: 'base64', data: string, length: number }` (data truncated if > maxStringLength) |
| `Map` | `{ _type: 'Map', size: number, entries: [[k,v]...] }` (first maxArrayItems entries) |
| `Set` | `{ _type: 'Set', size: number, values: [...]  }` (first maxArrayItems values) |
| `TypedArray` | `{ _type: typeName, length: number, sample: [...] }` (first maxArrayItems elements) |
| `ArrayBuffer` | `{ _type: 'ArrayBuffer', byteLength: number }` |
| `Array` | cloned array (first maxArrayItems items, rest truncated with marker) |
| Plain object | cloned object (first maxObjectKeys keys, rest truncated with marker) |

### Performance targets

- Standard profile: 1000-key object at depth 5 serializes in < 1ms.
- Tight profile: typical cache value serializes in < 10 microseconds.
- This function runs at capture time (standard) or state-read time (tight). It does NOT run in the hot path of I/O recording.

---

## Security Considerations

- This function processes arbitrary user data. It must not throw or leak stack traces into output.
- String truncation may cut a multi-byte UTF-8 character in half. Use `String.prototype.slice()` which handles surrogate pairs correctly in modern V8.

---

## Edge Cases

- Input is `undefined` -> returns `null`
- Input is a self-referencing object (circular) -> `'[Circular]'` at second visit
- A->B->A cycle -> A is cloned, B is cloned, second A is `'[Circular]'`
- Object getter throws -> that key's value is `'[Serialization error: message]'`
- Proxy with throwing get trap -> `'[Serialization error: message]'`
- Empty object `{}` -> `{}`
- Empty array `[]` -> `[]`
- Deeply nested past maxDepth -> values at the boundary become `'[Depth limit]'`
- `NaN`, `Infinity`, `-Infinity` -> `null` (JSON has no representation)

---

## Testing Requirements

- Depth limiting at exact boundary (depth 8 clones, depth 9 returns marker)
- Array truncation with correct `_originalLength`
- Object key truncation with correct `_originalKeyCount`
- String truncation with correct character count annotation
- Circular reference detection: self-referencing object, A->B->A cycle
- Every type in the type table above produces correct output
- Getter that throws -> `'[Serialization error]'`
- Proxy with throwing get trap -> `'[Serialization error]'`
- `NaN`, `Infinity` -> `null`
- Empty objects, empty arrays, null, nested nulls
- Performance: 1000-key object at depth 5 completes in < 1ms (standard limits)
- Output is valid `JSON.stringify()` input (no symbols, no undefined, no functions remain)

---

## Completion Criteria

- `cloneAndLimit` function exported and handles all types in the table.
- `STANDARD_LIMITS` and `TIGHT_LIMITS` exported.
- Function never throws regardless of input.
- Function never mutates input.
- All unit tests pass.
- Performance benchmarks met.
