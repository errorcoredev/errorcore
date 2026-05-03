
import { createHash } from 'node:crypto';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';

import { getBodyEncoding, isTextualContentType } from '../pii/scrubber';
import type { IOEventSlot, RequestContext } from '../types';

const METADATA_OVERHEAD = 256;
const MAX_STATE_POOL_SIZE = 200;
const BODY_CAPTURE_STATE = Symbol('errorcore.bodyCaptureState');
const INBOUND_REQUEST_CAPTURE = Symbol('errorcore.inboundRequestCapture');
const OUTBOUND_RESPONSE_CAPTURE = Symbol('errorcore.outboundResponseCapture');
const CLIENT_REQUEST_CAPTURE = Symbol('errorcore.clientRequestCapture');

interface BodyCaptureConfig {
  maxPayloadSize: number;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureBodyDigest?: boolean;
  bodyCaptureContentTypes?: string[];
  scrubber?: {
    scrubBodyBuffer(
      buffer: Buffer,
      headers: Record<string, string> | null | undefined
    ): Buffer;
  };
}

interface AccumulatorState {
  chunks: Buffer[];
  totalBytesSeen: number;
  capturedBytes: number;
  truncated: boolean;
  finalized: boolean;
  contentTypeChecked: boolean;
  digest: ReturnType<typeof createHash> | null;
  digestHex: string | null;
  headers: Record<string, string> | null;
}

interface SlotCaptureState {
  request?: AccumulatorState;
  response?: AccumulatorState;
}

interface InboundRequestCaptureHandler {
  capture: BodyCapture;
  slot: IOEventSlot;
  seq: number;
  state: AccumulatorState | null;
  attached: boolean;
  originalOn: IncomingMessage['on'];
  onBytesChanged: (oldBytes: number, newBytes: number) => void;
}

interface OutboundResponseCaptureHandler {
  capture: BodyCapture;
  slot: IOEventSlot;
  seq: number;
  state: AccumulatorState;
  originalWrite: ServerResponse['write'];
  originalEnd: ServerResponse['end'];
  onBytesChanged: (oldBytes: number, newBytes: number) => void;
}

interface ClientRequestCaptureHandler {
  capture: BodyCapture;
  slot: IOEventSlot;
  seq: number;
  state: AccumulatorState;
  originalWrite: ClientRequest['write'];
  originalEnd: ClientRequest['end'];
  onBytesChanged: (oldBytes: number, newBytes: number) => void;
}

function estimateBytes(slot: IOEventSlot): number {
  return (
    METADATA_OVERHEAD +
    (slot.requestBody?.length ?? 0) +
    (slot.responseBody?.length ?? 0)
  );
}

function toBufferView(chunk: unknown, encoding?: BufferEncoding): Buffer | null {
  if (chunk === null || chunk === undefined || chunk === false) {
    return null;
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding);
  }

  return Buffer.from(String(chunk));
}

export class BodyCapture {
  private readonly maxPayloadSize: number;

  private readonly captureRequestBodies: boolean;

  private readonly captureResponseBodies: boolean;

  private readonly captureDigest: boolean;

  private readonly bodyCaptureContentTypes: string[];

  private readonly statePool: AccumulatorState[] = [];

  private readonly scrubber?: BodyCaptureConfig['scrubber'];

  public constructor(config: BodyCaptureConfig) {
    this.maxPayloadSize = config.maxPayloadSize;
    this.captureRequestBodies = config.captureRequestBodies;
    this.captureResponseBodies = config.captureResponseBodies;
    this.captureDigest = config.captureBodyDigest ?? false;
    this.bodyCaptureContentTypes = (config.bodyCaptureContentTypes ?? []).map((value) =>
      value.trim().toLowerCase()
    );
    this.scrubber = config.scrubber;
  }

  private static handleInboundRequestOn(
    this: IncomingMessage,
    eventName: string,
    listener: (...args: unknown[]) => void
  ): IncomingMessage {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return this;
    }

    if (eventName === 'data' && !handler.attached) {
      if (handler.state === null) {
        handler.state = handler.capture.createState(handler.slot.requestHeaders);
        handler.capture.setState(handler.slot, 'request', handler.state);
      }

      handler.attached = true;
      Reflect.apply(handler.originalOn, this, ['data', BodyCapture.handleInboundRequestData]);
      Reflect.apply(handler.originalOn, this, ['end', BodyCapture.handleInboundRequestEnd]);
    }

    return Reflect.apply(handler.originalOn, this, [eventName, listener]) as IncomingMessage;
  }

  private static handleInboundRequestData(this: IncomingMessage, chunk: unknown): void {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return;
    }

    if (handler.state === null) {
      return;
    }

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'requestBody',
      'requestBodyTruncated',
      'requestBodyOriginalSize',
      chunk
    );

    if (
      handler.state.truncated &&
      !handler.capture.shouldTrackAfterTruncation(handler.state)
    ) {
      request.removeListener('data', BodyCapture.handleInboundRequestData);
    }
  }

  private static handleInboundRequestEnd(this: IncomingMessage): void {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return;
    }

    request.on = handler.originalOn;
    delete request[INBOUND_REQUEST_CAPTURE];

    if (handler.state === null) {
      return;
    }

    handler.capture.finalizeCapture({
      slot: handler.slot,
      seq: handler.seq,
      bodyKey: 'requestBody',
      digestKey: 'requestBodyDigest',
      truncatedKey: 'requestBodyTruncated',
      originalSizeKey: 'requestBodyOriginalSize',
      state: handler.state,
      headers: handler.slot.requestHeaders,
      onBytesChanged: handler.onBytesChanged
    });
  }

  private static handleOutboundResponseFinish(this: ServerResponse): void {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return;
    }

    handler.capture.restoreOutboundResponse(response, handler);
    delete response[OUTBOUND_RESPONSE_CAPTURE];
  }

  private static handleOutboundResponseWrite(
    this: ServerResponse,
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return true;
    }

    if (handler.capture.skipOutboundResponseCapture(response, handler)) {
      return handler.originalWrite.call(
        response,
        chunk as never,
        encoding as never,
        callback as never
      );
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'responseBody',
      'responseBodyTruncated',
      'responseBodyOriginalSize',
      chunk,
      normalizedEncoding
    );

    return handler.originalWrite.call(
      response,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  private static handleOutboundResponseEnd(
    this: ServerResponse,
    chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): ServerResponse {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return this;
    }

    if (handler.capture.skipOutboundResponseCapture(response, handler)) {
      return handler.originalEnd.call(
        response,
        chunk as never,
        encoding as never,
        callback as never
      );
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'responseBody',
      'responseBodyTruncated',
      'responseBodyOriginalSize',
      chunk,
      normalizedEncoding
    );

    handler.capture.finalizeCapture({
      slot: handler.slot,
      seq: handler.seq,
      bodyKey: 'responseBody',
      digestKey: 'responseBodyDigest',
      truncatedKey: 'responseBodyTruncated',
      originalSizeKey: 'responseBodyOriginalSize',
      state: handler.state,
      headers: handler.slot.responseHeaders,
      onBytesChanged: handler.onBytesChanged
    });

    return handler.originalEnd.call(
      response,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  private static handleClientRequestWrite(
    this: ClientRequest,
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const request = this as ClientRequest & {
      [CLIENT_REQUEST_CAPTURE]?: ClientRequestCaptureHandler;
    };
    const handler = request[CLIENT_REQUEST_CAPTURE];

    if (handler === undefined) {
      return true;
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'requestBody',
      'requestBodyTruncated',
      'requestBodyOriginalSize',
      chunk,
      normalizedEncoding
    );

    return handler.originalWrite.call(
      this,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  private static handleClientRequestEnd(
    this: ClientRequest,
    chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): ClientRequest {
    const request = this as ClientRequest & {
      [CLIENT_REQUEST_CAPTURE]?: ClientRequestCaptureHandler;
    };
    const handler = request[CLIENT_REQUEST_CAPTURE];

    if (handler === undefined) {
      return this;
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    if (chunk !== undefined && chunk !== null) {
      handler.capture.captureChunk(
        handler.state,
        handler.slot,
        'requestBody',
        'requestBodyTruncated',
        'requestBodyOriginalSize',
        chunk,
        normalizedEncoding
      );
    }

    handler.capture.finalizeCapture({
      slot: handler.slot,
      seq: handler.seq,
      bodyKey: 'requestBody',
      digestKey: 'requestBodyDigest',
      truncatedKey: 'requestBodyTruncated',
      originalSizeKey: 'requestBodyOriginalSize',
      state: handler.state,
      headers: handler.slot.requestHeaders,
      onBytesChanged: handler.onBytesChanged
    });

    request.write = handler.originalWrite;
    request.end = handler.originalEnd;
    delete request[CLIENT_REQUEST_CAPTURE];

    return handler.originalEnd.call(
      this,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  public captureInboundRequest(
    req: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isRequestCaptureEnabled() || !this.shouldCaptureHeaders(slot.requestHeaders)) {
      return;
    }

    const request = req as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };

    request[INBOUND_REQUEST_CAPTURE] = {
      capture: this,
      slot,
      seq,
      state: null,
      attached: false,
      originalOn: req.on,
      onBytesChanged
    };
    req.on = BodyCapture.handleInboundRequestOn as IncomingMessage['on'];
  }

  public releaseInboundRequest(req: IncomingMessage): void {
    const request = req as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return;
    }

    request.on = handler.originalOn;
    delete request[INBOUND_REQUEST_CAPTURE];

    if (handler.state === null) {
      return;
    }

    delete this.getState(handler.slot).request;
    this.releaseState(handler.state);
  }

  public captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isResponseCaptureEnabled()) {
      return;
    }

    const state = this.createState(null);
    this.setState(slot, 'response', state);
    const response = res as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };

    response[OUTBOUND_RESPONSE_CAPTURE] = {
      capture: this,
      slot,
      seq,
      state,
      originalWrite: res.write,
      originalEnd: res.end,
      onBytesChanged
    };

    res.on('finish', BodyCapture.handleOutboundResponseFinish);
    res.write = BodyCapture.handleOutboundResponseWrite as ServerResponse['write'];
    res.end = BodyCapture.handleOutboundResponseEnd as ServerResponse['end'];
  }

  public captureClientRequest(
    req: ClientRequest,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isRequestCaptureEnabled() || !this.shouldCaptureHeaders(slot.requestHeaders)) {
      return;
    }

    const state = this.createState(slot.requestHeaders);
    this.setState(slot, 'request', state);
    const request = req as ClientRequest & {
      [CLIENT_REQUEST_CAPTURE]?: ClientRequestCaptureHandler;
    };

    request[CLIENT_REQUEST_CAPTURE] = {
      capture: this,
      slot,
      seq,
      state,
      originalWrite: req.write,
      originalEnd: req.end,
      onBytesChanged
    };

    req.write = BodyCapture.handleClientRequestWrite as ClientRequest['write'];
    req.end = BodyCapture.handleClientRequestEnd as ClientRequest['end'];
  }

  public captureClientRequestBody(
    slot: IOEventSlot,
    seq: number,
    body: unknown,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isRequestCaptureEnabled() || !this.shouldCaptureHeaders(slot.requestHeaders)) {
      return;
    }
    if (body === null || body === undefined) {
      return;
    }
    // Streams (Readable) cannot be consumed here without breaking the
    // outbound send. Surface that the request had a streaming body but
    // we did not capture its content.
    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { pipe?: unknown }).pipe === 'function'
    ) {
      slot.requestBodyTruncated = true;
      slot.requestBodyOriginalSize = null;
      return;
    }

    const state = this.createState(slot.requestHeaders);
    this.setState(slot, 'request', state);

    this.captureChunk(
      state,
      slot,
      'requestBody',
      'requestBodyTruncated',
      'requestBodyOriginalSize',
      body
    );

    this.finalizeCapture({
      slot,
      seq,
      bodyKey: 'requestBody',
      digestKey: 'requestBodyDigest',
      truncatedKey: 'requestBodyTruncated',
      originalSizeKey: 'requestBodyOriginalSize',
      state,
      headers: slot.requestHeaders,
      onBytesChanged
    });
  }

  public captureClientResponse(
    res: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isResponseCaptureEnabled() || !this.shouldCaptureHeaders(slot.responseHeaders)) {
      return;
    }

    const state = this.createState(null);
    this.setState(slot, 'response', state);

    const dataListener = (chunk: unknown) => {
      this.captureChunk(
        state,
        slot,
        'responseBody',
        'responseBodyTruncated',
        'responseBodyOriginalSize',
        chunk
      );

      if (state.truncated && !this.shouldTrackAfterTruncation(state)) {
        res.removeListener('data', dataListener);
      }
    };

    res.on('data', dataListener);
    res.on('end', () => {
      this.finalizeCapture({
        slot,
        seq,
        bodyKey: 'responseBody',
        digestKey: 'responseBodyDigest',
        truncatedKey: 'responseBodyTruncated',
        originalSizeKey: 'responseBodyOriginalSize',
        state,
        headers: slot.responseHeaders,
        onBytesChanged
      });
    });
  }

  public materializeSlotBodies(slot: IOEventSlot): void {
    if (this.isRequestCaptureEnabled()) {
      this.materializeBody(slot, 'requestBody', 'requestBodyDigest', slot.requestHeaders);
    }

    if (this.isResponseCaptureEnabled()) {
      this.materializeBody(slot, 'responseBody', 'responseBodyDigest', slot.responseHeaders);
    }
  }

  public materializeContextBody(context: RequestContext): void {
    let slot: IOEventSlot | undefined;
    const { ioEvents } = context;
    for (let index = ioEvents.length - 1; index >= 0; index -= 1) {
      const candidate = ioEvents[index];
      if (candidate.type === 'http-server' && candidate.direction === 'inbound') {
        slot = candidate;
        break;
      }
    }

    if (slot === undefined) {
      return;
    }

    this.materializeSlotBodies(slot);
    context.body = slot.requestBody;
    context.bodyTruncated = slot.requestBodyTruncated;
  }

  private isRequestCaptureEnabled(): boolean {
    return this.captureRequestBodies && this.maxPayloadSize > 0;
  }

  private isResponseCaptureEnabled(): boolean {
    return this.captureResponseBodies && this.maxPayloadSize > 0;
  }

  private createState(headers: Record<string, string> | null): AccumulatorState {
    const state = this.statePool.pop();

    if (state !== undefined) {
      state.chunks.length = 0;
      state.totalBytesSeen = 0;
      state.capturedBytes = 0;
      state.truncated = false;
      state.finalized = false;
      state.contentTypeChecked = false;
      state.digest = this.captureDigest ? createHash('sha256') : null;
      state.digestHex = null;
      state.headers = headers;
      return state;
    }

    return {
      chunks: [],
      totalBytesSeen: 0,
      capturedBytes: 0,
      truncated: false,
      finalized: false,
      contentTypeChecked: false,
      digest: this.captureDigest ? createHash('sha256') : null,
      digestHex: null,
      headers
    };
  }

  private shouldCaptureHeaders(headers: Record<string, string> | null | undefined): boolean {
    return this.shouldCaptureContentTypeHeader(headers?.['content-type']);
  }

  private shouldCaptureContentTypeHeader(contentType: unknown): boolean {
    if (this.bodyCaptureContentTypes.length === 0) {
      return true;
    }

    const rawContentType = Array.isArray(contentType)
      ? contentType.find((value) => typeof value === 'string' && value.trim() !== '') ??
        contentType[0]
      : contentType;
    const normalized =
      (typeof rawContentType === 'string'
        ? rawContentType
        : rawContentType === undefined || rawContentType === null
          ? ''
          : String(rawContentType)
      )
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase() ?? '';

    if (normalized === '') {
      return false;
    }

    return this.bodyCaptureContentTypes.some((candidate) => normalized.startsWith(candidate));
  }

  private snapshotContentTypeHeaders(contentType: unknown): Record<string, string> | null {
    const rawContentType = Array.isArray(contentType) ? contentType[0] : contentType;

    if (typeof rawContentType !== 'string' || rawContentType.trim() === '') {
      return null;
    }

    return { 'content-type': rawContentType };
  }

  private captureChunk(
    state: AccumulatorState,
    slot: IOEventSlot,
    bodyKey: 'requestBody' | 'responseBody',
    truncatedKey: 'requestBodyTruncated' | 'responseBodyTruncated',
    originalSizeKey: 'requestBodyOriginalSize' | 'responseBodyOriginalSize',
    chunk: unknown,
    encoding?: BufferEncoding
  ): void {
    const buffer = toBufferView(chunk, encoding);

    if (buffer === null) {
      return;
    }

    if (state.digest !== null) {
      state.digest.update(buffer);
    }

    if (state.truncated) {
      state.totalBytesSeen += buffer.length;
      slot[originalSizeKey] = state.totalBytesSeen;
      return;
    }

    state.totalBytesSeen += buffer.length;
    const remaining = this.maxPayloadSize - state.capturedBytes;

    if (remaining <= 0) {
      state.truncated = true;
      slot[truncatedKey] = true;
      slot[originalSizeKey] = state.totalBytesSeen;
      return;
    }

    const captured =
      buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);

    state.chunks.push(captured);
    state.capturedBytes += captured.length;

    if (buffer.length <= remaining) {
      return;
    }

    state.truncated = true;
    slot[truncatedKey] = true;
    slot[originalSizeKey] = state.totalBytesSeen;
  }

  private restoreOutboundResponse(
    res: ServerResponse,
    handler: OutboundResponseCaptureHandler
  ): void {
    res.write = handler.originalWrite;
    res.end = handler.originalEnd;
  }

  private skipOutboundResponseCapture(
    res: ServerResponse,
    handler: OutboundResponseCaptureHandler
  ): boolean {
    if (handler.state.contentTypeChecked) {
      return false;
    }

    handler.state.contentTypeChecked = true;
    const contentType = res.getHeader?.('content-type');
    handler.state.headers = this.snapshotContentTypeHeaders(contentType);

    if (this.shouldCaptureContentTypeHeader(contentType)) {
      return false;
    }

    this.restoreOutboundResponse(res, handler);
    delete (res as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    })[OUTBOUND_RESPONSE_CAPTURE];
    delete this.getState(handler.slot).response;
    this.releaseState(handler.state);
    return true;
  }

  private shouldTrackAfterTruncation(state: AccumulatorState): boolean {
    return state.digest !== null;
  }

  private releaseState(state: AccumulatorState): void {
    state.chunks.length = 0;
    state.totalBytesSeen = 0;
    state.capturedBytes = 0;
    state.truncated = false;
    state.finalized = false;
    state.contentTypeChecked = false;
    state.digest = null;
    state.digestHex = null;
    state.headers = null;
    // Cap the pool size to avoid unbounded memory growth from pooled objects
    // when many concurrent streams were active. Let excess states be GC'd.
    if (this.statePool.length < MAX_STATE_POOL_SIZE) {
      this.statePool.push(state);
    }
  }

  private finalizeCapture(input: {
    slot: IOEventSlot;
    seq: number;
    bodyKey: 'requestBody' | 'responseBody';
    digestKey: 'requestBodyDigest' | 'responseBodyDigest';
    truncatedKey: 'requestBodyTruncated' | 'responseBodyTruncated';
    originalSizeKey: 'requestBodyOriginalSize' | 'responseBodyOriginalSize';
    state: AccumulatorState;
    headers: Record<string, string> | null;
    onBytesChanged: (oldBytes: number, newBytes: number) => void;
  }): void {
    const {
      slot,
      seq,
      bodyKey,
      digestKey,
      state,
      headers,
      onBytesChanged
    } = input;

    if (slot.seq !== seq) {
      delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
      this.releaseState(state);
      return;
    }

    const oldBytes = slot.estimatedBytes;
    state.finalized = true;
    state.headers = headers;
    if (state.digest !== null && state.digestHex === null && state.capturedBytes > 0) {
      state.digestHex = state.digest.digest('hex');
    }

    slot[bodyKey] = null;
    slot[digestKey] = state.digestHex;
    slot.estimatedBytes = oldBytes + state.capturedBytes;

    onBytesChanged(oldBytes, slot.estimatedBytes);

    if (state.capturedBytes === 0 && !state.truncated) {
      delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
      this.releaseState(state);
    }
  }

  private getState(slot: IOEventSlot): SlotCaptureState {
    const trackedSlot = slot as IOEventSlot & { [BODY_CAPTURE_STATE]?: SlotCaptureState };
    trackedSlot[BODY_CAPTURE_STATE] ??= {};
    return trackedSlot[BODY_CAPTURE_STATE] as SlotCaptureState;
  }

  private setState(
    slot: IOEventSlot,
    bodyType: 'request' | 'response',
    state: AccumulatorState
  ): void {
    this.getState(slot)[bodyType] = state;
  }

  private materializeBody(
    slot: IOEventSlot,
    bodyKey: 'requestBody' | 'responseBody',
    digestKey: 'requestBodyDigest' | 'responseBodyDigest',
    headers: Record<string, string> | null
  ): void {
    if (slot[bodyKey] !== null) {
      return;
    }

    const state = this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
    if (state === undefined) {
      return;
    }

    if (!this.shouldCaptureHeaders(headers ?? state.headers)) {
      if (state.capturedBytes > 0) {
        slot.estimatedBytes = Math.max(estimateBytes(slot), slot.estimatedBytes - state.capturedBytes);
      }

      slot[digestKey] = null;
      delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
      this.releaseState(state);
      return;
    }

    if (state.digest !== null && state.digestHex === null && state.capturedBytes > 0) {
      state.digestHex = state.finalized
        ? state.digest.digest('hex')
        : state.digest.copy().digest('hex');
    }

    const body = Buffer.concat(state.chunks, state.capturedBytes);
    const scrubbed = this.scrubber?.scrubBodyBuffer(body, headers ?? state.headers) ?? body;

    // For textual content-types, decode UTF-8 (or charset-declared encoding)
    // so the body lands in the package as a readable string, not as a typed-
    // array byte sample that the JSON serializer would clamp to maxArrayItems.
    // Binary content stays as a Buffer.
    const contentType = (headers ?? state.headers)?.['content-type'];
    if (isTextualContentType(contentType)) {
      slot[bodyKey] = scrubbed.toString(getBodyEncoding(contentType));
    } else {
      slot[bodyKey] = scrubbed;
    }
    slot[digestKey] = state.digestHex;
    delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
    this.releaseState(state);
  }
}
