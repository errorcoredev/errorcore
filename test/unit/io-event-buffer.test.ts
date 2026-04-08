import { describe, expect, it } from 'vitest';

import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import type { IOEventSlot } from '../../src/types';

type PushableIOEvent = Omit<IOEventSlot, 'seq' | 'estimatedBytes'>;

function createEvent(overrides: Partial<PushableIOEvent> = {}): PushableIOEvent {
  return {
    phase: 'active',
    startTime: 1n,
    endTime: null,
    durationMs: null,
    type: 'http-server',
    direction: 'inbound',
    requestId: 'req-default',
    contextLost: false,
    target: 'service',
    method: 'GET',
    url: '/resource',
    statusCode: null,
    fd: null,
    requestHeaders: { host: 'localhost' },
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    ...overrides
  };
}

function applyBackfill(
  buffer: IOEventBuffer,
  slot: IOEventSlot,
  expectedSeq: number,
  requestBody: Buffer
): boolean {
  if (slot.seq !== expectedSeq) {
    return false;
  }

  const oldBytes = slot.estimatedBytes;

  slot.requestBody = requestBody;
  slot.phase = 'done';
  slot.requestBodyOriginalSize = requestBody.length;
  slot.estimatedBytes = 256 + requestBody.length + (slot.responseBody?.length ?? 0);
  buffer.updatePayloadBytes(oldBytes, slot.estimatedBytes);

  return true;
}

describe('IOEventBuffer', () => {
  it('pushes and reads back a single event with computed metadata', () => {
    const buffer = new IOEventBuffer({ capacity: 3, maxBytes: 4096 });
    const { slot, seq } = buffer.push(
      createEvent({
        requestId: 'req-1',
        requestBody: Buffer.from('abc')
      })
    );

    expect(seq).toBe(1);
    expect(slot.seq).toBe(1);
    expect(slot.estimatedBytes).toBe(259);
    expect(buffer.drain()).toEqual([slot]);
    expect(buffer.getStats()).toEqual({
      slotCount: 1,
      payloadBytes: 259,
      overflowCount: 0,
      capacity: 3,
      maxBytes: 4096
    });
  });

  it('overwrites the oldest event when capacity is exceeded', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1', url: '/1' }));
    buffer.push(createEvent({ requestId: 'req-2', url: '/2' }));
    buffer.push(createEvent({ requestId: 'req-3', url: '/3' }));

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual(['req-2', 'req-3']);
    expect(buffer.getOverflowCount()).toBe(1);
  });

  it('maintains chronological order after wrap-around', () => {
    const buffer = new IOEventBuffer({ capacity: 3, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));
    buffer.push(createEvent({ requestId: 'req-3' }));
    buffer.push(createEvent({ requestId: 'req-4' }));
    buffer.push(createEvent({ requestId: 'req-5' }));

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual([
      'req-3',
      'req-4',
      'req-5'
    ]);
  });

  it('evicts oldest slots to satisfy the byte budget', () => {
    const buffer = new IOEventBuffer({ capacity: 5, maxBytes: 700 });

    buffer.push(
      createEvent({ requestId: 'req-1', requestBody: Buffer.alloc(300, 1) })
    );
    buffer.push(
      createEvent({ requestId: 'req-2', requestBody: Buffer.alloc(300, 2) })
    );

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual(['req-2']);
    expect(buffer.getStats()).toEqual({
      slotCount: 1,
      payloadBytes: 556,
      overflowCount: 1,
      capacity: 5,
      maxBytes: 700
    });
  });

  it('keeps byte accounting accurate across pushes and overwrites', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1', requestBody: Buffer.alloc(10) }));
    buffer.push(createEvent({ requestId: 'req-2', responseBody: Buffer.alloc(20) }));
    buffer.push(createEvent({ requestId: 'req-3', requestBody: Buffer.alloc(5) }));

    const liveSlots = buffer.drain();
    const summedBytes = liveSlots.reduce((total, slot) => total + slot.estimatedBytes, 0);

    expect(buffer.getStats().payloadBytes).toBe(summedBytes);
    expect(liveSlots.map((slot) => slot.requestId)).toEqual(['req-2', 'req-3']);
  });

  it('filters by request id across interleaved requests', () => {
    const buffer = new IOEventBuffer({ capacity: 6, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-a', url: '/1' }));
    buffer.push(createEvent({ requestId: 'req-b', url: '/2' }));
    buffer.push(createEvent({ requestId: 'req-a', url: '/3' }));
    buffer.push(createEvent({ requestId: 'req-c', url: '/4' }));

    expect(buffer.filterByRequestId('req-a').map((slot) => slot.url)).toEqual([
      '/1',
      '/3'
    ]);
  });

  it('removes evicted request slots from the request-id index', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-a', url: '/1' }));
    buffer.push(createEvent({ requestId: 'req-b', url: '/2' }));
    buffer.push(createEvent({ requestId: 'req-c', url: '/3' }));

    expect(buffer.filterByRequestId('req-a')).toEqual([]);
    expect(buffer.filterByRequestId('req-b').map((slot) => slot.url)).toEqual(['/2']);
  });

  it('supports live body backfill and payload byte updates', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });
    const { slot, seq } = buffer.push(createEvent({ requestId: 'req-1' }));

    const applied = applyBackfill(buffer, slot, seq, Buffer.from('hello'));

    expect(applied).toBe(true);
    expect(slot.phase).toBe('done');
    expect(slot.requestBody?.toString()).toBe('hello');
    expect(slot.estimatedBytes).toBe(261);
    expect(buffer.getStats().payloadBytes).toBe(261);
  });

  it('silently discards recycled-slot backfill when the seq mismatches', () => {
    const buffer = new IOEventBuffer({ capacity: 1, maxBytes: 4096 });

    const first = buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));

    const currentSlot = buffer.drain()[0];
    const applied = applyBackfill(
      buffer,
      currentSlot,
      first.seq,
      Buffer.from('late-body')
    );

    expect(currentSlot.seq).not.toBe(first.seq);
    expect(applied).toBe(false);
    expect(currentSlot.requestBody).toBeNull();
    expect(buffer.getStats().payloadBytes).toBe(256);
  });

  it('clears all live slots and resets byte totals without resetting overflow count', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));
    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));
    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));

    expect(buffer.getOverflowCount()).toBe(1);

    buffer.clear();

    expect(buffer.drain()).toEqual([]);
    expect(buffer.getStats()).toEqual({
      slotCount: 0,
      payloadBytes: 0,
      overflowCount: 1,
      capacity: 2,
      maxBytes: 4096
    });
  });

  it('returns all live slots when getRecent exceeds the slot count', () => {
    const buffer = new IOEventBuffer({ capacity: 5, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));

    expect(buffer.getRecent(10).map((slot) => slot.requestId)).toEqual([
      'req-1',
      'req-2'
    ]);
  });

  it('does not infinite-loop when readHead lands on a null hole during byte eviction', () => {
    const buffer = new IOEventBuffer({ capacity: 3, maxBytes: 512 });
    const internal = buffer as unknown as {
      slots: (IOEventSlot | null)[];
      readHead: number;
      writeHead: number;
      slotCount: number;
      payloadBytes: number;
      nextSeq: number;
    };

    internal.slots[2] = {
      ...createEvent({ requestId: 'req-live' }),
      seq: 1,
      estimatedBytes: 256
    };
    internal.readHead = 1;
    internal.writeHead = 3;
    internal.slotCount = 1;
    internal.payloadBytes = 256;
    internal.nextSeq = 2;

    const { seq } = buffer.push(
      createEvent({
        requestId: 'req-next',
        requestBody: Buffer.alloc(300, 1)
      })
    );

    expect(seq).toBe(2);
    expect(buffer.drain().map((slot) => slot.requestId)).toEqual(['req-next']);
    expect(buffer.getStats()).toEqual({
      slotCount: 1,
      payloadBytes: 556,
      overflowCount: 1,
      capacity: 3,
      maxBytes: 512
    });
  });

  it('getRecentWithContext returns ambient metadata with seq gaps and distinct request ids', () => {
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });

    buffer.push(createEvent({ requestId: 'req-a', target: 'svc-1' }));
    buffer.push(createEvent({ requestId: 'req-b', target: 'svc-2' }));
    buffer.push(createEvent({ requestId: null, target: 'svc-3' }));
    buffer.push(createEvent({ requestId: 'req-a', target: 'svc-4' }));

    const { events, context } = buffer.getRecentWithContext(10);

    expect(events).toHaveLength(4);
    expect(context.totalBufferEventsAtCapture).toBe(4);
    expect(context.retrievedCount).toBe(4);
    expect(context.seqRange).toEqual({ min: 1, max: 4 });
    expect(context.seqGaps).toBe(0);
    expect(context.distinctRequestIds.sort()).toEqual(['req-a', 'req-b']);
  });

  it('getRecentWithContext detects seq gaps from evictions', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 100000 });

    buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));
    buffer.push(createEvent({ requestId: 'req-3' }));

    const { events, context } = buffer.getRecentWithContext(10);

    expect(events).toHaveLength(2);
    expect(context.seqRange).toEqual({ min: 2, max: 3 });
    expect(context.seqGaps).toBe(0);
    expect(context.totalBufferEventsAtCapture).toBe(2);
  });

  it('getRecentWithContext returns null seqRange for empty buffer', () => {
    const buffer = new IOEventBuffer({ capacity: 5, maxBytes: 100000 });
    const { events, context } = buffer.getRecentWithContext(5);

    expect(events).toEqual([]);
    expect(context.seqRange).toBeNull();
    expect(context.seqGaps).toBe(0);
    expect(context.retrievedCount).toBe(0);
  });

  it('records eviction metadata in the eviction log', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 100000 });

    buffer.push(createEvent({ requestId: 'req-1', type: 'http-client', direction: 'outbound', target: 'api.example.com' }));
    buffer.push(createEvent({ requestId: 'req-2' }));
    buffer.push(createEvent({ requestId: 'req-3' }));

    const log = buffer.getEvictionLog();

    expect(log).toHaveLength(1);
    expect(log[0].seq).toBe(1);
    expect(log[0].type).toBe('http-client');
    expect(log[0].direction).toBe('outbound');
    expect(log[0].target).toBe('api.example.com');
    expect(log[0].requestId).toBe('req-1');
    expect(typeof log[0].evictedAt).toBe('bigint');
  });

  it('caps the eviction log at 100 entries using a ring', () => {
    const buffer = new IOEventBuffer({ capacity: 1, maxBytes: 100000 });

    for (let i = 0; i < 150; i += 1) {
      buffer.push(createEvent({ requestId: `req-${i}` }));
    }

    const log = buffer.getEvictionLog();

    expect(log).toHaveLength(100);
    expect(log[0].seq).toBe(50);
    expect(log[99].seq).toBe(149);
  });

  it('stays consistent under a rapid push loop', () => {
    const buffer = new IOEventBuffer({ capacity: 100, maxBytes: 1000000 });

    for (let index = 0; index < 10000; index += 1) {
      buffer.push(createEvent({ requestId: `req-${index}` }));
    }

    const liveSlots = buffer.drain();
    const stats = buffer.getStats();
    const summedBytes = liveSlots.reduce((total, slot) => total + slot.estimatedBytes, 0);

    expect(liveSlots).toHaveLength(100);
    expect(liveSlots[0]?.seq).toBe(9901);
    expect(liveSlots[99]?.seq).toBe(10000);
    expect(stats.slotCount).toBe(100);
    expect(stats.overflowCount).toBe(9900);
    expect(stats.payloadBytes).toBe(summedBytes);
  });
});
