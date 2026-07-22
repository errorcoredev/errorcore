import { getTransportAuthorization, resolveConfig } from './config';
import { safeConsole, setLogLevel } from './debug-log';
import { IOEventBuffer } from './buffer/io-event-buffer';
import { ALSManager } from './context/als-manager';
import { EventClock } from './context/event-clock';
import { RequestTracker } from './context/request-tracker';
import { RequestContextCarrier } from './context/request-context-carrier';
import { HeaderFilter } from './pii/header-filter';
import { Scrubber } from './pii/scrubber';
import { RateLimiter } from './security/rate-limiter';
import { Encryption } from './security/encryption';
import {
  createEncryptionFromAssemblyConfig,
  createPackageAssemblyEncryptionConfig
} from './security/encryption-runtime';
import { ProcessMetadata } from './capture/process-metadata';
import { InspectorManager } from './capture/inspector-manager';
import { BodyCapture } from './recording/body-capture';
import { PayloadSpool } from './spool/payload-spool';
import { StateTracker } from './state/state-tracker';
import { HttpServerRecorder } from './recording/http-server';
import { HttpClientRecorder } from './recording/http-client';
import { UndiciRecorder } from './recording/undici';
import { NetDnsRecorder } from './recording/net-dns';
import { PatchManager } from './recording/patches/patch-manager';
import { ChannelSubscriber } from './recording/channel-subscriber';
import { PackageBuilder } from './capture/package-builder';
import { TransportDispatcher } from './transport/transport';
import {
  DeadLetterStore,
  createHmacVerifier,
  type IntegrityVerifier
} from './transport/dead-letter-store';
import { ErrorCapturer } from './capture/error-capturer';
import { PackageAssemblyDispatcher } from './capture/package-assembly-dispatcher';
import { SourceMapResolver } from './capture/source-map-resolver';
import { WatchdogManager } from './middleware/watchdog';
import { HealthMetrics } from './health/health-metrics';
import type {
  ModeState,
  ResolvedConfig,
  SDKConfig,
  TransportConfig
} from './types';
import type { SDKInstance } from './sdk';
import type { DeadLetterHealthState, SDKInstanceInput } from './sdk-instance-input';

function getWebhookSecret(
  transport: TransportConfig | undefined
): string | undefined {
  return transport?.type === 'webhook' ? transport.secret : undefined;
}

function deriveDeadLetterVerifier(
  encryption: Encryption | null,
  config: ResolvedConfig,
  transportAuthorization: string | undefined,
  webhookSecret?: string
): IntegrityVerifier | null {
  if (encryption !== null) {
    return {
      sign: (payload) => encryption.sign(payload),
      verifyKeyIndex: (payload, mac) => {
        const result = encryption.verify(payload, mac);
        return result.ok ? result.keyIndex : null;
      }
    };
  }

  const fallback = config.encryptionKey ?? transportAuthorization ?? webhookSecret;
  if (fallback === undefined) return null;
  return createHmacVerifier([
    fallback,
    ...config.previousTransportAuthorizations
  ]);
}

function normalizeCallbackEncryptionKey(value: string | Buffer): string {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      throw new Error('encryptionKeyCallback must return a 32-byte Buffer or 64-character hex string');
    }
    return value.toString('hex');
  }

  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('encryptionKeyCallback must return a 32-byte Buffer or 64-character hex string');
  }
  return value;
}

function resolveEncryptionKeyCallback(config: ResolvedConfig): ResolvedConfig {
  if (config.encryptionKey !== undefined || config.encryptionKeyCallback === undefined) {
    return config;
  }

  const resolved = config.encryptionKeyCallback();
  if (
    typeof resolved === 'object' &&
    resolved !== null &&
    typeof (resolved as unknown as Promise<unknown>).then === 'function'
  ) {
    throw new Error(
      'encryptionKeyCallback returned a Promise, but createSDK()/init() are synchronous. Resolve the key before calling createSDK(), or use a synchronous callback.'
    );
  }

  return {
    ...config,
    encryptionKey: normalizeCallbackEncryptionKey(resolved as string | Buffer)
  };
}

export function createSDKComposition(
  userConfig: Partial<SDKConfig>,
  instantiate: (input: SDKInstanceInput) => SDKInstance
): SDKInstance {
  const config = resolveEncryptionKeyCallback(resolveConfig(userConfig));
  setLogLevel(config.logLevel);
  const transportAuthorization = getTransportAuthorization(userConfig.transport);
  const webhookSecret = getWebhookSecret(userConfig.transport);
  const eventClock = new EventClock();
  const buffer = new IOEventBuffer({
    capacity: config.bufferSize,
    maxBytes: config.bufferMaxBytes,
    eventClock,
    storeContextEvents: false
  });
  const als = new ALSManager({ eventClock, config });
  const requestContextCarrier = new RequestContextCarrier();
  const headerFilter = new HeaderFilter(config);
  als.setHeaderFilter((headers) => headerFilter.filterAndNormalizeHeaders(headers));
  const scrubber = new Scrubber(config);
  const rateLimiter = new RateLimiter({
    maxCaptures: config.rateLimitPerMinute,
    windowMs: config.rateLimitWindowMs
  });
  const packageAssemblyEncryption = createPackageAssemblyEncryptionConfig(config);
  const encryption = createEncryptionFromAssemblyConfig(packageAssemblyEncryption);
  const processMetadata = new ProcessMetadata(config);
  const inspector = new InspectorManager(config, {
    getRequestId: () => als.getRequestId(),
    eventClock
  });
  let bodyCaptureForCleanup: BodyCapture | null = null;
  const requestTracker = new RequestTracker({
    maxConcurrent: config.maxConcurrentRequests,
    ttlMs: 300000,
    onRemove: (context) => {
      const cleanup = setTimeout(() => {
        const activeBodyCapture = bodyCaptureForCleanup;
        if (activeBodyCapture === null) {
          return;
        }
        buffer.releaseCompletedRequest(
          context.requestId,
          (slot) => activeBodyCapture.releaseSlotBodies(slot)
        );
        for (const slot of context.ioEvents) {
          buffer.compactDetachedSlot(
            slot,
            (entry) => activeBodyCapture.releaseSlotBodies(entry)
          );
        }
        context.ioEvents.length = 0;
        context.stateReads.length = 0;
        context.stateWrites.length = 0;
        context.body = null;
        context.bodyTruncated = false;
        context.headers = {};
        context.completenessOverflow = undefined;
      }, 1000);
      if (typeof cleanup.unref === 'function') {
        cleanup.unref();
      }
    }
  });
  const healthMetrics = new HealthMetrics();
  let errorCapturerForSpool: ErrorCapturer | null = null;
  let modeProvider: (() => ModeState) | null = null;
  let onAdmittedCapture: ((modeState: ModeState) => void) | null = null;
  const payloadSpool = config.payloadSpool.enabled
    ? new PayloadSpool({
        globalMaxBytes: config.payloadSpool.globalMaxBytes,
        perRequestMaxBytes: config.payloadSpool.perRequestMaxBytes,
        perBlobMaxBytes: config.payloadSpool.perBlobMaxBytes,
        previewBytes: config.payloadSpool.previewBytes,
        completedTtlMs: config.payloadSpool.completedTtlMs,
        getTransportQueueDepth: () =>
          errorCapturerForSpool?.getPendingTransportCount() ?? 0,
        onWarning: (warning) => {
          if (warning.code === 'EC_PAYLOAD_SPOOL_PRESSURE') {
            healthMetrics.recordPayloadSpoolPressure();
          } else if (warning.code === 'EC_PAYLOAD_SPOOL_PREVIEW') {
            healthMetrics.recordPayloadSpoolPreviewFallback();
          } else if (warning.code === 'EC_PAYLOAD_SPOOL_DROPPED') {
            healthMetrics.recordPayloadSpoolDrop();
          }

          try {
            config.onInternalWarning?.(warning);
          } catch {
            // onInternalWarning must never crash the host.
          }
        }
      })
    : null;
  const bodyCapture = new BodyCapture({
    maxPayloadSize: config.maxPayloadSize,
    captureRequestBodies: config.captureRequestBodies,
    captureResponseBodies: config.captureResponseBodies,
    captureBodyDigest: config.captureBodyDigest,
    bodyCaptureContentTypes: config.bodyCaptureContentTypes,
    scrubber,
    ...(payloadSpool === null ? {} : { payloadSpool })
  });
  bodyCaptureForCleanup = bodyCapture;
  const stateTracker = new StateTracker({ als, eventClock, config });
  const httpServerRecorder = new HttpServerRecorder({
    buffer,
    als,
    requestTracker,
    bodyCapture,
    headerFilter,
    scrubber,
    config,
    payloadSpool,
    requestContextCarrier
  });
  const httpClientRecorder = new HttpClientRecorder({
    buffer,
    als,
    bodyCapture,
    headerFilter
  });
  const undiciRecorder = new UndiciRecorder({
    buffer,
    als,
    headerFilter,
    bodyCapture
  });
  const netDnsRecorder = new NetDnsRecorder({
    buffer,
    als,
    autoInstall: false
  });
  const patchManager = new PatchManager({ buffer, als, config });
  const channelSubscriber = new ChannelSubscriber({
    httpServer: httpServerRecorder,
    httpClient: httpClientRecorder,
    undiciRecorder,
    netDns: netDnsRecorder
  });
  const packageBuilder = new PackageBuilder({ scrubber, config, encryption });
  const transport = new TransportDispatcher({
    config,
    encryption,
    transportAuthorization,
    webhookSecret
  });
  const deadLetterVerifier = deriveDeadLetterVerifier(
    encryption,
    config,
    transportAuthorization,
    webhookSecret
  );
  const deadLetterStore =
    config.deadLetterPath !== undefined
      ? deadLetterVerifier === null
        ? null
        : new DeadLetterStore(config.deadLetterPath, {
            verifier: deadLetterVerifier,
            maxSizeBytes: config.deadLetterMaxBytes,
            maxBackups: config.deadLetterMaxBackups,
            maxPayloadBytes: config.serialization.maxTotalPackageSize + 16384,
            requireEncryptedPayload: config.encryptionKey !== undefined,
            onInternalWarning: config.onInternalWarning === undefined
              ? undefined
              : (warning) => {
                  try {
                    config.onInternalWarning!(warning);
                  } catch {
                    // onInternalWarning must never crash the host.
                  }
                }
          })
      : null;

  if (config.deadLetterPath !== undefined && deadLetterVerifier === null) {
    safeConsole.warn(
      '[ErrorCore] Dead-letter persistence is disabled because no encryptionKey or HTTP authorization secret is configured.'
    );
    try {
      config.onInternalWarning?.({
        code: 'EC_DLQ_DISABLED',
        message: 'Dead-letter persistence is disabled because no stable signing secret is configured.',
        context: { reason: 'unsigned' }
      });
    } catch {
      // onInternalWarning must never crash the host.
    }
  }
  const deadLetterHealth: DeadLetterHealthState =
    config.deadLetterPath === undefined
      ? { enabled: false, signed: false, reason: 'not_configured' }
      : deadLetterStore === null
        ? { enabled: false, signed: false, reason: 'unsigned' }
        : { enabled: true, signed: true, reason: 'configured' };
  const sourceMapResolver = config.resolveSourceMaps
    ? new SourceMapResolver({
        sourceMapSyncThresholdBytes: config.sourceMapSyncThresholdBytes
      })
    : null;

  if (sourceMapResolver !== null) {
    sourceMapResolver.warmCache();
  }
  const hasCustomFieldDetectors = userConfig.scrubberPolicy?.piiDetectors !== undefined;
  const packageAssemblyDispatcher = config.useWorkerAssembly && !hasCustomFieldDetectors
    ? new PackageAssemblyDispatcher({ config, encryption: packageAssemblyEncryption })
    : null;
  let watchdog: WatchdogManager | null = null;
  if (config.serverless && config.transport.type === 'http') {
    watchdog = new WatchdogManager(config, transportAuthorization);
    watchdog.start();
  }

  const errorCapturer = new ErrorCapturer({
    buffer,
    als,
    inspector,
    rateLimiter,
    requestTracker,
    processMetadata,
    packageBuilder,
    transport,
    encryption,
    bodyCapture,
    config,
    eventClock,
    packageAssemblyDispatcher,
    stateTrackerStatus: stateTracker,
    deadLetterStore,
    sourceMapResolver,
    watchdog,
    healthMetrics,
    payloadSpool,
    modeProvider: () => modeProvider!(),
    onAdmittedCapture: (modeState) => onAdmittedCapture?.(modeState)
  });
  errorCapturerForSpool = errorCapturer;

  const instance = instantiate({
    config,
    buffer,
    als,
    requestTracker,
    headerFilter,
    inspector,
    channelSubscriber,
    patchManager,
    stateTracker,
    errorCapturer,
    transport,
    processMetadata,
    httpServerRecorder,
    httpClientRecorder,
    undiciRecorder,
    netDnsRecorder,
    bodyCapture,
    deadLetterStore,
    watchdog,
    healthMetrics,
    deadLetterHealth,
    requestContextCarrier,
    payloadSpool,
    sourceMapResolver,
    packageAssemblyDispatcher,
    packageAssemblyEncryption,
    packageAssemblyWorkerAllowed: !hasCustomFieldDetectors
  });
  modeProvider = () => instance.getModeState();
  onAdmittedCapture = (modeState) => instance.handleAdmittedCapture(modeState);
  return instance;
}
