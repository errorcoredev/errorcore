# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
Semantic Versioning from 1.0.0 onward; before then, breaking changes may ship in
any minor release and are called out under a **Breaking** heading.

## 0.1.0 - 2026-06-21

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
