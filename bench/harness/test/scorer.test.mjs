import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as scorer from '../scorer.mjs';

const expected = {
  expectedErrorType: 'TypeError',
  expectedMessage: 'limitCents.toFixed is not a function',
  expectedOriginatingFrame: 'applyPolicyLimit',
  expectedPayloadCount: 1,
  applicableDimensions: ['D1', 'D2', 'D4', 'D11']
};

describe('diagnosability scorer', () => {
  it('emits exactly D1-D12 with bounded numeric scores', () => {
    const result = scorer.scoreScenario({
      scenarioId: 'S5',
      sdk: 'errorcore',
      expected: {
        expectedErrorType: 'Error',
        expectedMessage: 'service-b failed',
        expectedOriginatingFrame: 'runServiceBCall',
        expectedPayloadCount: 1,
        applicableDimensions: scorer.D_RUBRIC.map((entry) => entry.id)
      },
      payloads: [
        {
          error: { type: 'Error', message: 'service-b failed' },
          request: { headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' } },
          ioTimeline: [
            { type: 'http-client', direction: 'outbound', statusCode: 503 },
            { type: 'db-query', dbMeta: { query: 'select * from users where id=$1', params: '[42]' } }
          ],
          localVariables: [{ functionName: 'runServiceBCall', locals: { accountId: 42 } }],
          trace: { traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb' },
          completeness: { encrypted: true, piiScrubbed: true, localVariablesCaptured: true }
        }
      ],
      delivery: { delivered: 1, deadLettered: 0, lost: 0 },
      perf: { p95LatencyMs: 12, throughput: 1000 }
    });

    assert.deepEqual(Object.keys(result.dimensions), scorer.D_RUBRIC.map((entry) => entry.id));
    for (const dimension of Object.values(result.dimensions)) {
      if (dimension.applicable === false) continue;
      assert.equal(dimension.max, 5);
      assert.equal(Number.isInteger(dimension.score), true);
      assert.equal(dimension.score >= 0 && dimension.score <= 5, true);
    }
    assert.equal(result.total > 0, true);
  });

  it('excludes non-applicable dimensions from the denominator', () => {
    const result = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'errorcore',
      expected,
      payloads: [
        {
          error: {
            type: 'TypeError',
            message: 'limitCents.toFixed is not a function',
            stack: 'TypeError\n    at applyPolicyLimit (/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs:42:11)'
          },
          request: { path: '/scenario/S1' }
        }
      ],
      delivery: { delivered: 1, deadLettered: 0, lost: 0 }
    });

    assert.equal(result.dimensions.D5.applicable, false);
    assert.equal(result.dimensions.D12.applicable, false);
    assert.equal(result.maxTotal, expected.applicableDimensions.length * 5);
  });

  it('awards a better D2 score to the SDK that matches the expected app frame', () => {
    const matching = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'errorcore',
      expected,
      payloads: [
        {
          error: {
            type: 'TypeError',
            message: 'limitCents.toFixed is not a function',
            stack: 'TypeError\n    at applyPolicyLimit (/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs:42:11)'
          }
        }
      ],
      delivery: { delivered: 1, lost: 0, deadLettered: 0 }
    });
    const frameworkFrame = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'sentry',
      expected,
      payloads: [
        {
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'limitCents.toFixed is not a function',
                stacktrace: {
                  frames: [
                    { filename: '/node_modules/express/router.js', function: 'dispatch' },
                    { filename: '/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs', function: 'runScenario' }
                  ]
                }
              }
            ]
          }
        }
      ],
      delivery: { delivered: 1, lost: 0, deadLettered: 0 }
    });

    assert.equal(matching.dimensions.D2.score, 5);
    assert.equal(frameworkFrame.dimensions.D2.score, 3);
    assert.equal(matching.dimensions.D2.score > frameworkFrame.dimensions.D2.score, true);
  });

  it('scores all sdk variants for all scenarios without dropped-before-scoring gates', () => {
    assert.equal(typeof scorer.scoreBenchmarkResults, 'function');
    const scenarios = Array.from({ length: 9 }, (_, index) => ({
      scenarioId: `S${index + 1}`,
      expected,
      variants: [
        { sdk: 'errorcore', payloads: [], delivery: { delivered: 0, lost: 1, deadLettered: 0 } },
        { sdk: 'sentry', payloads: [], delivery: { delivered: 0, lost: 1, deadLettered: 0 } }
      ]
    }));

    const scores = scorer.scoreBenchmarkResults(scenarios);

    assert.equal(scores.length, 18);
    assert.equal(scenarios.some((scenario) => scenario.droppedBeforeScoring), false);
  });

  it('turns S9 delivery loss into a low D11 score and P0 backlog entry', () => {
    assert.equal(typeof scorer.buildBacklog, 'function');
    const score = scorer.scoreScenario({
      scenarioId: 'S9',
      sdk: 'errorcore',
      expected: {
        expectedErrorType: 'Error',
        expectedMessage: 'checkout failed while capture sink is unreachable',
        expectedOriginatingFrame: 'runScenario',
        expectedPayloadCount: 1,
        applicableDimensions: ['D1', 'D2', 'D11']
      },
      payloads: [],
      delivery: { delivered: 0, deadLettered: 0, lost: 1 }
    });

    const backlog = scorer.buildBacklog({
      scores: [score],
      sentryScoresByScenario: new Map()
    });

    assert.equal(score.dimensions.D11.score, 0);
    assert.equal(backlog.some((entry) =>
      entry.priority === 'P0' &&
      entry.scenarioId === 'S9' &&
      entry.dimension === 'D11'
    ), true);
  });

  it('scores raw BugSnag events against ground truth', () => {
    const result = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'bugsnag',
      expected,
      payloads: [
        {
          exceptions: [
            {
              errorClass: 'TypeError',
              message: 'limitCents.toFixed is not a function',
              stacktrace: [
                {
                  method: 'applyPolicyLimit',
                  file: '/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs',
                  lineNumber: 42,
                  columnNumber: 11
                }
              ]
            }
          ],
          request: { url: '/scenario/S1' },
          breadcrumbs: [{ name: 'request:start' }]
        }
      ],
      delivery: { delivered: 1, deadLettered: 0, lost: 0 }
    });

    assert.equal(result.dimensions.D1.score, 5);
    assert.equal(result.dimensions.D2.score, 5);
    assert.equal(result.dimensions.D4.score, 5);
  });

  it('uses the configured comparator SDK when building backlog comparison entries', () => {
    const errorcore = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'errorcore',
      expected,
      payloads: [],
      delivery: { delivered: 0, deadLettered: 0, lost: 1 }
    });
    const bugsnag = scorer.scoreScenario({
      scenarioId: 'S1',
      sdk: 'bugsnag',
      expected,
      payloads: [
        {
          exceptions: [
            {
              errorClass: 'TypeError',
              message: 'limitCents.toFixed is not a function',
              stacktrace: [
                { method: 'applyPolicyLimit', file: '/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs' }
              ]
            }
          ]
        }
      ],
      delivery: { delivered: 1, deadLettered: 0, lost: 0 }
    });

    const backlog = scorer.buildBacklog({ scores: [errorcore, bugsnag], comparatorSdk: 'bugsnag' });

    assert.equal(backlog.some((entry) =>
      entry.dimension === 'D1' &&
      entry.comparatorSdk === 'bugsnag' &&
      entry.reason === 'errorcore scored below bugsnag on D1'
    ), true);
  });
});
