# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres
to Semantic Versioning once it reaches 1.0.0; until then, breaking changes may
ship in any minor release and are called out under the BREAKING heading.

## 0.2.0 (unreleased)

Coordinated P0+P1 production readiness pass. Several defaults tightened and
unsafe implicit behaviors removed.

### BREAKING

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
- `allowUnencrypted` no longer defaults based on `NODE_ENV`. The default is
  now `false` unconditionally. Callers that previously relied on the dev
  fallback (`NODE_ENV !== 'production'` implicitly enabling plaintext) must
  set `allowUnencrypted: true` explicitly in their config. The previous
  behavior silently disabled encryption when `NODE_ENV` was missing or
  misspelled (for example `NODE_ENV=prod` or `NODE_ENV=Production`).
- `allowInsecureTransport` is removed. It was a silent alias for
  `allowPlainHttpTransport`. `resolveConfig` throws a clear error if the
  removed name is passed. `ResolvedConfig.allowInsecureTransport` is no
  longer emitted.
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

### Fixed

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
