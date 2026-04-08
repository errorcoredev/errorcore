# Module 09: Database Driver Patches

> **Spec status:** LOCKED
> **Source files:** `src/recording/patches/patch-manager.ts`, `src/recording/patches/pg.ts`, `src/recording/patches/mysql2.ts`, `src/recording/patches/ioredis.ts`, `src/recording/patches/mongodb.ts`
> **Dependencies:** Module 01 (types), Module 03 (buffer), Module 06 (ALS)
> **Build order position:** 9

---

## Module Contract Header

```typescript
/**
 * @module 09-database-patches
 * @spec spec/09-database-patches.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts
 */
```

---

## Purpose

Monkey-patch popular database driver public APIs to record query I/O events into the circular buffer. Provides safe wrap/unwrap infrastructure and per-driver patch implementations for pg, mysql2, ioredis, and mongodb.

---

## Scope

- `PatchManager` class: safe monkey-patching infrastructure with idempotent wrap/unwrap
- `pg.ts`: patch `pg.Client.prototype.query` and `pg.Pool.prototype.query`
- `mysql2.ts`: patch `mysql2.Connection.prototype.query` and `.execute`
- `ioredis.ts`: patch `Redis.prototype.sendCommand`
- `mongodb.ts`: patch `Collection.prototype` methods

---

## Non-Goals

- Does not support database drivers not listed above.
- Does not capture full query results or document contents (only row counts).
- Does not perform PII scrubbing (bind params are redacted to `[PARAM_N]` placeholders by default).

---

## Dependencies

- Module 01: `IOEventSlot`, `ResolvedConfig`
- Module 03: `IOEventBuffer`
- Module 06: `ALSManager`

---

## Node.js APIs Used

- `require()` with try/catch for optional driver detection
- `process.hrtime.bigint()` for timing
- Prototype property assignment for monkey-patching

---

## Data Structures

### PatchManager class

```typescript
class PatchManager {
  constructor(deps: { buffer: IOEventBuffer; als: ALSManager; config: ResolvedConfig });
  installAll(): void;
  unwrapAll(): void;
}
```

### Internal patch infrastructure

```typescript
function wrapMethod(target: object, methodName: string, wrapper: (original: Function) => Function): void;
function unwrapMethod(target: object, methodName: string): void;
```

- `wrapMethod` stores the original function on the target via a non-enumerable symbol property.
- Calling `wrapMethod` twice on the same method unwraps the first before applying the second (idempotent).
- The wrapper receives the original and must call it, preserving `this` and arguments.

---

## Implementation Notes

### Per-driver patch pattern

Each driver file exports an `install(deps)` function:

1. `try { require(driverName) }` — if module not found, return no-op uninstall function
2. Wrap the public query methods with instrumentation
3. In the wrapper:
   - Create IOEventSlot: `type: 'db-query'`, `direction: 'outbound'`, record `startTime`
   - Extract query string (NOT bind param values — those are redacted to `[PARAM_1]`, `[PARAM_2]`, etc.)
   - Extract target: database name, host, port from connection config
   - Read ALS context for `requestId`
   - Call original method
   - On completion (callback or promise): record `endTime`, `durationMs`, row count, error if any
   - Push IOEventSlot to buffer
4. Return an `uninstall()` function that calls `unwrapMethod`

### pg.ts specifics

- `pg.Client.prototype.query` accepts `(text, values?, callback?)` or `QueryConfig { text, values, ... }`. Handle both.
- `pg.Pool.prototype.query` delegates to `Client.prototype.query` — patch both to catch pool-level calls.
- Target: `postgres://${client.host}:${client.port}/${client.database}`
- Record: `{ query: text, params: '[PARAM_1],...', rowCount: result.rowCount }`
- If `config.captureDbBindParams` is true: capture actual param values (still subject to PII scrubbing at capture time)

### mysql2.ts specifics

- `Connection.prototype.query(sql, values?, callback?)` and `.execute(sql, values?, callback?)`
- Target: `mysql://${config.host}:${config.port}/${config.database}`
- Record: query string, param count

### ioredis.ts specifics

- `Redis.prototype.sendCommand(command)` — all commands flow through this
- `command.name` gives the command (GET, SET, etc.)
- `command.args[0]` gives the key
- Target: `redis://${options.host}:${options.port}`
- Do NOT record values (PII risk). Only record command name and key.

### mongodb.ts specifics

- Patch `Collection.prototype` methods: `find`, `findOne`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `aggregate`
- Target: `mongodb://${db.databaseName}/${collection.collectionName}`
- Record: operation name, collection name, filter (scrubbed — keys only, values replaced with types)
- Do NOT record document contents

### Driver load order

For v1: document that `require('errorcore')` must come BEFORE `require('pg')` etc. The SDK patches the prototype at `installAll()` time. If the driver is loaded later, the prototype methods are already patched because they share the same prototype object.

---

## Security Considerations

- Bind parameters are redacted to `[PARAM_1]`, `[PARAM_2]`, etc. by default. This prevents SQL injection payloads, passwords, and other sensitive data from being captured.
- Query strings are captured as-is. Inline values in SQL strings are NOT redacted by the driver patch (they are handled by the PII scrubber at capture time).
- MongoDB document contents are NOT captured. Only operation name, collection name, and filter key names.
- Redis values are NOT captured. Only command name and key.

---

## Edge Cases

- Driver not installed: `require()` throws, caught silently, no-op uninstall returned
- Driver version incompatibility (method signature changed): wrap in try/catch, log warning, skip
- `wrapMethod` called twice: idempotent — unwraps first, then re-wraps
- Query callback throws: error propagates to application normally. IOEvent records the error.
- Query returns a stream (pg cursor, mysql2 streaming): record the query start. Do not attempt to capture stream data.
- Connection lost during query: record error in IOEvent
- Pool query that creates a new connection: patched method still fires

---

## Testing Requirements

- PatchManager.installAll with no drivers installed: no errors
- PatchManager.unwrapAll restores original methods
- wrapMethod/unwrapMethod are idempotent
- pg patch: query with callback signature records IOEvent with correct query, target, duration
- pg patch: query with QueryConfig object works
- pg patch: bind params redacted to placeholders
- mysql2 patch: query and execute recorded
- ioredis patch: GET/SET recorded with command and key, no value
- mongodb patch: find/insertOne recorded with collection name and operation
- All patches: original method still called and returns correct result
- All patches: error in query recorded in IOEvent.error
- All patches: ALS context propagated (requestId set on IOEvent)

---

## Completion Criteria

- `PatchManager` class exported with `installAll()` and `unwrapAll()`.
- All four driver patches implemented and tested.
- `wrapMethod`/`unwrapMethod` are idempotent.
- Bind params redacted by default.
- Original method behavior preserved exactly.
- All unit tests pass.
