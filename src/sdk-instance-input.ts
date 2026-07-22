import type { IOEventBuffer } from './buffer/io-event-buffer';
import type { ALSManager } from './context/als-manager';
import type { RequestTracker } from './context/request-tracker';
import type { RequestContextCarrier } from './context/request-context-carrier';
import type { HeaderFilter } from './pii/header-filter';
import type { InspectorManager } from './capture/inspector-manager';
import type { BodyCapture } from './recording/body-capture';
import type { PayloadSpool } from './spool/payload-spool';
import type { StateTracker } from './state/state-tracker';
import type { HttpServerRecorder } from './recording/http-server';
import type { HttpClientRecorder } from './recording/http-client';
import type { UndiciRecorder } from './recording/undici';
import type { NetDnsRecorder } from './recording/net-dns';
import type { PatchManager } from './recording/patches/patch-manager';
import type { ChannelSubscriber } from './recording/channel-subscriber';
import type { TransportDispatcher } from './transport/transport';
import type { DeadLetterStore } from './transport/dead-letter-store';
import type { ErrorCapturer } from './capture/error-capturer';
import type { PackageAssemblyDispatcher } from './capture/package-assembly-dispatcher';
import type { SourceMapResolver } from './capture/source-map-resolver';
import type { ProcessMetadata } from './capture/process-metadata';
import type { WatchdogManager } from './middleware/watchdog';
import type { HealthMetrics } from './health/health-metrics';
import type { PackageAssemblyEncryptionConfig, ResolvedConfig } from './types';

export interface DeadLetterHealthState {
  enabled: boolean;
  signed: boolean;
  reason: 'configured' | 'not_configured' | 'unsigned';
}

export interface ProcessListenerEntry {
  event: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection' | 'beforeExit' | 'exit';
  handler: (...args: any[]) => void;
  once?: boolean;
}

export interface SDKInstanceInput {
  config: ResolvedConfig;
  buffer: IOEventBuffer;
  als: ALSManager;
  requestTracker: RequestTracker;
  headerFilter: HeaderFilter;
  inspector: InspectorManager;
  channelSubscriber: ChannelSubscriber;
  patchManager: PatchManager;
  stateTracker: StateTracker;
  errorCapturer: ErrorCapturer;
  transport: TransportDispatcher;
  processMetadata: ProcessMetadata;
  httpServerRecorder: HttpServerRecorder;
  httpClientRecorder: HttpClientRecorder;
  undiciRecorder: UndiciRecorder;
  netDnsRecorder: NetDnsRecorder;
  bodyCapture: BodyCapture;
  deadLetterStore: DeadLetterStore | null;
  watchdog: WatchdogManager | null;
  healthMetrics: HealthMetrics;
  deadLetterHealth: DeadLetterHealthState;
  requestContextCarrier: RequestContextCarrier;
  payloadSpool: PayloadSpool | null;
  sourceMapResolver: SourceMapResolver | null;
  packageAssemblyDispatcher: PackageAssemblyDispatcher | null;
  packageAssemblyEncryption: PackageAssemblyEncryptionConfig | undefined;
  packageAssemblyWorkerAllowed: boolean;
}
