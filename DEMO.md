# ErrorCore Demo Script

This is the reproducible local demo for investors and design partners. It shows
the "state at the moment of failure" story without a hosted backend.

## Commands

Run in an empty project:

```bash
npm install errorcore
npx errorcore init --quickstart
node errorcore-test.js
npx errorcore show --latest
npx errorcore dashboard
```

For a repo checkout before the package is published:

```bash
npm run build
npm pack --pack-destination ..
mkdir ../errorcore-demo
cd ../errorcore-demo
npm init -y
npm install ../errorcore-0.3.0.tgz
npx errorcore init --quickstart
node errorcore-test.js
npx errorcore show --latest
```

## Expected Evidence

`node errorcore-test.js` should print that the demo request returned HTTP 500 and
was captured locally.

`npx errorcore show --latest` should render:

- `Local Variables`, including quickstart locals such as `orderId`, `cartTotal`,
  and `inventory`.
- `Request Context`, showing the local `/checkout` request.
- `Async Context`, showing `traceId`, `spanId`, ALS availability, and tracked
  state reads/writes.
- `IO Timeline`, showing the inbound HTTP request and outbound inventory fetch.

`npx errorcore dashboard` opens the same event at `127.0.0.1:4400`.
