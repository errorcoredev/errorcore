# errorcore

![errorcore banner](https://raw.githubusercontent.com/errorcoredev/errorcore/main/banner.png)

errorcore is an error tracking tool for Node. When your code breaks in production, it captures the state leading up to the crash, not just where it broke.

*Stack traces tell you where. errorcore tells you why.*

## 5-Minute Quickstart

```bash
npm install errorcore
npx errorcore init --quickstart
node errorcore-test.js
npx errorcore show --latest
```

The generated demo starts a tiny local Node app, performs one outbound `fetch`,
captures a failing checkout request, and stores the event in
`.errorcore/events.ndjson`. `show --latest` renders the captured stack, locals,
request context, trace context, and IO timeline in your terminal.

To browse the same event in the local UI:

```bash
npx errorcore dashboard
```

For a real app, add errorcore at the top of your entry point:

```js
const errorcore = require('errorcore');

errorcore.init(require('./errorcore.config.js'));
```

For framework apps, add the middleware so request timelines stay attached:

```js
const { expressMiddleware, fastifyPlugin, honoMiddleware } = require('errorcore');

app.use(expressMiddleware());
fastify.register(fastifyPlugin);
honoApp.use('*', honoMiddleware());
```

### Option A: Local Dashboard

Use a local NDJSON event store:

```js
// errorcore.config.js
module.exports = {
  transport: { type: 'file', path: '.errorcore/events.ndjson' },
  allowUnencrypted: true
};
```

Trigger an error, then open the dashboard:

```bash
npx errorcore show --latest
npx errorcore dashboard
```

The dashboard runs at `127.0.0.1:4400` by default. `npx ecd dashboard` works too.

### Option B: Webhook

Send captured errors to your own endpoint:

```js
// errorcore.config.js
module.exports = {
  transport: {
    type: 'webhook',
    url: 'https://example.com/errorcore-webhook',
    secret: process.env.ERRORCORE_WEBHOOK_SECRET
  },
  encryptionKey: process.env.ERRORCORE_DEK
};
```

Webhook batches are signed with HMAC-SHA256 when `secret` is set. See [SETUP.md](SETUP.md#transport-required) for the receiver verification snippet.

## What errorcore captures

- Local variables and arguments at the moment an error is thrown
- Ordered IO timeline events for inbound HTTP, outgoing HTTP/fetch, DNS/TCP, and DB queries
- Request and response headers and bodies when enabled
- DB query text and bind parameters when enabled
- State reads and writes from tracked objects and maps
- Process, release, environment, trace, and source-map context

Captured values are scrubbed and fieldized before they leave the process. Production configs should use encryption.

## Pricing

Free for hobbyists and small projects under the open-core license. Enterprise tier details live in [TEAMS.md](TEAMS.md).

## Links

- [Configuration](SETUP.md)
- [Demo script](DEMO.md)
- [Operations](OPERATIONS.md)
- [Backpressure and warnings](docs/BACKPRESSURE.md)
- [Data structures](DB.md)
- [Next.js setup](SETUP.md#nextjs-app-router)
- [Repository](https://github.com/errorcoredev/errorcore)
- [Support](https://github.com/errorcoredev/errorcore/issues)
