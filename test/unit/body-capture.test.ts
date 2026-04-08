import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { Scrubber } from '../../src/pii/scrubber';
import { BodyCapture } from '../../src/recording/body-capture';
import type { IOEventSlot, RequestContext } from '../../src/types';
import { resolveTestConfig } from '../helpers/test-config';

class MockIncomingMessage extends EventEmitter {}

class MockServerResponse extends EventEmitter {
  private readonly headers: Record<string, string> = {};

  public setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  public write(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    return true;
  }

  public end(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): this {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    this.emit('finish');
    return this;
  }
}

function createSlot(overrides: Partial<IOEventSlot> = {}): IOEventSlot {
  return {
    seq: 1,
    phase: 'active',
    startTime: 1n,
    endTime: null,
    durationMs: null,
    type: 'http-server',
    direction: 'inbound',
    requestId: 'req-1',
    contextLost: false,
    target: 'service',
    method: 'GET',
    url: '/resource',
    statusCode: null,
    fd: null,
    requestHeaders: null,
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    estimatedBytes: 256,
    ...overrides
  };
}

function createBodyCapture(input: {
  maxPayloadSize?: number;
  captureRequestBodies?: boolean;
  captureResponseBodies?: boolean;
  captureBodyDigest?: boolean;
  bodyCaptureContentTypes?: string[];
  scrubber?: InstanceType<typeof Scrubber>;
} = {}): BodyCapture {
  return new BodyCapture({
    maxPayloadSize: input.maxPayloadSize ?? 32,
    captureRequestBodies: input.captureRequestBodies ?? true,
    captureResponseBodies: input.captureResponseBodies ?? true,
    ...(input.captureBodyDigest === undefined
      ? {}
      : { captureBodyDigest: input.captureBodyDigest }),
    ...(input.bodyCaptureContentTypes === undefined
      ? {}
      : { bodyCaptureContentTypes: input.bodyCaptureContentTypes }),
    ...(input.scrubber === undefined ? {} : { scrubber: input.scrubber })
  });
}

describe('BodyCapture', () => {
  it('accumulates inbound request chunks and preserves app data listeners', () => {
    const capture = createBodyCapture();
    const req = new MockIncomingMessage();
    const slot = createSlot();
    const onBytesChanged = vi.fn();
    const seenByApp: Buffer[] = [];

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    req.on('data', (chunk) => {
      seenByApp.push(Buffer.from(chunk as Buffer));
    });

    req.emit('data', Buffer.from('he'));
    req.emit('data', Buffer.from('llo'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(Buffer.concat(seenByApp).toString()).toBe('hello');
    expect(slot.requestBody?.toString()).toBe('hello');
    expect(slot.phase).toBe('active');
    expect(slot.estimatedBytes).toBe(261);
    expect(onBytesChanged).toHaveBeenCalledWith(256, 261);
  });

  it('truncates inbound bodies at the configured limit', () => {
    const capture = createBodyCapture({ maxPayloadSize: 5 });
    const req = new MockIncomingMessage();
    const slot = createSlot();

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      () => undefined
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('abc'));
    req.emit('data', Buffer.from('def'));
    req.emit('data', Buffer.from('ghi'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody?.toString()).toBe('abcde');
    expect(slot.requestBodyTruncated).toBe(true);
    expect(slot.requestBodyOriginalSize).toBe(6);
  });

  it('skips inbound request capture for disallowed content types', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const req = new MockIncomingMessage();
    const slot = createSlot({
      requestHeaders: { 'content-type': 'text/plain; charset=utf-8' }
    });
    const onBytesChanged = vi.fn();

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('fails closed for inbound request capture when content type is missing', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const req = new MockIncomingMessage();
    const slot = createSlot({ requestHeaders: {} });
    const onBytesChanged = vi.fn();

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('discards inbound backfill when the slot sequence mismatches', () => {
    const capture = createBodyCapture();
    const req = new MockIncomingMessage();
    const slot = createSlot({ seq: 2 });
    const onBytesChanged = vi.fn();

    capture.captureInboundRequest(req as IncomingMessage, slot, 1, onBytesChanged);

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('captures outbound response bodies from write plus end and restores methods on finish', () => {
    const capture = createBodyCapture();
    const res = new MockServerResponse();
    const slot = createSlot();
    const onBytesChanged = vi.fn();
    const originalWrite = res.write;
    const originalEnd = res.end;

    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.write('hel', 'utf8');
    res.end(Buffer.from('lo'));
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody?.toString()).toBe('hello');
    expect(onBytesChanged).toHaveBeenCalledWith(256, 261);
    expect(res.write).toBe(originalWrite);
    expect(res.end).toBe(originalEnd);
  });

  it('captures outbound response bodies from end(chunk) only', () => {
    const capture = createBodyCapture();
    const res = new MockServerResponse();
    const slot = createSlot();

    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      slot,
      slot.seq,
      () => undefined
    );

    res.end('hello');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody?.toString()).toBe('hello');
  });

  it('skips outbound response capture for disallowed content types after the first write', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const res = new MockServerResponse();
    const slot = createSlot();
    const onBytesChanged = vi.fn();
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.setHeader('content-type', 'text/html; charset=utf-8');

    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.write('<html>');
    res.end('</html>');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
    expect(res.write).toBe(originalWrite);
    expect(res.end).toBe(originalEnd);
  });

  it('fails closed for outbound response capture when content type is missing', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const res = new MockServerResponse();
    const slot = createSlot();
    const onBytesChanged = vi.fn();

    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.write('hello');
    res.end('world');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('captures outbound client responses', () => {
    const capture = createBodyCapture();
    const res = new MockIncomingMessage();
    const slot = createSlot();
    const onBytesChanged = vi.fn();

    capture.captureClientResponse(
      res as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.emit('data', Buffer.from('he'));
    res.emit('data', Buffer.from('llo'));
    res.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody?.toString()).toBe('hello');
    expect(onBytesChanged).toHaveBeenCalledWith(256, 261);
  });

  it('skips outbound client response capture for disallowed content types', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const res = new MockIncomingMessage();
    const slot = createSlot({
      direction: 'outbound',
      type: 'http-client',
      responseHeaders: { 'content-type': 'text/html; charset=utf-8' }
    });
    const onBytesChanged = vi.fn();

    capture.captureClientResponse(
      res as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.emit('data', Buffer.from('hello'));
    res.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('fails closed for outbound client response capture when content type is missing', () => {
    const capture = createBodyCapture({
      bodyCaptureContentTypes: ['application/json']
    });
    const res = new MockIncomingMessage();
    const slot = createSlot({
      direction: 'outbound',
      type: 'http-client',
      responseHeaders: null
    });
    const onBytesChanged = vi.fn();

    capture.captureClientResponse(
      res as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );

    res.emit('data', Buffer.from('hello'));
    res.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('treats disabled request and response capture as a no-op for all capture methods', () => {
    const capture = createBodyCapture({
      captureRequestBodies: false,
      captureResponseBodies: false
    });
    const req = new MockIncomingMessage();
    const clientRes = new MockIncomingMessage();
    const serverRes = new MockServerResponse();
    const slot = createSlot();
    const onBytesChanged = vi.fn();

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );
    capture.captureClientResponse(
      clientRes as IncomingMessage,
      slot,
      slot.seq,
      onBytesChanged
    );
    capture.captureOutboundResponse(
      serverRes as unknown as ServerResponse,
      slot,
      slot.seq,
      onBytesChanged
    );

    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    clientRes.emit('data', Buffer.from('hello'));
    clientRes.emit('end');
    serverRes.write('hello');
    serverRes.end();

    expect(slot.requestBody).toBeNull();
    expect(slot.responseBody).toBeNull();
    expect(onBytesChanged).not.toHaveBeenCalled();
  });

  it('handles string chunk encodings correctly', () => {
    const capture = createBodyCapture();
    const res = new MockServerResponse();
    const slot = createSlot();

    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      slot,
      slot.seq,
      () => undefined
    );

    res.write('caf\xe9', 'latin1');
    res.end();
    capture.materializeSlotBodies(slot);

    expect(slot.responseBody).toEqual(Buffer.from('caf\xe9', 'latin1'));
  });

  it('computes body digests only when explicitly enabled', () => {
    const disabled = createBodyCapture({ captureBodyDigest: false });
    const enabled = createBodyCapture({ captureBodyDigest: true });
    const disabledSlot = createSlot();
    const enabledSlot = createSlot({ seq: 2 });
    const disabledReq = new MockIncomingMessage();
    const enabledReq = new MockIncomingMessage();

    disabled.captureInboundRequest(
      disabledReq as IncomingMessage,
      disabledSlot,
      disabledSlot.seq,
      () => undefined
    );
    enabled.captureInboundRequest(
      enabledReq as IncomingMessage,
      enabledSlot,
      enabledSlot.seq,
      () => undefined
    );

    disabledReq.on('data', () => undefined);
    enabledReq.on('data', () => undefined);
    disabledReq.emit('data', Buffer.from('hello'));
    enabledReq.emit('data', Buffer.from('hello'));
    disabledReq.emit('end');
    enabledReq.emit('end');
    disabled.materializeSlotBodies(disabledSlot);
    enabled.materializeSlotBodies(enabledSlot);

    expect(disabledSlot.requestBodyDigest).toBeNull();
    expect(enabledSlot.requestBodyDigest).toBe(
      createHash('sha256').update('hello').digest('hex')
    );
  });

  it('computes the digest across the full stream even when capture truncates', () => {
    const capture = createBodyCapture({
      maxPayloadSize: 5,
      captureBodyDigest: true
    });
    const req = new MockIncomingMessage();
    const slot = createSlot();

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      () => undefined
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('abc'));
    req.emit('data', Buffer.from('def'));
    req.emit('data', Buffer.from('ghi'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody?.toString()).toBe('abcde');
    expect(slot.requestBodyOriginalSize).toBe(9);
    expect(slot.requestBodyDigest).toBe(
      createHash('sha256').update('abcdefghi').digest('hex')
    );
  });

  it('materializes multipart bodies as a safe placeholder instead of raw bytes', () => {
    const capture = createBodyCapture({
      maxPayloadSize: 64,
      scrubber: new Scrubber(resolveTestConfig())
    });
    const req = new MockIncomingMessage();
    const slot = createSlot({
      requestHeaders: { 'content-type': 'multipart/form-data; boundary=test' }
    });

    capture.captureInboundRequest(
      req as IncomingMessage,
      slot,
      slot.seq,
      () => undefined
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('top-secret-file-contents'));
    req.emit('end');
    capture.materializeSlotBodies(slot);

    expect(slot.requestBody?.toString('utf8')).toBe('[MULTIPART BODY OMITTED]');
  });

  it('can capture only request bodies without response bodies', () => {
    const capture = createBodyCapture({ captureResponseBodies: false });
    const req = new MockIncomingMessage();
    const res = new MockServerResponse();
    const requestSlot = createSlot();
    const responseSlot = createSlot({ seq: 2 });

    capture.captureInboundRequest(
      req as IncomingMessage,
      requestSlot,
      requestSlot.seq,
      () => undefined
    );
    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      responseSlot,
      responseSlot.seq,
      () => undefined
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    res.end('world');
    capture.materializeSlotBodies(requestSlot);
    capture.materializeSlotBodies(responseSlot);

    expect(requestSlot.requestBody?.toString()).toBe('hello');
    expect(responseSlot.responseBody).toBeNull();
  });

  it('can capture only response bodies without request bodies', () => {
    const capture = createBodyCapture({ captureRequestBodies: false });
    const req = new MockIncomingMessage();
    const res = new MockServerResponse();
    const requestSlot = createSlot();
    const responseSlot = createSlot({ seq: 2 });

    capture.captureInboundRequest(
      req as IncomingMessage,
      requestSlot,
      requestSlot.seq,
      () => undefined
    );
    capture.captureOutboundResponse(
      res as unknown as ServerResponse,
      responseSlot,
      responseSlot.seq,
      () => undefined
    );

    req.on('data', () => undefined);
    req.emit('data', Buffer.from('hello'));
    req.emit('end');
    res.end('world');
    capture.materializeSlotBodies(requestSlot);
    capture.materializeSlotBodies(responseSlot);

    expect(requestSlot.requestBody).toBeNull();
    expect(responseSlot.responseBody?.toString()).toBe('world');
  });

  it('materializes the most recent inbound http-server body onto the request context', () => {
    const capture = createBodyCapture();
    const olderInbound = createSlot({
      seq: 1,
      requestBody: Buffer.from('older'),
      requestBodyTruncated: false
    });
    const outbound = createSlot({
      seq: 2,
      direction: 'outbound',
      requestBody: Buffer.from('ignored')
    });
    const latestInbound = createSlot({
      seq: 3,
      requestBody: Buffer.from('latest'),
      requestBodyTruncated: true
    });
    const nonHttp = createSlot({
      seq: 4,
      type: 'dns'
    });
    const context: RequestContext = {
      requestId: 'req-1',
      startTime: 1n,
      method: 'GET',
      url: '/resource',
      headers: {},
      body: null,
      bodyTruncated: false,
      ioEvents: [olderInbound, outbound, latestInbound, nonHttp],
      stateReads: []
    };

    capture.materializeContextBody(context);

    expect(context.body?.toString()).toBe('latest');
    expect(context.bodyTruncated).toBe(true);
  });
});
