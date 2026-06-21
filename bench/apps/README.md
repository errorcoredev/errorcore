# Benchmark Apps

`benchmark-app/` contains the runnable overlay used by the scenario runner. Each
`<target>@<pin>/target.json` records the pinned upstream application used for
fairness review. Run `node bench/harness/prepare-apps.mjs` from the repository
root to clone the upstream sources into `<target>@<pin>/source/`.

The overlay uses the same scenario engine and SDK adapter for all SDK variants;
only `BENCH_SDK=baseline|errorcore|sentry` changes between runs.
