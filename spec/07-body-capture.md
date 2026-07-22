# Module 07: Body Capture

> **Spec status:** LOCKED
> **Source files:** `src/recording/body-capture.ts`
> **Dependencies:** Module 01 (types, config), Module 03 (io-event-buffer)
> **Build order position:** 7

---

## Module Contract Header

```typescript
/**
 * @module 07-body-capture
 * @spec spec/07-body-capture.md
 * @dependencies types.ts, config.ts, io-event-buffer.ts (IOEventSlot, updatePayloadBytes)
 */
```

---

## Purpose

Tee stream data for request and response body capture without consuming the stream or interfering with application behavior. Accumulate chunks into SDK-owned Buffers, respecting size limits, and backfill into IOEventSlot references.

---

## Scope

- `BodyCapture` class with methods for inbound request bodies, outbound response bodies, and outbound client response bodies
- Chunk accumulation with truncation at configurable size limits
- Safe backfill into IOEventSlot references with seq-based recycling detection

---

## Non-Goals

- Does not subscribe to diagnostics channels.
- Does not parse or interpret body content (JSON parsing, etc.).
- Does not perform PII scrubbing on bodies.

---

## Dependencies

- Module 01: `IOEventSlot`, `ResolvedConfig`
- Module 03: `IOEventBuffer` (for `updatePayloadBytes` callback)

---

## Node.js APIs Used

- Stream `'data'` and `'end'` events on `IncomingMessage`
- Monkey-patching `res.write()` and `res.end()` on `ServerResponse`
- `Buffer.concat()` for chunk accumulation
- `Buffer.byteLength()` for size tracking

---

## Data Structures

### BodyCapture class

```typescript
class BodyCapture {
  constructor(config: { maxPayloadSize: number; captureBody: boolean });

  captureInboundRequest(
    req: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;

  captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;

  captureClientResponse(
    res: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
}
```

---

## Implementation Notes

### Inbound request body capture

- Monkey-patch `req.on` to intercept when the first `'data'` listener is added by the application. At that point, add our own `'data'` listener. This ensures we do NOT prematurely switch the stream to flowing mode.
- Accumulate chunks into a `Buffer[]`. Track total size.
- If accumulated size exceeds `maxPayloadSize`: stop listening for `'data'`, set `slot.requestBodyTruncated = true`, record `slot.requestBodyOriginalSize` as the total bytes seen so far.
- On `'end'`: concatenate chunks into a single `Buffer`, write to `slot.requestBody`. Call `onBytesChanged` with old and new `estimatedBytes`. Set `slot.phase = 'done'` for the request body portion.
- Before writing to slot: verify `slot.seq === seq`. If mismatch, discard all accumulated data silently.

### Outbound response body capture

- Monkey-patch `res.write(chunk, encoding, callback)` and `res.end(chunk, encoding, callback)` on the `ServerResponse` instance (NOT the prototype — per-instance patching).
- In the wrapper: if `chunk` is truthy, accumulate it (convert string to Buffer using encoding).
- Respect `maxPayloadSize`. Once exceeded, stop accumulating, set truncated flag.
- On `res.end`: concatenate accumulated chunks, write to `slot.responseBody`. Call `onBytesChanged`.
- Restore original methods on `response.on('finish')`.
- Before writing to slot: verify `slot.seq === seq`.

### Outbound HTTP client response body capture

- Listen to `response.on('data', chunk)` on the `http.ClientRequest`'s response.
- Same accumulation and truncation logic as inbound request body.
- On `'end'`: concatenate, backfill slot.

### GC safety

- Body capture creates its OWN `Buffer[]` for chunk accumulation. These are NEW allocations, not references to the socket's internal buffers.
- When concatenation completes, the chunk array is discarded and replaced with the single concatenated Buffer.
- The slot never holds references to the original stream chunks.

### Performance

- Size limit (32KB default) caps accumulation. Most bodies are small; the limit prevents runaway memory use.
- No serialization at capture time — store raw Buffers.
- If `captureBody` is `false`, all methods are no-ops.

---

## Security Considerations

- Body data may contain PII. The body capture stores it as-is. PII scrubbing happens at capture time, not at recording time.
- Body capture MUST NOT consume the stream. Application code must still be able to read the body normally.

---

## Edge Cases

- Application never reads the body (no `'data'` listener added): our monkey-patch of `req.on` never fires, no body captured. This is correct — we cannot force the stream to flow.
- Request aborted before body completes: `'end'` never fires. Accumulated chunks are held until the capture object is GC'd. Partial body is NOT written to the slot.
- Response body sent via `res.end(chunk)` with no prior `res.write()`: capture the chunk from `res.end`.
- `res.write()` called with no chunk (just a callback): skip accumulation.
- Encoding is specified (e.g., `'utf-8'`): convert string chunks to Buffer using the specified encoding.
- Slot recycled before body completes (seq mismatch on backfill): discard silently.
- `maxPayloadSize` is 0: no body capture (treat as disabled).

---

## Testing Requirements

- Accumulate chunks up to limit, verify concatenated Buffer is correct
- Truncation at limit: verify flag set, originalSize recorded, no further accumulation
- Stream not consumed: application `'data'` listener still receives all data
- Backfill to live slot: body written, estimatedBytes updated via callback
- Backfill to recycled slot (seq mismatch): data discarded silently
- Response body capture via `res.write` + `res.end`
- Response body capture via `res.end(chunk)` only
- `captureBody: false` makes all methods no-ops
- Chunk encoding handling (string with encoding vs Buffer)

---

## Completion Criteria

- `BodyCapture` class exported with all three capture methods.
- Monkey-patching of `req.on`, `res.write`, `res.end` works correctly.
- Stream is never consumed by the SDK.
- Size limits enforced with truncation flags.
- Seq-based backfill safety works.
- All unit tests pass.
