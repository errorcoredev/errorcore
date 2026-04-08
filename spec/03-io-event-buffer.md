# Module 03: I/O Event Buffer

> **Spec status:** LOCKED
> **Source files:** `src/buffer/io-event-buffer.ts`
> **Dependencies:** Module 01 (types)
> **Build order position:** 3

---

## Module Contract Header

```typescript
/**
 * @module 03-io-event-buffer
 * @spec spec/03-io-event-buffer.md
 * @dependencies types.ts (IOEventSlot)
 */
```

---

## Purpose

Purpose-built fixed-capacity circular buffer for `IOEventSlot` records. Provides O(1) writes and O(n) filtered reads. Enforces the GC safety invariant: slots contain only self-contained POJOs with no references to host application objects.

---

## Scope

- Implement `IOEventBuffer` class with constructor `{ capacity: number, maxBytes: number }`
- Dual byte accounting (metadata overhead + payload bytes)
- Slot lifecycle management (active -> done) with seq-based recycling detection
- Filtered access by requestId for error-time capture
- Buffer statistics for completeness flags

---

## Non-Goals

- Does not capture I/O events itself. Recorders push events into it.
- Does not serialize events. Serialization happens at capture time.
- Does not perform PII scrubbing.

---

## Dependencies

- Module 01: `IOEventSlot` interface

---

## Node.js APIs Used

- `process.hrtime.bigint()` referenced in slot timestamps (but timestamps are set by callers, not by the buffer itself)
- No direct Node.js API usage. Pure data structure.

---

## Data Structures

### IOEventSlot (imported from types)

All 28 fields as defined in Module 01. Every slot is a self-contained POJO.

### METADATA_OVERHEAD

Constant: `256` bytes. Covers all fixed-size fields per slot.

### estimatedBytes formula

`METADATA_OVERHEAD + (requestBody?.length ?? 0) + (responseBody?.length ?? 0)`

### Internal state

```
slots: (IOEventSlot | null)[]   — pre-allocated array of size capacity
writeHead: number               — monotonically increasing index
slotCount: number               — live slots (0..capacity)
payloadBytes: number            — running sum of estimatedBytes across live slots
overflowCount: number           — lifetime counter of evicted events
nextSeq: number                 — monotonically increasing sequence number
```

---

## Implementation Notes

### Push algorithm

```
push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>):
  1. Assign seq = nextSeq++
  2. Compute estimatedBytes = METADATA_OVERHEAD + body lengths
  3. index = writeHead % capacity
  4. If slots[index] is not null (overwrite):
     - Subtract old slot's estimatedBytes from payloadBytes
     - Increment overflowCount
  5. Else: increment slotCount
  6. While payloadBytes + new estimatedBytes > maxBytes AND there are other live slots:
     - Evict the oldest live slot (null it out, subtract its bytes, decrement slotCount, increment overflowCount)
  7. slots[index] = complete IOEventSlot with seq and estimatedBytes
  8. payloadBytes += estimatedBytes
  9. Advance writeHead
  10. Return { slot: reference to written slot, seq }
```

### Body backfill

Callers receive the slot reference and seq from `push()`. When body data completes:

1. Verify `slot.seq === expectedSeq`. If mismatch, discard silently.
2. Update `slot.requestBody` / `slot.responseBody`.
3. Recompute `slot.estimatedBytes`. Update buffer's `payloadBytes` accordingly (subtract old, add new).
4. Set `slot.phase = 'done'`.

The buffer does NOT provide a backfill method. Body capture writes directly to the slot reference and calls `updatePayloadBytes(oldBytes, newBytes)` on the buffer.

### Slot replacement invariant

When overwriting a slot, replace the entire array element: `this.slots[index] = newSlot`. Never selectively null fields. This ensures the old slot and ALL its body Buffers become unreachable atomically.

### Access methods

- `push(event)` — O(1). Returns `{ slot, seq }`.
- `updatePayloadBytes(oldBytes: number, newBytes: number)` — O(1). Adjusts payloadBytes.
- `filterByRequestId(requestId: string): IOEventSlot[]` — O(capacity). Chronological order.
- `getRecent(n: number): IOEventSlot[]` — O(n). Most recent live slots.
- `drain(): IOEventSlot[]` — O(capacity). All live slots in chronological order.
- `clear(): void` — Null all slots, reset payloadBytes and slotCount. Does NOT reset overflowCount.
- `getOverflowCount(): number` — Lifetime eviction count.
- `getStats(): { slotCount, payloadBytes, overflowCount, capacity, maxBytes }` — Diagnostic snapshot.

---

## Security Considerations

- Slots may contain body data that includes PII. The buffer stores it as-is. PII scrubbing happens at capture time, not at recording time.
- The buffer MUST NOT write data to disk. It is an in-memory structure only.

---

## Edge Cases

- Buffer starts empty (all null slots). `filterByRequestId` and `drain` return empty arrays.
- Push to a full buffer overwrites the oldest slot.
- Byte-budget eviction: push events with large bodies. Buffer evicts oldest slots beyond the one being overwritten to stay within `maxBytes`.
- Byte-budget eviction can reduce `slotCount` below `capacity`.
- Body backfill to a recycled slot (seq mismatch): data is discarded. No error thrown.
- `getRecent(n)` where n > slotCount: returns all live slots.
- `clear()` followed by `getOverflowCount()`: returns the pre-clear overflow count (it is a lifetime counter).
- Rapid pushes in a tight loop: internal index math must not corrupt state.

---

## Testing Requirements

- Push and read back single event with correct fields
- Overflow: push capacity+1, verify oldest is gone, overflowCount === 1
- Chronological ordering after wrap-around
- Byte-budget eviction: push events with large bodies, verify slots evicted when budget exceeded
- Byte accounting accuracy: push, overwrite, verify payloadBytes matches sum of live slot estimatedBytes
- filterByRequestId correctness with interleaved requests
- Body backfill on live slot: succeeds, estimatedBytes updated via updatePayloadBytes
- Body backfill on recycled slot (seq mismatch): silently discarded
- clear() releases all body Buffers (verify payloadBytes === 0, slotCount === 0)
- getRecent with n > slotCount returns all live slots
- Rapid push loop: push 10000 events into a capacity-100 buffer, verify consistent state

---

## Completion Criteria

- `IOEventBuffer` class exported with all access methods.
- Push is O(1) in the common case (no byte-budget eviction needed).
- Byte accounting is accurate after any sequence of push/backfill/clear operations.
- Seq-based recycling detection works correctly.
- All unit tests pass.
- No references to host application objects stored in any slot.
