# Module 11: State Tracking System

> **Spec status:** LOCKED
> **Source files:** `src/state/state-tracker.ts`
> **Dependencies:** Module 01 (types), Module 02 (serialization), Module 06 (ALS)
> **Build order position:** 11

---

## Module Contract Header

```typescript
/**
 * @module 11-state-tracking
 * @spec spec/11-state-tracking.md
 * @dependencies types.ts, clone-and-limit.ts (TIGHT_LIMITS), als-manager.ts
 */
```

---

## Purpose

Wrap user-registered in-memory state containers (Maps, objects, caches) in Proxies that record READS per-request via ALS context. Only reads are recorded, not writes.

---

## Scope

- `StateTracker` class with `track(name, container)` method
- Proxy handler for `Map` containers
- Proxy handler for plain objects
- Eager serialization of read values using `cloneAndLimit` with tight limits

---

## Non-Goals

- Does not track writes/mutations.
- Does not manage the containers themselves (user owns them).
- Does not perform PII scrubbing (scrubbing happens at capture time).

---

## Dependencies

- Module 01: `StateRead`, `ResolvedConfig`
- Module 02: `cloneAndLimit`, `TIGHT_LIMITS`
- Module 06: `ALSManager`

---

## Node.js APIs Used

- `Proxy` (built-in)
- `Reflect.get()` for trap delegation
- `process.hrtime.bigint()` for timestamps

---

## Data Structures

### StateTracker class

```typescript
class StateTracker {
  constructor(deps: { als: ALSManager });
  track(name: string, container: Map<any, any> | Record<string, any>): typeof container;
}
```

### StateRead (from types)

```typescript
interface StateRead {
  container: string;
  operation: string;
  key: unknown;
  value: unknown;    // eagerly serialized via cloneAndLimit(TIGHT_LIMITS)
  timestamp: bigint;
}
```

---

## Implementation Notes

### Map container proxy

Return `new Proxy(container, handler)` where the `get` trap intercepts property access:

- If property is `'get'`: return a wrapped function that calls `original.get(key)`, records a `StateRead`, and returns the result
- If property is `'has'`: return a wrapped function that records a `StateRead` with the boolean result
- If property is `'entries'`, `'values'`, `'forEach'`: return wrapped versions that record reads
- All other properties: delegate via `Reflect.get(target, prop, receiver)`

### Plain object proxy

Return `new Proxy(container, handler)` where the `get` trap records every property access EXCEPT:
- Symbols (e.g., `Symbol.toPrimitive`, `Symbol.iterator`)
- Known internal properties: `constructor`, `__proto__`, `prototype`, `toJSON`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`

### Recording a state read

1. Get ALS context via `als.getContext()`. If `undefined`, silently drop the read (cannot correlate).
2. Serialize the read value eagerly: `cloneAndLimit(value, TIGHT_LIMITS)`. This creates a self-contained POJO snapshot with no references to the original.
3. Push a `StateRead` to `context.stateReads[]`.

### Why eager serialization (GC safety)

If we stored a reference to the original value, the state read array would keep cache entries alive indefinitely. Eager serialization with tight limits (~1-5 microseconds per read) breaks the reference chain. See GC safety invariant in index.md.

### Performance budget

- Proxy `get` trap overhead: ~100-200ns per access
- `cloneAndLimit` with tight limits: ~1-5 microseconds per read
- For 10-100 reads per request: < 500 microseconds total — negligible

---

## Security Considerations

- Read values may contain PII. They are captured with tight serialization limits but NOT scrubbed at this stage. Scrubbing happens at error-capture time.
- The proxy does NOT modify the container's behavior. Application reads return the original values unchanged.

---

## Edge Cases

- Container is modified after being tracked (keys added/removed): Proxy handles transparently
- Container is a class instance with prototype methods: `get` trap uses `Reflect.get` and only intercepts known read methods for Maps
- User passes a frozen/sealed object: Proxy works for reads
- Value is `undefined`: recorded as-is (serialized to `null` by cloneAndLimit)
- Value is a large object: tight limits (depth 4, 20 array items, 20 keys) bound the snapshot size
- No ALS context: read is silently dropped, no error
- Container used outside request scope (e.g., at startup): reads dropped (no ALS)
- `track()` called with the same name twice: second call creates a new Proxy for the new container. Old Proxy continues to work independently.

---

## Testing Requirements

- Map.get: read recorded with correct container name, operation, key, serialized value
- Map.has: read recorded with boolean result
- Plain object property access: read recorded
- Symbol access: NOT recorded
- Internal property access (`constructor`, etc.): NOT recorded
- Values eagerly serialized: mutating original after read does NOT change recorded value
- No ALS context: read silently dropped (stateReads array unchanged)
- Large value: tight limits applied (depth 4, etc.)
- Proxy does not alter application-visible behavior (same return values)
- Multiple tracked containers with different names

---

## Completion Criteria

- `StateTracker` class exported with `track()` method.
- Proxies for Map and plain objects work correctly.
- State reads eagerly serialized with `TIGHT_LIMITS`.
- No GC safety violations (no external references in recorded data).
- Reads outside ALS context silently dropped.
- All unit tests pass.
