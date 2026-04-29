# Module 20: Universal Event Stamping

> **Spec status:** LOCKED
> **Source files:** (cross-cutting; modifies modules 01, 03, 11, 12, 13, 19, 22)
> **Dependencies:** Module 19 (EventClock)
> **Build order position:** 20
> **Schema version contributed to:** 1.1.0

---

## Module Contract Header

```typescript
/**
 * @module 20-event-stamping
 * @spec spec/20-event-stamping.md
 * @dependencies event-clock.ts
 */
```

This module is a contract, not a single source file. Each affected source file's contract header must reference module 20 in addition to its own module.

---

## Purpose

Define the contract that every captured event landing in an `ErrorPackage` carries two synchronously-stamped fields:

- `seq: number` — the post-bump value of `EventClock.tick()` at stamp time
- `hrtimeNs: bigint` — `process.hrtime.bigint()` at stamp time

Together with the package-level `TimeAnchor` (module 16), these allow a downstream collection layer to derive display-time wall clock for any event without the runtime ever calling `Date.now()` per event.

---

## Scope

Every site that produces a stamped event:

| Site | Stamp moment |
|---|---|
| `IOEventBuffer.push()` (module 03) | Inside `assignSlot()`, set `slot.hrtimeNs = process.hrtime.bigint()` synchronously alongside the existing `seq` assignment (which now comes from `EventClock.tick()`). |
| `StateTracker.recordStateRead()` (module 11) | When constructing the `StateRead` record. |
| `StateTracker.recordStateWrite()` (module 22) | When constructing the `StateWrite` record. |
| `InspectorManager._onPaused()` (module 12) | At the very top of the method, before any filtering, async I/O, or `Runtime.getProperties` call. |
| `ErrorCapturer.capture()` (module 13) | At function entry, before serializing the error or fetching locals. The values become `errorEventSeq` / `errorEventHrtimeNs` on the package. |
| `PackageBuilder.build()` (module 13) | Computes `eventClockRange = { min, max }` over all stamped seqs in the assembled package. |

---

## Non-Goals

- Does not introduce per-event wall-clock (`Date.now()`) timestamps; the wall-clock `TimeAnchor` is still captured exactly once at SDK startup (module 13).
- Does not change inspector pause-on-exception behavior.
- Does not move sourcemap resolution.

---

## Dependencies

- Module 19: `EventClock`

---

## Node.js APIs Used

- `process.hrtime.bigint()`

---

## Data Structures

The following type declarations gain new fields. Full updates land in module 01 (types).

```typescript
interface IOEventSlot {
  seq: number;
  hrtimeNs: bigint;                        // NEW: stamp moment of buffer.push()
  // ...rest unchanged...
}
interface IOEventSerialized {
  seq: number;
  hrtimeNs: string;                        // NEW: bigint → string
  // ...rest unchanged...
}
interface StateRead {
  seq: number;                             // NEW
  // ...timestamp etc unchanged...
}
interface StateWrite {                     // see module 22
  seq: number;
  hrtimeNs: bigint;
  // ...
}
interface LocalsRingBufferEntry {
  // ...existing...
  seq: number;                             // NEW
  hrtimeNs: bigint;                        // NEW
  createdAt: number;                       // existing — kept (internal-only, see below)
}
interface ErrorPackage {
  // ...existing...
  errorEventSeq: number;                   // NEW
  errorEventHrtimeNs: string;              // NEW (bigint → string)
  eventClockRange: { min: number; max: number };  // NEW
}
```

---

## Wall-Clock Anchoring (cross-cutting clarification)

`TimeAnchor { wallClockMs, hrtimeNs }` is captured **once** at SDK startup (`ProcessMetadata`, module 13) and shipped on every `ErrorPackage`. All per-event timestamps are `process.hrtime.bigint()`. Display-time wall-clock for any event is derived **consumer-side**:

```
displayWallClockNs = BigInt(timeAnchor.wallClockMs) * 1_000_000n
                   + (eventHrtimeNs - BigInt(timeAnchor.hrtimeNs))
```

The runtime never emits per-event wall-clock timestamps. Carve-outs:

- The package-level `capturedAt` ISO string is per-package and stays. It is computed once per error capture, not per event.
- `LocalsRingBufferEntry.createdAt: Date.now()` is internal to the ring buffer (used for entry-age inspection during ring-buffer development) and is not part of the shipped package. It predates this contract and is kept unchanged. Any consumer of locals must use `entry.hrtimeNs`, not `entry.createdAt`.

---

## Implementation Notes

### Synchronous stamping is mandatory

The stamp must happen **synchronously** at the earliest capture moment — before any await, callback, filter, or asynchronous operation. Stamping at package-build time would collapse all events to similar values and lose ordering.

For locals: `seq` and `hrtimeNs` are stamped at the very top of `_onPaused`, even before the `params.reason` check. Captures that miss (e.g., rate-limited, non-app frames) consume a `seq` value monotonically; this is by design — gaps in seq from outside `_onPaused` are visible to the consumer and indicate something happened that we declined to record.

### eventClockRange

Computed by `PackageBuilder.build()` over the union of `errorEventSeq`, all `ioTimeline[].seq`, all `stateReads[].seq`, all `stateWrites[].seq`. Locals are not included because the package's `localVariables` field does not carry per-frame seq stamps; the ring-buffer-entry seq is consumed during package assembly but not shipped.

If the package has no I/O, no state reads, and no state writes, `eventClockRange = { min: errorEventSeq, max: errorEventSeq }`.

Implementation must use a loop, not `Math.min(...arr)` / `Math.max(...arr)` — large arrays may stack-overflow on some Node versions.

### Sourcemap fast-path (folded into module 13)

When `process.execArgv` includes `--enable-source-maps` or `process.env.NODE_OPTIONS` contains it, V8 already resolves source maps; `SourceMapResolver.resolveStack` short-circuits to a no-op. This lives in module 13 and is documented here only because it is part of the same change set.

The `warmCache` extension filter is extended to include `.cjs` alongside `.js` and `.mjs`.

---

## Security Considerations

- `hrtimeNs` reveals nanosecond-resolution timing within the process. This is no more sensitive than the existing `IOEventSlot.startTime`/`endTime` fields and does not require additional scrubbing.
- `seq` values reveal approximate event volume per process. Already exposed by the previous buffer-local `seq`. No regression.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Empty package (no I/O, no state) | `eventClockRange = { min: errorEventSeq, max: errorEventSeq }`. |
| Out-of-context state read (no ALS) | Read silently dropped; no seq consumed. |
| `_onPaused` rejects via fast-path early return | Stamped seq is consumed (gap visible from outside). |
| `IOEventBuffer.push` for an event whose `startTime` was captured earlier (e.g., http-server inbound that reuses `context.startTime`) | `hrtimeNs` is the **stamp** time (push time), `startTime` is the **observed** time (event start). They can differ; this is correct. |

---

## Testing Requirements

- Each stamp site is asserted in unit tests:
  - `IOEventBuffer.push` sets both `seq` and `hrtimeNs` on the slot
  - `StateTracker.recordStateRead` includes `seq` on the StateRead
  - `StateTracker.recordStateWrite` (module 22) includes `seq` and `hrtimeNs`
  - `InspectorManager._onPaused` stamps before any filtering
  - `ErrorCapturer.capture` stamps `errorEventSeq` and `errorEventHrtimeNs` at entry
  - `PackageBuilder.build` computes correct `eventClockRange`
- Integration test asserts `eventClockRange` brackets every shipped event
- No new `Date.now()` call site introduced (audit by `grep`)

---

## Completion Criteria

- All six stamp sites updated
- `eventClockRange` populated correctly in every shipped package
- All unit + integration tests pass
- `grep -rn "Date.now\|new Date()" src` shows no new sites beyond the pre-existing inventory
