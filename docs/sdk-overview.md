# Errorcore SDK Overview

Last updated: 2026-05-05. This document describes the SDK-side v1 readiness contract only. It intentionally excludes ingestion, reconstruction, default-on locals, identity extraction, application HTTP/2 instrumentation, span exporting, OpenTelemetry bridging, and tracing UI.

## Scope

The SDK captures errors in Node.js applications, packages scrubbed context, optionally encrypts the package, and sends the serialized envelope through stdout, file, or collector HTTP transport. The collector and any reconstruction product are separate systems and are not implemented here.

Included in this SDK contract:

- Error capture through explicit `captureError`, process-level handlers, and supported middleware.
- Async request context through AsyncLocalStorage.
- Outbound IO recording for existing HTTP/HTTPS, undici/fetch, DNS, TCP, and supported database driver hooks.
- Opt-in local-variable capture through V8 Inspector.
- PII scrubbing, serialization limits, deterministic hard-cap downgrades, and final payload drop when still oversized.
- AES-256-GCM envelope encryption with AAD and outer HMAC.
- Typed transport payloads carrying both the serialized bytes and parsed envelope metadata.
- Collector HTTP/1.1 and HTTPS HTTP/2 transport, with ALPN-driven `auto` selection.
- W3C `traceparent` / `tracestate` propagation and package metadata.

Excluded from this SDK contract:

- Ingestion APIs, backend storage, reconstruction, UI rendering, or issue grouping products.
- Default-on locals.
- Identity extraction.
- Application `node:http2` server/client instrumentation.
- Public span API, span exporter, OpenTelemetry bridge, baggage, sampling controls, or tracing UI.

## Capture Flow

```text
application error
  -> ErrorCapturer
  -> PackageBuilder
  -> scrubber and size limits
  -> optional Encryption
  -> TransportPayload { serialized, envelope }
  -> TransportDispatcher
  -> stdout | file | HTTP collector
  -> DeadLetterStore on persistent failure when configured and signed
```

Worker assembly and inline assembly share the same encryption options: primary DEK, previous DEKs, MAC key, derived key, and SDK version. Decryption uses the envelope SDK version for AAD so CLI/UI/DLQ paths can read envelopes produced by runtime workers.

## Transport Contract

File and stdout transports remain newline-delimited. HTTP transport sends one JSON envelope per POST without appending a newline.

HTTP collector requests set:

- `Content-Type: application/errorcore+json`
- `Authorization` when configured
- `X-Errorcore-Key-Id` when envelope metadata has `keyId`
- `X-Errorcore-Event-Id` when envelope metadata has `eventId`

Retry behavior:

- Five attempts total.
- 30 second per-payload retry budget.
- `Retry-After` seconds and HTTP-date forms honored for retryable responses.
- Retryable statuses: `408`, `429`, `500`, `502`, `503`, `504`.
- Permanent statuses such as `401`, `403`, and `404` are not retried.
- Permanent TLS/certificate failures are not retried.

Collector protocol selection:

```ts
transport: {
  type: 'http',
  url: 'https://collector.example.com/v1/errors',
  protocol: 'auto', // 'auto' | 'http1' | 'http2'
}
```

- `auto` is the default. On HTTPS, it tries HTTP/2 first and falls back to HTTP/1.1 only if negotiation fails before the request is committed. On plain HTTP, it uses HTTP/1.1 only and still requires `allowPlainHttpTransport: true`.
- `http1` always uses HTTP/1.1.
- `http2` requires an HTTPS collector URL and fails if HTTP/2 cannot be negotiated. h2c is not supported.
- Negotiated protocol changes are debug-logged through the SDK debug logger, not unconditional console output.

## Encryption Contract

DEK resolution order:

1. `config.encryptionKey`
2. `ERRORCORE_DEK`
3. `config.encryptionKeyCallback()`

`encryptionKeyCallback` is synchronous and called once during SDK creation before activation. It must return a 64-character hex string or a 32-byte Buffer.

MAC key resolution order:

1. `config.macKey`
2. `ERRORCORE_MAC_KEY`
3. Derived MAC sub-key from the DEK

`previousEncryptionKeys` are used for decrypt/verify rotation paths and are passed to worker, CLI, UI, DLQ drain, and runtime decryption consistently.

## W3C Trace Context

The SDK supports propagation and package metadata only.

Public helpers:

```ts
getTraceHeaders(): { traceparent: string; tracestate?: string } | null;

withTraceContext<T>(
  input: {
    traceparent?: string;
    tracestate?: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  },
  fn: () => T
): T;
```

`withTraceContext` creates a request context from inbound W3C headers. If an AsyncLocalStorage context already exists, it preserves that context and simply runs `fn`.

Packages include trace metadata when a context is active:

- `traceId`
- `spanId`
- `parentSpanId`
- `traceFlags`
- `tracestate`
- `isEntrySpan`

Outbound HTTP/HTTPS and undici propagation use the same formatter as `getTraceHeaders()`. Foreign `tracestate` entries are preserved within W3C limits, and the full trace-flags byte is preserved.

## Hard Cap And Completeness

`hardCapBytes` is enforced against the final serialized envelope size. The SDK uses this downgrade order:

1. Drop `localVariables`.
2. Trim `ioTimeline` to the newest 50 events.
3. Drop request/response bodies from remaining IO events.
4. Drop `stateReads`.
5. Drop `concurrentRequests`.
6. Drop `ambientContext`.

Completeness is recomputed after destructive trims. If the final serialized envelope is still over the cap, the SDK emits `EC_PACKAGE_OVER_HARD_CAP` and drops the payload before transport.

## Warning And DLQ Contract

Runtime warning callbacks use `EC_*` codes. Warning context and cause are scrubbed before `onInternalWarning` is invoked.

DLQ entries store the serialized envelope exactly once, with line-level signing when a stable secret exists. Replay/drain parses envelope metadata and sends typed transport payloads so HTTP replay retains key/event headers. `errorcore replay` is an alias for `errorcore drain`.

Health snapshots expose DLQ enabled/signed state, depth, and drop counters so operators can detect disabled or unsigned durability paths before transport failures occur.
