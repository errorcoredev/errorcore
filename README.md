# Errorcore

![errorcore](banner.png)

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

## Documentation

- [SDK documentation](https://errorcore.dev/docs)
- [Configuration reference](SETUP.md)
- [CLI usage](SETUP.md#validation)
- [Operations guide](OPERATIONS.md)
- [Data structures](DB.md)

## Security

Report vulnerabilities via issues or privately.

## License

[PolyForm Small Business 1.0.0](LICENSE) — free for individuals and companies under $1M revenue. Commercial license required above that threshold.
