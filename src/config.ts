
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  PublicTransportConfig,
  ResolvedConfig,
  SDKConfig,
  SerializationLimits
} from './types';

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
  'user-agent',
  'x-request-id',
  'x-correlation-id',
  'host',
  'traceparent'
];

const DEFAULT_HEADER_BLOCKLIST = [
  /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
  /auth|token|key|secret|password|credential/i
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

const DEFAULT_ENV_BLOCKLIST = [/key|secret|token|password|credential|auth|private/i];

const DEFAULT_BODY_CAPTURE_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
  'application/xml'
];

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
  if (process.env.AWS_EXECUTION_ENV) return true;
  return false;
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
  const maxConcurrentRequests = userConfig.maxConcurrentRequests ?? 50;
  const rateLimitPerMinute = userConfig.rateLimitPerMinute ?? 60;
  const rateLimitWindowMs = userConfig.rateLimitWindowMs ?? 60000;
  const maxLocalsCollectionsPerSecond =
    userConfig.maxLocalsCollectionsPerSecond ?? 20;
  const maxCachedLocals = userConfig.maxCachedLocals ?? 50;
  const maxLocalsFrames = userConfig.maxLocalsFrames ?? 5;
  const uncaughtExceptionExitDelayMs =
    userConfig.uncaughtExceptionExitDelayMs ?? 1500;
  const maxDrainOnStartup = userConfig.maxDrainOnStartup ?? (serverless ? 0 : 100);
  const explicitBodyControlsProvided =
    userConfig.captureRequestBodies !== undefined ||
    userConfig.captureResponseBodies !== undefined;
  const captureRequestBodies = explicitBodyControlsProvided
    ? userConfig.captureRequestBodies ?? false
    : userConfig.captureBody ?? false;
  const captureResponseBodies = explicitBodyControlsProvided
    ? userConfig.captureResponseBodies ?? false
    : userConfig.captureBody ?? false;
  const allowPlainHttpTransport =
    userConfig.allowPlainHttpTransport ?? userConfig.allowInsecureTransport ?? false;
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

  assertPositiveInteger(maxConcurrentRequests, 'maxConcurrentRequests');
  assertPositiveInteger(rateLimitPerMinute, 'rateLimitPerMinute');
  assertPositiveInteger(rateLimitWindowMs, 'rateLimitWindowMs', (candidate) => {
    if (candidate < 1000) {
      return 'rateLimitWindowMs must be at least 1000';
    }

    return null;
  });
  assertPositiveInteger(
    maxLocalsCollectionsPerSecond,
    'maxLocalsCollectionsPerSecond'
  );
  assertPositiveInteger(maxCachedLocals, 'maxCachedLocals');
  assertPositiveInteger(maxLocalsFrames, 'maxLocalsFrames');
  assertPositiveInteger(
    uncaughtExceptionExitDelayMs,
    'uncaughtExceptionExitDelayMs'
  );
  assertNonNegativeInteger(maxDrainOnStartup, 'maxDrainOnStartup');

  if (transport === undefined) {
    throw new Error(
      'transport must be configured explicitly in production.\n' +
      'Set NODE_ENV to "development" for automatic stdout transport, or configure one:\n' +
      '  transport: { type: \'stdout\' }          // local development\n' +
      '  transport: { type: \'file\', path: ... }  // controlled environments\n' +
      '  transport: { type: \'http\', url: ... }   // production collectors'
    );
  }

  if (
    userConfig.encryptionKey !== undefined &&
    !/^[0-9a-f]{64}$/i.test(userConfig.encryptionKey)
  ) {
    throw new Error(
      'encryptionKey must be a 64-character hex string (32 bytes). ' +
      'Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (userConfig.encryptionKey !== undefined) {
    const keyEntropy = hexKeyEntropy(userConfig.encryptionKey);
    if (keyEntropy < 2.0) {
      throw new Error(
        'encryptionKey has insufficient entropy (all-zeros, repeated characters, or trivially predictable). ' +
        'Generate a random key with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
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

  if (transport.type === 'http') {
    try {
      const parsed = new URL(transport.url);

      if (parsed.protocol !== 'https:' && !allowPlainHttpTransport) {
        throw new Error(
          'HTTP transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
        );
      }
    } catch (urlError) {
      if (urlError instanceof TypeError) {
        throw new Error(`HTTP transport URL is invalid: ${transport.url}`);
      }

      throw urlError;
    }

    if (transport.timeoutMs !== undefined) {
      assertPositiveInteger(transport.timeoutMs, 'transport.timeoutMs');
    }
  }

  const resolvedTransport: PublicTransportConfig =
    transport.type === 'http'
      ? {
          type: 'http',
          url: transport.url,
          ...(transport.timeoutMs === undefined ? {} : { timeoutMs: transport.timeoutMs }),
          ...(transport.maxBackups === undefined ? {} : { maxBackups: transport.maxBackups })
        }
      : transport;

  const useWorkerAssembly = userConfig.useWorkerAssembly ??
    (serverless ? false : true);

  if (userConfig.useWorkerAssembly === true && isWebpackBundled()) {
    console.warn(
      '[ErrorCore] useWorkerAssembly is enabled but a bundled environment was detected. ' +
      'Worker threads may not function correctly in bundlers — the SDK will fall back to main-thread processing at runtime.'
    );
  }
  const flushIntervalMs = userConfig.flushIntervalMs ??
    (serverless ? 0 : 5000);
  if (flushIntervalMs !== 0) {
    assertPositiveInteger(flushIntervalMs, 'flushIntervalMs', (candidate) => {
      if (candidate < 1000) {
        return 'flushIntervalMs must be at least 1000 (1 second) or 0 to disable';
      }
      return null;
    });
  }
  const deadLetterPath = serverless && userConfig.deadLetterPath === undefined
    ? undefined
    : resolveDeadLetterPath(userConfig, transport);

  if (deadLetterPath !== undefined) {
    try {
      const dir = path.dirname(deadLetterPath);
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      console.warn(
        `[ErrorCore] Dead-letter directory is not writable: ${path.dirname(deadLetterPath)}. ` +
        'Dead-letter persistence will fail unless the directory is created before the first transport failure.'
      );
    }
  }

  if (serverless && transport.type === 'file') {
    console.warn(
      '[ErrorCore] File transport in a serverless environment writes to ephemeral disk. Consider using HTTP transport instead.'
    );
  }

  return {
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
    encryptionKey: userConfig.encryptionKey,
    allowUnencrypted: userConfig.allowUnencrypted ?? !isProduction(),
    transport: resolvedTransport,
    captureLocalVariables: userConfig.captureLocalVariables ?? false,
    captureDbBindParams: userConfig.captureDbBindParams ?? false,
    captureRequestBodies,
    captureResponseBodies,
    captureBody: captureRequestBodies && captureResponseBodies,
    captureBodyDigest: userConfig.captureBodyDigest ?? false,
    bodyCaptureContentTypes: [
      ...(userConfig.bodyCaptureContentTypes ?? DEFAULT_BODY_CAPTURE_CONTENT_TYPES)
    ],
    piiScrubber: userConfig.piiScrubber,
    replaceDefaultScrubber: userConfig.replaceDefaultScrubber ?? false,
    serialization: resolveSerializationLimits(userConfig),
    maxLocalsCollectionsPerSecond,
    maxCachedLocals,
    maxLocalsFrames,
    uncaughtExceptionExitDelayMs,
    allowPlainHttpTransport,
    allowInvalidCollectorCertificates,
    allowInsecureTransport: allowPlainHttpTransport,
    deadLetterPath,
    maxDrainOnStartup,
    useWorkerAssembly,
    flushIntervalMs,
    resolveSourceMaps: userConfig.resolveSourceMaps ?? true,
    serverless,
    onInternalWarning: userConfig.onInternalWarning
  };
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

  if (transport !== undefined && transport.type === 'http') {
    return path.join(process.cwd(), '.errorcore-dead-letters.ndjson');
  }

  return undefined;
}
