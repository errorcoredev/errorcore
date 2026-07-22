import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as perf from '../perf.mjs';

describe('performance aggregation', () => {
  it('computes aggregate throughput and latency stats across three repetitions', () => {
    assert.equal(typeof perf.aggregatePerfRepetitions, 'function');
    const repetitions = [
      { sdk: 'errorcore', endpoint: '/healthz', throughput: 100, p50LatencyMs: 1, p95LatencyMs: 4, p99LatencyMs: 9 },
      { sdk: 'errorcore', endpoint: '/healthz', throughput: 130, p50LatencyMs: 2, p95LatencyMs: 5, p99LatencyMs: 10 },
      { sdk: 'errorcore', endpoint: '/healthz', throughput: 160, p50LatencyMs: 3, p95LatencyMs: 6, p99LatencyMs: 11 }
    ];

    const aggregate = perf.aggregatePerfRepetitions(repetitions);

    assert.equal(aggregate.throughput.mean, 130);
    assert.equal(aggregate.throughput.min, 100);
    assert.equal(aggregate.throughput.max, 160);
    assert.equal(aggregate.throughput.stddev, Math.sqrt(600));
    assert.equal(aggregate.latency.p95.mean, 5);
    assert.equal(aggregate.latency.p99.max, 11);
  });

  it('quarantines no-op results that are more than 3x worse than baseline', () => {
    assert.equal(typeof perf.evaluatePerfSanity, 'function');
    const result = perf.evaluatePerfSanity({
      endpoint: '/healthz',
      baseline: { throughput: { mean: 1200 } },
      variant: { sdk: 'errorcore', throughput: { mean: 300 } }
    });

    assert.equal(result.quarantined, true);
    assert.match(result.reason, /more than 3x worse than baseline/);
  });

  it('fills p95 from autocannon p97_5 when autocannon does not emit p95', () => {
    assert.equal(typeof perf.extractAutocannonMetrics, 'function');
    const metrics = perf.extractAutocannonMetrics({
      requests: { average: 1000 },
      latency: { p50: 2, p97_5: 34, p99: 50 }
    });

    assert.equal(metrics.p95LatencyMs, 34);
    assert.equal(metrics.p95LatencySource, 'p97_5');
  });
});
