
import type { RateLimiterDropSummary } from '../types';

interface RateLimiterConfig {
  maxCaptures: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly maxCaptures: number;

  private readonly windowMs: number;

  private timestamps: number[] = [];

  private droppedCount = 0;

  private droppedSinceLastAcquire = 0;

  private firstDropTimestamp: number | null = null;

  private lastDropTimestamp: number | null = null;

  public constructor(config: RateLimiterConfig) {
    this.maxCaptures = config.maxCaptures ?? 10;
    this.windowMs = config.windowMs ?? 60000;
  }

  public tryAcquire(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);

    if (this.timestamps.length < this.maxCaptures) {
      this.timestamps.push(now);
      return true;
    }

    this.droppedCount += 1;
    this.droppedSinceLastAcquire += 1;
    if (this.firstDropTimestamp === null) {
      this.firstDropTimestamp = now;
    }
    this.lastDropTimestamp = now;
    return false;
  }

  public getAndResetDropSummary(): RateLimiterDropSummary | null {
    if (this.droppedSinceLastAcquire === 0) {
      return null;
    }

    const summary: RateLimiterDropSummary = {
      droppedCount: this.droppedSinceLastAcquire,
      firstDropMs: this.firstDropTimestamp!,
      lastDropMs: this.lastDropTimestamp!
    };

    this.droppedSinceLastAcquire = 0;
    this.firstDropTimestamp = null;
    this.lastDropTimestamp = null;

    return summary;
  }

  public getDroppedCount(): number {
    return this.droppedCount;
  }

  public reset(): void {
    this.timestamps = [];
    this.droppedCount = 0;
    this.droppedSinceLastAcquire = 0;
    this.firstDropTimestamp = null;
    this.lastDropTimestamp = null;
  }
}
