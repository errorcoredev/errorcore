/**
 * Module: 17-health-metrics
 *
 * Public self-observability snapshot returned by SDKInstance.getHealth()
 * and the module-level getHealth() facade.
 *
 * Semantics:
 *   - Counters (captured, dropped, droppedBreakdown.*, transportFailures)
 *     are monotonic since init() and reset only on process restart.
 *     Operators scrape snapshots and compute rates by differencing,
 *     matching the Prometheus counter convention.
 *   - Gauges (transportQueueDepth, deadLetterDepth, ioBufferDepth) are
 *     point-in-time samples evaluated at call time.
 *   - Latency percentiles are computed over the last 512 completed
 *     transport.send() round-trips. Zero until the first send completes.
 *   - lastFailureReason / lastFailureAt reflect the most recent transport
 *     rejection, or both null until the first failure.
 *
 * Invariant: dropped === droppedBreakdown.rateLimited +
 *            droppedBreakdown.captureFailed +
 *            droppedBreakdown.deadLetterWriteFailed.
 */
export interface HealthSnapshot {
  captured: number;
  dropped: number;
  droppedBreakdown: {
    rateLimited: number;
    captureFailed: number;
    deadLetterWriteFailed: number;
  };
  transportFailures: number;

  transportQueueDepth: number;
  deadLetterDepth: number;
  ioBufferDepth: number;

  flushLatencyP50: number;
  flushLatencyP99: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
}
