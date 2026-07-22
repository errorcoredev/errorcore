# Fair SDK Benchmark

This benchmark compares the local errorcore package with
`@sentry/node@10.56.0` and `@sentry/nextjs@10.56.0` under the same Node image,
dependency services, resource limits, inputs, and fault triggers.

Run from this directory:

```sh
docker compose up --build --abort-on-container-exit --exit-code-from runner
```

The runner writes raw payloads, parity logs, performance samples, scoring
artifacts, and `REPORT.md` under `bench/results/`.

The pinned upstream applications are recorded in `manifest.json` and mirrored
under `bench/apps/<target>@<pin>/`. The runnable benchmark overlay lives in
`bench/apps/benchmark-app/`; `harness/prepare-apps.mjs` can clone pinned source
trees into each target directory when a full source audit is needed.

Sentry parity note: the app enables `includeLocalVariables`, `tracesSampleRate:
1.0`, `sendDefaultPii`, default integrations, `beforeSend`, and a local custom
transport. The report discloses Sentry's ESM unhandled local-variable limitation
before scoring background-job scenarios.
