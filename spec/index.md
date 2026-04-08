# ErrorCore SDK — Master Specification Index

> **Status:** LOCKED
> **Schema version:** 1.0.0
> **Runtime target:** Node.js >= 20
> **Language:** TypeScript (compiled to JS for distribution)
> **Dependencies:** Zero runtime dependencies. Only `node:` built-in modules.

---

## System Overview

ErrorCore (Error Capture Diagnostics) is a single npm package (`errorcore`) that instruments a Node.js process to continuously record I/O and request context at low overhead. When an error occurs, it captures a self-contained "error package" with high-fidelity context for diagnosis and, in many cases, reproduction in an isolated environment.

The SDK is `require()`'d at the top of the user's entry point. It must not break the host process, must not leak PII, and must degrade gracefully when it cannot capture complete context.

---

## Architecture Summary

The SDK has four continuous recording layers plus an on-demand error-time capture:

1. **I/O Recording** — Subscribes to `diagnostics_channel` and monkey-patches database drivers to record all inbound/outbound I/O into a fixed-size circular buffer.
2. **Request Context Binding** — Uses `AsyncLocalStorage` to correlate I/O events to individual inbound HTTP requests.
3. **State Tracking** — Uses `Proxy` to record reads from user-registered in-memory state containers (opt-in).
4. **Error-Time Capture** — On error, assembles a self-contained `ErrorPackage` from the buffer, ALS context, V8 inspector local variables, process metadata, and completeness flags.

All components are plain classes with constructor-injected dependencies. The composition root (`sdk.ts`) is the only place where components are instantiated and wired together.

---

## Development Scope

- Pure JS/TS, zero native dependencies
- Package name: `errorcore`
- CommonJS package with `.d.ts` declarations
- Ships compiled JS + `.d.ts` declarations
- Test runner: vitest

---

## Strict Build Order

Modules MUST be implemented in this exact order. Each module depends only on modules above it. An implementation agent MUST NOT begin a module until all of its dependencies are complete.

| Step | Module Spec | Source Files | Dependencies |
|------|------------|--------------|--------------|
| 1 | [01-types-and-config](01-types-and-config.md) | `src/types.ts`, `src/config.ts` | None |
| 2 | [02-serialization](02-serialization.md) | `src/serialization/clone-and-limit.ts` | 01 |
| 3 | [03-io-event-buffer](03-io-event-buffer.md) | `src/buffer/io-event-buffer.ts` | 01 |
| 4 | [04-pii-scrubbing](04-pii-scrubbing.md) | `src/pii/patterns.ts`, `src/pii/scrubber.ts`, `src/pii/header-filter.ts` | 01, 02 |
| 5 | [05-encryption-and-security](05-encryption-and-security.md) | `src/security/encryption.ts`, `src/security/rate-limiter.ts` | 01 |
| 6 | [06-request-context](06-request-context.md) | `src/context/als-manager.ts`, `src/context/request-tracker.ts` | 01 |
| 7 | [07-body-capture](07-body-capture.md) | `src/recording/body-capture.ts` | 01, 03 |
| 8 | [08-io-recording](08-io-recording.md) | `src/recording/http-server.ts`, `src/recording/http-client.ts`, `src/recording/undici.ts`, `src/recording/net-dns.ts` | 01, 03, 06, 07 |
| 9 | [09-database-patches](09-database-patches.md) | `src/recording/patches/patch-manager.ts`, `src/recording/patches/pg.ts`, `src/recording/patches/mysql2.ts`, `src/recording/patches/ioredis.ts`, `src/recording/patches/mongodb.ts` | 01, 03, 06 |
| 10 | [10-channel-subscriber](10-channel-subscriber.md) | `src/recording/channel-subscriber.ts` | 01, 08, 09 |
| 11 | [11-state-tracking](11-state-tracking.md) | `src/state/state-tracker.ts` | 01, 02, 06 |
| 12 | [12-v8-inspector](12-v8-inspector.md) | `src/capture/inspector-manager.ts` | 01 |
| 13 | [13-error-capture-pipeline](13-error-capture-pipeline.md) | `src/capture/error-capturer.ts`, `src/capture/process-metadata.ts`, `src/capture/package-builder.ts` | 01, 02, 03, 04, 05, 06, 12 |
| 14 | [14-transport](14-transport.md) | `src/transport/transport.ts`, `src/transport/http-transport.ts`, `src/transport/file-transport.ts`, `src/transport/stdout-transport.ts` | 01, 05 |
| 15 | [15-middleware](15-middleware.md) | `src/middleware/express.ts`, `src/middleware/fastify.ts`, `src/middleware/koa.ts`, `src/middleware/hapi.ts`, `src/middleware/raw-http.ts` | 01, 06 |
| 16 | [16-sdk-composition](16-sdk-composition.md) | `src/sdk.ts`, `src/index.ts` | ALL prior modules |

---

## File Structure

```
src/
  index.ts                  — Public API facade (thin, delegates to SDKInstance)
  sdk.ts                    — Composition root: createSDK(), SDKInstance class
  config.ts                 — SDKConfig interface, defaults, validation
  types.ts                  — All shared TypeScript interfaces

  buffer/
    io-event-buffer.ts      — Purpose-built circular buffer for IOEvent records

  serialization/
    clone-and-limit.ts      — Recursive deep-clone with structural limits

  context/
    als-manager.ts          — AsyncLocalStorage lifecycle (class, not singleton)
    request-tracker.ts      — Active in-flight request Map

  recording/
    channel-subscriber.ts   — diagnostics_channel subscription orchestrator
    http-server.ts          — Inbound HTTP channel handlers
    http-client.ts          — Outbound HTTP (core) channel handlers
    undici.ts               — Undici channel handlers
    net-dns.ts              — net.socket / dns.resolve channel handlers
    body-capture.ts         — Stream tee / body accumulation utilities
    patches/
      patch-manager.ts      — Safe monkey-patch infrastructure (wrap/unwrap)
      pg.ts                 — pg driver patch
      mysql2.ts             — mysql2 driver patch
      ioredis.ts            — ioredis driver patch
      mongodb.ts            — mongodb driver patch

  state/
    state-tracker.ts        — Proxy-based container read tracking

  capture/
    error-capturer.ts       — Orchestrates full error-time capture
    inspector-manager.ts    — V8 inspector session + locals cache
    process-metadata.ts     — Process info, git SHA, env, event loop lag
    package-builder.ts      — Assemble final ErrorPackage object

  pii/
    scrubber.ts             — Recursive value scrubber engine
    patterns.ts             — Regex patterns for PII detection
    header-filter.ts        — Header allowlist / blocklist logic

  security/
    encryption.ts           — AES-256-GCM encrypt/decrypt
    rate-limiter.ts         — Sliding-window rate limiter

  transport/
    transport.ts            — Transport interface + worker_threads dispatcher
    http-transport.ts       — HTTPS POST transport
    file-transport.ts       — Append-to-file transport
    stdout-transport.ts     — JSON-line to stdout transport

  middleware/
    express.ts
    fastify.ts
    koa.ts
    hapi.ts
    raw-http.ts
```

---

## Cross-Cutting Invariants

These rules apply to ALL modules. Every module specification references them where relevant.

### GC Safety Invariant

All data stored in long-lived SDK data structures (circular buffer, state read arrays, inspector locals cache) MUST be self-contained plain objects with NO references to host application objects (`IncomingMessage`, `ServerResponse`, `Socket`, `ClientRequest`, etc.). At recording time, synchronously extract needed scalar values into plain fields. Replace entire slot references on overwrite for atomic unreachability.

### Dependency Injection

Every component is a plain class with constructor-injected dependencies. No component imports another component's module directly. The composition root (`sdk.ts`) is the only file that imports all component classes. Module-level mutable state exists only in `index.ts` (one `SDKInstance` reference).

### Serialization Limits

All arbitrary-value serialization uses `cloneAndLimit()` with structural bounds (depth, array items, object keys, string length). Two profiles: Standard (capture time) and Tight (state-read time). See [02-serialization](02-serialization.md).

### Shutdown Contract

Every component that holds timers, listeners, or sessions exposes a `shutdown()` method. The SDK orchestrates teardown in reverse-initialization order. All timers use `.unref()`. See [16-sdk-composition](16-sdk-composition.md).

---

## Testing Expectations

- **Unit tests:** Every module has isolated unit tests using vitest. Components are instantiated with real or mock dependencies. No module-level state to clean up between tests.
- **Integration tests:** Full SDK instances created via `createSDK()` (not the module-level `init()`). Tests verify end-to-end flows such as encrypted file delivery, ambient-event fallback, state-read capture, middleware context propagation, and shutdown completeness.
- **Performance tests:** A dedicated benchmark harness under `benchmark-harness/` and `perf/bench/` measures steady-state overhead, error capture latency, and micro-benchmark regressions outside the unit test suite.

---

## Security Requirements

- PII scrubbed by default on all captured data (headers, bodies, local variables, db params, env vars, file paths).
- Error packages encrypted with AES-256-GCM when an encryption key is configured. SDK activation requires an encryption key unless `allowUnencrypted: true` is explicitly set.
- This repository build is local-only at config resolution time: `stdout` and `file` transports are supported, while HTTP transport remains reserved for non-local-only builds and must enforce HTTPS when enabled.
- Inspector session used strictly for `Runtime.getProperties` during `Debugger.paused`. Never exposes session externally. Never evaluates expressions from external input.
- Circular buffer contents never written to disk in raw form. Only scrubbed, encrypted error packages leave the process.
- Rate limiting prevents capture amplification under high error rates (default 10 captures/minute).

---

## Performance Guarantees

| Metric | Target |
|--------|--------|
| Steady-state CPU overhead | < 5% |
| Steady-state memory overhead | < 100 MB |
| Error capture latency | < 500 ms |
| Inspector idle CPU | < 2% |
| Inspector with 100 caught exceptions/sec | < 5% CPU |
| Buffer push throughput | > 1M events/sec |
| Tight-profile cloneAndLimit | < 10 microseconds |

These are production readiness goals evaluated by the benchmark harness, not unit-test timing assertions.

---

## Implementation Guardrails

1. Agents implement exactly ONE module at a time.
2. Agents only modify files listed in that module's specification.
3. Agents follow the build order defined above. Never skip ahead.
4. Agents load only the relevant spec file plus `index.md` for context. Do NOT load the entire architecture plan.
5. If a specification is unclear or contradictory, the agent MUST stop and ask rather than invent behavior.
6. Agents must NOT redesign the system, introduce alternative architectures, change data structures, or reinterpret subsystem responsibilities.
7. Every source file must begin with a **module contract header** comment that states the file's purpose, its module spec reference, and its injected dependencies.
