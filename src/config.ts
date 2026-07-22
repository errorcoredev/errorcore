
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  PublicTransportConfig,
  ResolvedConfig,
  SDKConfig,
  SerializationLimits,
  TransportConfig
} from './types';
import {
  pickModeRelevantUserConfig,
  resolveCaptureModeSelection,
  resolveModeState
} from './capture-mode';
import { safeConsole } from './debug-log';
import { resolveScrubberPolicy } from './scrubber/policy';

export { resolveCaptureMode, resolveModeState } from './capture-mode';

let legacyInsecureTransportWarned = false;
function warnLegacyInsecureTransportOnce(): void {
  if (legacyInsecureTransportWarned) return;
  legacyInsecureTransportWarned = true;
  safeConsole.warn(
    '[ErrorCore] allowInsecureTransport is deprecated and ignored. ' +
    'Remove it from your config. (Deprecated in 0.2.1, will be removed in 1.0.0.) ' +
    'Use allowPlainHttpTransport to enable plain-http collector URLs.'
  );
}
// Test-only reset for the one-shot flag.
export function __resetLegacyInsecureTransportWarning(): void {
  legacyInsecureTransportWarned = false;
}

const DEFAULT_SERIALIZATION: SerializationLimits = {
  maxDepth: 8,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxStringLength: 2048,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880
};

const DEFAULT_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'user-agent',
  'x-request-id',
  'x-correlation-id',
  'host',
  'traceparent',
  'tracestate',
  // Operational headers that aren't PII but materially help debugging.
  // The blocklist below still filters auth/secret-y values regardless.
  'idempotency-key',
  'x-idempotency-key',
  'etag',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'range',
  'content-range',
  'vary',
  'retry-after',
  'cache-control'
];

// Default blocklist for outbound/inbound header capture. Three layers, narrow
// to broad. The previous broad alternation /auth|token|key|secret|password|
// credential/i used substring matches without word boundaries, which silently
// killed operational headers like idempotency-key (matched via "key").
const DEFAULT_HEADER_BLOCKLIST = [
  // Exact-match: well-known auth/cookie/api-key headers.
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-refresh-token|x-csrf-token|x-secret-token)$/i,
  // Auth-prefix compounds: api-key, auth-token, secret-key, session-secret, etc.
  /\b(api|auth|access|secret|session|bearer|private|client|refresh)[-_]?(key|token|secret|password)\b/i,
  // Standalone sensitive nouns. Word boundaries let `keystone` survive while
  // `password`/`passwords`/`credential`/`credentials` get blocked.
  /\b(passwords?|passwd|credentials?)\b/i
];

const DEFAULT_ENV_ALLOWLIST = [
  'NODE_ENV',
  'NODE_VERSION',
  'PORT',
  'HOST',
  'TZ',
  'LANG',
  'npm_package_version',
  'HOSTNAME',
  'POD_NAME',
  'POD_NAMESPACE',
  'POD_IP',
  'NODE_NAME',
  'KUBERNETES_SERVICE_HOST',
  'ECS_CONTAINER_METADATA_URI',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'CLOUD_RUN_JOB',
  'K_SERVICE',
  'K_REVISION',
  'RENDER_SERVICE_NAME',
  'FLY_APP_NAME',
  'FLY_REGION',
  'DEPLOYMENT_ID',
  'IMAGE_TAG',
  'REPLICA_SET'
];

const DEFAULT_ENV_BLOCKLIST = [/key|secret|token|password|passcode|passphrase|passwd|credential|auth|private/i];
const DEFAULT_DEAD_LETTER_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_DEAD_LETTER_MAX_BACKUPS = 5;
const DEFAULT_WEBHOOK_BATCH_SIZE = 100;
const DEFAULT_WEBHOOK_MAX_DELAY_MS = 10_000;
const DEFAULT_WEBHOOK_RETRIES = 5;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
const DEFAULT_WEBHOOK_MAX_BUFFER_EVENTS = 1_000;
const DEFAULT_BODY_CAPTURE_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
  'application/xml'
];

const ERRORCORE_API_KEY_PATTERN = /^ec_live_[A-Za-z0-9_-]{32,128}$/;

/**
 * Resolve the private HTTP credential independently of PublicTransportConfig.
 * Keeping this value on the runtime-only path prevents SDKInstance.config from
 * exposing either first-class API keys or legacy Authorization values.
 */
export function getTransportAuthorization(
  transport: TransportConfig | undefined
): string | undefined {
  if (transport?.type !== 'http') {
    return undefined;
  }

  const hasExplicitApiKey = transport.apiKey !== undefined;
  const hasExplicitAuthorization = transport.authorization !== undefined;

  if (hasExplicitApiKey && hasExplicitAuthorization) {
    throw new Error(
      'HTTP transport authentication is ambiguous: configure transport.apiKey or transport.authorization, not both.'
    );
  }

  if (hasExplicitAuthorization) {
    if (
      typeof transport.authorization !== 'string' ||
      transport.authorization.trim().length === 0
    ) {
      throw new Error(
        'transport.authorization must be a non-empty string for HTTP transport.'
      );
    }

    return transport.authorization;
  }

  const apiKey = hasExplicitApiKey
    ? transport.apiKey
    : process.env.ERRORCORE_API_KEY;
  const source = hasExplicitApiKey
    ? 'transport.apiKey'
    : 'ERRORCORE_API_KEY';

  if (apiKey === undefined) {
    throw new Error(
      'HTTP transport authentication is required. Set transport.apiKey (preferred), ERRORCORE_API_KEY, or transport.authorization for a legacy/custom collector.'
    );
  }

  if (typeof apiKey !== 'string' || !ERRORCORE_API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      `${source} must match /^ec_live_[A-Za-z0-9_-]{32,128}$/. Generate or copy a valid ErrorCore ingestion API key.`
    );
  }

  return `Bearer ${apiKey}`;
}

function assertNonNegativeInteger(
  value: number,
  fieldName: string
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

function hexKeyEntropy(key: string): number {
  const length = key.length;
  if (length === 0) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < length; i++) {
    const ch = key[i].toLowerCase();
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isWebpackBundled(): boolean {
  try {
    return typeof __webpack_require__ !== 'undefined';
  } catch {
    return false;
  }
}

declare const __webpack_require__: unknown;

export function detectServerlessEnvironment(): boolean {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
  if (process.env.FUNCTIONS_WORKER_RUNTIME) return true;
  if (process.env.K_SERVICE && process.env.K_REVISION) return true;
  if (process.env.VERCEL) return true;
  if (/^AWS_Lambda_/i.test(process.env.AWS_EXECUTION_ENV ?? '')) return true;
  return false;
}

function resolveFieldScrubberPolicy(
  userConfig: Partial<SDKConfig>
): ResolvedConfig['scrubberPolicy'] {
  const input = userConfig.scrubberPolicy;

  if (input !== undefined) {
    if (
      input.credentialNames !== undefined &&
      !(input.credentialNames instanceof RegExp)
    ) {
      throw new Error('scrubberPolicy.credentialNames must be a RegExp');
    }

    if (
      input.piiDetectors !== undefined &&
      (!Array.isArray(input.piiDetectors) ||
        !input.piiDetectors.every((detector) => typeof detector === 'function'))
    ) {
      throw new Error('scrubberPolicy.piiDetectors must be an array of functions');
    }

    for (const fieldName of ['maxKeys', 'spoolBytes', 'maxField'] as const) {
      const value = input[fieldName];
      if (value !== undefined) {
        assertPositiveInteger(value, `scrubberPolicy.${fieldName}`);
      }
    }
  }

  return resolveScrubberPolicy(input);
}

function assertPositiveInteger(
  value: number,
  fieldName: string,
  extraConstraint?: (candidate: number) => string | null
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  if (extraConstraint) {
    const message = extraConstraint(value);

    if (message !== null) {
      throw new Error(message);
    }
  }
}

function resolveSerializationLimits(
  userConfig: Partial<SDKConfig>
): SerializationLimits {
  const resolved: SerializationLimits = {
    ...DEFAULT_SERIALIZATION,
    ...userConfig.serialization
  };

  assertPositiveInteger(resolved.maxDepth, 'serialization.maxDepth');
  assertPositiveInteger(resolved.maxArrayItems, 'serialization.maxArrayItems');
  assertPositiveInteger(resolved.maxObjectKeys, 'serialization.maxObjectKeys');
  assertPositiveInteger(resolved.maxStringLength, 'serialization.maxStringLength');
  assertPositiveInteger(resolved.maxPayloadSize, 'serialization.maxPayloadSize');
  assertPositiveInteger(
    resolved.maxTotalPackageSize,
    'serialization.maxTotalPackageSize'
  );

  return resolved;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function resolveConfig(userConfig: Partial<SDKConfig> = {}): ResolvedConfig {
  const { adaptiveCapture, captureMode } = resolveCaptureModeSelection(userConfig);
  const transport: SDKConfig['transport'] | undefined =
    userConfig.transport ??
    (isProduction() ? undefined : { type: 'stdout' });

  const serverless =
    userConfig.serverless === true ? true :
    userConfig.serverless === false ? false :
    detectServerlessEnvironment();

  let bufferSize = userConfig.bufferSize ?? (serverless ? 50 : 200);
  let bufferMaxBytes = userConfig.bufferMaxBytes ?? (serverless ? 5242880 : 52428800);
  const maxPayloadSize = userConfig.maxPayloadSize ?? 32768;
  const payloadSpoolConfig = userConfig.payloadSpool ?? {};
  const payloadSpoolGlobalMaxBytes =
    payloadSpoolConfig.globalMaxBytes ?? (serverless ? 8 * 1024 * 1024 : 64 * 1024 * 1024);
  const payloadSpoolPerRequestMaxBytes =
    payloadSpoolConfig.perRequestMaxBytes ?? (serverless ? 512 * 1024 : 2 * 1024 * 1024);
  const payloadSpoolPerBlobMaxBytes =
    payloadSpoolConfig.perBlobMaxBytes ?? 512 * 1024;
  const payloadSpoolPreviewBytes = payloadSpoolConfig.previewBytes ?? 8 * 1024;
  const payloadSpoolCompletedTtlMs = payloadSpoolConfig.completedTtlMs ?? 60000;
  const maxConcurrentRequests = userConfig.maxConcurrentRequests ?? 50;
  const rateLimitPerMinute = userConfig.rateLimitPerMinute ?? 60;
  const rateLimitWindowMs = userConfig.rateLimitWindowMs ?? 60000;
  const maxLocalsCollectionsPerSecond =
    userConfig.maxLocalsCollectionsPerSecond ?? 20;
  const maxCachedLocals = userConfig.maxCachedLocals ?? 50;
  const uncaughtExceptionExitDelayMs =
    userConfig.uncaughtExceptionExitDelayMs ?? 1500;
  const maxDrainOnStartup = userConfig.maxDrainOnStartup ?? (serverless ? 0 : 100);
  const legacyInsecureTransport = (userConfig as { allowInsecureTransport?: unknown })
    .allowInsecureTransport;
  if (legacyInsecureTransport === true) {
    if (userConfig.allowPlainHttpTransport === false) {
      throw new Error(
        'Config contradiction: allowInsecureTransport: true and allowPlainHttpTransport: false cannot both be set. ' +
        'Remove allowInsecureTransport (deprecated) and set allowPlainHttpTransport: true if you intend to allow plain HTTP.'
      );
    }
    throw new Error(
      'allowInsecureTransport: true was renamed to allowPlainHttpTransport: true in 0.2.1. ' +
      'Update your config. (Deprecated in 0.2.1, will be removed in 1.0.0.)'
    );
  }
  if (legacyInsecureTransport === false) {
    warnLegacyInsecureTransportOnce();
  }
  const allowPlainHttpTransport = userConfig.allowPlainHttpTransport ?? false;
  const allowInvalidCollectorCertificates =
    userConfig.allowInvalidCollectorCertificates ?? false;

  assertPositiveInteger(bufferSize, 'bufferSize', (candidate) => {
    if (candidate < 10 || candidate > 100000) {
      return 'bufferSize must be between 10 and 100000';
    }

    return null;
  });

  assertPositiveInteger(bufferMaxBytes, 'bufferMaxBytes', (candidate) => {
    if (candidate < 1048576) {
      return 'bufferMaxBytes must be at least 1048576';
    }

    return null;
  });

  assertPositiveInteger(maxPayloadSize, 'maxPayloadSize', (candidate) => {
    if (candidate < 1024) {
      return 'maxPayloadSize must be at least 1024';
    }

    if (candidate > bufferMaxBytes) {
      return 'maxPayloadSize must be less than or equal to bufferMaxBytes';
    }

    return null;
  });
  assertPositiveInteger(payloadSpoolGlobalMaxBytes, 'payloadSpool.globalMaxBytes');
  assertPositiveInteger(payloadSpoolPerRequestMaxBytes, 'payloadSpool.perRequestMaxBytes');
  assertPositiveInteger(payloadSpoolPerBlobMaxBytes, 'payloadSpool.perBlobMaxBytes');
  assertPositiveInteger(payloadSpoolPreviewBytes, 'payloadSpool.previewBytes');
  assertPositiveInteger(payloadSpoolCompletedTtlMs, 'payloadSpool.completedTtlMs');

  assertPositiveInteger(maxConcurrentRequests, 'maxConcurrentRequests');
  assertPositiveInteger(rateLimitPerMinute, 'rateLimitPerMinute');
  assertPositiveInteger(rateLimitWindowMs, 'rateLimitWindowMs', (candidate) => {
    if (candidate < 1000) {
      return 'rateLimitWindowMs must be at least 1000';
    }

    return null;
  });
  assertPositiveInteger(
    uncaughtExceptionExitDelayMs,
    'uncaughtExceptionExitDelayMs'
  );
  assertNonNegativeInteger(maxDrainOnStartup, 'maxDrainOnStartup');

  const deadLetterMaxBytes =
    userConfig.deadLetterMaxBytes ?? DEFAULT_DEAD_LETTER_MAX_BYTES;
  assertPositiveInteger(deadLetterMaxBytes, 'deadLetterMaxBytes');

  const deadLetterMaxBackups =
    userConfig.deadLetterMaxBackups ?? DEFAULT_DEAD_LETTER_MAX_BACKUPS;
  assertNonNegativeInteger(deadLetterMaxBackups, 'deadLetterMaxBackups');

  if (transport === undefined) {
    throw new Error(
      'transport must be configured explicitly in production.\n' +
      'Set NODE_ENV to "development" for automatic stdout transport, or configure one:\n' +
      '  transport: { type: \'stdout\' }          // local development\n' +
      '  transport: { type: \'file\', path: ... }  // controlled environments\n' +
      '  transport: { type: \'http\', url: ... }   // production collectors'
    );
  }

  // The DEK can come from config.encryptionKey, the ERRORCORE_DEK env
  // var, or an async callback. Validate the explicit-config form here;
  // the env-var path is read at SDK init.
  const resolvedEncryptionKey = userConfig.encryptionKey
    ?? (process.env.ERRORCORE_DEK !== undefined && process.env.ERRORCORE_DEK !== ''
      ? process.env.ERRORCORE_DEK
      : undefined);

  if (
    resolvedEncryptionKey !== undefined &&
    !/^[0-9a-f]{64}$/i.test(resolvedEncryptionKey)
  ) {
    throw new Error(
      'encryptionKey must be a 64-character hex string (32 bytes). ' +
      'Generate one with: ' +
      'node -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\') + \'\\n\')"'
    );
  }

  const resolvedMacKey = userConfig.macKey
    ?? (process.env.ERRORCORE_MAC_KEY !== undefined && process.env.ERRORCORE_MAC_KEY !== ''
      ? process.env.ERRORCORE_MAC_KEY
      : undefined);

  if (
    resolvedMacKey !== undefined &&
    !/^[0-9a-f]{64}$/i.test(resolvedMacKey)
  ) {
    throw new Error(
      'macKey must be a 64-character hex string (32 bytes). ' +
      'Generate one with: ' +
      'node -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\') + \'\\n\')"'
    );
  }

  if (
    userConfig.encryptionKeyCallback !== undefined &&
    typeof userConfig.encryptionKeyCallback !== 'function'
  ) {
    throw new Error('encryptionKeyCallback must be a function or undefined');
  }

  if (resolvedEncryptionKey !== undefined) {
    // Shannon entropy over the hex alphabet (max 4.0 bits per character).
    // A uniformly random 32-byte hex key scores ~3.93. Threshold of 3.5
    // rejects trivially repetitive keys (all-zeros, single-letter, short
    // repeating patterns) while still passing any key generated from
    // crypto.randomBytes.
    const characterDistribution = hexKeyEntropy(resolvedEncryptionKey);
    if (characterDistribution < 3.5) {
      throw new Error(
        'encryptionKey has insufficient character diversity (all-zeros, repeated characters, or trivially predictable). ' +
        'Generate a random key with: ' +
        'node -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\') + \'\\n\')"'
      );
    }
  }

  const previousEncryptionKeys = userConfig.previousEncryptionKeys ?? [];
  if (!Array.isArray(previousEncryptionKeys)) {
    throw new Error('previousEncryptionKeys must be an array of 64-character hex strings');
  }

  const previousTransportAuthorizations =
    userConfig.previousTransportAuthorizations ?? [];
  if (!Array.isArray(previousTransportAuthorizations)) {
    throw new Error('previousTransportAuthorizations must be an array of strings');
  }
  if (!previousTransportAuthorizations.every((value) => typeof value === 'string')) {
    throw new Error('previousTransportAuthorizations must be an array of strings');
  }
  if (previousEncryptionKeys.length > 5) {
    throw new Error('previousEncryptionKeys must contain at most 5 entries');
  }
  for (const prev of previousEncryptionKeys) {
    if (typeof prev !== 'string' || !/^[0-9a-f]{64}$/i.test(prev)) {
      throw new Error(
        'previousEncryptionKeys entries must each be a 64-character hex string (32 bytes)'
      );
    }
    if (hexKeyEntropy(prev) < 3.5) {
      throw new Error(
        'previousEncryptionKeys entry has insufficient character diversity'
      );
    }
    if (userConfig.encryptionKey !== undefined && prev === userConfig.encryptionKey) {
      throw new Error(
        'previousEncryptionKeys must not include the primary key (encryptionKey)'
      );
    }
  }

  if (
    userConfig.piiScrubber !== undefined &&
    typeof userConfig.piiScrubber !== 'function'
  ) {
    throw new Error('piiScrubber must be a function or undefined');
  }

  if (
    userConfig.onInternalWarning !== undefined &&
    typeof userConfig.onInternalWarning !== 'function'
  ) {
    throw new Error('onInternalWarning must be a function or undefined');
  }

  const drivers = userConfig.drivers ?? {};
  if (typeof drivers !== 'object' || drivers === null || Array.isArray(drivers)) {
    throw new Error('drivers must be an object with pg/mongodb/mysql2/ioredis references');
  }

  const silent = userConfig.silent ?? false;
  if (typeof silent !== 'boolean') {
    throw new Error('silent must be a boolean');
  }

  const logLevel = userConfig.logLevel ?? 'warn';
  if (
    logLevel !== 'silent' &&
    logLevel !== 'error' &&
    logLevel !== 'warn' &&
    logLevel !== 'info' &&
    logLevel !== 'debug'
  ) {
    throw new Error(
      "logLevel must be one of 'silent' | 'error' | 'warn' | 'info' | 'debug'"
    );
  }

  const sourceMapSyncThresholdBytes =
    userConfig.sourceMapSyncThresholdBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isInteger(sourceMapSyncThresholdBytes) ||
    sourceMapSyncThresholdBytes < 0
  ) {
    throw new Error('sourceMapSyncThresholdBytes must be a non-negative integer');
  }

  const vendorKey = userConfig.traceContext?.vendorKey ?? 'ec';
  if (!/^[a-z0-9_\-*\/]{1,256}$/.test(vendorKey)) {
    throw new Error(
      'traceContext.vendorKey must match the W3C tracestate vendor-key grammar [a-z0-9_\\-*\\/]{1,256}'
    );
  }

  const captureWrites = userConfig.stateTracking?.captureWrites ?? true;
  if (typeof captureWrites !== 'boolean') {
    throw new Error('stateTracking.captureWrites must be a boolean');
  }
  const maxWritesPerContext =
    userConfig.stateTracking?.maxWritesPerContext ?? 50;
  assertNonNegativeInteger(
    maxWritesPerContext,
    'stateTracking.maxWritesPerContext'
  );

  const captureMiddlewareStatusCodes = userConfig.captureMiddlewareStatusCodes ?? 'none';
  if (
    captureMiddlewareStatusCodes !== 'none' &&
    captureMiddlewareStatusCodes !== 'all' &&
    !Array.isArray(captureMiddlewareStatusCodes)
  ) {
    throw new Error(
      `captureMiddlewareStatusCodes must be 'none', 'all', or integer[]`
    );
  }
  if (Array.isArray(captureMiddlewareStatusCodes)) {
    for (const code of captureMiddlewareStatusCodes) {
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        throw new Error(
          `captureMiddlewareStatusCodes entries must be integers 100-599; got ${String(code)}`
        );
      }
    }
  }

  for (const [fieldName, value] of [
    ['headerAllowlist', userConfig.headerAllowlist],
    ['envAllowlist', userConfig.envAllowlist],
  ] as const) {
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        throw new Error(`${fieldName} must be an array of strings`);
      }
    }
  }

  for (const [fieldName, value] of [
    ['headerBlocklist', userConfig.headerBlocklist],
    ['envBlocklist', userConfig.envBlocklist],
  ] as const) {
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.every((v) => v instanceof RegExp)) {
        throw new Error(`${fieldName} must be an array of RegExp`);
      }
    }
  }

  if (transport.type === 'http' || transport.type === 'webhook') {
    try {
      const parsed = new URL(transport.url);

      if (parsed.protocol !== 'https:' && !allowPlainHttpTransport) {
        throw new Error(
          transport.type === 'webhook'
            ? 'Webhook transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
            : 'HTTP transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
        );
      }
    } catch (urlError) {
      if (urlError instanceof TypeError) {
        throw new Error(
          transport.type === 'webhook'
            ? `Webhook transport URL is invalid: ${transport.url}`
            : `HTTP transport URL is invalid: ${transport.url}`
        );
      }

      throw urlError;
    }

    if (transport.timeoutMs !== undefined) {
      assertPositiveInteger(transport.timeoutMs, 'transport.timeoutMs');
    }

    if (transport.type === 'http') {
      if (
        transport.protocol !== undefined &&
        transport.protocol !== 'auto' &&
        transport.protocol !== 'http1' &&
        transport.protocol !== 'http2'
      ) {
        throw new Error("transport.protocol must be one of 'auto' | 'http1' | 'http2'");
      }

      if (transport.protocol === 'http2' && new URL(transport.url).protocol !== 'https:') {
        throw new Error('transport.protocol: "http2" requires an https:// collector URL; h2c is not supported');
      }

      // Validate authentication during config resolution while keeping the
      // resolved/public transport object free of secret values.
      getTransportAuthorization(transport);
    }
  }

  if (transport.type === 'webhook') {
    for (const [fieldName, value] of [
      ['transport.batchSize', transport.batchSize],
      ['transport.maxDelayMs', transport.maxDelayMs],
      ['transport.retries', transport.retries],
      ['transport.timeoutMs', transport.timeoutMs],
      ['transport.maxBufferEvents', transport.maxBufferEvents]
    ] as const) {
      if (value !== undefined) {
        assertPositiveInteger(value, fieldName);
      }
    }
  }

  const resolvedTransport: PublicTransportConfig =
    transport.type === 'http'
      ? {
          type: 'http',
          url: transport.url,
          ...(transport.timeoutMs === undefined ? {} : { timeoutMs: transport.timeoutMs }),
          protocol: transport.protocol ?? 'auto',
          ...(transport.maxBackups === undefined ? {} : { maxBackups: transport.maxBackups })
        }
      : transport.type === 'webhook'
        ? {
            type: 'webhook',
            url: transport.url,
            batchSize: transport.batchSize ?? DEFAULT_WEBHOOK_BATCH_SIZE,
            maxDelayMs: transport.maxDelayMs ?? DEFAULT_WEBHOOK_MAX_DELAY_MS,
            retries: transport.retries ?? DEFAULT_WEBHOOK_RETRIES,
            timeoutMs: transport.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
            maxBufferEvents: transport.maxBufferEvents ?? DEFAULT_WEBHOOK_MAX_BUFFER_EVENTS,
            storePath: transport.storePath ?? path.join(process.cwd(), '.errorcore', 'events.ndjson'),
            retainOnAck: transport.retainOnAck ?? true
          }
      : transport;

  if (userConfig.useWorkerAssembly === true && isWebpackBundled()) {
    safeConsole.warn(
      '[ErrorCore] useWorkerAssembly is enabled but a bundled environment was detected. ' +
      'Worker threads may not function correctly in bundlers - the SDK will fall back to main-thread processing at runtime.'
    );
  }
  const deadLetterPath = serverless && userConfig.deadLetterPath === undefined
    ? undefined
    : resolveDeadLetterPath(userConfig, transport);

  if (deadLetterPath !== undefined) {
    try {
      const dir = path.dirname(deadLetterPath);
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      safeConsole.warn(
        `[ErrorCore] Dead-letter directory is not writable: ${path.dirname(deadLetterPath)}. ` +
        'Dead-letter persistence will fail unless the directory is created before the first transport failure.'
      );
    }
  }

  if (serverless && transport.type === 'file') {
    safeConsole.warn(
      '[ErrorCore] File transport in a serverless environment writes to ephemeral disk. Consider using HTTP transport instead.'
    );
  }

  // §A14 production guard. If we're in production, posting via HTTP, with
  // allowUnencrypted: true, with no DEK from any source, and no explicit
  // allowProductionPlaintext: true, the SDK refuses to start. The triple-
  // flag combo is intentional friction. The KMS-callback path counts as
  // "key configured" because the SDK will resolve a real DEK at activate().
  const allowUnencryptedResolved = userConfig.allowUnencrypted ?? !isProduction();
  const allowProductionPlaintextResolved = userConfig.allowProductionPlaintext ?? false;
  const hasResolvableKey =
    resolvedEncryptionKey !== undefined ||
    userConfig.encryptionKeyCallback !== undefined;
  if (
    isProduction() &&
    transport.type === 'http' &&
    allowUnencryptedResolved &&
    !hasResolvableKey &&
    !allowProductionPlaintextResolved
  ) {
    throw new Error(
      'EC_PRODUCTION_PLAINTEXT_BYPASS: Refusing to start in production with HTTP transport, ' +
      'allowUnencrypted: true, and no encryption key (config, ERRORCORE_DEK, or encryptionKeyCallback). ' +
      'Either configure a DEK, or set allowProductionPlaintext: true to acknowledge plaintext-on-the-wire ' +
      'in production (not recommended).'
    );
  }

  const modeRelevantUserConfig = pickModeRelevantUserConfig(userConfig);
  const modeState = resolveModeState(
    modeRelevantUserConfig,
    {
      serverless,
      payloadSpool: {
        globalMaxBytes: payloadSpoolGlobalMaxBytes,
        perRequestMaxBytes: payloadSpoolPerRequestMaxBytes,
        perBlobMaxBytes: payloadSpoolPerBlobMaxBytes,
        previewBytes: payloadSpoolPreviewBytes,
        completedTtlMs: payloadSpoolCompletedTtlMs
      },
      maxLocalsCollectionsPerSecond,
      maxCachedLocals
    },
    captureMode
  );

  return {
    captureMode: modeState.captureMode,
    localVariablesMode: modeState.localVariablesMode,
    capabilities: modeState.capabilities,
    recorders: modeState.recorders,
    modeState,
    adaptiveCapture,
    userConfig: modeRelevantUserConfig,
    bufferSize,
    bufferMaxBytes,
    maxPayloadSize,
    maxConcurrentRequests,
    rateLimitPerMinute,
    rateLimitWindowMs,
    headerAllowlist: [...(userConfig.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST)],
    headerBlocklist: [...(userConfig.headerBlocklist ?? DEFAULT_HEADER_BLOCKLIST)],
    envAllowlist: [...(userConfig.envAllowlist ?? DEFAULT_ENV_ALLOWLIST)],
    envBlocklist: [...(userConfig.envBlocklist ?? DEFAULT_ENV_BLOCKLIST)],
    encryptionKey: resolvedEncryptionKey,
    macKey: resolvedMacKey,
    encryptionKeyCallback: userConfig.encryptionKeyCallback,
    previousEncryptionKeys: [...previousEncryptionKeys],
    previousTransportAuthorizations: [...previousTransportAuthorizations],
    // Default matches the transport default above (isProduction() gate): in
    // development (NODE_ENV !== 'production') plaintext is allowed and the
    // stdout transport is injected automatically; in production encryption
    // is required. Keep both defaults tied to the same isProduction() check
    // or the zero-config dev path breaks.
    allowUnencrypted: userConfig.allowUnencrypted ?? !isProduction(),
    allowProductionPlaintext: userConfig.allowProductionPlaintext ?? false,
    hardCapBytes: userConfig.hardCapBytes ?? 1_048_576,
    transport: resolvedTransport,
    captureLocalVariables: modeState.captureLocalVariables,
    localsGuard: modeState.localsGuard,
    captureDbBindParams: modeState.captureDbBindParams,
    captureRequestBodies: modeState.captureRequestBodies,
    captureResponseBodies: modeState.captureResponseBodies,
    captureBody: modeState.captureBody,
    captureBodyDigest: modeState.captureBodyDigest,
    payloadSpool: modeState.payloadSpool,
    bodyCaptureContentTypes: [
      ...(userConfig.bodyCaptureContentTypes ?? DEFAULT_BODY_CAPTURE_CONTENT_TYPES)
    ],
    piiScrubber: userConfig.piiScrubber,
    replaceDefaultScrubber: userConfig.replaceDefaultScrubber ?? false,
    scrubberPolicy: resolveFieldScrubberPolicy(userConfig),
    serialization: resolveSerializationLimits(userConfig),
    maxLocalsCollectionsPerSecond: modeState.maxLocalsCollectionsPerSecond,
    maxCachedLocals: modeState.maxCachedLocals,
    maxLocalsFrames: modeState.maxLocalsFrames,
    uncaughtExceptionExitDelayMs,
    allowPlainHttpTransport,
    allowInvalidCollectorCertificates,
    deadLetterPath,
    deadLetterMaxBytes,
    deadLetterMaxBackups,
    maxDrainOnStartup,
    useWorkerAssembly: modeState.useWorkerAssembly,
    flushIntervalMs: modeState.flushIntervalMs,
    resolveSourceMaps: modeState.resolveSourceMaps,
    serverless,
    onInternalWarning: userConfig.onInternalWarning,
    drivers,
    silent,
    logLevel,
    sourceMapSyncThresholdBytes,
    captureMiddlewareStatusCodes,
    traceContext: { vendorKey },
    stateTracking: { captureWrites, maxWritesPerContext },
    service: resolveServiceName(userConfig.service),
    deploymentEnv:
      userConfig.deploymentEnv ??
      (typeof process.env.ERRORCORE_ENVIRONMENT === 'string' && process.env.ERRORCORE_ENVIRONMENT.length > 0
        ? process.env.ERRORCORE_ENVIRONMENT
        : undefined)
  };
}

function resolveServiceName(explicit: string | undefined): string {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit;
  }
  if (typeof process.env.OTEL_SERVICE_NAME === 'string' && process.env.OTEL_SERVICE_NAME.length > 0) {
    return process.env.OTEL_SERVICE_NAME;
  }
  if (typeof process.env.npm_package_name === 'string' && process.env.npm_package_name.length > 0) {
    return process.env.npm_package_name;
  }
  return 'unknown-service';
}

function resolveDeadLetterPath(
  userConfig: Partial<SDKConfig>,
  transport: SDKConfig['transport']
): string | undefined {
  if (userConfig.deadLetterPath !== undefined) {
    return userConfig.deadLetterPath;
  }

  if (transport !== undefined && transport.type === 'file') {
    return path.join(path.dirname(transport.path), '.errorcore-dead-letters.ndjson');
  }

  if (transport !== undefined && (transport.type === 'http' || transport.type === 'webhook')) {
    return path.join(process.cwd(), '.errorcore-dead-letters.ndjson');
  }

  return undefined;
}
