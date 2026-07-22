# Module 22: State Write Tracking

> **Spec status:** LOCKED
> **Source files:** modifies `src/state/state-tracker.ts`
> **Dependencies:** Module 01 (types), Module 02 (serialization), Module 06 (ALS), Module 11 (state-tracking — reads), Module 19 (EventClock)
> **Build order position:** 22
> **Schema version contributed to:** 1.1.0
> **Sibling of:** Module 11

---

## Module Contract Header

```typescript
/**
 * @module 22-state-write-tracking
 * @spec spec/22-state-write-tracking.md
 * @dependencies types.ts, clone-and-limit.ts (TIGHT_LIMITS), als-manager.ts, event-clock.ts
 */
```

---

## Purpose

`StateTracker` (module 11) records reads on tracked Maps and plain objects. This module extends it to also record writes (`set`, `delete`) on the same containers as a separate stream.

Reconstruction of state-over-time happens in the downstream collection layer; the runtime captures raw events and ships them. No diffing, no hashing, no `prevValue` capture.

---

## Scope

- `set` and `deleteProperty` traps on `createObjectProxy`
- `set` and `delete` interceptors on `createMapProxy` (added to the existing `get` trap ladder)
- New `recordStateWrite` private method, wrapped by `safeRecordStateWrite`
- New `MAX_STATE_WRITES_PER_CONTEXT` (default 50, configurable via `stateTracking.maxWritesPerContext`)
- Overflow counter surfaced as `Completeness.stateWritesDropped`
- New types: `StateWrite`, `StateWriteSerialized` (module 01)
- New `RequestContext.stateWrites` array (module 06)

---

## Non-Goals

- Does not capture `prevValue` — diffing is the collection layer's job.
- Does not hash values — same.
- Does not unify reads and writes into a single stream — they are peer streams.
- Does not enable write capture by default for new tracked containers when `captureWrites: false` — but installs traps regardless so there is one consistent code path.

---

## Dependencies

- Module 01: `StateWrite`, `StateWriteSerialized`, `Completeness.stateWritesDropped`, `ResolvedConfig.stateTracking`
- Module 02: `cloneAndLimit`, `TIGHT_LIMITS`
- Module 06: `ALSManager` (for `getContext`)
- Module 11: `StateTracker` class — extended in place
- Module 19: `EventClock`

---

## Node.js APIs Used

- `Reflect.set`, `Reflect.deleteProperty`
- `Proxy` traps `set`, `deleteProperty`
- `process.hrtime.bigint()`

---

## Data Structures

### StateWrite (added to module 01)

```typescript
interface StateWrite {
  seq: number;                             // EventClock.tick()
  hrtimeNs: bigint;                        // process.hrtime.bigint()
  container: string;
  operation: 'set' | 'delete';
  key: unknown;                            // cloneAndLimit(TIGHT_LIMITS)
  value: unknown;                          // cloneAndLimit(TIGHT_LIMITS); undefined for 'delete'
}

interface StateWriteSerialized {
  seq: number;
  hrtimeNs: string;                        // bigint → string
  container: string;
  operation: 'set' | 'delete';
  key: unknown;
  value: unknown;
}
```

### RequestContext additions (module 06)

```typescript
interface RequestContext {                 // existing fields...
  stateWrites: StateWrite[];               // NEW; peer to existing stateReads
  /** Internal scratch — not serialized. Surfaced in Completeness at package time. */
  completenessOverflow?: { stateWritesDropped: number };
}
```

### Completeness addition (module 01)

```typescript
interface Completeness {
  // ...existing...
  stateWritesDropped?: number;             // NEW
}
```

### StateTracker constructor change (module 11)

```typescript
class StateTracker {
  constructor(deps: {
    als: ALSManager;
    eventClock: EventClock;                          // NEW
    config: Pick<ResolvedConfig, 'stateTracking'>;   // NEW
  });
  // ...track() unchanged...
}
```

---

## Implementation Notes

### Strict-mode invariant

The `set` trap MUST return the boolean from `Reflect.set` unchanged. The `deleteProperty` trap MUST return the boolean from `Reflect.deleteProperty` unchanged. Otherwise strict-mode writes to frozen objects would silently swallow the `TypeError`. Any deviation breaks proxy semantics under strict mode.

### Trap order: Reflect first, recorder second

```typescript
set: (target, property, value, receiver) => {
  const ok = Reflect.set(target, property, value, receiver);
  if (!this.config.stateTracking.captureWrites) return ok;
  if (typeof property === 'symbol' || INTERNAL_OBJECT_PROPERTIES.has(property)) return ok;
  this.safeRecordStateWrite(name, 'set', property, value);
  return ok;
}
```

The Reflect call runs first. If it throws (e.g., setter on the host throws), the throw propagates and the recorder does not fire — same pattern as the existing read trap (module 11).

`safeRecordStateWrite` wraps `recordStateWrite` in try/catch so any recorder failure (cloneAndLimit on a hostile value, ALS misbehavior, etc.) never propagates to the host write.

### Map interceptors

The existing `createMapProxy` uses a `get` trap to wrap individual methods (`get`, `has`, `entries`, `values`, `forEach`). Two new branches are added before the fallback `Reflect.get`:

```typescript
if (property === 'set') {
  const original = Reflect.get(target, property, target) as Map<unknown,unknown>['set'];
  return (key: unknown, value: unknown) => {
    const result = original.call(target, key, value);  // returns the Map
    if (this.config.stateTracking.captureWrites) {
      this.safeRecordStateWrite(name, 'set', key, value);
    }
    return result;                                      // preserves chaining
  };
}

if (property === 'delete') {
  const original = Reflect.get(target, property, target) as Map<unknown,unknown>['delete'];
  return (key: unknown) => {
    const result = original.call(target, key);          // returns boolean
    if (this.config.stateTracking.captureWrites) {
      this.safeRecordStateWrite(name, 'delete', key, undefined);
    }
    return result;
  };
}
```

`Map.set` returns the Map itself (so `m.set(a,1).set(b,2)` chains). The interceptor preserves this. `Map.delete` returns boolean.

### Filter rules (object trap)

Same as the existing read trap — `set` and `deleteProperty` traps skip recording if:
- `typeof property === 'symbol'`
- `INTERNAL_OBJECT_PROPERTIES.has(property)` (constructor, __proto__, prototype, toJSON, toString, valueOf, hasOwnProperty, isPrototypeOf, propertyIsEnumerable)

The traps still call `Reflect.set` / `Reflect.deleteProperty` (so behavior is unchanged); only the recording is skipped.

### Cap and overflow

`MAX_STATE_WRITES_PER_CONTEXT` is configurable via `stateTracking.maxWritesPerContext` (default 50). On overflow:

```typescript
if (context.stateWrites.length >= cap) {
  if (context.completenessOverflow === undefined) {
    context.completenessOverflow = { stateWritesDropped: 0 };
  }
  context.completenessOverflow.stateWritesDropped += 1;
  return;
}
```

The drop counter is surfaced into `Completeness.stateWritesDropped` by `PackageBuilder.build`.

### `value` for delete

Always `undefined`. The collection layer reconstructs prior state if it cares; the runtime is dumb.

### `captureWrites: false` mode

Traps are still installed (one code path). When `captureWrites === false`, `safeRecordStateWrite` is not called. `Reflect.set` / `Reflect.deleteProperty` still run, behavior is identical to today.

---

## Security Considerations

- Recorded `value` may contain PII. Captured with `TIGHT_LIMITS` but NOT scrubbed at this stage; scrubbing happens at error-capture time (module 13).
- Hostile getter/setter on the host is not invoked by us — `Reflect.set` runs first, and if the host setter throws, we propagate. Recorder failures are isolated by `safeRecordStateWrite`.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Frozen target, strict mode | `Reflect.set` returns false (strict throws TypeError); proxy returns false; throw propagates; recorder does not fire. |
| Target is Map, `set` chained | Map returned unchanged; chain works. |
| Hostile value breaks `cloneAndLimit` | `safeRecordStateWrite` catches; host write succeeds; no entry recorded. |
| Symbol key | Recorder skipped (matches read trap). |
| Internal property name | Recorder skipped. |
| Outside ALS context | Silent drop; host write succeeds. |
| Cap reached | Drop counted; host write succeeds; further drops continue counting. |
| `captureWrites: false` | Recorder skipped; behavior identical to today's read-only tracker. |
| Deleting a nonexistent key | `Reflect.deleteProperty` returns true; recorder fires (we record the attempt). |

---

## Testing Requirements

- Object set via Proxy `set` trap
- Object delete via `deleteProperty` trap
- Map.set with chained calls (returns Map; chain works)
- Map.delete returns boolean correctly
- Cap enforcement and overflow counter
- Telemetry failure isolation under hostile values that break `cloneAndLimit`
- Strict-mode boolean invariant on the set trap (frozen object throws TypeError)
- `captureWrites: false` produces no writes
- Symbol / internal property names are filtered
- Outside ALS context: no recording, no error
- Existing read-tracking tests (module 11) still pass after these changes

---

## Completion Criteria

- `StateTracker` proxies install set/delete traps for objects and set/delete interceptors for Maps
- `RequestContext.stateWrites` populated on tracked-container mutations
- `Completeness.stateWritesDropped` reflects overflow
- New types `StateWrite` and `StateWriteSerialized` exported from `src/types.ts`
- Unit tests in `test/unit/state-tracking.test.ts` (new describe block) pass
- Existing read-tracking tests continue to pass
