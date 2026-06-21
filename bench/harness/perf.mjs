import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getPerfVariants } from './scenarios.mjs';
import { spawnBenchmarkApp } from './process-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');
const appRoot = path.join(benchRoot, 'apps', 'benchmark-app');

export const PERF_ENDPOINTS = [
  { id: 'healthz', method: 'GET', path: '/healthz', label: 'Health/no-op' },
  { id: 'success-work', method: 'GET', path: '/perf/success', label: 'Successful work' },
  { id: 'error-capture', method: 'GET', path: '/perf/error-capture', label: 'Error capture' }
];

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runAutocannon(url, options = {}) {
  const duration = String(options.durationSeconds ?? Number(process.env.BENCH_PERF_DURATION ?? 5));
  const connections = String(options.connections ?? Number(process.env.BENCH_PERF_CONNECTIONS ?? 16));
  const bin = process.platform === 'win32'
    ? path.join(appRoot, 'node_modules', '.bin', 'autocannon.cmd')
    : path.join(appRoot, 'node_modules', '.bin', 'autocannon');
  const result = await runCommand(bin, ['-j', '-c', connections, '-d', duration, url], { cwd: appRoot, env: process.env });
  if (result.code !== 0) {
    return {
      skipped: true,
      reason: result.stderr || result.stdout || 'autocannon failed'
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      skipped: true,
      reason: `autocannon JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      rawText: result.stdout
    };
  }
  return {
    skipped: false,
    ...extractAutocannonMetrics(parsed),
    raw: parsed
  };
}

export function extractAutocannonMetrics(parsed) {
  const latency = parsed?.latency ?? {};
  let p95LatencyMs = latency.p95;
  let p95LatencySource = 'p95';
  if (p95LatencyMs === undefined && latency.p97_5 !== undefined) {
    p95LatencyMs = latency.p97_5;
    p95LatencySource = 'p97_5';
  }
  if (p95LatencyMs === undefined && latency.p99 !== undefined) {
    p95LatencyMs = latency.p99;
    p95LatencySource = 'p99';
  }
  return {
    throughput: parsed?.requests?.average,
    p50LatencyMs: latency.p50,
    p95LatencyMs,
    p95LatencySource,
    p99LatencyMs: latency.p99
  };
}

function stats(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) {
    return { mean: null, stddev: null, min: null, max: null };
  }
  const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const variance = numeric.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numeric.length;
  return {
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...numeric),
    max: Math.max(...numeric)
  };
}

export function aggregatePerfRepetitions(repetitions) {
  const completed = repetitions.filter((repetition) => repetition.skipped !== true);
  return {
    repetitions: repetitions.length,
    completed: completed.length,
    skipped: repetitions.length - completed.length,
    throughput: stats(completed.map((repetition) => repetition.throughput)),
    latency: {
      p50: stats(completed.map((repetition) => repetition.p50LatencyMs)),
      p95: stats(completed.map((repetition) => repetition.p95LatencyMs)),
      p99: stats(completed.map((repetition) => repetition.p99LatencyMs))
    }
  };
}

export function evaluatePerfSanity({ endpoint, baseline, variant }) {
  const endpointId = endpoint?.id ?? endpoint;
  if (endpointId !== 'healthz' && endpointId !== '/healthz') {
    return { quarantined: false };
  }
  const baselineThroughput = baseline?.throughput?.mean;
  const variantThroughput = variant?.throughput?.mean;
  if (!Number.isFinite(baselineThroughput) || !Number.isFinite(variantThroughput) || baselineThroughput <= 0) {
    return { quarantined: false };
  }
  if (variantThroughput < baselineThroughput / 3) {
    return {
      quarantined: true,
      reason: `${variant.sdk ?? 'variant'} no-op throughput is more than 3x worse than baseline (${variantThroughput} vs ${baselineThroughput})`
    };
  }
  return { quarantined: false };
}

function groupKey(sdk, endpointId) {
  return `${sdk}:${endpointId}`;
}

export function perfBySdkForScoring(perfResults) {
  const result = new Map();
  const aggregates = Array.isArray(perfResults?.aggregates) ? perfResults.aggregates : [];
  for (const aggregate of aggregates) {
    if (aggregate.endpoint !== 'healthz') continue;
    result.set(aggregate.sdk, {
      throughput: aggregate.throughput,
      latency: aggregate.latency,
      quarantined: aggregate.quarantined,
      reason: aggregate.reason
    });
  }
  return result;
}

export async function runPerfSuite({
  resultsDir,
  perfDir = path.join(resultsDir, 'perf'),
  basePort = 4300,
  compareSdk = process.env.BENCH_COMPARE_SDK ?? 'sentry',
  resultSuffix = ''
} = {}) {
  const repetitions = [];
  const settings = {
    durationSeconds: Number(process.env.BENCH_PERF_DURATION ?? 5),
    connections: Number(process.env.BENCH_PERF_CONNECTIONS ?? 16),
    repetitionsPerEndpoint: Number(process.env.BENCH_PERF_REPETITIONS ?? 3)
  };
  fs.mkdirSync(perfDir, { recursive: true });

  let portOffset = 0;
  for (const sdk of getPerfVariants(compareSdk)) {
    for (const endpoint of PERF_ENDPOINTS) {
      const app = spawnBenchmarkApp({
        port: basePort + portOffset,
        framework: 'express',
        sdk,
        scenarioId: 'PERF',
        serviceName: `perf-${sdk}-${endpoint.id}`,
        serviceRole: 'single',
        resultsDir,
        resultSuffix
      });
      portOffset += 1;
      try {
        await app.waitUntilReady();
        for (let repetition = 1; repetition <= settings.repetitionsPerEndpoint; repetition += 1) {
          const sample = await runAutocannon(`${app.baseUrl}${endpoint.path}`, settings);
          const record = {
            sdk,
            endpoint: endpoint.id,
            path: endpoint.path,
            repetition,
            ...sample
          };
          repetitions.push(record);
          const rawPath = path.join(perfDir, `${sdk}-${endpoint.id}-rep${repetition}.json`);
          fs.writeFileSync(rawPath, JSON.stringify(sample.raw ?? sample, null, 2));
          await app.flush();
        }
      } finally {
        await app.stop();
      }
    }
  }

  const aggregates = [];
  const groups = new Map();
  for (const repetition of repetitions) {
    const key = groupKey(repetition.sdk, repetition.endpoint);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(repetition);
  }
  for (const [key, group] of groups) {
    const [sdk, endpoint] = key.split(':');
    aggregates.push({
      sdk,
      endpoint,
      ...aggregatePerfRepetitions(group)
    });
  }

  const sanity = [];
  for (const aggregate of aggregates) {
    if (aggregate.sdk === 'baseline' || aggregate.endpoint !== 'healthz') continue;
    const baseline = aggregates.find((candidate) =>
      candidate.sdk === 'baseline' && candidate.endpoint === aggregate.endpoint
    );
    const sanityResult = evaluatePerfSanity({
      endpoint: aggregate.endpoint,
      baseline,
      variant: aggregate
    });
    Object.assign(aggregate, sanityResult);
    sanity.push({
      sdk: aggregate.sdk,
      endpoint: aggregate.endpoint,
      ...sanityResult
    });
  }

  return {
    settings,
    endpoints: PERF_ENDPOINTS,
    repetitions,
    aggregates,
    sanity
  };
}
