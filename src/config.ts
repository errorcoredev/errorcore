
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
  'host'
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

export function resolveConfig(userConfig: Partial<SDKConfig> = {}): ResolvedConfig {
  const transport = userConfig.transport;
  const bufferSize = userConfig.bufferSize ?? 200;
  const bufferMaxBytes = userConfig.bufferMaxBytes ?? 52428800;
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
  const maxDrainOnStartup = userConfig.maxDrainOnStartup ?? 100;
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
  assertPositiveInteger(maxDrainOnStartup, 'maxDrainOnStartup');

  if (transport === undefined) {
    throw new Error('transport must be configured explicitly');
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

  if (
    userConfig.piiScrubber !== undefined &&
    typeof userConfig.piiScrubber !== 'function'
  ) {
    throw new Error('piiScrubber must be a function or undefined');
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
    allowUnencrypted: userConfig.allowUnencrypted ?? false,
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
    replaceDefaultScrubber: false,
    serialization: resolveSerializationLimits(userConfig),
    maxLocalsCollectionsPerSecond,
    maxCachedLocals,
    maxLocalsFrames,
    uncaughtExceptionExitDelayMs,
    allowPlainHttpTransport,
    allowInvalidCollectorCertificates,
    allowInsecureTransport: allowPlainHttpTransport,
    deadLetterPath: resolveDeadLetterPath(userConfig, transport),
    maxDrainOnStartup,
    useWorkerAssembly: userConfig.useWorkerAssembly ?? false,
    flushIntervalMs: userConfig.flushIntervalMs ?? 5000,
    resolveSourceMaps: userConfig.resolveSourceMaps ?? true
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
