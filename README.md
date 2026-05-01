# Errorcore

![errorcore](https://raw.githubusercontent.com/errorcoredev/errorcore/main/banner.png)

Error monitoring with execution context for Node.js.

Errorcore captures the state around a failure so you can inspect what happened at the point an error was thrown. It focuses on request-level context, execution flow, and minimal setup.

## What it does

- Captures local variables and arguments at the point an error is thrown
- Tracks request context across async boundaries using AsyncLocalStorage
- Records outbound IO in sequence
- Attaches process and environment metadata with optional scrubbing
- Encrypts payloads before transport
- Buffers failed deliveries and retries when the network is available

## Getting started

```bash
npm install errorcore
```

Add two lines to the top of your application entry point:

```js
const errorcore = require('errorcore');
errorcore.init();
```

That's it. In development (`NODE_ENV !== 'production'`), errorcore defaults to stdout transport and unencrypted payloads. Throw an error and the captured payload prints to your terminal.

### Quick start (fastest path)

```bash
npm install errorcore
npx errorcore init --quickstart
node errorcore-test.js
```

### Framework middleware

```js
// Express
const { expressMiddleware } = require('errorcore');
app.use(expressMiddleware());

// Fastify
const { fastifyPlugin } = require('errorcore');
fastify.register(fastifyPlugin);

// Koa
const { koaMiddleware } = require('errorcore');
app.use(koaMiddleware());
```

### Production setup

Before deploying, configure a transport and encryption key:

```js
// errorcore.config.js
module.exports = {
  transport: {
    type: 'http',
    url: 'https://collector.example.com/v1/errors',
    authorization: 'Bearer <token>',
  },
  encryptionKey: process.env.ERRORCORE_ENCRYPTION_KEY,
};
```

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Database driver tiers

Errorcore records DB query events differently depending on your runtime environment.

**Tier 1: Plain Node.js** (Express, Fastify, Koa, NestJS, raw `http`): automatic. No config needed. All recorders install against the same `require()` graph the app uses.

**Tier 2: Single-graph bundlers** (Vite SSR, esbuild, plain webpack): automatic if the driver is not tree-shaken, or pass explicit references:

```ts
errorcore.init({
  drivers: { pg: require('pg'), mongodb: require('mongodb') },
});
```

**Tier 3: Next.js App Router**: externalize drivers from the webpack bundle:

```js
// next.config.js
module.exports = {
  serverExternalPackages: ['pg', 'mongodb', 'mysql2', 'ioredis'],
};
```

Without this, the DB timeline will not populate. The startup diagnostic will report `warn(bundled-unpatched)`. HTTP inbound, HTTP outbound, and `fetch` (undici) recording work in all three tiers.

## Startup diagnostic

At startup, errorcore prints one line listing the state of each recorder:

```
[errorcore] 0.2.0 node=20.11.0 recorders: http-server=ok http-client=ok undici=ok net=ok dns=ok pg=skip(not-installed) mongodb=warn(bundled-unpatched) mysql2=skip(not-installed) ioredis=skip(not-installed)
```

Three states: `ok` (active), `skip(<reason>)` (intentionally inactive, no action needed), `warn(<reason>)` (wanted to install but couldn't, action required). When warns are present, the output grows to 3–6 lines with one actionable guidance line per warn state. Suppress the entire block with `config.silent: true`.

## Next.js middleware capture

To capture errors and optionally non-2xx responses from Clerk-style middleware rejections, wrap your middleware with `withNextMiddleware`:

```ts
import { withNextMiddleware } from 'errorcore/nextjs';
import { clerkMiddleware } from '@clerk/nextjs/server';

export default withNextMiddleware(clerkMiddleware());
```

Control which response status codes trigger a capture:

```ts
errorcore.init({
  captureMiddlewareStatusCodes: [500, 502, 503, 504], // or 'all', or 'none' (default)
});
```

`undefined` returns (pass-through middleware) are never captured regardless of this setting. The ALS context started by `withNextMiddleware` propagates automatically into the downstream route handler.

## Documentation

- [SDK documentation](https://errorcore.dev/docs)
- [Configuration reference](SETUP.md)
- [CLI usage](SETUP.md#validation)
- [Dashboard (UI)](OPERATIONS.md#dashboard-ui)
- [Operations guide](OPERATIONS.md)
- [Data structures](DB.md)

## Running tests

```bash
npm test                                    # run the full test suite
npm run coverage                            # produce a coverage/ report
```

Coverage baseline (recorded 2026-05-01): 73.9% statements, 64.52% branches, 80.94% functions, 74.95% lines. The threshold is intentionally not enforced; the report is observability-only. Run `npm run coverage` and open `coverage/index.html` for the per-file breakdown.

## Security

Report vulnerabilities via issues or privately.

Encryption key rotation is supported via `previousEncryptionKeys` in the config. See the [Key rotation runbook](OPERATIONS.md#key-rotation-runbook) for the operational sequence.

## License

[PolyForm Small Business 1.0.0](LICENSE.md). Free for individuals and companies under $1M revenue. Commercial license required above that threshold.
