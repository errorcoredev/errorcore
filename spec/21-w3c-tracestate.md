# Module 21: W3C tracestate Round-Trip

> **Spec status:** LOCKED
> **Source files:** `src/context/tracestate.ts`, modifies `src/context/als-manager.ts`, `src/recording/http-client.ts`, `src/recording/undici.ts`, all middleware adapters
> **Dependencies:** Module 01 (types), Module 06 (ALS), Module 19 (EventClock)
> **Build order position:** 21
> **Schema version contributed to:** 1.1.0

---

## Module Contract Header

```typescript
/**
 * @module 21-w3c-tracestate
 * @spec spec/21-w3c-tracestate.md
 * @dependencies types.ts, als-manager.ts, event-clock.ts
 */
```

---

## Purpose

Round-trip the W3C `tracestate` HTTP header so that the `EventClock` (module 19) value propagates across services. Inbound `tracestate` is parsed: any `<vendorKey>=clk:<n>` entry is fed to `EventClock.merge`; remaining vendor entries are preserved on `RequestContext.inheritedTracestate` for re-emission. Outbound HTTP requests get a fresh `<vendorKey>=clk:<currentSeq>` entry prepended to the inherited entries.

This is the cross-process counterpart to module 19. Without it, two errorcore-instrumented services produce events with independent clock spaces and cannot be ordered downstream.

---

## Scope

- `parseTracestate(header, vendorKey)` and `formatTracestate(seq, inherited, vendorKey)` helpers in `src/context/tracestate.ts`
- `ALSManager.createRequestContext` ingest path (module 06 update)
- `ALSManager.formatOutboundTracestate()` egress helper (module 06 update)
- `recording/undici.ts` and `recording/http-client.ts` egress injection (module 08 update)
- All seven middleware adapters fan-out the `tracestate` header (module 15 update + `lambda.ts`, `nextjs.ts`)

---

## Non-Goals

- Does not parse or emit `traceparent` (already handled by module 06 and module 08).
- Does not perform any clock arithmetic; that is module 19.
- Does not implement reconstruction across services; the collection layer does that.

---

## Dependencies

- Module 01: `RequestContext`, `ResolvedConfig`
- Module 06: `ALSManager`
- Module 19: `EventClock`

---

## Node.js APIs Used

- `String.prototype.split`, `.indexOf`, `.slice`, `.trim`
- `RegExp` for vendor-key validation and `clk:<n>` extraction

---

## Data Structures

### Helper module: `src/context/tracestate.ts`

```typescript
interface ParsedTracestate {
  receivedSeq: number | null;            // n from <vendorKey>=clk:<n>, or null
  inheritedEntries: string[];            // all other vendor entries, in original order
}

function parseTracestate(header: string | undefined, vendorKey: string): ParsedTracestate;
function formatTracestate(currentSeq: number, inherited: string[] | undefined, vendorKey: string): string;
```

### `RequestContext` addition

```typescript
interface RequestContext {                 // existing fields...
  inheritedTracestate?: string[];        // NEW (set on ingress)
}
```

### `ALSManager` additions

```typescript
class ALSManager {
  // existing constructor expanded:
  constructor(deps: { eventClock: EventClock; config: Pick<ResolvedConfig, 'traceContext'> });
  // existing createRequestContext now accepts:
  createRequestContext(req: { method: string; url: string; headers: Record<string, string>;
                              traceparent?: string; tracestate?: string }): RequestContext;
  // new method:
  formatOutboundTracestate(): string | null;
}
```

### Vendor key

Default: `"ec"`. Configurable via `traceContext.vendorKey` (module 01 config). Validated against W3C grammar `[a-z0-9_\-*\/]{1,256}`.

### Caps

- W3C max 32 entries per `tracestate` header
- W3C max 512 chars total

---

## Implementation Notes

### parseTracestate

1. If header is undefined or empty string, return `{ receivedSeq: null, inheritedEntries: [] }`.
2. Split on `,`. For each entry:
   - Trim whitespace.
   - If empty, skip.
   - Find first `=`. If none or at index 0, skip (malformed).
   - Extract `key` (left of `=`, trimmed) and `value` (right of `=`, trimmed).
   - If key is empty, skip.
   - If `key === vendorKey`:
     - Match `value` against `/^clk:(\d{1,16})$/`. If matches, parse digits as `Number`. If `Number.isSafeInteger` and `> 0` and `receivedSeq === null` (first wins), assign to `receivedSeq`.
     - Drop the entry from `inheritedEntries` regardless (we re-emit fresh).
   - Else, push the trimmed entry to `inheritedEntries`.
3. Return.

**Parsing is silent on malformed input** — never throw, never warn. Any error path resolves to a clean `ParsedTracestate`.

### formatTracestate

1. Build `ours = <vendorKey>=clk:<currentSeq>`.
2. Build `list = [ours, ...(inherited ?? [])]`. Most-recent first per W3C §3.3.1.
3. While `list.length > 32`: pop rightmost.
4. While `list.join(',').length > 512` and `list.length > 1`: pop rightmost.
5. Return `list.join(',')`.

The cap-eviction logic preserves at least our own entry. If `ours` alone exceeds 512 chars (impossible in practice given vendorKey ≤ 256 and seq ≤ 16 digits), we still return it.

### Egress injection

Both HTTP recorders inject `tracestate` immediately after `traceparent`, only when `formatOutboundTracestate()` returns a non-empty string:

```typescript
// http-client.ts
const tracestate = this.als.formatOutboundTracestate();
if (tracestate !== null && tracestate.length > 0) {
  request.setHeader('tracestate', tracestate);
}

// undici.ts (uses addHeader on the undici request object)
if (typeof (request as any).addHeader === 'function') {
  const tracestate = this.als.formatOutboundTracestate();
  if (tracestate !== null && tracestate.length > 0) {
    (request as any).addHeader('tracestate', tracestate);
  }
}
```

### Middleware fan-out

Every middleware that calls `als.createRequestContext` passes the `tracestate` header alongside `traceparent`:

```typescript
sdk.als.createRequestContext({
  method: req.method,
  url: req.url,
  headers: filteredHeaders,
  traceparent: req.headers['traceparent'] as string | undefined,
  tracestate: req.headers['tracestate'] as string | undefined,
});
```

For Lambda, also check SQS message attributes:

```typescript
const tracestate = req.headers['tracestate'] as string | undefined
                ?? messageAttributes?.tracestate?.stringValue;
```

### `trace.tracestate` on the package

The `ErrorPackage.trace.tracestate` field carries the **inbound** header verbatim at capture time, NOT the egress version we'd emit. This lets the collection layer reconstruct who-told-us-what.

---

## Security Considerations

- Inbound `tracestate` may contain arbitrary peer-supplied data. We never `eval` it, never log it raw at WARN+ level, and never throw on malformed content.
- Inbound oversized (or hostile) headers don't OOM us: parsing splits on `,` once, and cap is applied only on egress (where we control the output).
- A peer cannot trick us into amplifying its tracestate: egress is capped at 512 chars / 32 entries.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Empty / undefined `tracestate` | No merge, no inherited entries. |
| Header with only commas/whitespace | All entries dropped silently; clean result. |
| Multiple `<vendorKey>=` entries | First valid `clk:<n>` wins; rest dropped. |
| `clk:` payload non-integer / negative / huge | No merge; entry not preserved. |
| Inbound oversized header | Parsed normally; cap applies on egress only. |
| `formatOutboundTracestate` outside ALS context | Returns `null`; recorder skips header injection. |
| User configures `vendorKey: 'errorcore'` but peer sent `ec=...` | Peer's entry is foreign; preserved verbatim in `inheritedEntries`. No merge. |
| Inherited entry alone exceeds 512 chars | Eviction pops it; our entry preserved. |
| User-supplied `traceparent` already on outbound request | Existing recorder behavior overwrites; `tracestate` follows the same pattern. |

---

## Testing Requirements

### parseTracestate

- Well-formed header: extracts `receivedSeq`, preserves other entries
- Missing vendor key: `receivedSeq = null`, all entries preserved
- Empty / undefined header: clean empty result
- Malformed entries (no `=`, leading `=`, trailing `=`): silently dropped
- Oversized headers: parsed without throwing
- Hostile input (`,,,,,`, 10 000-char string): does not throw
- Foreign-vendor entry using our `vendorKey` with malformed value: dropped from inherited

### formatTracestate

- Most-recent-first ordering: our entry leftmost
- 32-entry cap: drops rightmost
- 512-char cap: drops rightmost until under
- Empty inherited: emits our entry alone
- Custom `vendorKey`: respected

### Integration

- Two simulated SDK instances: A's egress `tracestate` → B's ingress → B's first `errorEventSeq > A's emitted clk value`
- `ErrorPackage.trace.tracestate` matches the inbound header verbatim

---

## Completion Criteria

- `parseTracestate` and `formatTracestate` exported from `src/context/tracestate.ts`
- `ALSManager.createRequestContext` parses on ingress, calls `merge`, stores inherited
- `ALSManager.formatOutboundTracestate` returns the egress string
- Both HTTP recorders inject the `tracestate` header alongside `traceparent`
- All seven middleware adapters fan-out the `tracestate` header
- Unit tests in `test/unit/trace-context.test.ts` pass
- Integration test in `test/integration/sdk-e2e.test.ts` confirms two-service chain
