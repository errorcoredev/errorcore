#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { runBenchmarks } = require(path.resolve(__dirname, "../../benchmark-harness/run-benchmarks.js"));

async function main() {
  const result = await runBenchmarks({
    profileMode: true,
    iterations: Number(process.env.BENCH_PROFILE_ITERATIONS || 1),
    warmupSeconds: Number(process.env.BENCH_PROFILE_WARMUP_SECONDS || 5),
    durationSeconds: Number(process.env.BENCH_PROFILE_DURATION_SECONDS || 15),
    cooldownMs: Number(process.env.BENCH_PROFILE_COOLDOWN_MS || 3000),
    connections: Number(process.env.BENCH_PROFILE_CONNECTIONS || 50)
  });

  console.log(`perf/bench/profile.js: wrote ${path.relative(process.cwd(), result.reportPath)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`perf/bench/profile.js: ${message}`);
  process.exit(1);
});
