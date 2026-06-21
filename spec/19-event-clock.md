# Module 19: EventClock

> **Spec status:** LOCKED
> **Source files:** `src/context/event-clock.ts`
> **Dependencies:** None
> **Build order position:** 19
> **Schema version contributed to:** 1.1.0

---

## Module Contract Header

```typescript
/**
 * @module 19-event-clock
 * @spec spec/19-event-clock.md
 * @dependencies (none)
 */
```

---

## Purpose

Provide a process-wide Lamport-style monotonic counter that orders every captured event within an SDK process and absorbs incoming counter values from peer services via W3C `tracestate` (module 21).

It is the single authority for the `seq` field on `IOEventSlot`, `StateRead`, `StateWrite`, `LocalsRingBufferEntry`, and the top-level `errorEventSeq` on the shipped `ErrorPackage` (module 20).

---

## Scope

- `EventClock` class with `tick()`, `merge(received)`, and `current()`
- One instance per SDK, owned by the composition root, injected wherever events are stamped
- Replaces the previously private `nextSeq` counter on `IOEventBuffer` (module 03)

---

## Non-Goals

- Does not parse or emit `tracestate` headers (that is module 21)
- Does not stamp events itself (callers do; see module 20)
- Does not persist across processes — clock resets to `0` on every cold start

---

## Dependencies

(none)

---

## Node.js APIs Used

- `Number.isSafeInteger`
- `Number.MAX_SAFE_INTEGER`

---

## Data Structures

### EventClock class

```typescript
class EventClock {
  private value: number;                   // 0 at startup, monotonic non-decreasing
  tick(): number;                          // value++; return new value
  merge(received: unknown): number;        // value = max(value, received) + 1; ignores invalid
  current(): number;                       // peek without bumping
}
```

---

## Implementation Notes

### Value type

`number`, not `bigint`. `Number.MAX_SAFE_INTEGER` (≈9×10¹⁵) is the practical ceiling and is unreachable in a single-process lifetime under any plausible workload (1M ticks/sec for 285 years to overflow). `bigint` was rejected because it forces per-event string serialization in the shipped package and complicates arithmetic. The previous `IOEventBuffer.nextSeq` was already `number`.

### tick() semantics

Post-increment: first call returns `1`, second returns `2`, etc. This matches the existing `IOEventBuffer.nextSeq` semantics (`nextSeq = 1` at construction; the value was read, then incremented). No existing test on event seq numbers needs to change.

### merge() semantics

Lamport rule: `value = max(value, received) + 1`. Implementation:

1. If `typeof received === 'number'` and `Number.isSafeInteger(received)` and `received > 0` and `received > value`: set `value = received`.
2. Always tick (return new value).

All other inputs (undefined, null, NaN, Infinity, negative, fractional, string, > `MAX_SAFE_INTEGER`) are silently treated as no-op merges. The clock still ticks. This is required so peer services on bad runtimes cannot poison ours.

### Ceiling behavior

If `value` reaches `MAX_SAFE_INTEGER`, further `tick()` calls pin at the ceiling and return it. Defensive — in practice unreachable.

### Process scope

The clock is process-local. Cross-process linkage is via `tracestate` (module 21), where ingress `merge` absorbs the peer's value and egress emits the current value.

---

## Security Considerations

- A hostile peer cannot poison our clock with garbage values: `merge` rejects anything that fails `Number.isSafeInteger`.
- A hostile peer cannot DoS us by sending huge values: rejected by the same check (`MAX_SAFE_INTEGER + 1` fails `isSafeInteger`).
- Clock values are not secrets and may be inferred from outbound `tracestate`. They reveal approximate event volume; that is by design.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| `tick()` at startup | Returns `1`. |
| `merge(undefined)` | No-op merge; clock ticks once. |
| `merge('42')` | No-op merge; clock ticks once (string ≠ safe integer). |
| `merge(Number.MAX_SAFE_INTEGER + 1)` | No-op merge; clock ticks once. |
| `merge(value < current)` | Lamport behavior: still bumps to `current + 1`. |
| `merge(value > current)` | Jump then bump: returns `value + 1`. |
| `merge(value === current)` | Bumps to `current + 1` (max(value, received) is `value`, then +1). |
| `value === MAX_SAFE_INTEGER` | `tick()` returns `MAX_SAFE_INTEGER` (no overflow). |
| Re-entrant `tick` during error capture | Not an issue; Node is single-threaded per worker. |
| Process restart | Clock resets to `0`; cross-process linkage handled by `tracestate`. |

---

## Testing Requirements

- `tick` strictly monotonic across calls
- `current` does not bump
- `merge(smaller)` still bumps
- `merge(larger)` jumps then bumps
- `merge(equal)` bumps
- All hostile `merge` inputs (undefined, null, NaN, Infinity, negative, string, fractional, > MAX_SAFE_INTEGER) are no-ops on the merged value but still tick
- Ceiling behavior at `MAX_SAFE_INTEGER`

---

## Completion Criteria

- `EventClock` exported from `src/context/event-clock.ts`
- Single instance constructed by the SDK composition root (`sdk.ts`)
- Injected into `IOEventBuffer`, `ALSManager`, `StateTracker`, `InspectorManager`, `ErrorCapturer`
- Unit tests in `test/unit/event-clock.test.ts` pass
