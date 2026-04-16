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
  timeoutMs: 5000,
  maxBackups: 5,
}
```

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

By default, the SDK requires an encryption key. Packages are encrypted with AES-256-GCM before leaving the process.

```js
encryptionKey: 'your-secret-key',
```

If you want to run without encryption (development only):

```js
allowUnencrypted: true,
```

### Capture options

```js
captureLocalVariables: false,     // Capture local variables via V8 Inspector
captureRequestBodies: false,      // Capture inbound request bodies
captureResponseBodies: false,     // Capture outbound response bodies
captureBodyDigest: false,         // Include SHA-256 digest of bodies
captureDbBindParams: false,       // Include database query bind parameters
```

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
allowPlainHttpTransport: false,            // Allow plain HTTP (not HTTPS) collectors
allowInvalidCollectorCertificates: false,  // Skip TLS cert validation (dev only)
deadLetterPath: undefined,                 // Custom path for dead-letter store
maxDrainOnStartup: 200,                   // Max dead-letter payloads to re-send on init
```

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

## Verification

After initializing the SDK, you can confirm it is working by:

1. Throwing an unhandled error in your application.
2. Checking the configured transport for a received `ErrorPackage`:
   - **stdout**: The package is printed to the terminal as JSON.
   - **file**: Check the configured file path for an NDJSON entry.
   - **http**: Check your collector for the received payload.
3. Running `npx errorcore status` to check if any payloads landed in the dead-letter store (which would indicate transport delivery failures).
