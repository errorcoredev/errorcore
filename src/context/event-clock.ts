/**
 * @module 19-event-clock
 * @spec spec/19-event-clock.md
 * @dependencies (none)
 *
 * Process-wide Lamport-style monotonic counter. Owned by the SDK composition
 * root and injected into every site that stamps an event. Replaces the private
 * nextSeq counter on IOEventBuffer.
 */

export class EventClock {
  private value = 0;

  public tick(): number {
    if (this.value >= Number.MAX_SAFE_INTEGER) {
      // Defensive ceiling. At 1M ticks/sec a fresh clock would take 285 years
      // to reach this; the only realistic path here is a hostile peer feeding
      // us a near-MAX value via merge(). Pin and stop counting up.
      this.value = Number.MAX_SAFE_INTEGER;
      return this.value;
    }
    this.value += 1;
    return this.value;
  }

  public merge(received: unknown): number {
    if (
      typeof received === 'number' &&
      Number.isSafeInteger(received) &&
      received > 0 &&
      received > this.value
    ) {
      this.value = received;
    }
    return this.tick();
  }

  public current(): number {
    return this.value;
  }
}
