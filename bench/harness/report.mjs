import fs from 'node:fs';
import path from 'node:path';

import { D_RUBRIC } from './scorer.mjs';

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function table(rows) {
  if (rows.length === 0) return '_None._';
  const headers = Object.keys(rows[0]);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((header) => cell(row[header])).join(' | ')} |`);
  }
  return lines.join('\n');
}

function scoreLabel(score) {
  if (score === undefined) return '';
  return `${score.total}/${score.maxTotal}`;
}

function scoresByScenarioSdk(scores) {
  const map = new Map();
  for (const score of scores ?? []) {
    map.set(`${score.scenarioId}:${score.sdk}`, score);
  }
  return map;
}

function average(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) return '';
  return (numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2);
}

function perDimensionRows(scores) {
  const sdks = [...new Set((scores ?? []).map((score) => score.sdk))].sort();
  return D_RUBRIC.map((dimension) => {
    const row = { Dimension: dimension.id, Label: dimension.label };
    for (const sdk of sdks) {
      const sdkScores = scores.filter((score) => score.sdk === sdk);
      row[sdk] = average(sdkScores
        .map((score) => score.dimensions?.[dimension.id])
        .filter((entry) => entry !== undefined && entry?.applicable !== false)
        .map((entry) => entry.score));
    }
    return row;
  });
}

function scenarioRows(scenarioResults, scores) {
  const byKey = scoresByScenarioSdk(scores);
  const sdks = [...new Set((scores ?? []).map((score) => score.sdk))].sort((left, right) => {
    if (left === 'errorcore') return -1;
    if (right === 'errorcore') return 1;
    return left.localeCompare(right);
  });
  return (scenarioResults ?? []).map((scenario) => ({
    ...{
      Scenario: scenario.scenarioId,
      Target: scenario.framework,
      Expected: scenario.expected?.expectedMessage,
      Payloads: scenario.expected?.expectedPayloadCount,
      Parity: scenario.parity?.ok ? 'pass' : 'diagnostic mismatch',
      Closer: scenario.parity?.closerToGroundTruth
        ? `message=${scenario.parity.closerToGroundTruth.messageWinner}; frame=${scenario.parity.closerToGroundTruth.frameWinner}`
        : ''
    },
    ...Object.fromEntries(sdks.map((sdk) => [sdk, scoreLabel(byKey.get(`${scenario.scenarioId}:${sdk}`))]))
  }));
}

function perfRows(perfResults) {
  const aggregates = Array.isArray(perfResults?.aggregates)
    ? perfResults.aggregates
    : Array.isArray(perfResults) ? perfResults : [];
  return aggregates.map((perf) => ({
    SDK: perf.sdk,
    Endpoint: perf.endpoint ?? '',
    Reps: `${perf.completed ?? 0}/${perf.repetitions ?? 0}`,
    ThroughputMean: perf.throughput?.mean ?? perf.throughput ?? '',
    P50Mean: perf.latency?.p50?.mean ?? perf.p50LatencyMs ?? '',
    P95Mean: perf.latency?.p95?.mean ?? perf.p95LatencyMs ?? '',
    P99Mean: perf.latency?.p99?.mean ?? perf.p99LatencyMs ?? '',
    Quarantined: perf.quarantined === true ? 'yes' : 'no',
    Note: perf.reason ?? ''
  }));
}

function backlogRows(backlog) {
  return (backlog ?? []).map((entry) => ({
    Priority: entry.priority,
    Scenario: entry.scenarioId,
    Dimension: entry.dimension,
    errorcore: `${entry.errorcoreScore}/${entry.max}`,
    Comparator: entry.comparatorSdk === undefined
      ? (entry.sentryScore ?? '')
      : `${entry.comparatorSdk}:${entry.comparatorScore ?? ''}`,
    Reason: entry.reason,
    Evidence: entry.evidence
  }));
}

function verdictText(scores, perfResults, blindJudge) {
  const totals = new Map();
  for (const score of scores ?? []) {
    const current = totals.get(score.sdk) ?? { total: 0, max: 0 };
    current.total += score.total;
    current.max += score.maxTotal;
    totals.set(score.sdk, current);
  }
  const errorcore = totals.get('errorcore');
  const comparatorSdk = [...totals.keys()].find((sdk) => sdk !== 'errorcore' && sdk !== 'baseline');
  const comparator = comparatorSdk === undefined ? undefined : totals.get(comparatorSdk);
  const quarantined = (perfResults?.aggregates ?? []).filter((entry) => entry.quarantined === true);
  const scoreVerdict = errorcore !== undefined && comparator !== undefined
    ? `Ground-truth diagnosability: errorcore ${errorcore.total}/${errorcore.max}; ${comparatorSdk} ${comparator.total}/${comparator.max}.`
    : 'Ground-truth diagnosability totals are unavailable.';
  const perfVerdict = quarantined.length > 0
    ? `Performance has ${quarantined.length} quarantined aggregate(s).`
    : 'Performance aggregates are recorded without quarantine.';
  return [
    scoreVerdict,
    perfVerdict,
    `Blind judge status: ${blindJudge?.status ?? 'unknown'}.`
  ].join('\n\n');
}

export function writeReport({
  resultsDir,
  reportFilename,
  preflight,
  fingerprint,
  scenarioResults,
  perfResults,
  scores,
  backlog = [],
  sdkInitConfigs = {},
  blindJudge = { status: 'not-run' },
  promptPath,
  artifactPaths = {}
}) {
  const reportPath = path.join(resultsDir, reportFilename ?? 'REPORT.md');
  const rawPath = artifactPaths.rawPayloads ?? path.join(resultsDir, 'raw');
  const summaryPath = artifactPaths.summary ?? path.join(resultsDir, 'summary.json');
  const fingerprintPath = artifactPaths.environmentFingerprint ?? path.join(resultsDir, 'env-fingerprint.json');
  const preflightPath = artifactPaths.preflight ?? path.join(resultsDir, 'preflight.json');
  const perfPath = artifactPaths.perf ?? path.join(resultsDir, 'perf');
  const integrity = preflight.facts.packageIntegrity ?? {};
  const body = [
    '# Fair SDK Benchmark Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Verdict',
    '',
    verdictText(scores, perfResults, blindJudge),
    '',
    '## Environment & fairness',
    '',
    preflight.ok ? 'Preflight passed.' : `Preflight failed: ${preflight.errors.join('; ')}`,
    '',
    `Node image: ${preflight.manifest.nodeImage}@${preflight.manifest.nodeImageDigest}`,
    `Local package: ${preflight.facts.packageName}@${preflight.facts.packageVersion}`,
    `Host tools: Node ${fingerprint.node}, npm ${fingerprint.npm}, ${fingerprint.docker}, ${fingerprint.compose}`,
    `Package integrity before: ${integrity.before ?? ''}`,
    `Package integrity after: ${integrity.after ?? ''}`,
    '',
    'SDK init configs:',
    '',
    '```json',
    JSON.stringify(sdkInitConfigs, null, 2),
    '```',
    '',
    'Parity diagnostics record status, trigger logs, dependency logs, extracted SDK signals, and ground-truth closeness; scores are computed independently from parity.',
    '',
    '## Per-dimension head-to-head',
    '',
    table(perDimensionRows(scores ?? [])),
    '',
    '## Per-scenario results',
    '',
    table(scenarioRows(scenarioResults ?? [], scores ?? [])),
    '',
    '## Performance',
    '',
    table(perfRows(perfResults)),
    '',
    'Raw repetitions: ' + ((perfResults?.repetitions ?? []).length),
    '',
    '## errorcore Improvement Backlog',
    '',
    table(backlogRows(backlog)),
    '',
    '## Threats to validity',
    '',
    '- Pinned upstream repositories are recorded and can be cloned with `harness/prepare-apps.mjs`; the runnable workload uses the shared benchmark overlay so both SDKs execute identical application code.',
    '- Local custom Sentry transport preserves the exact `beforeSend` event and envelope passed to transport, but it is not a hosted Sentry ingest pipeline.',
    '- Performance results can be dominated by local Docker, sink, and host scheduling behavior; quarantined aggregates are reported separately from diagnosability scores.',
    '- Blind diagnosability is marked `not-run` unless an executable judge command is configured with `BENCH_BLIND_JUDGE_COMMAND`.',
    '',
    '## Artifact index',
    '',
    `- Raw payloads: ${rawPath}`,
    `- Summary: ${summaryPath}`,
    `- Blind diagnosability prompts: ${promptPath}`,
    `- Environment fingerprint: ${fingerprintPath}`,
    `- Preflight: ${preflightPath}`,
    `- Performance raw and aggregate files: ${perfPath}`,
    ''
  ].join('\n');

  fs.writeFileSync(reportPath, body);
  return reportPath;
}
