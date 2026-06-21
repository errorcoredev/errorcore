export const D_RUBRIC = [
  { id: 'D1', label: 'Error identity' },
  { id: 'D2', label: 'Application frame ownership' },
  { id: 'D3', label: 'Local variables' },
  { id: 'D4', label: 'Request context' },
  { id: 'D5', label: 'Database context' },
  { id: 'D6', label: 'Outbound dependency context' },
  { id: 'D7', label: 'Async and worker context' },
  { id: 'D8', label: 'Trace propagation' },
  { id: 'D9', label: 'Timeline reconstruction' },
  { id: 'D10', label: 'Privacy and encryption controls' },
  { id: 'D11', label: 'Delivery durability' },
  { id: 'D12', label: 'Performance overhead evidence' }
];

const DEFAULT_EXPECTED_APP_FILE = 'bench/apps/benchmark-app/lib/scenario-engine.mjs';

function clamp(score) {
  return Math.max(0, Math.min(5, Math.round(score)));
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePath(filePath) {
  return String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/^\/+/, '');
}

function functionName(value) {
  return normalizeText(value)
    .replace(/^async\s+/, '')
    .replace(/^new\s+/, '')
    .replace(/^Object\./, '');
}

function getErrorType(payload) {
  return payload?.error?.type ??
    payload?.exception?.values?.[0]?.type ??
    payload?.exceptions?.[0]?.errorClass ??
    payload?.events?.[0]?.exceptions?.[0]?.errorClass ??
    payload?.name ??
    '';
}

function getErrorMessage(payload) {
  return normalizeText(
    payload?.error?.message ??
    payload?.exception?.values?.[0]?.value ??
    payload?.exceptions?.[0]?.message ??
    payload?.events?.[0]?.exceptions?.[0]?.message ??
    payload?.message
  );
}

function hasError(payload) {
  return getErrorType(payload).length > 0 || getErrorMessage(payload).length > 0;
}

function stackFramesFromString(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;
    const withFunction = trimmed.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/);
    if (withFunction !== null) {
      frames.push({
        functionName: functionName(withFunction[1]),
        filePath: withFunction[2],
        lineNumber: Number(withFunction[3]),
        columnNumber: Number(withFunction[4])
      });
      continue;
    }
    const withoutFunction = trimmed.match(/^at\s+(.*?):(\d+):(\d+)$/);
    if (withoutFunction !== null) {
      frames.push({
        functionName: '<anonymous>',
        filePath: withoutFunction[1],
        lineNumber: Number(withoutFunction[2]),
        columnNumber: Number(withoutFunction[3])
      });
    }
  }
  return frames;
}

function payloadFrames(payload) {
  const frames = [];
  const boundary = payload?.errorOrigin?.appBoundaryFrame;
  if (boundary !== undefined && boundary !== null) {
    frames.push({
      functionName: functionName(boundary.functionName ?? boundary.function ?? boundary.method),
      filePath: boundary.filePath ?? boundary.filename ?? boundary.abs_path ?? boundary.file,
      inApp: true
    });
  }

  for (const frame of stackFramesFromString(payload?.error?.stack)) {
    frames.push({ ...frame, inApp: normalizePath(frame.filePath).includes('bench/apps/benchmark-app') });
  }

  const sentryFrames = payload?.exception?.values?.[0]?.stacktrace?.frames ?? [];
  for (const frame of sentryFrames) {
    frames.push({
      functionName: functionName(frame.functionName ?? frame.function ?? frame.method),
      filePath: frame.filePath ?? frame.filename ?? frame.abs_path ?? frame.file,
      lineNumber: frame.lineno,
      columnNumber: frame.colno,
      inApp: frame.in_app === true || normalizePath(frame.filename ?? frame.abs_path ?? '').includes('bench/apps/benchmark-app')
    });
  }

  const bugsnagFrames = payload?.exceptions?.[0]?.stacktrace ??
    payload?.events?.[0]?.exceptions?.[0]?.stacktrace ??
    [];
  for (const frame of bugsnagFrames) {
    frames.push({
      functionName: functionName(frame.method ?? frame.function ?? frame.functionName),
      filePath: frame.file ?? frame.filename ?? frame.abs_path,
      lineNumber: frame.lineNumber ?? frame.lineno,
      columnNumber: frame.columnNumber ?? frame.colno,
      inApp: normalizePath(frame.file ?? frame.filename ?? frame.abs_path ?? '').includes('bench/apps/benchmark-app')
    });
  }

  return frames;
}

function appFrames(payloads) {
  return payloads
    .flatMap(payloadFrames)
    .filter((frame) => frame.inApp === true || normalizePath(frame.filePath).includes('bench/apps/benchmark-app'));
}

function frameMatchesExpected(frame, expected) {
  return functionName(frame.functionName) === functionName(expected.expectedOriginatingFrame);
}

function frameSameExpectedFile(frame, expected) {
  const expectedFile = normalizePath(expected.expectedOriginatingFile ?? DEFAULT_EXPECTED_APP_FILE);
  return normalizePath(frame.filePath).endsWith(expectedFile);
}

function expectedPayloads(expected) {
  if (Array.isArray(expected?.expectedPayloads) && expected.expectedPayloads.length > 0) {
    return expected.expectedPayloads;
  }
  return [{
    expectedErrorType: expected?.expectedErrorType,
    expectedMessage: expected?.expectedMessage,
    expectedOriginatingFrame: expected?.expectedOriginatingFrame
  }];
}

function payloadMatchesError(payload, expected) {
  const type = getErrorType(payload);
  const message = getErrorMessage(payload);
  return type === expected.expectedErrorType && message === normalizeText(expected.expectedMessage);
}

function payloadMatchesType(payload, expected) {
  return getErrorType(payload) === expected.expectedErrorType;
}

function payloadMatchesMessage(payload, expected) {
  return getErrorMessage(payload) === normalizeText(expected.expectedMessage);
}

function hasLocalVariables(payload) {
  return (
    (Array.isArray(payload?.localVariables) && payload.localVariables.length > 0) ||
    (Array.isArray(payload?.locals) && payload.locals.length > 0) ||
    payload?.completeness?.localVariablesCaptured === true ||
    payload?.contexts?.locals !== undefined ||
    payload?.metaData?.locals !== undefined ||
    payload?.metadata?.locals !== undefined
  );
}

function hasRequestContext(payload) {
  return Boolean(
    payload?.request !== undefined ||
    payload?.contexts?.trace !== undefined ||
    payload?.contexts?.benchmark?.request !== undefined ||
    payload?.metaData?.request !== undefined ||
    payload?.metadata?.request !== undefined
  );
}

function timelineEvents(payloads) {
  return payloads.flatMap((payload) => [
    ...(Array.isArray(payload?.ioTimeline) ? payload.ioTimeline : []),
    ...(Array.isArray(payload?.breadcrumbs) ? payload.breadcrumbs : []),
    ...(Array.isArray(payload?.spans) ? payload.spans : [])
  ]);
}

function dependencyEvents(input) {
  return [
    ...timelineEvents(input.payloads ?? []),
    ...(Array.isArray(input.dependencyLogs) ? input.dependencyLogs : [])
  ];
}

function hasDbEvidence(input) {
  return dependencyEvents(input).some((event) => {
    const text = normalizeText(JSON.stringify(event)).toLowerCase();
    return event?.type === 'db-query' ||
      event?.dbMeta !== undefined ||
      text.includes('postgres') ||
      text.includes('pg-query') ||
      text.includes('select ');
  });
}

function hasOutboundDependencyEvidence(input) {
  return dependencyEvents(input).some((event) => {
    const text = normalizeText(JSON.stringify(event)).toLowerCase();
    if (text.includes('postgres') || text.includes('pg-query')) return false;
    return event?.type === 'http-client' ||
      event?.type === 'undici' ||
      text.includes('upstream') ||
      text.includes('redis') ||
      text.includes('service-b') ||
      text.includes('http-fetch');
  });
}

function hasWorkerEvidence(input) {
  const payloads = input.payloads ?? [];
  if (appFrames(payloads).some((frame) => ['queueConsumer', 'redisGetRequired', 'delayedUpstreamFailureAfterResponse'].includes(frame.functionName))) {
    return true;
  }
  return payloads.some((payload) => {
    const text = normalizeText(JSON.stringify({
      tags: payload?.tags,
      contexts: payload?.contexts,
      extra: payload?.extra,
      localVariables: payload?.localVariables
    })).toLowerCase();
    return text.includes('worker') || text.includes('queue') || text.includes('delayed') || text.includes('phase');
  });
}

function traceIdFromTraceparent(value) {
  const match = String(value ?? '').match(/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i);
  return match?.[1];
}

function traceIdsFromPayload(payload) {
  const ids = [];
  for (const candidate of [
    payload?.trace?.traceId,
    payload?.trace?.trace_id,
    payload?.contexts?.trace?.trace_id,
    traceIdFromTraceparent(payload?.request?.headers?.traceparent),
    traceIdFromTraceparent(payload?.request?.headers?.Traceparent)
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) ids.push(candidate);
  }
  return ids;
}

function traceIdsFromLogs(logs = []) {
  return logs
    .map((entry) => traceIdFromTraceparent(entry?.traceparent))
    .filter((traceId) => typeof traceId === 'string' && traceId.length > 0);
}

function hasPrivacyControls(payloads) {
  return payloads.some((payload) =>
    payload?.completeness?.encrypted === true ||
    payload?.completeness?.piiScrubbed === true ||
    payload?.privacy?.encrypted === true ||
    payload?.privacy?.piiScrubbed === true
  );
}

function hasPerfEvidence(perf) {
  if (perf === undefined || perf === null) return false;
  if (perf.skipped === true) return true;
  return perf.throughput !== undefined ||
    perf.p95LatencyMs !== undefined ||
    perf.aggregate !== undefined ||
    perf.throughputMean !== undefined ||
    perf.latency !== undefined;
}

function isDimensionApplicable(id, expected, input) {
  if (id === 'D12') {
    return expected?.applicableDimensions?.includes(id) === true && hasPerfEvidence(input.perf);
  }
  if (Array.isArray(expected?.applicableDimensions)) {
    return expected.applicableDimensions.includes(id);
  }
  return true;
}

function makeDimension(id, score, evidence) {
  return {
    id,
    applicable: true,
    score: clamp(score),
    max: 5,
    evidence
  };
}

function makeNotApplicable(id) {
  return {
    id,
    applicable: false,
    evidence: 'not applicable for this scenario ground truth'
  };
}

function scoreD1(input) {
  const payloads = input.payloads ?? [];
  const expectedItems = expectedPayloads(input.expected);
  const exactMatches = expectedItems.filter((item) => payloads.some((payload) => payloadMatchesError(payload, item))).length;
  if (exactMatches === expectedItems.length) {
    return makeDimension('D1', 5, `matched expected type/message for ${exactMatches}/${expectedItems.length} payload expectation(s)`);
  }
  if (exactMatches > 0) {
    return makeDimension('D1', 3, `matched expected type/message for only ${exactMatches}/${expectedItems.length} payload expectation(s)`);
  }
  if (payloads.some((payload) => expectedItems.some((item) => payloadMatchesType(payload, item)))) {
    return makeDimension('D1', 3, 'captured expected error type but message did not match ground truth');
  }
  if (payloads.some((payload) => expectedItems.some((item) => payloadMatchesMessage(payload, item)))) {
    return makeDimension('D1', 2, 'captured expected message but type did not match ground truth');
  }
  if (payloads.some(hasError)) {
    return makeDimension('D1', 1, 'captured an exception, but it did not match expected type/message');
  }
  return makeDimension('D1', 0, 'missing captured exception');
}

function scoreD2(input) {
  const payloads = input.payloads ?? [];
  const expectedItems = expectedPayloads(input.expected);
  const frames = appFrames(payloads);
  const exactMatches = expectedItems.filter((item) => frames.some((frame) => frameMatchesExpected(frame, item))).length;
  if (exactMatches === expectedItems.length) {
    return makeDimension('D2', 5, `matched expected originating frame for ${exactMatches}/${expectedItems.length} payload expectation(s)`);
  }
  if (exactMatches > 0) {
    return makeDimension('D2', 4, `matched expected originating frame for only ${exactMatches}/${expectedItems.length} payload expectation(s)`);
  }
  if (frames.some((frame) => frameSameExpectedFile(frame, input.expected))) {
    return makeDimension('D2', 3, 'identified the expected app file but not the expected originating function');
  }
  if (frames.length > 0) {
    return makeDimension('D2', 1, 'identified an app frame, but not the expected source file/function');
  }
  return makeDimension('D2', 0, 'only library/runtime frames or no stack frames were found');
}

function scoreD3(input) {
  return (input.payloads ?? []).some(hasLocalVariables)
    ? makeDimension('D3', 5, 'local variable evidence is present')
    : makeDimension('D3', 1, 'local variable evidence is absent');
}

function scoreD4(input) {
  return (input.payloads ?? []).some(hasRequestContext)
    ? makeDimension('D4', 5, 'request metadata is present')
    : makeDimension('D4', 1, 'request metadata is absent');
}

function scoreD5(input) {
  return hasDbEvidence(input)
    ? makeDimension('D5', 5, 'database query context was found')
    : makeDimension('D5', 1, 'database query context was not found');
}

function scoreD6(input) {
  return hasOutboundDependencyEvidence(input)
    ? makeDimension('D6', 5, 'outbound dependency context was found')
    : makeDimension('D6', 1, 'outbound dependency context was not found');
}

function scoreD7(input) {
  if (hasWorkerEvidence(input)) {
    return makeDimension('D7', 5, 'async/worker phase evidence was found');
  }
  return (input.payloads ?? []).some(hasError)
    ? makeDimension('D7', 2, 'captured the async error but did not preserve worker phase evidence')
    : makeDimension('D7', 0, 'async/worker error evidence is missing');
}

function scoreD8(input) {
  const payloadTraceIds = (input.payloads ?? []).flatMap(traceIdsFromPayload);
  const logTraceIds = traceIdsFromLogs(input.dependencyLogs);
  const allTraceIds = [...payloadTraceIds, ...logTraceIds];
  const counts = new Map();
  for (const traceId of allTraceIds) {
    counts.set(traceId, (counts.get(traceId) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count >= Math.min(2, input.expected?.expectedPayloadCount ?? 2))) {
    return makeDimension('D8', 5, 'trace id correlation was found across expected payload/dependency evidence');
  }
  if (allTraceIds.length > 0) {
    return makeDimension('D8', 3, 'trace context exists but cross-payload correlation was incomplete');
  }
  return makeDimension('D8', 0, 'trace context is absent');
}

function scoreD9(input) {
  const events = timelineEvents(input.payloads ?? []);
  if (events.length > 0) {
    return makeDimension('D9', 5, `timeline contains ${events.length} captured event(s)`);
  }
  return makeDimension('D9', 1, 'captured payload timeline is absent');
}

function scoreD10(input) {
  const payloads = input.payloads ?? [];
  if (hasPrivacyControls(payloads)) {
    return makeDimension('D10', 5, 'privacy/encryption controls are indicated by payload completeness flags');
  }
  return payloads.length > 0
    ? makeDimension('D10', 2, 'payload captured, but privacy/encryption controls were not evidenced')
    : makeDimension('D10', 0, 'no payload available to evaluate privacy/encryption controls');
}

function scoreD11(input) {
  const expectedCount = input.expected?.expectedPayloadCount ?? 1;
  const delivery = input.delivery ?? {};
  const delivered = Number(delivery.delivered ?? 0);
  const deadLettered = Number(delivery.deadLettered ?? 0);
  const lost = Number(delivery.lost ?? Math.max(0, expectedCount - delivered));
  const evidence = `delivery delivered=${delivered} deadLettered=${deadLettered} lost=${lost}`;

  if (lost > 0) {
    return makeDimension('D11', 0, evidence);
  }
  if (delivered >= expectedCount) {
    return makeDimension('D11', deadLettered > 0 ? 4 : 5, evidence);
  }
  if (deadLettered > 0) {
    return makeDimension('D11', 3, evidence);
  }
  return makeDimension('D11', 0, evidence);
}

function scoreD12(input) {
  const perf = input.perf ?? {};
  if (perf.quarantined === true) {
    return makeDimension('D12', 0, `performance result quarantined: ${perf.reason ?? 'no reason recorded'}`);
  }
  if (perf.skipped === true) {
    return makeDimension('D12', 0, `performance run skipped: ${perf.reason ?? 'unknown reason'}`);
  }
  const throughput = perf.throughput?.mean ?? perf.throughputMean ?? perf.throughput;
  const p95 = perf.latency?.p95?.mean ?? perf.p95LatencyMs;
  if (throughput !== undefined && p95 !== undefined) {
    return makeDimension('D12', 5, `performance evidence present throughput=${throughput} p95=${p95}`);
  }
  return makeDimension('D12', 2, 'partial performance evidence present');
}

const SCORERS = {
  D1: scoreD1,
  D2: scoreD2,
  D3: scoreD3,
  D4: scoreD4,
  D5: scoreD5,
  D6: scoreD6,
  D7: scoreD7,
  D8: scoreD8,
  D9: scoreD9,
  D10: scoreD10,
  D11: scoreD11,
  D12: scoreD12
};

export function scoreScenario(input) {
  const expected = input.expected ?? input.scenario?.expected ?? {};
  const scoringInput = {
    ...input,
    expected,
    payloads: input.payloads ?? []
  };
  const dimensions = {};

  for (const dimension of D_RUBRIC) {
    if (!isDimensionApplicable(dimension.id, expected, scoringInput)) {
      dimensions[dimension.id] = makeNotApplicable(dimension.id);
      continue;
    }
    dimensions[dimension.id] = SCORERS[dimension.id](scoringInput);
  }

  const applicable = Object.values(dimensions).filter((entry) => entry.applicable !== false);
  const total = applicable.reduce((sum, entry) => sum + entry.score, 0);
  const maxTotal = applicable.reduce((sum, entry) => sum + entry.max, 0);

  return {
    scenarioId: input.scenarioId ?? input.scenario?.id,
    sdk: input.sdk,
    dimensions,
    total,
    maxTotal
  };
}

export function scoreBenchmarkResults(scenarioResults, options = {}) {
  const perfBySdk = options.perfBySdk ?? new Map();
  const scores = [];
  for (const scenario of scenarioResults) {
    for (const variant of scenario.variants ?? []) {
      scores.push(scoreScenario({
        scenarioId: scenario.scenarioId ?? scenario.id,
        sdk: variant.sdk,
        expected: scenario.expected,
        payloads: variant.payloads,
        delivery: variant.delivery,
        dependencyLogs: variant.dependencyLogs,
        triggerLogs: variant.triggerLogs,
        perf: perfBySdk instanceof Map ? perfBySdk.get(variant.sdk) : perfBySdk[variant.sdk]
      }));
    }
  }
  return scores;
}

function backlogPriority(score, dimension) {
  if (dimension === 'D11' && score <= 1) return 'P0';
  if (score <= 1) return 'P1';
  if (score < 4) return 'P2';
  return 'P3';
}

function entryKey(scenarioId, dimension) {
  return `${scenarioId}:${dimension}`;
}

export function buildBacklog({ scores, comparatorSdk = 'sentry' }) {
  const byScenario = new Map();
  for (const score of scores ?? []) {
    if (!byScenario.has(score.scenarioId)) byScenario.set(score.scenarioId, new Map());
    byScenario.get(score.scenarioId).set(score.sdk, score);
  }

  const entries = new Map();
  for (const [scenarioId, sdkScores] of byScenario) {
    const errorcore = sdkScores.get('errorcore');
    const comparator = sdkScores.get(comparatorSdk);
    if (errorcore === undefined) continue;

    for (const dimension of D_RUBRIC.map((entry) => entry.id)) {
      const ecDimension = errorcore.dimensions[dimension];
      if (ecDimension?.applicable === false) continue;
      const comparatorDimension = comparator?.dimensions?.[dimension];
      const comparatorBeats = comparatorDimension?.applicable !== false &&
        Number(comparatorDimension?.score ?? -1) > Number(ecDimension?.score ?? -1);

      if (ecDimension.score < ecDimension.max || comparatorBeats) {
        const key = entryKey(scenarioId, dimension);
        entries.set(key, {
          id: key,
          priority: backlogPriority(ecDimension.score, dimension),
          scenarioId,
          dimension,
          errorcoreScore: ecDimension.score,
          max: ecDimension.max,
          comparatorSdk,
          comparatorScore: comparatorDimension?.score,
          sentryScore: comparatorSdk === 'sentry' ? comparatorDimension?.score : undefined,
          reason: comparatorBeats
            ? `errorcore scored below ${comparatorSdk} on ${dimension}`
            : `errorcore did not receive full credit on ${dimension}`,
          evidence: ecDimension.evidence,
          action: `Improve errorcore ${D_RUBRIC.find((entry) => entry.id === dimension)?.label ?? dimension} evidence for ${scenarioId}.`
        });
      }
    }
  }

  return [...entries.values()].sort((left, right) => {
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return (priorityOrder[left.priority] - priorityOrder[right.priority]) ||
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.dimension.localeCompare(right.dimension);
  });
}
