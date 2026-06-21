import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareParity, extractSignal } from '../parity.mjs';

describe('parity comparison', () => {
  it('extracts comparable error signals from errorcore and Sentry payloads', () => {
    const errorcorePayload = {
      error: {
        type: 'TypeError',
        message: 'limitCents.toFixed is not a function',
        stack: [
          'TypeError: limitCents.toFixed is not a function',
          '    at applyPolicy (/app/bench/apps/benchmark-app/lib/scenario-engine.mjs:42:11)',
          '    at async runScenario (/app/bench/apps/benchmark-app/lib/scenario-engine.mjs:88:5)'
        ].join('\n')
      },
      errorOrigin: {
        appBoundaryFrame: {
          functionName: 'applyPolicy',
          filePath: '/app/bench/apps/benchmark-app/lib/scenario-engine.mjs',
          lineNumber: 42,
          columnNumber: 11
        }
      }
    };
    const sentryPayload = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'limitCents.toFixed is not a function',
            stacktrace: {
              frames: [
                {
                  filename: '/usr/local/lib/node_modules/express/index.js',
                  function: 'router'
                },
                {
                  filename: '/app/bench/apps/benchmark-app/lib/scenario-engine.mjs',
                  function: 'applyPolicy',
                  lineno: 42,
                  colno: 11,
                  in_app: true
                }
              ]
            }
          }
        ]
      }
    };

    assert.deepEqual(extractSignal('errorcore', errorcorePayload), {
      type: 'TypeError',
      message: 'limitCents.toFixed is not a function',
      topAppFrame: 'applyPolicy@bench/apps/benchmark-app/lib/scenario-engine.mjs'
    });
    assert.deepEqual(extractSignal('sentry', sentryPayload), {
      type: 'TypeError',
      message: 'limitCents.toFixed is not a function',
      topAppFrame: 'applyPolicy@bench/apps/benchmark-app/lib/scenario-engine.mjs'
    });
  });

  it('passes only when status, trigger, error, and app frame match', () => {
    const left = {
      sdk: 'errorcore',
      http: { status: 500 },
      triggerLogs: [
        { scenarioId: 'S1', event: 'request:start' },
        { scenarioId: 'S1', event: 'dependency:pg-query' }
      ],
      dependencyLogs: [{ scenarioId: 'S1', dependency: 'postgres', fault: 'schema-mismatch' }],
      payloads: [
        {
          error: {
            type: 'TypeError',
            message: 'limitCents.toFixed is not a function',
            stack: 'TypeError\n    at applyPolicy (/app/bench/apps/benchmark-app/lib/scenario-engine.mjs:42:11)'
          }
        }
      ]
    };
    const right = {
      sdk: 'sentry',
      http: { status: 500 },
      triggerLogs: [
        { scenarioId: 'S1', event: 'request:start' },
        { scenarioId: 'S1', event: 'dependency:pg-query' }
      ],
      dependencyLogs: [{ scenarioId: 'S1', dependency: 'postgres', fault: 'schema-mismatch' }],
      payloads: [
        {
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'limitCents.toFixed is not a function',
                stacktrace: {
                  frames: [
                    {
                      filename: '/app/bench/apps/benchmark-app/lib/scenario-engine.mjs',
                      function: 'applyPolicy',
                      in_app: true
                    }
                  ]
                }
              }
            ]
          }
        }
      ]
    };

    assert.equal(compareParity(left, right).ok, true);
    assert.equal(compareParity(left, { ...right, http: { status: 202 } }).ok, false);
  });

  it('records which SDK is closer to ground truth without making parity a scoring gate', () => {
    const expected = {
      expectedMessage: 'limitCents.toFixed is not a function',
      expectedOriginatingFrame: 'applyPolicyLimit'
    };
    const left = {
      sdk: 'errorcore',
      http: { status: 500 },
      triggerLogs: [],
      dependencyLogs: [],
      payloads: [
        {
          error: {
            type: 'TypeError',
            message: 'limitCents.toFixed is not a function',
            stack: 'TypeError\n    at applyPolicyLimit (/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs:42:11)'
          }
        }
      ]
    };
    const right = {
      sdk: 'sentry',
      http: { status: 500 },
      triggerLogs: [],
      dependencyLogs: [],
      payloads: [
        {
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'Cannot read properties of undefined',
                stacktrace: {
                  frames: [
                    { filename: '/workspace/bench/apps/benchmark-app/lib/scenario-engine.mjs', function: 'runScenario' }
                  ]
                }
              }
            ]
          }
        }
      ]
    };

    const result = compareParity(left, right, { expected });

    assert.equal(result.ok, false);
    assert.deepEqual(result.closerToGroundTruth, {
      messageWinner: 'errorcore',
      frameWinner: 'errorcore',
      evidence: [
        'errorcore message matched expected; sentry message did not',
        'errorcore frame matched expected; sentry frame did not'
      ]
    });
  });

  it('extracts comparable error signals from BugSnag notify payloads', () => {
    const payload = {
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
      ]
    };

    assert.deepEqual(extractSignal('bugsnag', payload), {
      type: 'TypeError',
      message: 'limitCents.toFixed is not a function',
      topAppFrame: 'applyPolicyLimit@bench/apps/benchmark-app/lib/scenario-engine.mjs'
    });
  });
});
