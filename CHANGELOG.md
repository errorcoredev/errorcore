# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres
to Semantic Versioning once it reaches 1.0.0; until then, breaking changes may
ship in any minor release and are called out under the BREAKING heading.

## Unreleased

### Added

- `previousEncryptionKeys: string[]` config — declare prior `encryptionKey`
  values so dead-letter entries written under the old key still verify,
  decrypt, and drain after rotation. Validated with the same length /
  hex-format / Shannon-entropy / non-equal-to-primary rules as the
  primary key. Maximum 5 entries.
- `Encryption.verify(payload, mac)` and `Encryption.tryDecrypt(envelope)`
  walk the key chain (primary -> previous -> previous, in declaration
  order) and return the index of the matching key. The single-key
  `decrypt(envelope)` and `sign(payload)` shapes are unchanged for
  back-compat.
- `errorcore drain --rotate` — one-shot CLI flag that re-signs every
  valid dead-letter entry with the primary key. Reports counts of
  re-signed payloads, kept markers, and dropped (unverifiable) entries.

### Security

- Encryption key rotation is no longer a documented limitation. README's
  "rotation not supported" warning has been removed. The DeadLetterStore's
  HMAC integrity check now accepts a verifier object instead of a raw
  string key, opening the path to rotation-aware draining.

### Added

- `errorcore.getHealth()` and `SDKInstance.getHealth()` return a
  `HealthSnapshot` POJO for `/healthz`-style endpoints. The snapshot
  reports monotonic counters (`captured`, `dropped` with a per-bucket
  `droppedBreakdown`, `transportFailures`), current gauges
  (`transportQueueDepth`, `deadLetterDepth`, `ioBufferDepth`), rolling
  P50/P99 of per-payload transport latency, and the most recent
  transport-failure reason with its timestamp. Counters are cumulative
  since `init()` and never reset by `getHealth()` — operators scrape on
  an interval and compute rates by differencing, matching the
  Prometheus counter convention. Dead-lettered payloads are not
  counted as dropped; only errors that will never reach a collector
  (rate-limited, capture-failed, dead-letter write failed) increment
  `dropped`.

### Tests

- `npm run coverage` (new script) produces a coverage report via
  `@vitest/coverage-v8`. Reporters: text, html, lcov. The report excludes
  `dist/`, `bin/`, `tmp-*/`, `benchmark-harness/`, `perf/`,
  `config-template/`, `scripts/`, `node_modules/`, the test files
  themselves, and `.d.ts` files. Baseline at this commit:
  73.9% statements, 64.52% branches, 80.94% functions, 74.95% lines.
  No threshold is enforced — the change is observability-only; a hard
  gate may follow once the number stabilises. Notable 0% gaps surfaced
  by the baseline: `src/ui/terminal/*` (terminal renderer untested),
  `src/ui/frontend.ts` (dashboard frontend), and
  `src/capture/package-assembly-worker.ts` (worker-thread entry,
  mocked in tests).

### Added

- `logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'` config knob.
  Default `'warn'`. Filters which internal SDK messages reach `console.*`.
  Does NOT affect `onInternalWarning` -- that channel remains separate
  and unfiltered. Set `'silent'` to suppress every `[ErrorCore]` line
  that goes through the gate. The legacy `silent: true` flag still works
  and continues to gate only the one-line startup diagnostic; `logLevel`
  is the broader gate for warnings, info, and debug messages emitted
  throughout the SDK.

### Fixed

- `onInternalWarning(warning).cause` is now a structured `{ name, message,
  stackHead?, code? }` object whenever the underlying trigger was an
  `Error`. `code` is preserved on errno-typed errors so consumers can
  distinguish `ENOSPC` from `EACCES` at the dead-letter callsite without
  parsing message text. Previously `cause` was the raw `Error` instance,
  which serialised poorly through structured-clone and JSON paths.
  Non-Error triggers (strings, falsy values) still pass through verbatim
  for back-compat.

### Docs

- README links to a new "Dashboard (UI)" section in OPERATIONS.md.
  SETUP.md now has a `## Dashboard` section covering the
  `errorcore ui` subcommand, port configuration, `EC_DASHBOARD_TOKEN`,
  and the `--allow-external-config` flag's threat model. OPERATIONS.md
  has an operator-facing walkthrough for incident triage, deploy
  validation, and dead-letter recovery, plus the security defaults
  (loopback-only bind, two-layer CSRF guard, constant-time bearer
  compare).

## 0.2.0 (2026-04-21)

Coordinated P0+P1+P2 production readiness pass. Several defaults tightened,
unsafe implicit behaviors removed, and three previously-dark features restored
(local variables capture, IO timeline recording, source-map resolution).

### Breaking (pre-1.0 semver window)

- **Config**: `allowInsecureTransport: true` is rejected with an error pointing
  at `allowPlainHttpTransport: true`. `allowInsecureTransport: false` is
  accepted as a silent no-op with a one-time deprecation warning.
  `allowInsecureTransport: true` combined with `allowPlainHttpTransport: false`
  is rejected as a contradiction. Deprecated in 0.2.0, will be removed in
  1.0.0. [G4]
- **Startup output**: a single diagnostic line is printed at `activate()`
  listing recorder states. Suppress with `config.silent: true`.
- `init()` no longer auto-loads `./errorcore.config.js` from the current
  working directory. Callers must pass configuration explicitly, for example
  `errorcore.init(require('./errorcore.config.js'))`. The previous behavior
  executed an arbitrary JS file whose path was only controlled by the process
  cwd at startup, which was an RCE surface for any entry point that ran
  errorcore with an attacker-controlled cwd.
- The `errorcore` CLI (`validate`, `status`, `drain`, `ui`) refuses to load a
  config file located outside the current working directory unless the new
  `--allow-external-config` flag is passed.
- `Encryption.prototype.getHmacKeyHex()` is removed. Consumers that signed
  their own payloads by pulling the HMAC key out of the Encryption instance
  now call `encryption.sign(serializedPayload)` instead. The HMAC key never
  leaves the Encryption instance.
- `encryptionKey` validation raises the minimum character-diversity (Shannon
  entropy) from 2.0 to 3.5 bits per character. A uniformly random 32-byte
  hex key scores ~3.93 so `crypto.randomBytes(32).toString('hex')` still
  passes. A four-distinct-character repeating pattern that previously
  scraped by is now rejected.
- `startDashboard()` no longer binds to `0.0.0.0` when a token is configured.
  The default is always `127.0.0.1`. Remote binding now requires passing
  `hostname` explicitly. Attempting to bind to a non-loopback hostname
  without a token throws on startup.

### Added

- `Encryption.sign(serializedPackage)` returns an HMAC-SHA256 signature of the
  argument using the internally-derived HMAC key. Derivation parameters are
  unchanged, so signatures remain bitwise identical to the previous external
  `createHmac('sha256', getHmacKeyHex()).update(...).digest('base64')`
  formulation. Existing signed dead-letter entries still verify.
- `withNextMiddleware(middleware)` — wrap a Next.js middleware handler to start
  an ALS context, capture thrown errors, and optionally capture non-2xx
  responses. Propagates context into the wrapped route handler. `undefined`
  returns are always pass-through. [C1]
- `captureMiddlewareStatusCodes: number[] | 'none' | 'all'` config — control
  which middleware-returned status codes are captured. Default `'none'`. [C1]
- `drivers: { pg?, mongodb?, mysql2?, ioredis? }` config — explicit driver
  references for bundled environments where `require()` does not reach the
  same module instance the app uses. [G2]
- `silent: boolean` config — suppress the startup diagnostic block.
- `sourceMapSyncThresholdBytes: number` config (default 2 MB) — maps larger
  than this threshold resolve asynchronously to avoid cold-cascade event-loop
  blocking. Setting to `0` restores pre-0.2.0 fully-async behavior. [G3]
- Three-state recorder telemetry in the startup block: `ok`, `skip(<reason>)`,
  `warn(<reason>)`, with per-warn actionable guidance lines.
- `completeness.localVariablesCaptureLayer`, `completeness.localVariablesDegradation`,
  `completeness.localVariablesFrameAlignment`, and `completeness.sourceMapResolution`
  fields for production dashboard visibility into capture path and degradation.

### Fixed

- Local variables now capture correctly in bundled environments (Next.js,
  Vite SSR, webpack). Inspector locals are correlated via a non-enumerable
  Symbol tag on the exception object (Layer 1), with identity-tuple fallback
  (Layer 2) and frame-index alignment (Layer 3). [G1]
- HTTP inbound and outbound recorders no longer early-return on missing
  `socket` in diagnostic-channel payloads. HTTP server, HTTP client, and
  undici now subscribe against real Node channel shapes per supported version.
  [G2 shape audit]
- Source-map resolution is consistent from the first capture. Cache misses
  load synchronously on the normal capture path (up to the 2 MB size gate);
  `uncaughtException`/`SIGTERM` paths remain cache-only. [G3]
- `errorcore validate` no longer prints the configured `encryptionKey` to
  stdout. The resolved-config dump now renders a `(set, hidden)` sentinel
  for `encryptionKey`, `apiKey`, `token`, `dsn`, and `password` fields. The
  previous output emitted the full hex key, which leaked into CI logs, copy-
  pasted support threads, and shared screenshots.
- `allowUnencrypted` default is tied to the existing transport default:
  `!isProduction()` in development, `false` in production. The two defaults
  now share the same `isProduction()` helper, restoring the README's zero-
  config dev contract (`require('errorcore').init()` with no args captures
  to stdout in development). An interim stricter policy defaulted
  `allowUnencrypted` to `false` unconditionally, which broke the documented
  getting-started flow.
- README license link points to `LICENSE.md` (was `LICENSE`, a 404 on npm).

- StateTracker proxy traps no longer propagate exceptions from the internal
  recorder (cloneAndLimit of a hostile value, ALS misbehavior). Host reads
  of a tracked container always succeed; telemetry failures are silently
  dropped. Host-side getter exceptions are still propagated normally.
- The SDK's `uncaughtException` handler no longer calls `process.exit(1)`
  when the host application has its own `uncaughtException` listener
  installed. The error is still captured. The previous behavior overrode
  host-managed crash recovery logic.
- The `beforeExit` handler is now async and awaits shutdown so pending
  flushes complete before Node exits. The previous implementation used
  fire-and-forget and lost the final flush.
- `captureError` and `flush` now accept calls during the `shutting_down`
  phase, bounded by the existing buffer. This eliminates silent drops of
  errors that arrive between shutdown start and transport close.
- `drainDeadLetters` arithmetic rewritten as a clearer `drainedEverything`
  branch. Behavior is equivalent; the previous ternary form obscured a
  subtle correctness requirement around purging interleaved invalid
  entries.
- The `initializing` re-entry guard moved from a module-scoped `let` to a
  `globalThis[Symbol.for('errorcore.sdk.initializing')]` slot so the
  guard spans webpack chunks and bundled entry points.
- `withErrorcore` (Next.js) no longer calls `.clone().json()` on the
  handler's return value to pick an error message from a 5xx body. That
  path interacted badly with streaming responses and with framework
  internals that had already consumed the clone. The status code alone
  now drives the auto-capture; a real message comes via exceptions.
- `wrapLambda` / `wrapServerless` safety timer uses an `invocationCompleted`
  flag so a timer that fires in the same tick as a handler's return
  short-circuits instead of reporting a spurious "Timeout imminent".
- Lambda `WatchdogManager` worker no longer silently swallows HTTP
  errors from the collector post. Errors go to stderr so CloudWatch
  sees ECONNREFUSED/DNS failures. The 3-second write timeout now
  destroys the request with an explicit error, which propagates to any
  in-flight write buffers.
- `FileTransport` rotation is serialized in-process so two concurrent
  `send()` calls that observe a size over the threshold no longer both
  attempt to rename the file. Rotated-filename suffix uses a monotonic
  per-instance counter so two rotations inside the same millisecond
  produce distinct names.
- `DeadLetterStore` `clearSent` failures and temp-file-unlink failures
  now surface via the new `onInternalError` constructor option instead
  of being silently swallowed. If no callback is provided the error is
  logged as before.
- `TransportDispatcher` worker message handler validates that the
  incoming message has a numeric `id` field before touching the
  pending Map. A corrupted or unexpected message now early-returns
  instead of silently dropping an unrelated in-flight request.
- `TransportDispatcher.sendSync` now applies configured encryption
  before handing the payload off to the synchronous transport. The
  previous implementation explicitly discarded the encryption handle,
  so the uncaught-exception path wrote plaintext even when the SDK was
  configured with an `encryptionKey`.
- `HttpTransport` retry filter rewritten as an explicit allowlist of
  transient network codes (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`,
  `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`)
  plus the same HTTP status allowlist as before. Everything else is
  non-retryable. The previous logic treated any `error.code` as
  retryable except a small TLS blocklist, which meant local errors
  like `EACCES` and `ENOSPC` were retried pointlessly.
- `PackageAssemblyDispatcher` request-id counter wraps at 2^31 and
  skips ids still live in the pending Map. The previous counter grew
  without bound.
- `PackageAssemblyDispatcher` worker exit handler always rejects
  in-flight assemble promises. The previous code gated rejection on
  `!shuttingDown && code !== 0`, so assembles that were still in
  flight when shutdown began hung forever on a clean worker exit.
- `PackageAssemblyDispatcher` message handler validates the message
  shape before touching the pending Map. Corrupted messages early
  return instead of dropping an unrelated request silently.
- `package-assembly-worker` error responses carry only
  `${name}: ${message}` across the port boundary. Stack traces stayed
  inside the worker process. Host file paths (and PII interpolated
  into error messages by host code) no longer leak to the parent's
  warning log.
- `SourceMapResolver` caps .js/.map file reads at 4 MB. Oversized
  files (by upstream bundler misconfiguration or a crafted payload)
  are skipped. Base64 inline source maps are length-checked before
  decode.
- `SourceMapResolver` path-traversal guard normalized through
  `path.relative` so a `sourceMappingURL` with forward slashes on
  Windows cannot escape the containing directory.
- `SourceMapResolver.warmPromises` is bounded at 256 entries; older
  entries are dropped when the cap is reached. Previously this array
  grew without limit in long-running processes that never awaited
  `flushWarmQueue()`.
- `ProcessMetadata.startEventLoopLagMeasurement` uses `setInterval`
  instead of recursive `setTimeout`. Under a stalled event loop the
  recursive form queued new timers inside delayed callbacks,
  amplifying backlog. `shutdown()` sets a `lagStopped` flag so a
  callback already queued by Node returns without writing state.
- `ProcessMetadata.readContainerId` caps `/proc/self/cgroup` and
  `/proc/self/mountinfo` reads at 64 KB using an fd-based bounded
  read so unusually large container-stack hierarchies do not block
  SDK init.

### Docs

- `spec/17-nextjs-integration.md` expanded with Tier 1/2/3 guidance,
  `serverExternalPackages` recommendation, Edge capture pattern, and
  `withNextMiddleware` reference.
- README mirrors the three-tier block and documents the 3–6-line verbose
  startup output and Next.js middleware usage.

### Deferred (tracked in followups.md)

- Byte-size budget for source-map cache (secondary eviction criterion beyond
  count-of-128).
- Per-`activate()` lifetime sync-parse budget with fallback-to-async after
  exhaustion.
- `parseTimeoutMs` for source-map parse abort.
- 1.0.0 release concurrent with ingestion-backend commercial availability.

### Security (additional)

- ioredis patch redacts the first argument of `AUTH` and `HELLO`
  commands. These commands transmit credentials to the Redis server
  as their first argument, which the SDK previously recorded
  verbatim as the "collection" and included in the formatted query
  string on every captured error package.

### Defensive bounds

- `RateLimiter.droppedCount` and `droppedSinceLastAcquire` increments
  are saturating at `Number.MAX_SAFE_INTEGER`. Reaching the bound
  would take ~9e15 drops, but the counter no longer produces
  non-integer values if a long-lived rate limiter ever did.
- `ALSManager.requestCounter` wraps to 0 at `Number.MAX_SAFE_INTEGER`
  so generated request ids remain integers even on processes that
  somehow sustained millions of requests per second for weeks.

### Diagnostics

- `ERRORCORE_DEBUG` is re-read on every `createDebug(...)` log call
  so operators can toggle debug output during incident triage without
  restarting the host. Previously the flag was captured once at import
  time.
- `emitSafeWarning('capture_failed', ...)` now includes the error's
  name and a 200-char-truncated message instead of only the
  constructor name. Operators can now tell a RangeError apart from a
  TypeError without enabling debug output.

### Packaging

- `package.json` `exports.` no longer points at `./dist/index.mjs`.
  The `tsc`-only build does not emit `.mjs` so the declared ESM
  entry was a dangling reference. ESM consumers now resolve to the
  same CJS entry via Node's default CJS-ESM interop. The stale
  `dist/index.mjs` shim that had been checked in has been removed.

### Security

- Closed an arbitrary-code-execution path in `init()` that would `require()`
  any file named `errorcore.config.js` found in the process cwd at init time.
- Hardened the CLI's config-path resolution: paths outside cwd are rejected by
  default, and non-regular-file paths (dangling symlinks, directories) are
  rejected explicitly.
- The derived HMAC signing key is no longer exposed via a public method. The
  signing operation now happens inside `Encryption` itself. Constant-time
  comparison (`crypto.timingSafeEqual`) replaces `Buffer.equals` when
  detecting whether a ciphertext uses the legacy per-message salt scheme; this
  removes a salt-matching timing oracle on decrypt.
- Dashboard bearer token comparison uses `crypto.timingSafeEqual`.
- Dashboard POST endpoints now require both an `x-errorcore-action: true`
  header and a same-origin `Origin` header. The previous single-header gate
  was insufficient on its own.

## 0.1.1

Previous release. See git history.
