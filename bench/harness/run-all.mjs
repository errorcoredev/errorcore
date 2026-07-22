import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computePackageIntegrity, runPreflight } from './preflight.mjs';
import { compareParity } from './parity.mjs';
import { buildBacklog, scoreBenchmarkResults } from './scorer.mjs';
import { collectEnvFingerprint } from './env-fingerprint.mjs';
import {
  getScenarioMatrix,
  requestForScenario,
  expectedPayloadCount,
  getSdkVariants,
  getPerfVariants
} from './scenarios.mjs';
import { requestJson, waitFor } from './http.mjs';
import { spawnBenchmarkApp } from './process-runner.mjs';
import { PERF_ENDPOINTS, perfBySdkForScoring, runPerfSuite } from './perf.mjs';
import { runBlindJudge, writeBlindDiagnosabilityPrompts } from './blind-diagnosability.mjs';
import { writeReport } from './report.mjs';
import { evaluateStrictBenchmarkRelease } from './strict-release-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.join(benchRoot, 'results');
const compareSdk = process.env.BENCH_COMPARE_SDK ?? 'sentry';
const resultSuffix = compareSdk === 'sentry' ? '' : `-${compareSdk}`;
const rawDirName = `raw${resultSuffix}`;
const parityDirName = `parity${resultSuffix}`;
const perfDirName = `perf${resultSuffix}`;
const deadLetterDirName = `dead-letter${resultSuffix}`;
const summaryFilename = compareSdk === 'sentry' ? 'summary.json' : `summary-${compareSdk}.json`;
const reportFilename = compareSdk === 'sentry' ? 'REPORT.md' : `${compareSdk.toUpperCase()}_REPORT.md`;
const preflightFilename = compareSdk === 'sentry' ? 'preflight.json' : `preflight-${compareSdk}.json`;
const fingerprintFilename = compareSdk === 'sentry' ? 'env-fingerprint.json' : `env-fingerprint-${compareSdk}.json`;
const promptFilename = compareSdk === 'sentry'
  ? 'blind-diagnosability-prompts.jsonl'
  : `blind-diagnosability-prompts-${compareSdk}.jsonl`;
const paths = {
  rawDir: path.join(resultsDir, rawDirName),
  parityDir: path.join(resultsDir, parityDirName),
  perfDir: path.join(resultsDir, perfDirName),
  deadLetterDir: path.join(resultsDir, deadLetterDirName),
  summary: path.join(resultsDir, summaryFilename),
  report: path.join(resultsDir, reportFilename),
  preflight: path.join(resultsDir, preflightFilename),
  fingerprint: path.join(resultsDir, fingerprintFilename)
};
const errorcoreSinkUrl = process.env.ERRORCORE_SINK_URL ?? 'http://127.0.0.1:3010';
const sentrySinkUrl = process.env.SENTRY_SINK_URL ?? 'http://127.0.0.1:3011';
const bugsnagSinkUrl = process.env.BUGSNAG_SINK_URL ?? 'http://127.0.0.1:3012';
const strictReleaseEnabled = process.env.BENCH_STRICT_RELEASE === '1';

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  };
}

function ensureDirs() {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.parityDir, { recursive: true });
  fs.mkdirSync(paths.perfDir, { recursive: true });
  fs.mkdirSync(paths.deadLetterDir, { recursive: true });
}

function collectSdkInitConfigs() {
  const configs = {
    baseline: {
      captureException: 'no-op',
      frameworkMiddleware: 'none'
    },
    errorcore: {
      service: 'per benchmark app instance',
      deploymentEnv: 'benchmark',
      transport: {
        type: 'http',
        url: `${errorcoreSinkUrl}/ingest`,
        timeoutMs: 750,
        protocol: 'http1',
        maxBackups: 1
      },
      allowPlainHttpTransport: true,
      encryptionKey: 'BENCH_ERRORCORE_KEY',
      captureLocalVariables: true,
      captureDbBindParams: true,
      captureRequestBodies: true,
      captureResponseBodies: true,
      captureBodyDigest: true,
      resolveSourceMaps: true,
      deadLetterPath: `bench/results/${deadLetterDirName}/<service>-<scenario>.ndjson`,
      flushIntervalMs: 1000,
      envAllowlist: ['BENCH_SCENARIO_ID', 'BENCH_FRAMEWORK', 'BENCH_SDK', 'BENCH_SERVICE_NAME'],
      traceContext: { vendorKey: 'ec' },
      drivers: ['pg', 'ioredis'],
      logLevel: 'error'
    }
  };
  if (compareSdk === 'sentry') {
    configs.sentry = {
      dsn: 'https://public@example.invalid/1',
      includeLocalVariables: true,
      tracesSampleRate: 1.0,
      sendDefaultPii: true,
      environment: 'benchmark',
      release: 'errorcore-bench@0.1.0',
      beforeSend: `${sentrySinkUrl}/before-send`,
      transport: `${sentrySinkUrl}/envelope`
    };
  }
  if (compareSdk === 'bugsnag') {
    configs.bugsnag = {
      apiKey: '00000000000000000000000000000000',
      appType: 'node-benchmark',
      appVersion: 'errorcore-bench@0.1.0',
      autoDetectErrors: true,
      autoTrackSessions: false,
      releaseStage: 'benchmark',
      enabledReleaseStages: ['benchmark'],
      endpoints: {
        notify: `${bugsnagSinkUrl}/notify`,
        sessions: `${bugsnagSinkUrl}/sessions`
      },
      onError: 'adds benchmark scenario/service/framework metadata'
    };
  }
  return configs;
}

function sinkUrlForSdk(sdk) {
  if (sdk === 'errorcore') return errorcoreSinkUrl;
  if (sdk === 'sentry') return sentrySinkUrl;
  if (sdk === 'bugsnag') return bugsnagSinkUrl;
  throw new Error(`No sink URL configured for SDK ${sdk}`);
}

async function resetSink(sdk) {
  await requestJson(`${sinkUrlForSdk(sdk)}/control/reset`, { method: 'POST', body: {} });
  await requestJson(`${sinkUrlForSdk(sdk)}/control/fail`, { method: 'POST', body: { enabled: false } });
}

async function setSinkFailure(sdk, enabled) {
  await requestJson(`${sinkUrlForSdk(sdk)}/control/fail`, { method: 'POST', body: { enabled } });
}

async function fetchSinkEvents(sdk, scenarioId) {
  const response = await requestJson(`${sinkUrlForSdk(sdk)}/events?scenarioId=${encodeURIComponent(scenarioId)}`);
  return response.body?.events ?? [];
}

function payloadsFromSinkEvents(sdk, events) {
  if (sdk === 'errorcore') {
    return events.map((event) => event.package);
  }
  return events.map((event) => event.event);
}

function splitLogs(apps) {
  const logs = apps.flatMap((app) => app.logs);
  return {
    triggerLogs: logs.filter((entry) => entry.kind === 'trigger'),
    dependencyLogs: logs.filter((entry) => entry.kind === 'dependency'),
    lifecycleLogs: logs.filter((entry) => entry.kind === 'lifecycle'),
    sdkLogs: logs.filter((entry) => entry.kind === 'sdk'),
    rawLogs: apps.flatMap((app) => app.rawLogs)
  };
}

async function trigger(app, request) {
  return requestJson(`${app.baseUrl}${request.path}`, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
}

async function runVariant({ scenario, sdk, basePort }) {
  await resetSink(sdk);
  const apps = [];
  const request = requestForScenario(scenario);
  const framework = scenario.framework;

  try {
    let app;
    if (scenario.id === 'S5') {
      const serviceB = spawnBenchmarkApp({
        port: basePort + 1,
        framework,
        sdk,
        scenarioId: scenario.id,
        serviceName: `${sdk}-${scenario.id}-service-b`,
        serviceRole: 'B',
        resultsDir,
        resultSuffix
      });
      apps.push(serviceB);
      await serviceB.waitUntilReady();

      app = spawnBenchmarkApp({
        port: basePort,
        framework,
        sdk,
        scenarioId: scenario.id,
        serviceName: `${sdk}-${scenario.id}-service-a`,
        serviceRole: 'A',
        serviceBUrl: serviceB.baseUrl,
        resultsDir,
        resultSuffix
      });
    } else {
      app = spawnBenchmarkApp({
        port: basePort,
        framework,
        sdk,
        scenarioId: scenario.id,
        serviceName: `${sdk}-${scenario.id}`,
        serviceRole: 'single',
        resultsDir,
        resultSuffix
      });
    }
    apps.push(app);
    await app.waitUntilReady();

    if (scenario.id === 'S9') {
      await setSinkFailure(sdk, true);
    }

    const http = await trigger(app, request);

    if (scenario.id === 'S9') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await setSinkFailure(sdk, false);
      for (const running of apps) {
        await running.flush();
      }
    }

    for (const running of apps) {
      await running.flush();
    }

    const expected = expectedPayloadCount(scenario);
    let events;
    let payloadWait = { timedOut: false };
    try {
      events = await waitFor(`${sdk} ${scenario.id} payloads`, async () => {
        const current = await fetchSinkEvents(sdk, scenario.id);
        return current.length >= expected ? current : false;
      }, { timeoutMs: scenario.id === 'S9' ? 45_000 : 15_000, intervalMs: 500 });
    } catch (error) {
      payloadWait = { timedOut: true, error: serializeError(error).message };
      events = await fetchSinkEvents(sdk, scenario.id);
    }

    const logs = splitLogs(apps);
    const result = {
      scenarioId: scenario.id,
      sdk,
      framework,
      http: { status: http.status, body: http.body },
      sinkEvents: events,
      payloads: payloadsFromSinkEvents(sdk, events),
      delivery: {
        delivered: events.length,
        deadLettered: logs.sdkLogs.filter((entry) => String(entry.code).includes('DEAD_LETTER')).length,
        lost: Math.max(0, expected - events.length),
        waitTimedOut: payloadWait.timedOut,
        ...(payloadWait.error === undefined ? {} : { waitError: payloadWait.error })
      },
      payloadWait,
      ...logs
    };

    const outDir = path.join(paths.rawDir, scenario.id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${sdk}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    for (const app of apps.reverse()) {
      await app.stop().catch(() => undefined);
    }
    await setSinkFailure(sdk, false).catch(() => undefined);
  }
}

async function runScenarios(matrix = getScenarioMatrix()) {
  const scenarioResults = [];
  const sdkVariants = getSdkVariants(compareSdk);

  for (const [scenarioIndex, scenario] of matrix.entries()) {
    const variants = [];
    for (const [sdkIndex, sdk] of sdkVariants.entries()) {
      variants.push(await runVariant({
        scenario,
        sdk,
        basePort: 4100 + scenarioIndex * 10 + sdkIndex * 3
      }));
    }
    const parity = compareParity(variants[0], variants[1], { expected: scenario.expected });
    fs.writeFileSync(
      path.join(paths.parityDir, `${scenario.id}.json`),
      JSON.stringify(parity, null, 2)
    );
    scenarioResults.push({
      scenarioId: scenario.id,
      framework: scenario.framework,
      description: scenario.description,
      expected: scenario.expected,
      parity,
      variants
    });
  }

  return { scenarioResults };
}

ensureDirs();

const preflight = await runPreflight();
fs.writeFileSync(paths.preflight, JSON.stringify(preflight, null, 2));
if (!preflight.ok) {
  console.error(preflight.errors.join('\n'));
  process.exit(1);
}

const fingerprint = await collectEnvFingerprint();
fs.writeFileSync(paths.fingerprint, JSON.stringify(fingerprint, null, 2));

const scenarioMatrix = getScenarioMatrix();
const { scenarioResults } = await runScenarios(scenarioMatrix);
let perfSuiteError;
let perfResults;
try {
  perfResults = await runPerfSuite({
    resultsDir,
    perfDir: paths.perfDir,
    compareSdk,
    resultSuffix
  });
} catch (error) {
  perfSuiteError = serializeError(error);
  perfResults = {
    settings: {},
    endpoints: PERF_ENDPOINTS,
    repetitions: [],
    aggregates: [
      { sdk: 'all', endpoint: 'all', skipped: true, reason: perfSuiteError.message }
    ],
    sanity: [],
    suiteError: perfSuiteError
  };
}
fs.writeFileSync(path.join(paths.perfDir, 'perf.json'), JSON.stringify(perfResults, null, 2));

const scores = scoreBenchmarkResults(scenarioResults, { perfBySdk: perfBySdkForScoring(perfResults) });
const backlog = buildBacklog({ scores, comparatorSdk: compareSdk });
const sdkInitConfigs = collectSdkInitConfigs();
const promptPath = writeBlindDiagnosabilityPrompts({ resultsDir, scenarioResults, filename: promptFilename });
const blindJudge = await runBlindJudge({ promptsPath: promptPath });

const packageRoot = preflight.facts.packageRoot ?? process.env.ERRORCORE_PACKAGE_ROOT;
const finalIntegrity = await computePackageIntegrity(packageRoot);
preflight.facts.packageIntegrity.after = finalIntegrity;
fingerprint.packageIntegrityAfter = finalIntegrity;
if (preflight.facts.packageIntegrity.before !== finalIntegrity) {
  preflight.ok = false;
  preflight.errors.push('errorcore package integrity changed during benchmark run');
}
fs.writeFileSync(paths.preflight, JSON.stringify(preflight, null, 2));
fs.writeFileSync(paths.fingerprint, JSON.stringify(fingerprint, null, 2));

const captureMode = process.env.BENCH_ERRORCORE_ADAPTIVE === '1'
  ? 'adaptive'
  : (process.env.BENCH_ERRORCORE_CAPTURE_MODE ?? 'forensic');
const releaseGate = strictReleaseEnabled
  ? {
      enabled: true,
      ...evaluateStrictBenchmarkRelease({
        captureMode,
        compareSdk,
        candidateSha256: process.env.BENCH_CANDIDATE_SHA256,
        expectedScenarios: scenarioMatrix,
        expectedScenarioSdks: getSdkVariants(compareSdk),
        expectedPerfSdks: getPerfVariants(compareSdk),
        expectedPerfEndpoints: PERF_ENDPOINTS,
        expectedPerfRepetitions: Number(process.env.BENCH_PERF_REPETITIONS ?? 3),
        scenarioResults,
        scores,
        perfResults,
        perfSuiteError
      })
    }
  : {
      enabled: false,
      ok: true,
      captureMode: String(captureMode).toLowerCase(),
      errors: []
    };

const summary = {
  generatedAt: new Date().toISOString(),
  compareSdk,
  preflight,
  fingerprint,
  scenarioResults,
  perfResults,
  scores,
  droppedScenarios: 0,
  sdkInitConfigs,
  blindJudge,
  backlog,
  releaseGate
};
fs.writeFileSync(paths.summary, JSON.stringify(summary, null, 2));
const reportPath = writeReport({
  resultsDir,
  reportFilename,
  preflight,
  fingerprint,
  scenarioResults,
  perfResults,
  scores,
  backlog,
  sdkInitConfigs,
  blindJudge,
  releaseGate,
  promptPath,
  artifactPaths: {
    rawPayloads: paths.rawDir,
    summary: paths.summary,
    environmentFingerprint: paths.fingerprint,
    preflight: paths.preflight,
    perf: paths.perfDir
  }
});

const benchmarkOk = preflight.ok && releaseGate.ok;
console.log(JSON.stringify({
  ok: benchmarkOk,
  reportPath,
  scenarios: scenarioResults.length,
  scoreRecords: scores.length,
  parityFailures: scenarioResults.filter((scenario) => !scenario.parity.ok).length,
  backlogItems: backlog.length,
  releaseGate
}, null, 2));

if (!benchmarkOk) {
  process.exitCode = 1;
}
