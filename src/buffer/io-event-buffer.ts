
import type { EventClock } from '../context/event-clock';
import type { AmbientEventContext, EvictionRecord, IOEventSlot } from '../types';

// Accounts for serialized JSON field names and structure, not the in-memory null slot size.
const METADATA_OVERHEAD = 256;

type PushableIOEvent = Omit<IOEventSlot, 'seq' | 'hrtimeNs' | 'estimatedBytes'>;

const EMPTY_REQUEST_SLOTS: IOEventSlot[] = [];

interface IOEventBufferOptions {
  capacity: number;
  maxBytes: number;
  eventClock: EventClock;
}

interface IOEventBufferStats {
  slotCount: number;
  payloadBytes: number;
  overflowCount: number;
  capacity: number;
  maxBytes: number;
}

function estimateBytes(event: {
  requestBody: Buffer | null;
  responseBody: Buffer | null;
}): number {
  return (
    METADATA_OVERHEAD +
    (event.requestBody?.length ?? 0) +
    (event.responseBody?.length ?? 0)
  );
}

export class IOEventBuffer {
  private readonly slots: (IOEventSlot | null)[];

  private readonly capacity: number;

  private readonly maxBytes: number;

  private writeHead = 0;

  private readHead = 0;

  private slotCount = 0;

  private payloadBytes = 0;

  private overflowCount = 0;

  private readonly eventClock: EventClock;

  private requestIdIndex: Map<string, IOEventSlot[]> | null = null;

  private static readonly EVICTION_LOG_CAPACITY = 100;

  private readonly evictionSlots: (EvictionRecord | null)[];

  private evictionWriteHead = 0;

  private evictionCount = 0;

  public constructor(options: IOEventBufferOptions) {
    this.capacity = options.capacity;
    this.maxBytes = options.maxBytes;
    this.eventClock = options.eventClock;
    this.slots = new Array<IOEventSlot | null>(this.capacity).fill(null);
    this.evictionSlots = new Array<EvictionRecord | null>(
      IOEventBuffer.EVICTION_LOG_CAPACITY
    ).fill(null);
  }

  public push(event: PushableIOEvent): { slot: IOEventSlot; seq: number } {
    this.requestIdIndex = null;
    const seq = this.eventClock.tick();
    const estimatedBytes = estimateBytes(event);
    const index = this.writeHead % this.capacity;
    const overwrittenSlot = this.slots[index];

    if (overwrittenSlot !== null) {
      this.evictIndex(index);
    }

    while (this.payloadBytes + estimatedBytes > this.maxBytes && this.slotCount > 0) {
      this.evictOldest();
    }

    const slot = {} as IOEventSlot;
    this.assignSlot(slot, event, seq, estimatedBytes);

    this.slots[index] = slot;
    this.payloadBytes += estimatedBytes;
    this.slotCount += 1;
    this.writeHead += 1;

    return { slot, seq };
  }

  public updatePayloadBytes(oldBytes: number, newBytes: number): void {
    this.payloadBytes += newBytes - oldBytes;
  }

  public filterByRequestId(requestId: string): IOEventSlot[] {
    if (this.requestIdIndex === null) {
      this.requestIdIndex = new Map<string, IOEventSlot[]>();

      for (let cursor = this.readHead; cursor < this.writeHead; cursor += 1) {
        const slot = this.slots[cursor % this.capacity];
        if (slot === null || slot.requestId === null) {
          continue;
        }

        const indexedSlots = this.requestIdIndex.get(slot.requestId);
        if (indexedSlots === undefined) {
          this.requestIdIndex.set(slot.requestId, [slot]);
        } else {
          indexedSlots.push(slot);
        }
      }
    }

    return this.requestIdIndex.get(requestId) ?? EMPTY_REQUEST_SLOTS;
  }

  public getRecent(n: number): IOEventSlot[] {
    if (n <= 0 || this.slotCount === 0) {
      return [];
    }

    const recent: IOEventSlot[] = [];

    for (let cursor = this.writeHead - 1; cursor >= this.readHead; cursor -= 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        recent.push(slot);
      }

      if (recent.length >= n) {
        break;
      }
    }

    return recent.reverse();
  }

  public getRecentWithContext(
    n: number
  ): { events: IOEventSlot[]; context: AmbientEventContext } {
    if (n <= 0 || this.slotCount === 0) {
      return {
        events: [],
        context: {
          totalBufferEventsAtCapture: this.slotCount,
          seqRange: null,
          seqGaps: 0,
          distinctRequestIds: [],
          retrievedCount: 0
        }
      };
    }

    const recent: IOEventSlot[] = [];
    const requestIdSet = new Set<string>();

    for (let cursor = this.writeHead - 1; cursor >= this.readHead; cursor -= 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        recent.push(slot);
        if (slot.requestId !== null) {
          requestIdSet.add(slot.requestId);
        }
      }

      if (recent.length >= n) {
        break;
      }
    }

    recent.reverse();

    let seqRange: { min: number; max: number } | null = null;
    let seqGaps = 0;

    if (recent.length > 0) {
      const minSeq = recent[0].seq;
      const maxSeq = recent[recent.length - 1].seq;
      seqRange = { min: minSeq, max: maxSeq };
      seqGaps = maxSeq - minSeq + 1 - recent.length;
    }

    return {
      events: recent,
      context: {
        totalBufferEventsAtCapture: this.slotCount,
        seqRange,
        seqGaps,
        distinctRequestIds: [...requestIdSet],
        retrievedCount: recent.length
      }
    };
  }

  public getEvictionLog(): EvictionRecord[] {
    const records: EvictionRecord[] = [];
    const cap = IOEventBuffer.EVICTION_LOG_CAPACITY;
    const count = Math.min(this.evictionCount, cap);
    const start =
      this.evictionCount <= cap ? 0 : this.evictionWriteHead;

    for (let i = 0; i < count; i += 1) {
      const entry = this.evictionSlots[(start + i) % cap];
      if (entry !== null) {
        records.push(entry);
      }
    }

    return records;
  }

  public drain(): IOEventSlot[] {
    return this.collectChronological();
  }

  public clear(): void {
    this.requestIdIndex = null;
    for (let cursor = this.readHead; cursor < this.writeHead; cursor += 1) {
      const index = cursor % this.capacity;
      const slot = this.slots[index];

      if (slot !== null) {
        this.slots[index] = null;
      }
    }

    this.payloadBytes = 0;
    this.slotCount = 0;
    this.readHead = this.writeHead;
  }

  public getOverflowCount(): number {
    return this.overflowCount;
  }

  public getStats(): IOEventBufferStats {
    return {
      slotCount: this.slotCount,
      payloadBytes: this.payloadBytes,
      overflowCount: this.overflowCount,
      capacity: this.capacity,
      maxBytes: this.maxBytes
    };
  }

  private collectChronological(): IOEventSlot[] {
    const liveSlots: IOEventSlot[] = [];

    for (let cursor = this.readHead; cursor < this.writeHead; cursor += 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        liveSlots.push(slot);
      }
    }

    return liveSlots;
  }

  private evictOldest(): void {
    while (this.readHead < this.writeHead) {
      const index = this.readHead % this.capacity;
      if (this.slots[index] !== null) {
        this.evictIndex(index);
        return;
      }
      this.readHead += 1;
    }
  }

  private evictIndex(index: number): void {
    const slot = this.slots[index];
    if (slot === null) {
      return;
    }

    const cap = IOEventBuffer.EVICTION_LOG_CAPACITY;
    const logIndex = this.evictionWriteHead % cap;
    this.evictionSlots[logIndex] = {
      seq: slot.seq,
      type: slot.type,
      direction: slot.direction,
      target: slot.target,
      requestId: slot.requestId,
      startTime: slot.startTime,
      evictedAt: process.hrtime.bigint()
    };
    this.evictionWriteHead += 1;
    this.evictionCount += 1;

    this.slots[index] = null;
    this.payloadBytes -= slot.estimatedBytes;
    this.slotCount -= 1;
    this.overflowCount += 1;

    if (this.slotCount === 0) {
      this.readHead = this.writeHead;
      return;
    }

    if (index === this.readHead % this.capacity) {
      this.readHead += 1;
    }
  }

  private assignSlot(
    slot: IOEventSlot,
    event: PushableIOEvent,
    seq: number,
    estimatedBytes: number
  ): void {
    slot.seq = seq;
    slot.hrtimeNs = process.hrtime.bigint();
    slot.phase = event.phase;
    slot.startTime = event.startTime;
    slot.endTime = event.endTime;
    slot.durationMs = event.durationMs;
    slot.type = event.type;
    slot.direction = event.direction;
    slot.requestId = event.requestId;
    slot.contextLost = event.contextLost;
    slot.target = event.target;
    slot.method = event.method;
    slot.url = event.url;
    slot.statusCode = event.statusCode;
    slot.fd = event.fd;
    slot.requestHeaders = event.requestHeaders;
    slot.responseHeaders = event.responseHeaders;
    slot.requestBody = event.requestBody;
    slot.responseBody = event.responseBody;
    slot.requestBodyDigest = event.requestBodyDigest ?? null;
    slot.responseBodyDigest = event.responseBodyDigest ?? null;
    slot.requestBodyTruncated = event.requestBodyTruncated;
    slot.responseBodyTruncated = event.responseBodyTruncated;
    slot.requestBodyOriginalSize = event.requestBodyOriginalSize;
    slot.responseBodyOriginalSize = event.responseBodyOriginalSize;
    slot.error = event.error;
    slot.aborted = event.aborted;
    slot.dbMeta = event.dbMeta;
    slot.estimatedBytes = estimatedBytes;
  }
}
