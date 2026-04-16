
import { Scrubber } from '../pii/scrubber';
import { Encryption } from '../security/encryption';
import type {
  CapturedFrame,
  Completeness,
  EvictionRecord,
  EvictionRecordSerialized,
  ErrorInfo,
  ErrorPackage,
  ErrorPackageParts,
  IOEventSlot,
  IOEventSerialized,
  PackageAssemblyResult,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  StateRead,
  StateReadSerialized,
  TimeAnchor
} from '../types';

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

function serializeIOEvent(event: IOEventSlot, scrubber: Scrubber): IOEventSerialized {
  return {
    seq: event.seq,
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
    container: read.container,
    operation: read.operation,
    key: read.key,
    value: read.value,
    timestamp: read.timestamp.toString()
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

function signSerializedPackage(
  serializedPackage: string,
  encryption: Encryption | null | undefined
): string | null {
  if (!encryption) {
    return null;
  }

  return encryption.sign(serializedPackage);
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
}): PackageAssemblyResult {
  const { packageObject, config } = input;
  const serializedPackageForSignature = JSON.stringify(packageObject);
  const integritySignature = signSerializedPackage(
    serializedPackageForSignature,
    input.encryption
  );

  if (integritySignature !== null) {
    packageObject.integrity = {
      algorithm: 'HMAC-SHA256',
      signature: integritySignature
    };
  }

  const encrypted = config.encryptionKey !== undefined;
  packageObject.completeness.encrypted = encrypted;
  const serializedPackage =
    integritySignature === null && !encrypted
      ? serializedPackageForSignature
      : JSON.stringify(packageObject);

  const payload = !encrypted
    ? serializedPackage
    : JSON.stringify(
        (input.encryption ?? new Encryption(config.encryptionKey as string))
          .encrypt(serializedPackage)
      );

  return {
    packageObject,
    payload
  };
}

export function buildPackageAssemblyResult(input: {
  parts: ErrorPackageParts;
  config: ResolvedConfig;
  encryption?: Encryption | null;
}): PackageAssemblyResult {
  const scrubber = new Scrubber(input.config);
  const builder = new PackageBuilder({
    scrubber,
    config: input.config
  });

  return finalizePackageAssemblyResult({
    packageObject: builder.build(input.parts),
    config: input.config,
    encryption: input.encryption
  });
}

export class PackageBuilder {
  private readonly scrubber: Scrubber;

  private readonly config: ResolvedConfig;

  public constructor(deps: { scrubber: Scrubber; config: ResolvedConfig }) {
    this.scrubber = deps.scrubber;
    this.config = deps.config;
  }

  public build(parts: ErrorPackageParts): ErrorPackage {
    const serializedTimeline = parts.ioTimeline.map((event) =>
      serializeIOEvent(event, this.scrubber)
    );
    const serializedStateReads = parts.stateReads.map((read) =>
      serializeStateRead(read)
    );
    const serializedEvictionLog = parts.evictionLog.map(serializeEvictionRecord);

    const packageObject: ErrorPackage = {
      schemaVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      timeAnchor: { ...parts.timeAnchor },
      error: {
        ...parts.error
      },
      localVariables: parts.localVariables ?? undefined,
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
      concurrentRequests: parts.concurrentRequests.map((summary) => ({ ...summary })),
      processMetadata: { ...parts.processMetadata },
      codeVersion: { ...parts.codeVersion },
      environment: { ...parts.environment },
      trace: parts.traceContext ? {
        traceId: parts.traceContext.traceId,
        spanId: parts.traceContext.spanId,
        parentSpanId: parts.traceContext.parentSpanId
      } : undefined,
      completeness: this.computeCompleteness(parts, false, {
        ioTimeline: serializedTimeline,
        stateReads: serializedStateReads,
        concurrentRequests: parts.concurrentRequests
      })
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

    scrubbedPackage.completeness = this.computeCompleteness(parts, false, scrubbedPackage);
    this.shedIfNeeded(scrubbedPackage, parts);

    return scrubbedPackage;
  }

  private shedIfNeeded(pkg: ErrorPackage, parts: ErrorPackageParts): void {
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
      // Don't re-measure — clearing the timeline always reduces size.
    }

    if (currentPackageSize > maxPackageSize) {
      pkg.stateReads = [];
    }

    pkg.completeness = this.computeCompleteness(
      parts,
      pkg.completeness.encrypted,
      pkg
    );
  }

  private computeCompleteness(
    parts: ErrorPackageParts,
    encrypted: boolean,
    pkg: Pick<
      ErrorPackage,
      'request' | 'ioTimeline' | 'stateReads' | 'localVariables' | 'concurrentRequests'
    >
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
      concurrentRequestsCaptured: pkg.concurrentRequests.length > 0,
      piiScrubbed: true,
      encrypted,
      captureFailures: [...parts.captureFailures],
      rateLimiterDrops: parts.rateLimiterDrops
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
