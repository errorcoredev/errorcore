# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
Semantic Versioning from 1.0.0 onward; before then, breaking changes may ship in
any minor release and are called out under a **Breaking** heading.

## Unreleased - 0.4.0

### Changed

- **Licensing:** `0.4.0` is the first version prepared under the unmodified
  PolyForm Strict License 1.0.0. The last repository version under PolyForm
  Small Business 1.0.0 was `0.3.0`; the last npm-published version under that
  license was `0.2.1`. Earlier artifacts and Git history are unchanged.
- **Breaking (wire format): the encrypted envelope is now `v: 2`.** Envelopes
  carry two new fields — `kind: 'error' | 'payload_blob'` and `blobId`
  (required iff `kind === 'payload_blob'`, absent otherwise) — and both are
  authenticated: AAD is now
  `2|keyId|sdkVersion|eventId|kind|blobId-or-empty-string`. The outer HMAC
  input is unchanged (`iv‖ciphertext‖authTag‖AAD`); the AAD change carries the
  new binding. Previously the payload kind travelled only in the mutable
  `X-Errorcore-Payload-Kind` header and blob envelopes carried an
  unauthenticated `blobId`. Collectors must be upgraded to the envelope-v2
  verifier before SDKs are upgraded (see ADR-0001 in the ingestion repo).
- **Breaking (local spools): v1 envelopes are no longer emitted, only read.**
  `v: 1` acceptance survives on local read paths only — dead-letter drain, the
  `errorcore/ingest` reader, and the local ndjson viewer — so spools written by
  0.3.x still verify and drain. A v1 envelope POSTed to an envelope-v2
  collector will be rejected; dev spools that never drain will be dropped after
  their retry budget expires.
- **Breaking (types): key material is no longer on the public resolved
  config.** `encryptionKey`, `macKey`, `encryptionKeyCallback`,
  `previousEncryptionKeys`, and `previousTransportAuthorizations` were removed
  from `ResolvedConfig`, mirroring the existing `PublicTransportConfig`
  narrowing for transport credentials. `instance.config.encryptionKey` is now
  both a type error and `undefined` at runtime. The values are resolved and
  validated by the new exported `resolveSecrets()` into a runtime-only
  `ResolvedSecrets` object held by the composition root and handed directly to
  the components that need it (encryption setup, worker config assembly, DLQ
  signing). Validation behavior and error messages are unchanged.
- **Duplicate suppression is no longer counted as rate limiting.** The
  fingerprint dedup check now runs *before* rate-limiter token acquisition, so
  a suppressed duplicate consumes no token — previously a duplicate burned a
  token and could starve a later distinct error out of its capture budget.
  Duplicates increment the new `droppedBreakdown.deduplicated` bucket instead
  of `droppedBreakdown.rateLimited`, and emit an `EC_DUPLICATE_SUPPRESSED`
  internal warning (previously silent). The dedup anchor is only registered for
  admitted captures.
- `getHealth()`'s `dropped` invariant is now the four-bucket sum:
  `rateLimited + deduplicated + captureFailed + deadLetterWriteFailed`.
  Consumers that destructure `droppedBreakdown` exhaustively must add the new
  field.
- Documentation corrections: HTTP transport retry is 3 attempts with jittered
  ~200ms/~600ms delays under a 30s budget (`OPERATIONS.md`,
  `BACKPRESSURE.md`, `spec/14-transport.md` previously claimed 5 attempts or
  1s/2s/4s exponential backoff); the transport content type is
  `application/errorcore+json`, not `application/json`; emitted
  `schemaVersion` is `1.3.0` (`spec/01`, `spec/13`, `DB.md` previously said
  `1.1.0`).

### Security

- **Bounded decompression.** `maybeDecompress` now passes zlib's
  `maxOutputLength`, so an over-cap payload throws *during* inflation instead
  of allocating unbounded output. The limit threads from the ingest reader
  through `Encryption` to the inflate call; breaching it raises
  `EC_DECOMPRESSION_LIMIT_EXCEEDED` (surfaced as `EC_INGEST_PLAINTEXT_TOO_LARGE`
  / HTTP 413 by the reader) and other inflate failures raise
  `EC_DECOMPRESSION_FAILED`. Default cap is 10 MiB.
- **Plaintext limiting is mandatory.** `maxPlaintextBytes` on
  `receiveIngestEnvelope` now defaults to 10 MiB instead of being optional and
  unbounded when omitted.
- **Envelope identity is enforced after decrypt.** The ingest reader rejects a
  payload whose decrypted inner `eventId` differs from the authenticated
  envelope `eventId`, whose inner kind contradicts the envelope `kind`, or (for
  blobs) whose inner `blobId` differs from the envelope `blobId`, with
  `EC_ENVELOPE_IDENTITY_MISMATCH` (HTTP 422). Previously the inner ids were
  never compared to the envelope.
- Envelope `kind`/`blobId` coherence is validated on both encrypt and decrypt
  (`EC_ENVELOPE_BLOB_ID_REQUIRED` / `EC_ENVELOPE_BLOB_ID_FORBIDDEN`), and the
  HTTP transport derives `X-Errorcore-Payload-Kind` from the envelope rather
  than a caller-supplied hint so the header can never disagree with the
  authenticated field.

### Added

- `resolveSecrets(userConfig)` (exported from `src/config`) and the
  `ResolvedSecrets` type: the runtime-only home for DEK/MAC/rotation material.
- `HealthMetrics.recordDroppedDeduplicated()` and
  `HealthSnapshot.droppedBreakdown.deduplicated`.
- `EC_DUPLICATE_SUPPRESSED` internal warning code.
- `DEFAULT_MAX_PLAINTEXT_BYTES` (10 MiB) exported from
  `src/security/compression`, and a `maxPlaintextBytes` option on
  `Encryption`.
- `EncryptedEnvelopeV1` and `AnyEncryptedEnvelope` types for the legacy
  read-only path.

See `docs/spec-amendments.md` entries 4 and 5 for the rationale behind the
envelope-v2 and dedup-metric deviations from the locked specs.

## 0.3.0 - 2026-07-10

### Changed

- **Breaking (default behavior): `captureMode: 'safe'` redesigned.** Safe now
  runs on the low-overhead capture chassis: direct package assembly, deferred
  delivery drained by the flush timer, no standing recorders (the inbound
  http-server event is synthesized from the request context at capture time),
  and shallow local-variable capture **on** by default, protected by an
  adaptive guard. Previously safe ran the full standing pipeline while
  capturing no locals. Users who want the full standing IO
  timeline (outbound HTTP, DB, DNS recorders) should set
  `captureMode: 'balanced'`.
- Mode behavior is expressed as derived `capabilities` on the resolved config
  instead of scattered `captureMode === 'fast'` point checks.
- The SDK flush timer now also drains capture payloads buffered by the
  deferred-delivery chassis, not just the transport queue.
- **Breaking:** `localsGuard` is now windowed rather than process-permanent.
  When the guard trips, locals report `disabled_adaptive_guard` until adaptive
  escalation re-arms capture or five quiet minutes pass below threshold.
- Framework middleware now lazily materializes request context. Successful
  requests that never capture or propagate trace headers only pay the ALS
  wrapper plus cheap request snapshots; tracker registration, cleanup, header
  filtering, trace parsing, and trace/span ID generation run on first
  materialization.
- Request method and URL are snapshotted at middleware entry, while request
  headers remain live until first header materialization. Header mutations made
  before capture or trace propagation are reflected in the emitted package.

### Added

- `localsGuard` config: `'off' | { maxPausesPerSecond?, maxPauseMsPerMinute? }`
  (defaults: 50 pauses/second sustained for 10s, or 250ms cumulative pause
  wall-time per minute).
- Runtime capture mode switching via `setCaptureMode(mode)` and
  `getCaptureMode()`, with stable transport, encryption, scrubbers, buffers,
  rate limiters, and dead-letter state across mode changes. Manual switches
  reconcile adaptive health and timers; modes outside the configured adaptive
  endpoints report the `manual` phase until base or escalated is selected.
- `adaptiveCapture` config. When enabled, the SDK starts in `safe` by default,
  escalates to `forensic` after an admitted capture, and de-escalates after
  quiet time and minimum dwell conditions.
- Health snapshots now include `captureMode` plus adaptive fields:
  `adaptive.active`, `adaptive.phase`, `adaptive.lastEscalationAt`, and
  `adaptive.switchCount`.
- Error package completeness now includes `modeAtCapture`.
- Bench: `docker-compose.capture-mode.yml` overlay plus
  `BENCH_ERRORCORE_CAPTURE_MODE`, `BENCH_ERRORCORE_ADAPTIVE`,
  `BENCH_ERRORCORE_LOCALS`, and `BENCH_ERRORCORE_MIDDLEWARE` knobs for
  per-mode overhead runs and cost decomposition.
- Bench: `BENCH_ERRORCORE_MIDDLEWARE=als-only` and
  `bench/harness/run-perf-only.mjs` isolate the AsyncLocalStorage floor for
  middleware-cost measurements.

## 0.2.1 - 2026-06-21

Initial public release.

ErrorCore captures the state of a Node.js program at the moment of failure — the
error and stack, the surrounding I/O timeline, request metadata, and (optionally)
local variables — and ships it to a transport of your choice.

### Capture

- Error capture with V8 stack-ownership classification (app vs. dependency
  frames) and an app-boundary frame for fast triage.
- Optional local-variable capture via the V8 inspector, with bundled-environment
  correlation (Next.js, Vite SSR, webpack) and graceful degradation when the
  debugger is unavailable.
- I/O timeline recording across HTTP server/client, undici/fetch, net, and DNS.
- Database query recording for `pg`, `mysql2`, `ioredis`, and `mongodb`, with
  bind parameters redacted by default (`captureDbBindParams: false`).
- Source-map resolution for server-side stack frames, with a synchronous
  fast-path under a configurable size gate (`sourceMapSyncThresholdBytes`) and
  cache-only resolution on `uncaughtException` / `SIGTERM` paths.
- Request context, W3C Trace Context propagation (`traceparent` / `tracestate`),
  and an EventClock for cross-service event ordering.
- State tracking via `trackState()` for capturing application state reads at
  failure time.
- Deterministic 1 MB hard cap on serialized payloads with priority-ordered field
  shedding and explicit `truncated` reporting.

### Framework integrations

- Express, Fastify, Koa, Hapi, raw HTTP, and Hono middleware.
- Next.js: route/handler wrappers, middleware wrapper (`withNextMiddleware`),
  server-action wrapper, and an Edge-runtime entry (`errorcore/nextjs`).
- AWS Lambda / serverless wrappers with a timeout watchdog.

### Transport & delivery

- File, stdout, HTTP (HTTP/1.1 and HTTP/2 with `auto` negotiation), and webhook
  transports.
- Dead-letter store (NDJSON) with per-line HMAC-SHA256 integrity, durable
  fsync-on-append, in-process rotation, and CLI-driven draining / replay.
- Health snapshot via `errorcore.getHealth()` exposing monotonic counters,
  current gauges, and P50/P99 transport latency for `/healthz`-style endpoints.

### Security & privacy

- AES-256-GCM encryption with associated-data binding
  (`<aadVersion>|<keyId>|<sdkVersion>|<eventId>`) and an outer HMAC-SHA256 over
  the envelope, so receivers can reject tampered envelopes before decryption.
- Encryption-key rotation via `previousEncryptionKeys` and an independently
  rotatable `macKey` (`ERRORCORE_MAC_KEY`); `errorcore drain --rotate` re-signs
  dead-letter entries under the current key.
- PII scrubbing of headers and bodies with a configurable, fail-safe scrubber.
- Production plaintext guard: refuses to start under `NODE_ENV=production` with
  an HTTP transport and no key unless `allowProductionPlaintext: true` is set.
- `init()` does not auto-load config from the current working directory, and the
  CLI refuses to load config paths outside cwd unless `--allow-external-config`
  is passed.
- Local dashboard binds to `127.0.0.1` by default, with constant-time
  bearer-token comparison and a same-origin + custom-header CSRF guard on POST
  endpoints.

### Configuration

- `logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'` (default `'warn'`)
  gates internal `[ErrorCore]` console output; `onInternalWarning` remains a
  separate, unfiltered channel.
- `deploymentEnv` / `ERRORCORE_ENVIRONMENT` deployment label distinct from
  `NODE_ENV`; `ERRORCORE_RELEASE` / `GIT_SHA` resolution for `codeVersion`.
- `drivers: { pg?, mysql2?, ioredis?, mongodb? }` for bundled environments where
  `require()` does not reach the app's module instance.
- A single startup diagnostic line reporting recorder states
  (`ok` / `skip(<reason>)` / `warn(<reason>)`); suppress with `silent: true`.

### CLI

- `errorcore` (alias `ecd`): `init` (`--full`, `--quickstart`), `validate`,
  `status`, `show --latest`, `drain` / `replay` (`--dry-run`, `--force`,
  `--rotate`), and `dashboard` / `ui`.
- `errorcore init` scaffolds `errorcore.config.js` from a minimal or full
  template; `--quickstart` additionally writes a runnable demo
  (`errorcore-test.js`) so a fresh install can capture an event immediately.

### Requirements

- Node.js >= 20.
- Optional peer dependencies (`pg`, `mysql2`, `ioredis`, `mongodb`, `hono`,
  `@hono/node-server`) are only required for their corresponding integrations.
