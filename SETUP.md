# Setup

## Prerequisites

- **Node.js** >= 20
- **npm** (ships with Node.js)
- **TypeScript** >= 5.9 (dev dependency, included)
- **Git** (optional, used to embed `gitSha` in error packages)

## Installation

Install from npm:

```bash
npm install errorcore
```

Or clone and build from source:

```bash
git clone <repo-url>
cd errorcore
npm install
npm run build
```

The build step compiles TypeScript from `src/` into `dist/` using `tsc`.

## Zero-config quick start

In development (`NODE_ENV !== 'production'`), errorcore works with no config file at all:

```js
require('errorcore').init();
// Defaults to stdout transport, unencrypted payloads
```

Or use the quickstart command to scaffold a working example:

```bash
npx errorcore init --quickstart
node errorcore-test.js
```

## Configuration

Generate a config file in your project root:

```bash
npx errorcore init          # minimal config (recommended)
npx errorcore init --full   # all options with defaults
```

This creates `errorcore.config.js`. The minimal template is all you need to get started:

```js
module.exports = {
  transport: { type: 'stdout' },
  allowUnencrypted: true,
};
```

For the full configuration reference, see below or run `npx errorcore init --full`.

### Transport (required)

Pick exactly one transport. The SDK will not start without one.

**HTTP transport** (production):

```js
transport: {
  type: 'http',
  url: 'https://collector.example.com/v1/errors',
  authorization: 'Bearer <collector-token>',
  protocol: 'auto',
  timeoutMs: 5000,
  maxBackups: 5,
}
```

`protocol` controls the collector transport only:

| Value | Behavior |
|-------|----------|
| `'auto'` (default) | HTTPS tries HTTP/2 first, logs the negotiated protocol at debug level, then falls back to HTTP/1.1 only if HTTP/2 negotiation fails before a request is committed. Plain HTTP uses HTTP/1.1 only and still requires `allowPlainHttpTransport: true`. |
| `'http1'` | Always use the HTTP/1.1 transport path. |
| `'http2'` | Require HTTPS HTTP/2. Startup/config validation rejects plain HTTP; send fails if HTTP/2 cannot be negotiated. Cleartext h2c is not supported. |

This does not add application `node:http2` instrumentation. The SDK continues to record app HTTP through the existing HTTP/HTTPS and undici hooks.

**File transport** (controlled environments):

```js
transport: {
  type: 'file',
  path: '/var/log/errorcore/errors.ndjson',
  maxSizeBytes: 104857600,  // 100 MB
  maxBackups: 5,
}
```

**Stdout transport** (local development only):

```js
transport: { type: 'stdout' }
```

### Encryption

By default in production, the SDK requires an encryption key. Packages are encrypted with AES-256-GCM and authenticated with an outer HMAC before leaving the process.

```js
encryptionKey: process.env.ERRORCORE_DEK,
macKey: process.env.ERRORCORE_MAC_KEY,
```

`encryptionKey` must be a 64-character hex string (32 bytes). `encryptionKeyCallback` is a synchronous resolver that is called once during SDK creation and then behaves exactly like `encryptionKey`:

```js
encryptionKeyCallback: () => loadHexKeyFromLocalKmsCache(),
```

The DEK resolution order is `encryptionKey`, then `ERRORCORE_DEK`, then `encryptionKeyCallback`. The MAC key resolution order is `macKey`, then `ERRORCORE_MAC_KEY`; when omitted, the SDK derives a separate MAC sub-key from the DEK.

If you want to run without encryption (development only):

```js
allowUnencrypted: true,
```

### Key rotation

To rotate the encryption key without losing dead-letter entries written under the previous key, declare the prior key(s) under `previousEncryptionKeys`:

```js
encryptionKey: process.env.ERRORCORE_ENCRYPTION_KEY_NEW,
previousEncryptionKeys: [process.env.ERRORCORE_ENCRYPTION_KEY_OLD],
```

The list accepts up to 5 entries. New error packages are encrypted and signed with the primary key only. Existing dead-letter entries verify against the primary first, then each previous key in declaration order. Entries that verify under a previous key continue to drain successfully through the SDK runtime.

After every workload has rolled to the new key, run:

```bash
npx errorcore drain --rotate
```

This force-re-signs every valid entry in one pass and drops entries that no longer verify under any chain key. After the next deploy you can remove the previous key from the config.

### Capture options

```js
captureLocalVariables: false,     // Capture local variables via V8 Inspector
captureRequestBodies: false,      // Capture inbound request bodies
captureResponseBodies: false,     // Capture outbound response bodies
captureBodyDigest: false,         // Include SHA-256 digest of bodies
captureDbBindParams: false,       // Include database query bind parameters
```

### Middleware capture

Control whether non-2xx responses returned by Next.js middleware (Clerk-style auth rejections, rewrites, custom guards) are captured. Applies only when middleware is wrapped with `withNextMiddleware`.

```js
captureMiddlewareStatusCodes: 'none',
```

| Value | Behavior |
|-------|----------|
| `'none'` (default) | Only thrown errors are captured. Status-driven rejections pass through silently. |
| `'all'` | Every non-2xx middleware response is captured. |
| `number[]` | Only listed status codes are captured. Each entry must be an integer 100-599, e.g. `[401, 403, 500]`. |

`undefined` returns (pass-through middleware) are never captured regardless of this setting.

### Database driver references

In bundled environments (Next.js, Vite SSR, esbuild), `require()` may not reach the same module instance the application uses, so the SDK's monkey-patches silently miss queries. Pass the driver references explicitly to install patches against the application's actual module graph:

```js
drivers: {
  pg: require('pg'),
  mongodb: require('mongodb'),
  mysql2: require('mysql2'),
  ioredis: require('ioredis'),
}
```

Only include the drivers your application uses; each entry is optional. For Next.js App Router specifically, prefer the `serverExternalPackages` approach documented in the README -- it externalizes drivers from the webpack bundle and makes the explicit reference unnecessary. The startup diagnostic line reports `warn(bundled-unpatched)` for any driver that was found but could not be patched.

### Body capture content types

Controls which content types are eligible for body capture:

```js
bodyCaptureContentTypes: [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
  'application/xml',
]
```

### PII filtering

Headers and environment variables are filtered using allowlists and blocklists.

```js
headerAllowlist: [
  'content-type', 'content-length', 'accept',
  'user-agent', 'x-request-id', 'x-correlation-id', 'host',
  'traceparent', 'tracestate', 'retry-after',
],

headerBlocklist: [
  /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
  /auth|token|key|secret|password|credential/i,
],

envAllowlist: [
  'NODE_ENV', 'NODE_VERSION', 'PORT', 'HOST', 'TZ', 'LANG',
  // Kubernetes, AWS, GCP, Fly.io, and deployment identifiers
],

envBlocklist: [
  /key|secret|token|password|credential|auth|private/i,
],
```

You can supply a custom PII scrubber function:

```js
piiScrubber: (key, value) => {
  // return modified value or undefined to redact
},
replaceDefaultScrubber: false,  // true = use only your scrubber; false = run both
```

### State tracking

Records reads (always) and writes (`set`/`delete` on tracked Maps and plain objects) on values registered via `trackState()`. Reads and writes appear as separate streams (`stateReads`, `stateWrites`) on the shipped error package.

```js
stateTracking: {
  captureWrites: true,         // false to record reads only
  maxWritesPerContext: 50,     // overflow drops are silent; surfaced in completeness.stateWritesDropped
}
```

`maxWritesPerContext` must be a non-negative integer. Set `captureWrites: false` to disable write recording without removing the proxy wrapper -- reads continue to be captured.

### Trace context

Configures the W3C `tracestate` vendor key used for cross-service Lamport-clock propagation. The SDK preserves inbound W3C `traceparent` flags, preserves foreign `tracestate` entries up to W3C limits, and adds its own clock entry under the configured vendor key.

```js
traceContext: {
  vendorKey: 'ec',  // default; 1-256 chars matching [a-z0-9_\-*\/]
}
```

Pick a short identifier -- outbound `tracestate` is capped at 512 characters total, and longer keys leave less room for the actual state value. Invalid keys are rejected at `init()`.

Manual propagation helpers are available for queues, jobs, and custom middleware:

```js
const errorcore = require('errorcore');

errorcore.withTraceContext({ traceparent, tracestate, method: 'POST', url: '/worker' }, () => {
  const headers = errorcore.getTraceHeaders();
  // headers is null outside an active context
});
```

`withTraceContext(input, fn)` keeps an existing AsyncLocalStorage context if one is already active. It does not create spans, sampling policy, baggage, exporters, OpenTelemetry bridges, or tracing UI.

### Limits and tuning

```js
serialization: {
  maxDepth: 8,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxStringLength: 2048,
  maxPayloadSize: 32768,        // 32 KB per serialized value
  maxTotalPackageSize: 5242880, // 5 MB total package
},

rateLimitPerMinute: 60,
rateLimitWindowMs: 60000,
bufferSize: 200,                // I/O event circular buffer capacity
bufferMaxBytes: 52428800,       // 50 MB buffer byte limit
maxConcurrentRequests: 50,
maxLocalsCollectionsPerSecond: 20,
maxCachedLocals: 50,
maxLocalsFrames: 5,
uncaughtExceptionExitDelayMs: 1500,
```

### Advanced options

```js
useWorkerAssembly: false,                  // Assemble packages in a worker thread
silent: false,                             // Suppress the startup diagnostic line
logLevel: 'warn',                          // 'silent' | 'error' | 'warn' | 'info' | 'debug'
allowPlainHttpTransport: false,            // Allow plain HTTP (not HTTPS) collectors
allowInvalidCollectorCertificates: false,  // Skip TLS cert validation (dev only)
deadLetterPath: undefined,                 // Custom path for dead-letter store
maxDrainOnStartup: 200,                    // Max dead-letter payloads to re-send on init
sourceMapSyncThresholdBytes: 2097152,      // 2 MB; maps larger than this resolve asynchronously. Set to 0 to restore fully-async behavior.
```

`logLevel` controls which internal SDK messages reach `console.warn` / `console.error` / `console.info` / `console.debug`. It does NOT affect the `onInternalWarning` callback -- that is a separate, structured event channel. Default `'warn'` lets warnings and errors through and suppresses info/debug. Set `'silent'` to suppress every `[ErrorCore]` line that goes through the gate. The legacy `silent: true` flag is unchanged and still suppresses only the one-line startup diagnostic; `logLevel` is the broader gate for everything else.

You can also subscribe to internal SDK warnings (transport failures, rate-limit drops, dead-letter overflow, encryption misconfiguration, and aggregate drop summaries):

```js
onInternalWarning: (warning) => {
  // warning: { code, message, cause?, context? }
  metrics.increment('errorcore.warning', { code: warning.code });
}
```

The full callback signature, the warning-code matrix, and the rate-limit / aggregation rules are documented in [docs/BACKPRESSURE.md](docs/BACKPRESSURE.md).

## Running locally

1. Create a config file:

```bash
npx errorcore init
```

2. Edit `errorcore.config.js`. For local development, the simplest setup is:

```js
module.exports = {
  transport: { type: 'stdout' },
  allowUnencrypted: true,
};
```

3. Add to your application entry point:

```js
const errorcore = require('errorcore');
errorcore.init(require('./errorcore.config.js'));
```

4. Start your application as usual (`node app.js`, `npm start`, etc.).

## Validation

Verify your configuration is correct:

```bash
npx errorcore validate
```

This loads and resolves the config, reports any issues, and prints all resolved values. If the config is invalid, it exits with an error message.

## Dashboard

The CLI ships a small read-only HTTP dashboard (`errorcore ui`) for browsing captured error packages from a `file` transport or a populated dead-letter store.

```bash
npx errorcore ui                       # binds 127.0.0.1:4400, no auth
npx errorcore ui --port 5500           # custom port
EC_DASHBOARD_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))") \
  npx errorcore ui                     # require Bearer token on /api/*
```

Configuration sources:

| Source | Effect |
|---|---|
| `--port <n>` flag | Listening port. Default `4400`. |
| `EC_DASHBOARD_TOKEN` env var | When set, `/api/*` requires `Authorization: Bearer <token>`. The token must be 16+ characters and contain only `[A-Za-z0-9_-]`. |
| Config file `transport.type` or `deadLetterPath` | The dashboard reads NDJSON from `transport.path` (when `transport.type === 'file'`) or `deadLetterPath` otherwise. If neither is set, the command refuses to start. |

Security defaults:

- The server binds to `127.0.0.1` by default. The previous behavior of binding `0.0.0.0` whenever a token was set was removed in 0.2.0 because operators using a token still expected loopback-only by default.
- Binding to a non-loopback hostname requires an explicit `hostname` argument and a configured token; the server throws on startup otherwise.
- POST endpoints require both `x-errorcore-action: true` and a same-origin `Origin` header. This is a two-layer CSRF guard -- browsers block cross-origin JS from setting custom headers without a preflight, and the Origin check covers misconfigurations that allow the preflight.
- Bearer tokens are compared with `crypto.timingSafeEqual`; the comparison runs in constant time regardless of the prefix length.

The dashboard requires `hono` and `@hono/node-server` at runtime; both are listed as optional peer dependencies. If they are not installed, the CLI prints a one-line install hint and exits.

### `--allow-external-config`

By default, all CLI subcommands (`validate`, `status`, `drain`, `ui`) refuse to load a `--config <path>` that resolves outside the current working directory. This blocks accidental or hostile invocations from running arbitrary JavaScript whose path is controlled only by the process cwd at startup.

Pass `--allow-external-config` to load a config from an absolute path or a path with `..` segments. Use this when the config lives in a shared mount point (`/etc/errorcore.config.js`) or in a directory above the CLI's cwd in a monorepo. Do not pass it in CI without auditing the path.

## Verification

After initializing the SDK, you can confirm it is working by:

1. Throwing an unhandled error in your application.
2. Checking the configured transport for a received `ErrorPackage`:
   - **stdout**: The package is printed to the terminal as JSON.
   - **file**: Check the configured file path for an NDJSON entry.
   - **http**: Check your collector for the received payload.
3. Running `npx errorcore status` to check if any payloads landed in the dead-letter store (which would indicate transport delivery failures).
