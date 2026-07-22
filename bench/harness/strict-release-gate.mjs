const DEFAULT_PERF_ENDPOINTS = Object.freeze([
  'healthz',
  'success-work',
  'error-capture'
]);

// S6 begins in an HTTP request but captures after the response, so request
// metadata itself is not a scored D4 expectation. It is still request-derived
// and must retain a timeline in safe mode.
const REQUEST_DERIVED_SCENARIOS_WITHOUT_D4 = new Set(['S6']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values)];
}

function perfEndpointId(endpoint) {
  return typeof endpoint === 'string' ? endpoint : endpoint?.id;
}

function perfKey(sdk, endpoint) {
  return `${String(sdk)}:${String(endpoint)}`;
}

function isCompleteMetric(value) {
  return Number.isFinite(value) && value >= 0;
}

function repetitionMetricsComplete(repetition) {
  return isCompleteMetric(repetition?.throughput) &&
    isCompleteMetric(repetition?.p50LatencyMs) &&
    isCompleteMetric(repetition?.p95LatencyMs) &&
    isCompleteMetric(repetition?.p99LatencyMs);
}

function aggregateMetricsComplete(aggregate) {
  return isCompleteMetric(aggregate?.throughput?.mean) &&
    isCompleteMetric(aggregate?.latency?.p50?.mean) &&
    isCompleteMetric(aggregate?.latency?.p95?.mean) &&
    isCompleteMetric(aggregate?.latency?.p99?.mean);
}

function fullCredit(dimension) {
  return dimension?.applicable !== false &&
    Number.isFinite(dimension?.score) &&
    Number.isFinite(dimension?.max) &&
    dimension.score === dimension.max;
}

function configuredApplicability(scenario, dimensionId, scoredDimension) {
  const configured = scenario?.expected?.applicableDimensions;
  if (Array.isArray(configured)) return configured.includes(dimensionId);
  return scoredDimension?.applicable !== false;
}

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  return String(error ?? 'unknown error');
}

function countPayloads(payloads) {
  return asArray(payloads).filter((payload) => payload !== null && payload !== undefined).length;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Evaluate the evidence produced by a complete benchmark run.
 *
 * This function is deliberately pure: it reads no environment variables, writes no
 * files, and does not mutate the supplied benchmark results. The caller decides
 * whether the strict gate is enabled and how to report the returned errors.
 */
export function evaluateStrictBenchmarkRelease({
  captureMode = 'forensic',
  compareSdk = 'sentry',
  candidateSha256,
  expectedScenarios,
  expectedScenarioSdks,
  expectedPerfSdks,
  expectedPerfEndpoints = DEFAULT_PERF_ENDPOINTS,
  expectedPerfRepetitions = 3,
  scenarioResults,
  scores,
  perfResults,
  perfSuiteError
} = {}) {
  const errors = [];
  const addError = (code, message, details = {}) => {
    errors.push({ code, message, ...details });
  };

  const mode = String(captureMode || 'forensic').toLowerCase();
  const scenarios = asArray(expectedScenarios ?? scenarioResults);
  const results = asArray(scenarioResults);
  const scenarioSdks = unique(expectedScenarioSdks ?? ['errorcore', compareSdk]);
  const perfSdks = unique(expectedPerfSdks ?? ['baseline', 'errorcore', compareSdk]);
  const perfEndpoints = unique(asArray(expectedPerfEndpoints)
    .map(perfEndpointId)
    .filter((endpoint) => typeof endpoint === 'string' && endpoint.length > 0));

  if (typeof candidateSha256 !== 'string' || candidateSha256.length === 0) {
    addError(
      'CANDIDATE_SHA256_MISSING',
      'BENCH_CANDIDATE_SHA256 is required for a strict benchmark release run'
    );
  } else if (!/^sha256:[0-9a-f]{64}$/i.test(candidateSha256)) {
    addError(
      'CANDIDATE_SHA256_INVALID',
      'BENCH_CANDIDATE_SHA256 must be sha256 followed by exactly 64 hexadecimal characters'
    );
  }

  if (perfSuiteError !== undefined && perfSuiteError !== null) {
    addError(
      'PERF_SUITE_ERROR',
      `performance suite threw an exception: ${errorText(perfSuiteError)}`
    );
  }

  const configuredRepetitions = perfResults?.settings?.repetitionsPerEndpoint;
  const repetitionsPerEndpoint = positiveInteger(configuredRepetitions)
    ? configuredRepetitions
    : expectedPerfRepetitions;
  if (!positiveInteger(repetitionsPerEndpoint)) {
    addError(
      'PERF_SETTINGS_INVALID',
      `performance repetitions per endpoint must be a positive integer; received ${String(repetitionsPerEndpoint)}`
    );
  } else if (configuredRepetitions !== undefined && !positiveInteger(configuredRepetitions)) {
    addError(
      'PERF_SETTINGS_INVALID',
      `performance suite reported an invalid repetitionsPerEndpoint value: ${String(configuredRepetitions)}`
    );
  }

  const repetitions = asArray(perfResults?.repetitions);
  const aggregates = asArray(perfResults?.aggregates);
  const sanity = asArray(perfResults?.sanity);
  const repetitionsByGroup = new Map();
  const aggregatesByGroup = new Map();

  for (const repetition of repetitions) {
    const key = perfKey(repetition?.sdk, repetition?.endpoint);
    if (!repetitionsByGroup.has(key)) repetitionsByGroup.set(key, []);
    repetitionsByGroup.get(key).push(repetition);

    const details = {
      sdk: repetition?.sdk,
      endpoint: repetition?.endpoint,
      repetition: repetition?.repetition
    };
    if (repetition?.skipped === true) {
      addError(
        'PERF_REPETITION_SKIPPED',
        `performance repetition ${key}#${String(repetition?.repetition)} was skipped: ${repetition?.reason ?? 'no reason recorded'}`,
        details
      );
    } else if (!repetitionMetricsComplete(repetition)) {
      addError(
        'PERF_REPETITION_INCOMPLETE',
        `performance repetition ${key}#${String(repetition?.repetition)} is missing throughput or latency metrics`,
        details
      );
    }
    if (repetition?.quarantined === true) {
      addError(
        'PERF_REPETITION_QUARANTINED',
        `performance repetition ${key}#${String(repetition?.repetition)} was quarantined: ${repetition?.reason ?? 'no reason recorded'}`,
        details
      );
    }
  }

  for (const aggregate of aggregates) {
    const key = perfKey(aggregate?.sdk, aggregate?.endpoint);
    if (!aggregatesByGroup.has(key)) aggregatesByGroup.set(key, []);
    aggregatesByGroup.get(key).push(aggregate);

    const details = { sdk: aggregate?.sdk, endpoint: aggregate?.endpoint };
    const skipped = aggregate?.skipped === true || Number(aggregate?.skipped ?? 0) > 0;
    if (skipped) {
      addError(
        'PERF_AGGREGATE_SKIPPED',
        `performance aggregate ${key} contains skipped work: ${aggregate?.reason ?? String(aggregate?.skipped)}`,
        details
      );
    }
    if (aggregate?.quarantined === true) {
      addError(
        'PERF_AGGREGATE_QUARANTINED',
        `performance aggregate ${key} was quarantined: ${aggregate?.reason ?? 'no reason recorded'}`,
        details
      );
    }
    const countsComplete = positiveInteger(repetitionsPerEndpoint) &&
      aggregate?.repetitions === repetitionsPerEndpoint &&
      aggregate?.completed === repetitionsPerEndpoint &&
      Number(aggregate?.skipped ?? 0) === 0;
    if (!countsComplete || !aggregateMetricsComplete(aggregate)) {
      addError(
        'PERF_AGGREGATE_INCOMPLETE',
        `performance aggregate ${key} is incomplete (completed=${String(aggregate?.completed)}, repetitions=${String(aggregate?.repetitions)})`,
        details
      );
    }
  }

  for (const sanityResult of sanity) {
    if (sanityResult?.quarantined !== true) continue;
    addError(
      'PERF_SANITY_QUARANTINED',
      `performance sanity result ${perfKey(sanityResult?.sdk, sanityResult?.endpoint)} was quarantined: ${sanityResult?.reason ?? 'no reason recorded'}`,
      { sdk: sanityResult?.sdk, endpoint: sanityResult?.endpoint }
    );
  }

  if (perfResults === undefined || perfResults === null) {
    addError('PERF_RESULTS_MISSING', 'performance suite did not return a result');
  }

  if (positiveInteger(repetitionsPerEndpoint)) {
    for (const sdk of perfSdks) {
      for (const endpoint of perfEndpoints) {
        const key = perfKey(sdk, endpoint);
        const group = repetitionsByGroup.get(key) ?? [];
        const repetitionNumbers = new Set(group.map((entry) => entry?.repetition));
        const hasExpectedRepetitions = group.length === repetitionsPerEndpoint &&
          repetitionNumbers.size === repetitionsPerEndpoint &&
          Array.from({ length: repetitionsPerEndpoint }, (_, index) => index + 1)
            .every((repetition) => repetitionNumbers.has(repetition));
        if (!hasExpectedRepetitions) {
          addError(
            'PERF_REPETITIONS_INCOMPLETE',
            `performance group ${key} has ${group.length}/${repetitionsPerEndpoint} required repetition(s)`,
            { sdk, endpoint }
          );
        }

        const aggregateGroup = aggregatesByGroup.get(key) ?? [];
        if (aggregateGroup.length !== 1) {
          addError(
            'PERF_AGGREGATE_MISSING',
            `performance group ${key} has ${aggregateGroup.length}/1 required aggregate(s)`,
            { sdk, endpoint }
          );
        }
      }
    }
  }

  const resultByScenario = new Map(results.map((scenario) => [scenario?.scenarioId ?? scenario?.id, scenario]));
  const scoreByScenarioSdk = new Map(asArray(scores).map((score) => [
    `${String(score?.scenarioId)}:${String(score?.sdk)}`,
    score
  ]));

  for (const expectedScenario of scenarios) {
    const scenarioId = expectedScenario?.scenarioId ?? expectedScenario?.id;
    const scenario = resultByScenario.get(scenarioId);
    if (scenario === undefined) {
      addError(
        'SCENARIO_RESULT_MISSING',
        `benchmark scenario ${String(scenarioId)} did not produce a result`,
        { scenarioId }
      );
      continue;
    }

    const expectedCount = Number(expectedScenario?.expected?.expectedPayloadCount ?? 1);
    const variantBySdk = new Map(asArray(scenario?.variants).map((variant) => [variant?.sdk, variant]));
    for (const sdk of scenarioSdks) {
      const variant = variantBySdk.get(sdk);
      if (variant === undefined) {
        addError(
          'SDK_VARIANT_MISSING',
          `${sdk} did not produce a result for ${String(scenarioId)}`,
          { scenarioId, sdk }
        );
        continue;
      }

      // Comparator payload quality is diagnostic parity evidence, not an
      // ErrorCore release criterion. Its variant must execute, but a designed
      // comparator limitation (for example S9 retry behavior) cannot veto the
      // ErrorCore release.
      if (sdk !== 'errorcore') continue;

      const payloadCount = countPayloads(variant.payloads);
      const delivered = Number(variant?.delivery?.delivered ?? payloadCount);
      const lost = Number(variant?.delivery?.lost ?? Math.max(0, expectedCount - delivered));
      if (payloadCount < expectedCount || delivered < expectedCount) {
        addError(
          'ERRORCORE_PAYLOAD_MISSING',
          `${sdk} produced ${payloadCount} payload(s) and delivered ${delivered}/${expectedCount} for ${String(scenarioId)}`,
          { scenarioId, sdk, expected: expectedCount, actual: payloadCount, delivered }
        );
      }
      if (lost > 0) {
        addError(
          'ERRORCORE_PAYLOAD_LOST',
          `${sdk} lost ${lost} expected payload(s) for ${String(scenarioId)}`,
          { scenarioId, sdk, lost }
        );
      }
      if (variant?.payloadWait?.timedOut === true || variant?.delivery?.waitTimedOut === true) {
        addError(
          'ERRORCORE_PAYLOAD_WAIT_TIMEOUT',
          `${sdk} timed out waiting for expected payloads for ${String(scenarioId)}: ${variant?.payloadWait?.error ?? variant?.delivery?.waitError ?? 'no reason recorded'}`,
          { scenarioId, sdk }
        );
      }
    }

    const errorcoreScore = scoreByScenarioSdk.get(`${String(scenarioId)}:errorcore`);
    if (errorcoreScore === undefined) {
      addError(
        'ERRORCORE_SCORE_MISSING',
        `errorcore did not produce correctness scores for ${String(scenarioId)}`,
        { scenarioId, sdk: 'errorcore' }
      );
      continue;
    }

    const requireFullCredit = (dimensionId) => {
      const dimension = errorcoreScore?.dimensions?.[dimensionId];
      if (!fullCredit(dimension)) {
        addError(
          'ERRORCORE_DIMENSION_NOT_FULL_CREDIT',
          `errorcore ${String(scenarioId)} ${dimensionId} received ${String(dimension?.score ?? 'missing')}/${String(dimension?.max ?? 5)} instead of full credit`,
          { scenarioId, sdk: 'errorcore', dimension: dimensionId }
        );
      }
    };

    for (const dimensionId of ['D1', 'D2', 'D10', 'D11']) {
      requireFullCredit(dimensionId);
    }

    for (const dimensionId of ['D4', 'D8']) {
      const dimension = errorcoreScore?.dimensions?.[dimensionId];
      if (configuredApplicability(expectedScenario, dimensionId, dimension)) {
        requireFullCredit(dimensionId);
      }
    }

    const d9 = errorcoreScore?.dimensions?.D9;
    const requestContextScenario = configuredApplicability(
      expectedScenario,
      'D4',
      errorcoreScore?.dimensions?.D4
    ) || expectedScenario?.requestContextScenario === true ||
      expectedScenario?.expected?.requestContextScenario === true ||
      REQUEST_DERIVED_SCENARIOS_WITHOUT_D4.has(String(scenarioId));
    const d9Applicable = configuredApplicability(expectedScenario, 'D9', d9);
    if (d9Applicable && (mode !== 'safe' || requestContextScenario)) {
      requireFullCredit('D9');
    }
  }

  if (mode !== 'fast') {
    const hasLocalEvidence = scenarios.some((scenario) => {
      const scenarioId = scenario?.scenarioId ?? scenario?.id;
      return fullCredit(scoreByScenarioSdk.get(`${String(scenarioId)}:errorcore`)?.dimensions?.D3);
    });
    if (!hasLocalEvidence) {
      addError(
        'ERRORCORE_LOCALS_EVIDENCE_MISSING',
        `errorcore ${mode} mode did not receive a locals-positive D3 score in any scenario`,
        { sdk: 'errorcore', dimension: 'D3' }
      );
    }
  }

  return {
    ok: errors.length === 0,
    captureMode: mode,
    errors
  };
}
