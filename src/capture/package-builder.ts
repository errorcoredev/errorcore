
import { randomUUID } from 'node:crypto';

import { Scrubber as PiiScrubber } from '../pii/scrubber';
import { Scrubber as FieldScrubber } from '../scrubber/scrubber';
import { Encryption, buildTransparentEnvelope } from '../security/encryption';
import { getSdkVersion } from '../version';
import { analyzeStackOwnership } from './stack-ownership';
import type {
  CapturedFrame,
  Completeness,
  EncryptedEnvelope,
  EvictionRecord,
  EvictionRecordSerialized,
  ErrorInfo,
  ErrorPackage,
  ErrorPackageParts,
  PayloadBlobEnvelope,
  IOEventSlot,
  IOEventSerialized,
  PackageAssemblyResult,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  StateRead,
  StateReadSerialized,
  StateWrite,
  StateWriteSerialized,
  TimeAnchor
} from '../types';
import type { Source } from '../scrubber/types';

function approximateIsoFromHrtime(
  startTime: bigint,
  anchor: TimeAnchor
): string {
  const anchorNs = BigInt(anchor.hrtimeNs);
  const offsetNs = startTime - anchorNs;
  const offsetMs = offsetNs / 1_000_000n;

  return new Date(anchor.wallClockMs + Number(offsetMs)).toISOString();
}

function serializeEvictionRecord(record: EvictionRecord): EvictionRecordSerialized {
  return {
    seq: record.seq,
    type: record.type,
    direction: record.direction,
    target: record.target,
    requestId: record.requestId,
    startTime: record.startTime.toString(),
    evictedAt: record.evictedAt.toString()
  };
}

function serializeIOEvent(event: IOEventSlot, scrubber: PiiScrubber): IOEventSerialized {
  return {
    seq: event.seq,
    hrtimeNs: event.hrtimeNs.toString(),
    type: event.type,
    direction: event.direction,
    target: event.target,
    method: event.method,
    url: event.url === null ? null : scrubber.scrubUrl(event.url),
    statusCode: event.statusCode,
    fd: event.fd,
    requestId: event.requestId,
    contextLost: event.contextLost,
    startTime: event.startTime.toString(),
    endTime: event.endTime?.toString() ?? null,
    durationMs: event.durationMs,
    requestHeaders: event.requestHeaders === null ? null : { ...event.requestHeaders },
    responseHeaders: event.responseHeaders === null ? null : { ...event.responseHeaders },
    requestBody: event.requestBody,
    responseBody: event.responseBody,
    requestBodyDigest: event.requestBodyDigest ?? null,
    responseBodyDigest: event.responseBodyDigest ?? null,
    requestPayloadRef: event.requestPayloadRef ?? null,
    responsePayloadRef: event.responsePayloadRef ?? null,
    requestBodyTruncated: event.requestBodyTruncated,
    responseBodyTruncated: event.responseBodyTruncated,
    requestBodyOriginalSize: event.requestBodyOriginalSize,
    responseBodyOriginalSize: event.responseBodyOriginalSize,
    error: event.error === null ? null : { ...event.error },
    aborted: event.aborted,
    dbMeta: event.dbMeta === undefined ? undefined : { ...event.dbMeta }
  };
}

function serializeStateRead(read: StateRead): StateReadSerialized {
  return {
    seq: read.seq,
    container: read.container,
    operation: read.operation,
    key: read.key,
    value: read.value,
    timestamp: read.timestamp.toString()
  };
}

function serializeStateWrite(write: StateWrite): StateWriteSerialized {
  return {
    seq: write.seq,
    hrtimeNs: write.hrtimeNs.toString(),
    container: write.container,
    operation: write.operation,
    key: write.key,
    value: write.value
  };
}

function estimateBodySize(body: unknown): number {
  if (body === null || body === undefined) {
    return 0;
  }

  if (typeof body === 'string') {
    return body.length;
  }

  if (typeof body === 'object' && body !== null && 'length' in body) {
    const length = (body as { length?: unknown }).length;

    if (typeof length === 'number') {
      return length;
    }
  }

  return Object.keys(body as Record<string, unknown>).length * 32;
}

function normalizeScrubbedArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { _items?: unknown })._items)
  ) {
    return (value as { _items: T[] })._items;
  }

  return [];
}

type RouteCapturedValue = (name: string, value: unknown, source: Source) => void;

function routeRawCapturedValues(
  pkg: ErrorPackage,
  policy: ResolvedConfig['scrubberPolicy']
): void {
  const routingScrubber = new FieldScrubber(policy);
  const routeCapturedValue: RouteCapturedValue = (name, value, source) => {
    routingScrubber.process(name, value, source);
  };

  if (pkg.fingerprint !== undefined) {
    routeCapturedValue('fingerprint', pkg.fingerprint, 'app');
  }

  routeStackOwnership(pkg.errorOrigin, routeCapturedValue);
  routeErrorInfo(pkg.error, routeCapturedValue);

  if (pkg.localVariables !== undefined) {
    for (const frame of pkg.localVariables) {
      routeCapturedValue('filePath', frame.filePath, 'app');
    }
  }

  if (pkg.request !== undefined) {
    routeCapturedValue('requestId', pkg.request.id, 'http_incoming');
    routeCapturedValue('url', pkg.request.url, 'http_incoming');
  }

  for (const event of pkg.ioTimeline) {
    routeIOEventMetadata(event, getIOEventRequestSource(event), routeCapturedValue);
  }

  for (const eviction of pkg.evictionLog) {
    routeCapturedValue('target', eviction.target, 'app');
    if (eviction.requestId !== null) {
      routeCapturedValue('requestId', eviction.requestId, 'app');
    }
  }

  if (pkg.ambientContext !== undefined && pkg.ambientContext !== null) {
    for (const requestId of pkg.ambientContext.distinctRequestIds) {
      routeCapturedValue('requestId', requestId, 'app');
    }
  }

  for (const read of pkg.stateReads) {
    routeCapturedValue('container', read.container, 'app');
  }

  for (const write of pkg.stateWrites) {
    routeCapturedValue('container', write.container, 'app');
  }

  for (const request of pkg.concurrentRequests) {
    routeCapturedValue('requestId', request.requestId, 'app');
    routeCapturedValue('url', request.url, 'app');
  }

  routeProcessMetadata(pkg.processMetadata, routeCapturedValue);
  routeCapturedRecord(pkg.codeVersion, 'app', routeCapturedValue);
  routeCapturedRecord(pkg.environment, 'app', routeCapturedValue);

  if (pkg.trace?.tracestate !== undefined) {
    routeCapturedValue('tracestate', pkg.trace.tracestate, 'app');
  }

  for (const failure of pkg.completeness.captureFailures) {
    routeCapturedValue('captureFailure', failure, 'app');
  }
}

function routeErrorInfo(
  error: ErrorInfo | ErrorPackage['error'] | null,
  routeCapturedValue: RouteCapturedValue
): void {
  if (error === null) {
    return;
  }

  routeCapturedValue('message', error.message, 'app');
  routeCapturedValue('stack', error.stack, 'app');
  if (error.rawStack !== undefined) {
    routeCapturedValue('rawStack', error.rawStack, 'app');
  }
  routeCapturedRecord(error.properties, 'app', routeCapturedValue);
  if (error.cause !== undefined && error.cause !== null) {
    routeErrorInfo(error.cause, routeCapturedValue);
  }
}

function routeStackOwnership(
  ownership: ErrorPackage['errorOrigin'],
  routeCapturedValue: RouteCapturedValue
): void {
  if (ownership?.appBoundaryFrame === undefined) {
    return;
  }

  routeCapturedValue('filePath', ownership.appBoundaryFrame.filePath, 'app');
}

function routeIOEventMetadata(
  event: IOEventSerialized,
  requestSource: Source,
  routeCapturedValue: RouteCapturedValue
): void {
  routeCapturedValue('target', event.target, requestSource);
  if (event.url !== null) {
    routeCapturedValue('url', event.url, requestSource);
  }
  if (event.requestId !== null) {
    routeCapturedValue('requestId', event.requestId, requestSource);
  }
  if (event.requestBodyDigest !== undefined && event.requestBodyDigest !== null) {
    routeCapturedValue('requestBodyDigest', event.requestBodyDigest, requestSource);
  }
  if (event.responseBodyDigest !== undefined && event.responseBodyDigest !== null) {
    routeCapturedValue('responseBodyDigest', event.responseBodyDigest, 'app');
  }
  if (event.error !== null) {
    routeCapturedValue('message', event.error.message, 'app');
  }
  if (event.dbMeta !== undefined && event.dbMeta !== null) {
    if (event.dbMeta.query !== undefined) {
      routeCapturedValue('query', event.dbMeta.query, 'app');
    }
    if (event.dbMeta.params !== undefined) {
      routeCapturedValue('params', event.dbMeta.params, 'app');
    }
    if (event.dbMeta.collection !== undefined) {
      routeCapturedValue('collection', event.dbMeta.collection, 'app');
    }
  }
}

function routeProcessMetadata(
  metadata: ProcessMetadata,
  routeCapturedValue: RouteCapturedValue
): void {
  routeCapturedValue('hostname', metadata.hostname, 'app');
  if (metadata.containerId !== undefined) {
    routeCapturedValue('containerId', metadata.containerId, 'app');
  }
  if (metadata.deploymentEnv !== undefined) {
    routeCapturedValue('deploymentEnv', metadata.deploymentEnv, 'app');
  }
}

function routeCapturedRecord(
  record: Record<string, unknown>,
  source: Source,
  routeCapturedValue: RouteCapturedValue
): void {
  for (const [key, value] of Object.entries(record)) {
    routeCapturedValue(key, value, source);
  }
}

function getIOEventRequestSource(event: IOEventSerialized): Source {
  return event.type === 'http-server' && event.direction === 'inbound'
    ? 'http_incoming'
    : 'app';
}

/**
 * Count the number of rendered stack frames in an Error.stack string.
 * Lines starting with "    at " (after trimming) are counted as frames.
 */
function countRenderedStackFrames(stack: string): number {
  if (!stack) return 0;
  let count = 0;
  for (const line of stack.split('\n')) {
    if (line.trim().startsWith('at ')) count++;
  }
  return count;
}

const V8_STACK_FRAME_RE = /^(\s+at\s+)(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

function scrubStackFilePaths(stack: string, scrubber: PiiScrubber): string {
  if (stack === '') {
    return stack;
  }

  return stack
    .split('\n')
    .map((line) => {
      const match = V8_STACK_FRAME_RE.exec(line);
      if (match === null) {
        return line;
      }

      const [, indent, functionName, filePath, lineNumber, columnNumber] = match;
      const scrubbedPath = scrubber.scrubFilePath(filePath);
      if (scrubbedPath === filePath) {
        return line;
      }

      return functionName
        ? `${indent}${functionName} (${scrubbedPath}:${lineNumber}:${columnNumber})`
        : `${indent}${scrubbedPath}:${lineNumber}:${columnNumber}`;
    })
    .join('\n');
}

function scrubErrorInfoFilePaths(error: ErrorInfo, scrubber: PiiScrubber): ErrorInfo {
  return {
    ...error,
    stack: scrubStackFilePaths(error.stack, scrubber),
    ...(error.rawStack === undefined
      ? {}
      : { rawStack: scrubStackFilePaths(error.rawStack, scrubber) }),
    ...(error.cause === undefined
      ? {}
      : { cause: scrubErrorInfoFilePaths(error.cause, scrubber) })
  };
}

function scrubCapturedFrameFilePaths(
  frames: CapturedFrame[] | null,
  scrubber: PiiScrubber
): CapturedFrame[] | null {
  if (frames === null) {
    return null;
  }

  return frames.map((frame) => ({
    ...frame,
    filePath: scrubber.scrubFilePath(frame.filePath)
  }));
}

/**
 * Apply Layer 3 frame-index alignment: if the number of captured local-variable
 * frames exceeds the rendered stack frame count (e.g., due to custom
 * prepareStackTrace or Error.captureStackTrace clipping), trim the locals array
 * to the common prefix and return 'prefix_only'. Otherwise return 'full'.
 *
 * If renderedStackFrameCount is 0 (stack has no frame lines, which can happen
 * with intentionally minimal stacks), we do NOT trim - skipping alignment is safer
 * than discarding all locals.
 */
function alignLocalVariableFrames(
  locals: import('../types').CapturedFrame[],
  renderedStackFrameCount: number
): { aligned: import('../types').CapturedFrame[]; alignment: 'full' | 'prefix_only' } {
  if (renderedStackFrameCount > 0 && locals.length > renderedStackFrameCount) {
    return {
      aligned: locals.slice(0, renderedStackFrameCount),
      alignment: 'prefix_only'
    };
  }
  return { aligned: locals, alignment: 'full' };
}

function findLargestBodyEvent(ioTimeline: IOEventSerialized[]): {
  event: IOEventSerialized;
  estimatedBytes: number;
} | null {
  let largestEvent: IOEventSerialized | null = null;
  let largestBytes = 0;

  for (const event of ioTimeline) {
    const estimatedBytes =
      estimateBodySize(event.requestBody) + estimateBodySize(event.responseBody);

    if (estimatedBytes > largestBytes) {
      largestEvent = event;
      largestBytes = estimatedBytes;
    }
  }

  if (largestEvent === null || largestBytes === 0) {
    return null;
  }

  return {
    event: largestEvent,
    estimatedBytes: largestBytes
  };
}

export function finalizePackageAssemblyResult(input: {
  packageObject: ErrorPackage;
  config: ResolvedConfig;
  encryption?: Encryption | null;
  sdkVersion?: string;
}): PackageAssemblyResult {
  const { packageObject } = input;
  const encrypted = input.encryption !== null && input.encryption !== undefined;
  packageObject.completeness.encrypted = encrypted;

  const serializedPackage = JSON.stringify(packageObject);
  const plaintextBuf = Buffer.from(serializedPackage, 'utf8');
  const sdkVersion = input.sdkVersion ?? getSdkVersion();

  const envelope = encrypted
    ? input.encryption!.encryptToEnvelope(plaintextBuf, {
        eventId: packageObject.eventId
      })
    : buildTransparentEnvelope(plaintextBuf, {
        eventId: packageObject.eventId,
        sdkVersion
      });

  return {
    packageObject,
    payload: JSON.stringify(envelope),
    envelope
  };
}

export function finalizePayloadBlobAssemblyResult(input: {
  envelopeObject: PayloadBlobEnvelope;
  config: ResolvedConfig;
  encryption?: Encryption | null;
  sdkVersion?: string;
}): PackageAssemblyResult {
  const serializedPackage = JSON.stringify(input.envelopeObject);
  const plaintextBuf = Buffer.from(serializedPackage, 'utf8');
  const sdkVersion = input.sdkVersion ?? getSdkVersion();
  const encrypted = input.encryption !== null && input.encryption !== undefined;
  const envelope = encrypted
    ? input.encryption!.encryptToEnvelope(plaintextBuf, {
        eventId: input.envelopeObject.eventId
      })
    : buildTransparentEnvelope(plaintextBuf, {
        eventId: input.envelopeObject.eventId,
        sdkVersion
      });

  return {
    packageObject: undefined as never,
    payload: JSON.stringify(envelope),
    envelope
  };
}

export function buildPackageAssemblyResult(input: {
  parts: ErrorPackageParts;
  config: ResolvedConfig;
  encryption?: Encryption | null;
}): PackageAssemblyResult {
  const scrubber = new PiiScrubber(input.config);
  const builder = new PackageBuilder({
    scrubber,
    config: input.config,
    encryption: input.encryption
  });

  return finalizePackageAssemblyResult({
    packageObject: builder.build(input.parts),
    config: input.config,
    encryption: input.encryption
  });
}

export class PackageBuilder {
  private readonly scrubber: PiiScrubber;

  private readonly fieldScrubber: FieldScrubber;

  private readonly config: ResolvedConfig;

  public constructor(deps: {
    scrubber: PiiScrubber;
    config: ResolvedConfig;
    encryption?: Encryption | null;
  }) {
    this.scrubber = deps.scrubber;
    this.config = deps.config;
    this.fieldScrubber = new FieldScrubber(this.config.scrubberPolicy, {
      encryption: deps.encryption ?? null,
      onWarning: this.config.onInternalWarning
    });
  }

  public build(parts: ErrorPackageParts): ErrorPackage {
    const serializedTimeline = parts.ioTimeline.map((event) =>
      serializeIOEvent(event, this.scrubber)
    );
    const serializedStateReads = parts.stateReads.map((read) =>
      serializeStateRead(read)
    );
    const serializedStateWrites = parts.stateWrites.map((write) =>
      serializeStateWrite(write)
    );
    const serializedEvictionLog = parts.evictionLog.map(serializeEvictionRecord);

    // Layer 3: frame-index alignment between captured locals and rendered stack
    let alignedLocalVariables = parts.localVariables;
    let frameAlignment: 'full' | 'prefix_only' | undefined;
    if (Array.isArray(parts.localVariables) && parts.localVariables.length > 0) {
      const renderedFrameCount = countRenderedStackFrames(parts.error.stack);
      const { aligned, alignment } = alignLocalVariableFrames(
        parts.localVariables,
        renderedFrameCount
      );
      alignedLocalVariables = aligned;
      frameAlignment = alignment;
    }

    let minSeq = parts.errorEventSeq;
    let maxSeq = parts.errorEventSeq;
    for (const e of parts.ioTimeline) {
      if (e.seq < minSeq) minSeq = e.seq;
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    for (const r of parts.stateReads) {
      if (r.seq < minSeq) minSeq = r.seq;
      if (r.seq > maxSeq) maxSeq = r.seq;
    }
    for (const w of parts.stateWrites) {
      if (w.seq < minSeq) minSeq = w.seq;
      if (w.seq > maxSeq) maxSeq = w.seq;
    }
    const eventClockRange = { min: minSeq, max: maxSeq };
    const serializedError = scrubErrorInfoFilePaths(parts.error, this.scrubber);
    const scrubbedLocalVariables = scrubCapturedFrameFilePaths(
      alignedLocalVariables,
      this.scrubber
    );

    const packageObject: ErrorPackage = {
      schemaVersion: '1.2.0',
      eventId: randomUUID(),
      service: this.config.service,
      capturedAt: new Date().toISOString(),
      errorEventSeq: parts.errorEventSeq,
      errorEventHrtimeNs: parts.errorEventHrtimeNs.toString(),
      eventClockRange,
      fingerprint: parts.fingerprint,
      errorOrigin: analyzeStackOwnership(parts.error.stack, parts.error.type),
      timeAnchor: { ...parts.timeAnchor },
      error: {
        ...serializedError
      },
      localVariables: scrubbedLocalVariables ?? undefined,
      request:
        parts.requestContext === undefined
          ? undefined
          : {
              id: parts.requestContext.requestId,
              method: parts.requestContext.method,
              url: this.scrubber.scrubUrl(parts.requestContext.url),
              headers: { ...parts.requestContext.headers },
              body:
                parts.requestContext.body === null
                  ? undefined
                  : (parts.requestContext.body as unknown as string | object),
              bodyTruncated: parts.requestContext.bodyTruncated || undefined,
              receivedAt: approximateIsoFromHrtime(
                parts.requestContext.startTime,
                parts.timeAnchor
              )
            },
      ioTimeline: serializedTimeline,
      evictionLog: serializedEvictionLog,
      ambientContext: parts.ambientContext,
      stateReads: serializedStateReads,
      stateWrites: serializedStateWrites,
      concurrentRequests: parts.concurrentRequests.map((summary) => ({ ...summary })),
      processMetadata: { ...parts.processMetadata },
      codeVersion: { ...parts.codeVersion },
      environment: { ...parts.environment },
      trace: parts.traceContext ? {
        traceId: parts.traceContext.traceId,
        spanId: parts.traceContext.spanId,
        parentSpanId: parts.traceContext.parentSpanId,
        tracestate: parts.traceContext.tracestate,
        traceFlags: parts.traceContext.traceFlags,
        ...(parts.traceContext.isEntrySpan !== undefined
          ? { isEntrySpan: parts.traceContext.isEntrySpan }
          : {})
      } : undefined,
      completeness: this.computeCompleteness(parts, false, {
        ioTimeline: serializedTimeline,
        stateReads: serializedStateReads,
        concurrentRequests: parts.concurrentRequests
      }, frameAlignment)
    };

    // Early size estimate BEFORE scrubbing. If the raw package is far over
    // the limit, shed bodies first to avoid wasting CPU on PII-scrubbing
    // data that will be immediately discarded. Uses a rough estimate to
    // avoid a full JSON.stringify on the pre-scrub package.
    const maxPackageSize = this.config.serialization.maxTotalPackageSize;
    const roughSize = this.estimatePackageSizeRough(packageObject);
    if (roughSize > maxPackageSize * 2) {
      this.shedIfNeeded(packageObject, parts);
    }

    const scrubbedPackage = this.scrubber.scrubObject(packageObject) as ErrorPackage;

    if ((scrubbedPackage as { request?: ErrorPackage['request'] | null }).request === null) {
      delete (scrubbedPackage as { request?: ErrorPackage['request'] | null }).request;
    }

    if (
      (scrubbedPackage as { localVariables?: ErrorPackage['localVariables'] | null })
        .localVariables === null
    ) {
      delete (scrubbedPackage as {
        localVariables?: ErrorPackage['localVariables'] | null;
      }).localVariables;
    }

    this.normalizePackageArrays(scrubbedPackage);
    this.fieldizePackage(scrubbedPackage);
    scrubbedPackage.completeness = this.computeCompleteness(parts, false, scrubbedPackage, frameAlignment);
    this.shedIfNeeded(scrubbedPackage, parts, frameAlignment);
    this.enforceHardCap(scrubbedPackage, parts, frameAlignment);

    return scrubbedPackage;
  }

  /**
   * Last-resort downgrade for packages that exceed the spec's 1 MB hard
   * cap. Drops fields in priority order, marking the package's
   * `truncated.droppedFields` so the receiver can surface the loss.
   *
   * Called AFTER scrubbing and `shedIfNeeded`, before encryption. The
   * 1 MB target is approximate (we measure the JSON-stringified pkg
   * plus a small envelope-overhead estimate); the receiver's authority
   * is the actual envelope length on the wire.
   */
  private enforceHardCap(
    pkg: ErrorPackage,
    parts: ErrorPackageParts,
    frameAlignment?: 'full' | 'prefix_only'
  ): void {
    const hardCap = this.config.hardCapBytes;
    const ENVELOPE_OVERHEAD_ESTIMATE = 256;
    const estimateSize = (): number =>
      Buffer.byteLength(JSON.stringify(pkg), 'utf8') + ENVELOPE_OVERHEAD_ESTIMATE;

    if (estimateSize() <= hardCap) return;

    const dropped: string[] = [];
    const markTruncated = (): void => {
      pkg.truncated = { reason: 'hard_cap_1mb', droppedFields: [...dropped] };
      pkg.completeness = this.computeCompleteness(
        parts,
        pkg.completeness.encrypted,
        pkg,
        frameAlignment
      );
    };

    if (pkg.localVariables !== undefined) {
      delete pkg.localVariables;
      dropped.push('localVariables');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.ioTimeline.length > 50) {
      pkg.ioTimeline = pkg.ioTimeline.slice(-50);
      dropped.push('ioTimeline:trim50');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    let strippedBodies = false;
    for (const event of pkg.ioTimeline) {
      if (event.requestBody !== null) {
        event.requestBody = null;
        event.requestBodyTruncated = true;
        strippedBodies = true;
      }
      if (event.responseBody !== null) {
        event.responseBody = null;
        event.responseBodyTruncated = true;
        strippedBodies = true;
      }
    }
    if (strippedBodies) {
      dropped.push('ioTimeline:bodies');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.stateReads.length > 0) {
      pkg.stateReads = [];
      dropped.push('stateReads');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.concurrentRequests.length > 0) {
      pkg.concurrentRequests = [];
      dropped.push('concurrentRequests');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.ambientContext !== undefined) {
      delete pkg.ambientContext;
      dropped.push('ambientContext');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.evictionLog.length > 0) {
      pkg.evictionLog = [];
      dropped.push('evictionLog');
      markTruncated();
      if (estimateSize() <= hardCap) return;
    }

    if (pkg.stateWrites.length > 0) {
      pkg.stateWrites = [];
      dropped.push('stateWrites');
      markTruncated();
    }
    // Even after all sheds, if still over cap the caller (encrypt path)
    // is responsible for emitting EC_PACKAGE_OVER_HARD_CAP. We don't
    // throw here: a too-large package is preferable to losing the event
    // entirely; the receiver can still see whatever it does fit.
  }

  private normalizePackageArrays(pkg: ErrorPackage): void {
    const mutable = pkg as ErrorPackage & {
      ioTimeline: unknown;
      evictionLog: unknown;
      stateReads: unknown;
      stateWrites: unknown;
      concurrentRequests: unknown;
      localVariables?: unknown;
    };

    mutable.ioTimeline = normalizeScrubbedArray<IOEventSerialized>(mutable.ioTimeline);
    mutable.evictionLog = normalizeScrubbedArray<EvictionRecordSerialized>(mutable.evictionLog);
    mutable.stateReads = normalizeScrubbedArray<StateReadSerialized>(mutable.stateReads);
    mutable.stateWrites = normalizeScrubbedArray<StateWriteSerialized>(mutable.stateWrites);
    mutable.concurrentRequests = normalizeScrubbedArray<RequestSummary>(mutable.concurrentRequests);

    if (Object.prototype.hasOwnProperty.call(mutable, 'localVariables')) {
      const localVariables = normalizeScrubbedArray<CapturedFrame>(mutable.localVariables);
      if (localVariables.length > 0 || Array.isArray(mutable.localVariables)) {
        mutable.localVariables = localVariables;
      } else {
        delete mutable.localVariables;
      }
    }
  }

  private fieldizePackage(pkg: ErrorPackage): void {
    routeRawCapturedValues(pkg, this.config.scrubberPolicy);

    if (pkg.localVariables !== undefined) {
      for (const frame of pkg.localVariables) {
        frame.locals = this.fieldizeRecord(frame.locals, 'app');
      }
    }

    if (pkg.request !== undefined) {
      pkg.request.headers = this.fieldizeRecord(pkg.request.headers, 'http_incoming');
      if (pkg.request.body !== undefined) {
        pkg.request.body = this.fieldizeCapturedValue('body', pkg.request.body, 'http_incoming');
      }
    }

    for (const event of pkg.ioTimeline) {
      const requestSource = this.getIORequestSource(event);
      if (event.requestHeaders !== null) {
        event.requestHeaders = this.fieldizeRecord(event.requestHeaders, requestSource);
      }
      if (event.responseHeaders !== null) {
        event.responseHeaders = this.fieldizeRecord(event.responseHeaders, 'app');
      }
      if (event.requestBody !== null) {
        event.requestBody = this.fieldizeIORequestBody(event, requestSource);
      }
      if (event.responseBody !== null) {
        event.responseBody = this.fieldizeCapturedValue('responseBody', event.responseBody, 'app');
      }
    }

    for (const read of pkg.stateReads) {
      read.key = this.fieldizeCapturedValue('key', read.key, 'app');
      read.value = this.fieldizeCapturedValue('value', read.value, 'app');
    }

    for (const write of pkg.stateWrites) {
      write.key = this.fieldizeCapturedValue('key', write.key, 'app');
      write.value = this.fieldizeCapturedValue('value', write.value, 'app');
    }
  }

  private fieldizeRecord(
    record: Record<string, unknown>,
    source: Source
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = this.fieldizeCapturedValue(key, value, source);
    }
    return out;
  }

  private fieldizeCapturedValue(name: string, value: unknown, source: Source): unknown {
    return this.fieldScrubber.process(name, value, source);
  }

  private fieldizeIORequestBody(event: IOEventSerialized, source: Source): unknown {
    if (
      source === 'http_incoming' &&
      event.requestPayloadRef?.storage === 'spool'
    ) {
      return this.fieldScrubber.processRef(
        'requestBody',
        event.requestBody,
        source,
        {
          id: event.requestPayloadRef.blobId,
          bytes: event.requestPayloadRef.size
        }
      );
    }

    return this.fieldizeCapturedValue('requestBody', event.requestBody, source);
  }

  private getIORequestSource(event: IOEventSerialized): Source {
    return event.type === 'http-server' && event.direction === 'inbound'
      ? 'http_incoming'
      : 'app';
  }

  private shedIfNeeded(pkg: ErrorPackage, parts: ErrorPackageParts, frameAlignment?: 'full' | 'prefix_only'): void {
    const maxPackageSize = this.config.serialization.maxTotalPackageSize;
    let currentPackageSize = this.getPackageSize(pkg);

    if (currentPackageSize <= maxPackageSize) {
      return;
    }

    // Strip bodies from the largest IO events until the estimate is under the
    // limit. Use estimated subtraction inside the loop to avoid re-serializing
    // the entire package on every iteration. Re-measure exactly ONCE after the
    // loop for accuracy.
    let strippedAnyBody = false;
    while (currentPackageSize > maxPackageSize) {
      const largestBody = findLargestBodyEvent(pkg.ioTimeline);
      if (largestBody === null) {
        break;
      }

      const { event, estimatedBytes } = largestBody;

      if (event.requestBody !== null) {
        event.requestBody = null;
        event.requestBodyTruncated = true;
      }

      if (event.responseBody !== null) {
        event.responseBody = null;
        event.responseBodyTruncated = true;
      }

      currentPackageSize -= estimatedBytes;
      strippedAnyBody = true;
    }

    // Single re-serialization after the loop to get an accurate measurement.
    // This value is reused for the subsequent timeline/stateReads shedding
    // decisions to avoid additional full serializations.
    if (strippedAnyBody) {
      currentPackageSize = this.getPackageSize(pkg);
    }

    if (currentPackageSize > maxPackageSize && parts.usedAmbientEvents) {
      pkg.ioTimeline = [];
      // Don't re-measure - clearing the timeline always reduces size.
    }

    if (currentPackageSize > maxPackageSize) {
      pkg.stateReads = [];
    }

    pkg.completeness = this.computeCompleteness(
      parts,
      pkg.completeness.encrypted,
      pkg,
      frameAlignment
    );
  }

  private computeCompleteness(
    parts: ErrorPackageParts,
    encrypted: boolean,
    pkg: Pick<
      ErrorPackage,
      'request' | 'ioTimeline' | 'stateReads' | 'localVariables' | 'concurrentRequests'
    >,
    frameAlignment?: 'full' | 'prefix_only'
  ): Completeness {
    const ioPayloadsTruncated = pkg.ioTimeline.reduce((count, event) => {
      return count + Number(event.requestBodyTruncated) + Number(event.responseBodyTruncated);
    }, 0);
    const stateTrackingEnabled = parts.stateTrackingEnabled;

    return {
      requestCaptured: pkg.request !== undefined,
      requestBodyTruncated: pkg.request?.bodyTruncated ?? false,
      ioTimelineCaptured: pkg.ioTimeline.length > 0,
      usedAmbientEvents: parts.usedAmbientEvents,
      ioEventsDropped: parts.ioEventsDropped,
      ioPayloadsTruncated,
      alsContextAvailable: parts.alsContextAvailable,
      localVariablesCaptured:
        Array.isArray(pkg.localVariables) && pkg.localVariables.length > 0,
      localVariablesTruncated:
        (pkg.localVariables?.length ?? 0) > this.config.maxLocalsFrames,
      stateTrackingEnabled,
      stateReadsCaptured: pkg.stateReads.length > 0,
      stateWritesDropped: parts.completenessOverflow?.stateWritesDropped,
      concurrentRequestsCaptured: pkg.concurrentRequests.length > 0,
      piiScrubbed: true,
      encrypted,
      captureFailures: [...parts.captureFailures],
      rateLimiterDrops: parts.rateLimiterDrops,
      localVariablesCaptureLayer: parts.localVariablesCaptureLayer,
      localVariablesDegradation: parts.localVariablesDegradation,
      localVariablesFrameAlignment: frameAlignment ?? parts.localVariablesFrameAlignment,
      sourceMapResolution: parts.sourceMapResolution
    };
  }

  private estimatePackageSizeRough(pkg: ErrorPackage): number {
    let estimate = 4096; // base overhead for metadata, completeness, etc.
    estimate += Buffer.byteLength(pkg.error.stack, 'utf8');
    estimate += Buffer.byteLength(pkg.error.message, 'utf8');
    for (const event of pkg.ioTimeline) {
      estimate += 256; // per-event metadata overhead
      estimate += estimateBodySize(event.requestBody);
      estimate += estimateBodySize(event.responseBody);
    }
    return estimate;
  }

  private getPackageSize(pkg: ErrorPackage): number {
    return Buffer.byteLength(JSON.stringify(pkg), 'utf8');
  }
}
