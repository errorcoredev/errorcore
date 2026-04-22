import { describe, expect, it } from 'vitest';

import { HealthMetrics } from '../../src/health/health-metrics';

describe('HealthMetrics', () => {
  describe('initial state', () => {
    it('reports zero counters on a fresh instance', () => {
      const m = new HealthMetrics();

      expect(m.getCaptured()).toBe(0);
      expect(m.getTransportFailures()).toBe(0);
      expect(m.getDroppedBreakdown()).toEqual({
        rateLimited: 0,
        captureFailed: 0,
        deadLetterWriteFailed: 0
      });
    });

    it('reports zero percentiles when no latency samples are recorded', () => {
      const m = new HealthMetrics();

      expect(m.getLatencyPercentile(0.5)).toBe(0);
      expect(m.getLatencyPercentile(0.99)).toBe(0);
    });

    it('reports null last-failure on a fresh instance', () => {
      const m = new HealthMetrics();

      expect(m.getLastFailure()).toEqual({ reason: null, at: null });
    });
  });

  describe('counters', () => {
    it('recordCaptured monotonically increments', () => {
      const m = new HealthMetrics();

      m.recordCaptured();
      m.recordCaptured();
      m.recordCaptured();

      expect(m.getCaptured()).toBe(3);
    });

    it('records each dropped bucket independently', () => {
      const m = new HealthMetrics();

      m.recordDroppedRateLimited();
      m.recordDroppedRateLimited();
      m.recordDroppedCaptureFailed();
      m.recordDroppedDlqWriteFailed();
      m.recordDroppedDlqWriteFailed();
      m.recordDroppedDlqWriteFailed();

      expect(m.getDroppedBreakdown()).toEqual({
        rateLimited: 2,
        captureFailed: 1,
        deadLetterWriteFailed: 3
      });
    });

    it('recordTransportFailure increments the failure counter and captures the last-failure sample', () => {
      const m = new HealthMetrics();

      m.recordTransportFailure('connection refused', 1000);
      m.recordTransportFailure('HTTP 503', 2000);

      expect(m.getTransportFailures()).toBe(2);
      expect(m.getLastFailure()).toEqual({ reason: 'HTTP 503', at: 2000 });
    });

    it('truncates the recorded failure reason at 200 characters', () => {
      const m = new HealthMetrics();
      const longReason = 'x'.repeat(500);

      m.recordTransportFailure(longReason, 10);

      expect(m.getLastFailure().reason?.length).toBe(200);
    });
  });

  describe('latency histogram', () => {
    it('reports P50/P99 over recorded samples using nearest-rank percentile', () => {
      const m = new HealthMetrics();

      for (let i = 1; i <= 100; i += 1) {
        m.recordFlushLatency(i);
      }

      // Nearest-rank: samples[floor(p * (n - 1))] over sorted [1..100]
      //   p=0.5  -> floor(0.5  * 99) = 49 -> value 50
      //   p=0.99 -> floor(0.99 * 99) = 98 -> value 99
      expect(m.getLatencyPercentile(0.5)).toBe(50);
      expect(m.getLatencyPercentile(0.99)).toBe(99);
    });

    it('returns a single recorded sample for any percentile', () => {
      const m = new HealthMetrics();

      m.recordFlushLatency(42);

      expect(m.getLatencyPercentile(0.5)).toBe(42);
      expect(m.getLatencyPercentile(0.99)).toBe(42);
    });

    it('wraps the ring buffer at capacity (512) so oldest samples are evicted', () => {
      const m = new HealthMetrics();

      // Fill with 512 large samples, then push 512 tiny samples. After
      // wrap, every large sample should be gone and percentiles should
      // reflect only the tiny ones.
      for (let i = 0; i < 512; i += 1) {
        m.recordFlushLatency(1_000_000);
      }
      for (let i = 0; i < 512; i += 1) {
        m.recordFlushLatency(5);
      }

      expect(m.getLatencyPercentile(0.5)).toBe(5);
      expect(m.getLatencyPercentile(0.99)).toBe(5);
    });
  });

  describe('monotonicity', () => {
    it('never decreases captured/dropped/transportFailures after repeated reads', () => {
      const m = new HealthMetrics();

      m.recordCaptured();
      m.recordDroppedRateLimited();
      m.recordTransportFailure('boom', 1);

      const first = {
        captured: m.getCaptured(),
        breakdown: m.getDroppedBreakdown(),
        transportFailures: m.getTransportFailures()
      };
      const second = {
        captured: m.getCaptured(),
        breakdown: m.getDroppedBreakdown(),
        transportFailures: m.getTransportFailures()
      };

      expect(second.captured).toBe(first.captured);
      expect(second.breakdown).toEqual(first.breakdown);
      expect(second.transportFailures).toBe(first.transportFailures);
    });
  });
});
