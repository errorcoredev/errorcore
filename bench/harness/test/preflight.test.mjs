import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as preflight from '../preflight.mjs';

const expectedByScenario = {
  S1: {
    expectedErrorType: 'TypeError',
    expectedMessage: 'limitCents.toFixed is not a function',
    expectedOriginatingFrame: 'applyPolicyLimit',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D3', 'D4', 'D5', 'D9', 'D10', 'D11', 'D12']
  },
  S2: {
    expectedErrorType: 'Error',
    expectedMessage: 'upstream dependency returned HTTP 503',
    expectedOriginatingFrame: 'requireUpstreamOk',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D4', 'D6', 'D9', 'D10', 'D11', 'D12']
  },
  S3: {
    expectedErrorType: 'Error',
    expectedMessage: 'redis key bench:missing-worker-input was required but missing',
    expectedOriginatingFrame: 'redisGetRequired',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D6', 'D7', 'D9', 'D10', 'D11', 'D12']
  },
  S4: {
    expectedErrorType: 'Error',
    expectedMessage: 'upstream dependency returned HTTP 502',
    expectedOriginatingFrame: 'requireUpstreamOk',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D4', 'D5', 'D6', 'D9', 'D10', 'D11', 'D12']
  },
  S5: {
    expectedErrorType: 'Error',
    expectedMessage: 'service-b failed with HTTP 500',
    expectedOriginatingFrame: 'runScenario',
    expectedPayloadCount: 2,
    applicableDimensions: ['D1', 'D2', 'D4', 'D5', 'D6', 'D8', 'D9', 'D10', 'D11', 'D12']
  },
  S6: {
    expectedErrorType: 'Error',
    expectedMessage: 'delayed upstream failed after response: upstream dependency returned HTTP 504',
    messageWrapped: true,
    expectedOriginatingFrame: 'delayedUpstreamFailureAfterResponse',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D6', 'D7', 'D9', 'D10', 'D11', 'D12']
  },
  S7: {
    expectedErrorType: 'TypeError',
    expectedMessage: 'job.payload.price.cents must be an integer',
    expectedOriginatingFrame: 'queueConsumer',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D7', 'D9', 'D10', 'D11', 'D12']
  },
  S8: {
    expectedErrorType: 'Error',
    expectedMessage: 'ORM hydration failed: inventory.sku missing after parser plugin',
    expectedOriginatingFrame: 'inventoryPluginLayer',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D9', 'D10', 'D11', 'D12']
  },
  S9: {
    expectedErrorType: 'Error',
    expectedMessage: 'checkout failed while capture sink is unreachable',
    expectedOriginatingFrame: 'runScenario',
    expectedPayloadCount: 1,
    applicableDimensions: ['D1', 'D2', 'D5', 'D9', 'D10', 'D11', 'D12']
  }
};

const validManifest = {
  nodeImage: 'node:22.14.0-bookworm-slim',
  nodeImageDigest: 'sha256:1234567890abcdef',
  sentry: {
    node: '10.56.0',
    nextjs: '10.56.0'
  },
  errorcore: {
    version: preflight.CANDIDATE_VERSION
  },
  targets: [
    { id: 'express', repo: 'gothinkster/node-express-realworld-example-app', pin: '30b68e1e881462b2f4164ea09ab4c4f5699c7b0b' },
    { id: 'fastify', repo: 'fastify/demo', pin: '5fa922df34d0ace9f8a63279bfd72ea06cf358da' },
    { id: 'koa', repo: 'eflem00/koa-boilerplate', pin: '98265346877a30f3595baf6f574726078b2b6c54' },
    { id: 'hapi', repo: 'agendor/sample-hapi-rest-api', pin: '4706ead645949fb4e32c62f2582bfd4c1c7659a1' },
    { id: 'hono', repo: 'honojs/examples', pin: '3b0b62875a0e1265763fea1c6388866d5697ef81' },
    { id: 'nextjs', repo: 'vercel/next.js', pin: 'fb5a153bf0389719139d9e820afd170191b026ae', tag: 'v15.3.4' }
  ],
  scenarios: [
    { id: 'S1', frozen: true, expected: expectedByScenario.S1 },
    { id: 'S2', frozen: true, expected: expectedByScenario.S2 },
    { id: 'S3', frozen: true, expected: expectedByScenario.S3 },
    { id: 'S4', frozen: true, expected: expectedByScenario.S4 },
    { id: 'S5', frozen: true, expected: expectedByScenario.S5 },
    { id: 'S6', frozen: true, expected: expectedByScenario.S6 },
    { id: 'S7', frozen: true, expected: expectedByScenario.S7 },
    { id: 'S8', frozen: true, expected: expectedByScenario.S8 },
    { id: 'S9', frozen: true, expected: expectedByScenario.S9 }
  ]
};

describe('benchmark manifest validation', () => {
  it('accepts the frozen app and scenario matrix', () => {
    assert.deepEqual(preflight.validateBenchmarkManifest(validManifest), []);
  });

  it('derives the required candidate version from the root package', () => {
    const manifest = {
      ...validManifest,
      errorcore: { version: `${preflight.CANDIDATE_VERSION}-drift` }
    };

    assert.deepEqual(preflight.validateBenchmarkManifest(manifest), [
      `errorcore version must match root package ${preflight.CANDIDATE_VERSION}`
    ]);
  });

  it('rejects missing image digest and unfrozen scenarios', () => {
    const manifest = {
      ...validManifest,
      nodeImageDigest: '',
      scenarios: validManifest.scenarios.map((scenario) =>
        scenario.id === 'S7' ? { ...scenario, frozen: false } : scenario
      )
    };

    assert.deepEqual(preflight.validateBenchmarkManifest(manifest), [
      'nodeImageDigest is required',
      'scenario S7 must be frozen before scoring'
    ]);
  });

  it('rejects scenarios missing expected ground truth', () => {
    const manifest = {
      ...validManifest,
      scenarios: validManifest.scenarios.map((scenario) =>
        scenario.id === 'S1' ? { id: 'S1', frozen: true } : scenario
      )
    };

    assert.deepEqual(preflight.validateBenchmarkManifest(manifest), [
      'scenario S1 expected ground truth is missing'
    ]);
  });
});

describe('preflight facts validation', () => {
  it('rejects Docker and Compose command failures', () => {
    assert.equal(typeof preflight.validatePreflightFacts, 'function');
    const errors = preflight.validatePreflightFacts({
      packageName: 'errorcore',
      packageVersion: preflight.CANDIDATE_VERSION,
      docker: 'ERROR: spawn docker ENOENT',
      compose: 'ERROR: docker compose failed',
      sentryNodeDependency: '10.56.0',
      sentryNextDependency: '10.56.0',
      sentryNodeIntegrity: 'sha512-ok',
      packageIntegrity: { before: 'sha256-a', after: 'sha256-a' }
    }, {
      errorcore: { version: preflight.CANDIDATE_VERSION },
      sentry: { node: '10.56.0', nextjs: '10.56.0', npmIntegrity: 'sha512-ok' }
    });

    assert.deepEqual(errors, [
      'docker --version failed: ERROR: spawn docker ENOENT',
      'docker compose version failed: ERROR: docker compose failed'
    ]);
  });

  it('rejects alternate OSS dependency and lockfile drift when BugSnag is declared', () => {
    const errors = preflight.validatePreflightFacts({
      packageName: 'errorcore',
      packageVersion: preflight.CANDIDATE_VERSION,
      docker: 'Docker version 28.5.2',
      compose: 'Docker Compose version v2.40.3',
      sentryNodeDependency: '10.56.0',
      sentryNextDependency: '10.56.0',
      sentryNodeIntegrity: 'sha512-sentry-ok',
      bugsnagJsDependency: '8.9.1',
      bugsnagJsIntegrity: 'sha512-wrong',
      packageIntegrity: { before: 'sha256-a', after: 'sha256-a' }
    }, {
      errorcore: { version: preflight.CANDIDATE_VERSION },
      sentry: { node: '10.56.0', nextjs: '10.56.0', npmIntegrity: 'sha512-sentry-ok' },
      bugsnag: { js: '8.9.0', npmIntegrity: 'sha512-bugsnag-ok' }
    });

    assert.deepEqual(errors, [
      '@bugsnag/js package dependency drifted from manifest',
      '@bugsnag/js package-lock integrity drifted from manifest'
    ]);
  });

  it('does not require BugSnag facts when the manifest has no alternate OSS block', () => {
    const errors = preflight.validatePreflightFacts({
      packageName: 'errorcore',
      packageVersion: preflight.CANDIDATE_VERSION,
      docker: 'Docker version 28.5.2',
      compose: 'Docker Compose version v2.40.3',
      sentryNodeDependency: '10.56.0',
      sentryNextDependency: '10.56.0',
      sentryNodeIntegrity: 'sha512-sentry-ok',
      packageIntegrity: { before: 'sha256-a', after: 'sha256-a' }
    }, {
      errorcore: { version: preflight.CANDIDATE_VERSION },
      sentry: { node: '10.56.0', nextjs: '10.56.0', npmIntegrity: 'sha512-sentry-ok' }
    });

    assert.deepEqual(errors, []);
  });

  it('computes stable package integrity over package source files', async () => {
    assert.equal(typeof preflight.computePackageIntegrity, 'function');
    const first = await preflight.computePackageIntegrity();
    const second = await preflight.computePackageIntegrity();

    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first, second);
  });

  it('records only a canonical candidate tarball SHA-256 when provided', () => {
    const facts = {
      packageName: 'errorcore',
      packageVersion: preflight.CANDIDATE_VERSION,
      candidateSha256: 'sha256:not-a-release-hash',
      docker: 'Docker version 28.5.2',
      compose: 'Docker Compose version v2.40.3',
      sentryNodeDependency: '10.56.0',
      sentryNextDependency: '10.56.0',
      sentryNodeIntegrity: 'sha512-sentry-ok',
      packageIntegrity: { before: 'sha256-a', after: 'sha256-a' }
    };
    const manifest = {
      errorcore: { version: preflight.CANDIDATE_VERSION },
      sentry: { node: '10.56.0', nextjs: '10.56.0', npmIntegrity: 'sha512-sentry-ok' }
    };

    assert.deepEqual(preflight.validatePreflightFacts(facts, manifest), [
      'BENCH_CANDIDATE_SHA256 must be sha256 followed by exactly 64 hexadecimal characters'
    ]);

    facts.candidateSha256 = `sha256:${'a'.repeat(64)}`;
    assert.deepEqual(preflight.validatePreflightFacts(facts, manifest), []);
  });

  it('rejects diagnostic overrides from full scoring runs', () => {
    const facts = {
      packageName: 'errorcore',
      packageVersion: preflight.CANDIDATE_VERSION,
      diagnosticOverrides: { middleware: 'off', locals: 'off' },
      docker: 'Docker version 28.5.2',
      compose: 'Docker Compose version v2.40.3',
      sentryNodeDependency: '10.56.0',
      sentryNextDependency: '10.56.0',
      sentryNodeIntegrity: 'sha512-sentry-ok',
      packageIntegrity: { before: 'sha256-a', after: 'sha256-a' }
    };
    const manifest = {
      errorcore: { version: preflight.CANDIDATE_VERSION },
      sentry: { node: '10.56.0', nextjs: '10.56.0', npmIntegrity: 'sha512-sentry-ok' }
    };

    assert.deepEqual(preflight.validatePreflightFacts(facts, manifest), [
      'BENCH_ERRORCORE_MIDDLEWARE is diagnostic-only and cannot be used for run-all scoring; use harness/run-perf-only.mjs',
      'BENCH_ERRORCORE_LOCALS is diagnostic-only and cannot be used for run-all scoring; use harness/run-perf-only.mjs'
    ]);
  });

  it('uses cached host Docker and Compose versions when running inside a container without Docker CLI', () => {
    assert.equal(typeof preflight.applyHostToolCache, 'function');
    const facts = preflight.applyHostToolCache({
      docker: 'ERROR: spawn docker ENOENT',
      compose: 'ERROR: spawn docker ENOENT'
    }, {
      facts: {
        docker: 'Docker version 28.5.2, build ecc6942',
        compose: 'Docker Compose version v2.40.3-desktop.1'
      }
    });

    assert.equal(facts.docker, 'Docker version 28.5.2, build ecc6942');
    assert.equal(facts.compose, 'Docker Compose version v2.40.3-desktop.1');
  });
});
