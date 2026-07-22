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

## Capture modes

Use a fixed `captureMode` when you know the capture/overhead tradeoff you want:

| Mode | Standing infrastructure | Locals |
| --- | --- | --- |
| `fast` | transport only | off |
| `safe` (default) | process crash handlers + transport; inbound event synthesized at capture | shallow, adaptive guard |
| `balanced` | all recorders, worker assembly, payload spool | shallow |
| `forensic` | everything + request/response bodies + DB bind params | deep |

Performance results are specific to an integrity-matched release candidate.
Reproduce the per-mode measurements with
`BENCH_ERRORCORE_CAPTURE_MODE=<mode> docker compose -f docker-compose.yml -f docker-compose.capture-mode.yml up --build`
from `bench/`.

You can switch fixed modes at runtime without rebuilding the SDK:

```js
await errorcore.setCaptureMode('forensic');
console.log(errorcore.getCaptureMode());
```

Each package records the mode snapshot used for assembly at
`completeness.modeAtCapture`.

Adaptive capture starts in a base mode, escalates after an admitted capture,
and de-escalates after quiet time:

```js
errorcore.init({
  captureMode: 'safe',
  adaptiveCapture: {
    enabled: true,
    base: 'safe',
    escalated: 'forensic',
    deescalateAfterMs: 120000,
    minDwellMs: 10000,
    maxSwitchesPerHour: 60
  }
});
```

When adaptive capture is enabled, `getHealth()` includes
`adaptive.active`, `adaptive.phase`, `adaptive.lastEscalationAt`, and
`adaptive.switchCount`. Calling `setCaptureMode()` with the configured base or
escalated mode updates the adaptive phase and preserves timed de-escalation. A
different explicit mode reports the `manual` phase and suspends adaptive
switching until base or escalated is selected again.

Safe mode captures shallow local variables at error time. While locals are
armed, the V8 debugger pauses briefly on every thrown exception; if your
workload throws at very high rates, the SDK's locals guard disarms locals for
a recovery window (packages then report `locals: disabled_adaptive_guard`).
It re-arms on adaptive escalation or after five quiet minutes below threshold.
Tune or disable via `localsGuard`.

**Middleware cost is separate from mode cost.** The framework middleware
(request context, trace propagation, request-scoped attribution) now keeps
request data lazy until capture or trace propagation. The benchmark harness can
isolate middleware-off, ALS-only, and full-middleware runs; publish comparisons
only from a successful artifact for the exact package under test.
Without middleware, safe still captures locals, error, stack, and process
context; pass explicit request data to `captureError(error, { request })` for
request identity.

## Pricing

Free for hobbyists and small projects under the open-core license. Enterprise tier details live in [TEAMS.md](TEAMS.md).

## Links

- [Configuration](SETUP.md)
- [Demo script](DEMO.md)
- [Operations](OPERATIONS.md)
- [Backpressure and warnings](BACKPRESSURE.md)
- [Data structures](DB.md)
- [Next.js setup](SETUP.md#nextjs-app-router)
- [Repository](https://github.com/errorcoredev/errorcore)
- [Support](https://github.com/errorcoredev/errorcore/issues)
