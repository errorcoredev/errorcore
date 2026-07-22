import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateStrictBenchmarkRelease } from '../strict-release-gate.mjs';

const PERF_SDKS = ['baseline', 'errorcore', 'sentry'];
const PERF_ENDPOINTS = ['healthz', 'success-work', 'error-capture'];

function makePerfResults(repetitionsPerEndpoint = 2) {
  const repetitions = [];
  const aggregates = [];
  for (const sdk of PERF_SDKS) {
    for (const endpoint of PERF_ENDPOINTS) {
      for (let repetition = 1; repetition <= repetitionsPerEndpoint; repetition += 1) {
        repetitions.push({
          sdk,
          endpoint,
          repetition,
          skipped: false,
          throughput: 1000,
          p50LatencyMs: 1,
          p95LatencyMs: 2,
          p99LatencyMs: 3
        });
      }
      aggregates.push({
        sdk,
        endpoint,
        repetitions: repetitionsPerEndpoint,
        completed: repetitionsPerEndpoint,
        skipped: 0,
        quarantined: false,
        throughput: { mean: 1000 },
        latency: {
          p50: { mean: 1 },
          p95: { mean: 2 },
          p99: { mean: 3 }
        }
      });
    }
  }
  return {
    settings: { repetitionsPerEndpoint },
    repetitions,
    aggregates,
    sanity: []
  };
}

function fullDimension(id) {
  return { id, applicable: true, score: 5, max: 5, evidence: 'present' };
}

function passingInput(captureMode = 'safe') {
  const expected = {
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D3', 'D4', 'D8', 'D9', 'D10', 'D11']
  };
  const expectedScenario = { id: 'S1', expected };
  const scenarioResult = {
    scenarioId: 'S1',
    expected,
    parity: { ok: false },
    variants: [
      {
        sdk: 'errorcore',
        payloads: [{ error: { message: 'boom' } }],
        delivery: { delivered: 1, lost: 0 }
      },
      {
        sdk: 'sentry',
        payloads: [{ exception: { values: [] } }],
        delivery: { delivered: 1, lost: 0 }
      }
    ]
  };
  const dimensions = Object.fromEntries(
    expected.applicableDimensions.map((id) => [id, fullDimension(id)])
  );
  return {
    captureMode,
    compareSdk: 'sentry',
    candidateSha256: `sha256:${'a'.repeat(64)}`,
    expectedScenarios: [expectedScenario],
    expectedScenarioSdks: ['errorcore', 'sentry'],
    expectedPerfSdks: PERF_SDKS,
    expectedPerfEndpoints: PERF_ENDPOINTS,
    expectedPerfRepetitions: 2,
    scenarioResults: [scenarioResult],
    scores: [
      {
        scenarioId: 'S1',
        sdk: 'errorcore',
        dimensions,
        total: 40,
        maxTotal: 40
      },
      {
        scenarioId: 'S1',
        sdk: 'sentry',
        dimensions: { D1: { ...fullDimension('D1'), score: 0 } },
        total: 0,
        maxTotal: 5
      }
    ],
    perfResults: makePerfResults(2)
  };
}

function errorCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

describe('strict benchmark release gate', () => {
  it('passes complete release evidence and ignores parity/comparator score differences', () => {
    const result = evaluateStrictBenchmarkRelease(passingInput());

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects a performance-suite exception instead of accepting its fallback artifact', () => {
    const input = passingInput();
    input.perfSuiteError = new Error('spawn EINVAL');

    const result = evaluateStrictBenchmarkRelease(input);

    assert.equal(result.ok, false);
    assert.equal(errorCodes(result).has('PERF_SUITE_ERROR'), true);
    assert.match(result.errors.find((error) => error.code === 'PERF_SUITE_ERROR').message, /spawn EINVAL/);
  });

  it('requires the exact candidate SHA-256 in strict release evidence', () => {
    const missing = passingInput();
    delete missing.candidateSha256;
    const invalid = passingInput();
    invalid.candidateSha256 = 'sha256:not-a-release-digest';

    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(missing)).has('CANDIDATE_SHA256_MISSING'),
      true
    );
    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(invalid)).has('CANDIDATE_SHA256_INVALID'),
      true
    );
  });

  it('rejects skipped and incomplete performance repetitions', () => {
    const skipped = passingInput();
    skipped.perfResults.repetitions[0].skipped = true;
    skipped.perfResults.repetitions[0].reason = 'autocannon spawn failed';
    const incomplete = passingInput();
    delete incomplete.perfResults.repetitions[0].p95LatencyMs;

    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(skipped)).has('PERF_REPETITION_SKIPPED'),
      true
    );
    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(incomplete)).has('PERF_REPETITION_INCOMPLETE'),
      true
    );
  });

  it('rejects skipped, incomplete, quarantined, and missing performance aggregates', () => {
    const input = passingInput();
    input.perfResults.aggregates[0].skipped = 1;
    input.perfResults.aggregates[0].completed = 1;
    input.perfResults.aggregates[0].quarantined = true;
    input.perfResults.sanity.push({
      sdk: 'errorcore',
      endpoint: 'healthz',
      quarantined: true,
      reason: 'no-op throughput sanity failed'
    });
    input.perfResults.aggregates.pop();

    const codes = errorCodes(evaluateStrictBenchmarkRelease(input));

    assert.equal(codes.has('PERF_AGGREGATE_SKIPPED'), true);
    assert.equal(codes.has('PERF_AGGREGATE_INCOMPLETE'), true);
    assert.equal(codes.has('PERF_AGGREGATE_QUARANTINED'), true);
    assert.equal(codes.has('PERF_SANITY_QUARANTINED'), true);
    assert.equal(codes.has('PERF_AGGREGATE_MISSING'), true);
  });

  it('rejects missing, lost, and timed-out ErrorCore payload delivery', () => {
    const input = passingInput();
    const errorcore = input.scenarioResults[0].variants.find((variant) => variant.sdk === 'errorcore');
    errorcore.payloads = [];
    errorcore.delivery = {
      delivered: 0,
      lost: 1,
      waitTimedOut: true,
      waitError: 'timed out waiting for errorcore S1 payloads'
    };

    const codes = errorCodes(evaluateStrictBenchmarkRelease(input));

    assert.equal(codes.has('ERRORCORE_PAYLOAD_MISSING'), true);
    assert.equal(codes.has('ERRORCORE_PAYLOAD_LOST'), true);
    assert.equal(codes.has('ERRORCORE_PAYLOAD_WAIT_TIMEOUT'), true);
  });

  it('does not turn comparator payload limitations into ErrorCore release failures', () => {
    const input = passingInput();
    const sentry = input.scenarioResults[0].variants.find((variant) => variant.sdk === 'sentry');
    sentry.payloads = [];
    sentry.delivery = { delivered: 0, lost: 1, waitTimedOut: true };

    const result = evaluateStrictBenchmarkRelease(input);

    assert.equal(result.ok, true);
  });

  it('requires full ErrorCore D1, D2, D10, and D11 correctness credit', () => {
    for (const dimension of ['D1', 'D2', 'D10', 'D11']) {
      const input = passingInput();
      input.scores[0].dimensions[dimension].score = 4;

      const errors = evaluateStrictBenchmarkRelease(input).errors;

      assert.equal(errors.some((error) =>
        error.code === 'ERRORCORE_DIMENSION_NOT_FULL_CREDIT' && error.dimension === dimension
      ), true, `${dimension} should fail the gate`);
    }
  });

  it('requires full applicable D4 request context and D8 trace correlation credit', () => {
    for (const dimension of ['D4', 'D8']) {
      const input = passingInput();
      input.scores[0].dimensions[dimension].score = 1;

      const errors = evaluateStrictBenchmarkRelease(input).errors;

      assert.equal(errors.some((error) =>
        error.code === 'ERRORCORE_DIMENSION_NOT_FULL_CREDIT' && error.dimension === dimension
      ), true, `${dimension} should fail the gate`);
    }
  });

  it('requires D9 for safe request scenarios but not safe non-request scenarios', () => {
    const requestInput = passingInput('safe');
    requestInput.scores[0].dimensions.D9.score = 1;
    const nonRequestInput = passingInput('safe');
    nonRequestInput.expectedScenarios[0].expected.applicableDimensions =
      nonRequestInput.expectedScenarios[0].expected.applicableDimensions.filter((id) => id !== 'D4');
    nonRequestInput.scores[0].dimensions.D9.score = 1;

    const requestErrors = evaluateStrictBenchmarkRelease(requestInput).errors;
    const nonRequestErrors = evaluateStrictBenchmarkRelease(nonRequestInput).errors;

    assert.equal(requestErrors.some((error) => error.dimension === 'D9'), true);
    assert.equal(nonRequestErrors.some((error) => error.dimension === 'D9'), false);
  });

  it('treats delayed post-response S6 as request-derived for safe-mode D9', () => {
    const input = passingInput('safe');
    input.expectedScenarios[0].id = 'S6';
    input.expectedScenarios[0].expected.applicableDimensions =
      input.expectedScenarios[0].expected.applicableDimensions.filter((id) => id !== 'D4');
    input.scenarioResults[0].scenarioId = 'S6';
    input.scores[0].scenarioId = 'S6';
    input.scores[0].dimensions.D9.score = 1;

    const errors = evaluateStrictBenchmarkRelease(input).errors;

    assert.equal(errors.some((error) => error.scenarioId === 'S6' && error.dimension === 'D9'), true);
  });

  it('requires D9 for every applicable scenario in non-safe modes', () => {
    const input = passingInput('balanced');
    input.expectedScenarios[0].expected.applicableDimensions =
      input.expectedScenarios[0].expected.applicableDimensions.filter((id) => id !== 'D4');
    input.scores[0].dimensions.D9.score = 1;

    const errors = evaluateStrictBenchmarkRelease(input).errors;

    assert.equal(errors.some((error) => error.dimension === 'D9'), true);
  });

  it('requires locals-positive D3 evidence in non-fast modes and exempts fast mode', () => {
    const balanced = passingInput('balanced');
    balanced.scores[0].dimensions.D3.score = 1;
    const fast = passingInput('fast');
    fast.scores[0].dimensions.D3.score = 1;

    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(balanced)).has('ERRORCORE_LOCALS_EVIDENCE_MISSING'),
      true
    );
    assert.equal(
      errorCodes(evaluateStrictBenchmarkRelease(fast)).has('ERRORCORE_LOCALS_EVIDENCE_MISSING'),
      false
    );
  });
});
