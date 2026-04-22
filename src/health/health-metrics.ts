/**
 * Module: 17-health-metrics
 *
 * HealthMetrics aggregates the SDK's self-observability state. Counters
 * are monotonic since construction and never reset on read — operators
 * scrape snapshots and compute rates by differencing (Prometheus-style).
 *
 * Dependencies: none. Pure in-memory state, no I/O, no timers.
 */

export interface DroppedBreakdown {
  rateLimited: number;
  captureFailed: number;
  deadLetterWriteFailed: number;
}

export interface LastFailureSample {
  reason: string | null;
  at: number | null;
}

const LATENCY_CAPACITY = 512;
const FAILURE_REASON_MAX_LENGTH = 200;

export class HealthMetrics {
  private captured = 0;

  private droppedRateLimited = 0;

  private droppedCaptureFailed = 0;

  private droppedDlqWriteFailed = 0;

  private transportFailures = 0;

  private readonly latencySamples: number[] = [];

  private latencyWriteIdx = 0;

  private lastFailureReason: string | null = null;

  private lastFailureAt: number | null = null;

  public recordCaptured(): void {
    this.captured += 1;
  }

  public recordDroppedRateLimited(): void {
    this.droppedRateLimited += 1;
  }

  public recordDroppedCaptureFailed(): void {
    this.droppedCaptureFailed += 1;
  }

  public recordDroppedDlqWriteFailed(): void {
    this.droppedDlqWriteFailed += 1;
  }

  public recordTransportFailure(reason: string, atUnixMs: number): void {
    this.transportFailures += 1;
    this.lastFailureReason = reason.slice(0, FAILURE_REASON_MAX_LENGTH);
    this.lastFailureAt = atUnixMs;
  }

  public recordFlushLatency(ms: number): void {
    if (this.latencySamples.length < LATENCY_CAPACITY) {
      this.latencySamples.push(ms);
      this.latencyWriteIdx = this.latencySamples.length % LATENCY_CAPACITY;
      return;
    }

    this.latencySamples[this.latencyWriteIdx] = ms;
    this.latencyWriteIdx = (this.latencyWriteIdx + 1) % LATENCY_CAPACITY;
  }

  public getCaptured(): number {
    return this.captured;
  }

  public getDroppedBreakdown(): DroppedBreakdown {
    return {
      rateLimited: this.droppedRateLimited,
      captureFailed: this.droppedCaptureFailed,
      deadLetterWriteFailed: this.droppedDlqWriteFailed
    };
  }

  public getTransportFailures(): number {
    return this.transportFailures;
  }

  public getLatencyPercentile(p: number): number {
    const n = this.latencySamples.length;

    if (n === 0) {
      return 0;
    }

    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const idx = Math.floor(p * (n - 1));
    return sorted[idx] ?? 0;
  }

  public getLastFailure(): LastFailureSample {
    return { reason: this.lastFailureReason, at: this.lastFailureAt };
  }
}
