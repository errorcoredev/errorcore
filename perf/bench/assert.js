#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { THRESHOLDS } = require(path.resolve(__dirname, "../../benchmark-harness/run-benchmarks.js"));

const ROOT_DIR = path.resolve(__dirname, "../..");
const lastRunFile = path.join(ROOT_DIR, "benchmark-results", ".last-run.json");

function fail(message) {
  console.error(`perf/bench/assert.js: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(lastRunFile)) {
  fail("no benchmark run metadata found. Run benchmark-harness/run-benchmarks.js first.");
}

const lastRun = JSON.parse(fs.readFileSync(lastRunFile, "utf8"));

if (lastRun.mode !== "full") {
  fail(`expected a full benchmark run, found mode "${lastRun.mode}"`);
}

const result = JSON.parse(fs.readFileSync(lastRun.jsonPath, "utf8"));

if (!result.scenario) {
  fail("benchmark result is missing scenario data");
}

const scorecard = result.scenario.summaryScorecard;
const micro = result.microBenchmarks;
const failures = [];

if (scorecard.throughputDegradationPct > THRESHOLDS.throughputDegradationPct.assert) {
  failures.push(
    `throughput degradation ${scorecard.throughputDegradationPct}% exceeded ${THRESHOLDS.throughputDegradationPct.assert}%`
  );
}

if (scorecard.p99LatencyDeltaMs > THRESHOLDS.p99LatencyDeltaMs.assert) {
  failures.push(
    `p99 latency delta ${scorecard.p99LatencyDeltaMs}ms exceeded ${THRESHOLDS.p99LatencyDeltaMs.assert}ms`
  );
}

if (scorecard.p999LatencyDeltaMs > THRESHOLDS.p999LatencyDeltaMs.assert) {
  failures.push(
    `p99.9 latency delta ${scorecard.p999LatencyDeltaMs}ms exceeded ${THRESHOLDS.p999LatencyDeltaMs.assert}ms`
  );
}

if (scorecard.peakRssDeltaMb > THRESHOLDS.peakRssDeltaMb.assert) {
  failures.push(
    `peak RSS delta ${scorecard.peakRssDeltaMb}MB exceeded ${THRESHOLDS.peakRssDeltaMb.assert}MB`
  );
}

if (scorecard.eventLoopLagP99DeltaMs > THRESHOLDS.eventLoopLagP99DeltaMs.assert) {
  failures.push(
    `event loop lag p99 delta ${scorecard.eventLoopLagP99DeltaMs}ms exceeded ${THRESHOLDS.eventLoopLagP99DeltaMs.assert}ms`
  );
}

if (micro.ioEventBufferPush.opsPerSec < THRESHOLDS.ioEventBufferPushOpsPerSec.assert) {
  failures.push(
    `IOEventBuffer.push ${micro.ioEventBufferPush.opsPerSec} ops/sec fell below ${THRESHOLDS.ioEventBufferPushOpsPerSec.assert}`
  );
}

if (micro.errorCaptureLatency.p95Ms > THRESHOLDS.errorCaptureLatencyP95Ms.assert) {
  failures.push(
    `error capture p95 ${micro.errorCaptureLatency.p95Ms}ms exceeded ${THRESHOLDS.errorCaptureLatencyP95Ms.assert}ms`
  );
}

if (failures.length > 0) {
  console.error("perf/bench/assert.js: performance assertions failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`perf/bench/assert.js: PASS (${path.relative(ROOT_DIR, lastRun.jsonPath)})`);
