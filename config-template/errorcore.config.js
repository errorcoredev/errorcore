// errorcore.config.js - errorcore configuration
// Copy this file into your project root and enable the settings you need.

module.exports = {
  // Configure exactly one transport for your environment.

  // Recommended for production collectors.
  // transport: {
  //   type: 'http',
  //   url: 'https://collector.example.com/v1/errors',
  //   authorization: 'Bearer <collector-token>',
  //   timeoutMs: 5000,
  //   maxBackups: 5,
  // },

  // Local file transport for controlled environments.
  // transport: {
  //   type: 'file',
  //   path: '/var/log/errorcore/errors.ndjson',
  //   maxSizeBytes: 104857600,
  //   maxBackups: 5,
  // },

  // Local-development only. Stdout writes captured payloads into application logs.
  // transport: { type: 'stdout' },

  captureLocalVariables: false,

  // Deprecated compatibility alias. When true, this enables both request and response body capture.
  captureBody: false,
  captureRequestBodies: false,
  captureResponseBodies: false,
  captureBodyDigest: false,
  captureDbBindParams: false,

  bodyCaptureContentTypes: [
    'application/json',
    'application/x-www-form-urlencoded',
    'text/plain',
    'application/xml'
  ],

  // Provide a 64-character hex key (32 bytes) for payload encryption.
  // Use an environment variable — never hardcode secrets in config files.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryptionKey: process.env.ERRORCORE_ENCRYPTION_KEY,
  // IMPORTANT: Set to false and configure encryptionKey via ERRORCORE_ENCRYPTION_KEY
  // before deploying to production.
  allowUnencrypted: true,

  // Deprecated compatibility alias: allowInsecureTransport maps only to plain HTTP.
  allowInsecureTransport: false,
  allowPlainHttpTransport: false,

  // Local-development only. This disables TLS certificate validation for HTTPS collectors.
  allowInvalidCollectorCertificates: false,

  headerAllowlist: [
    'content-type',
    'content-length',
    'accept',
    'user-agent',
    'x-request-id',
    'x-correlation-id',
    'host'
  ],

  headerBlocklist: [
    /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
    /auth|token|key|secret|password|credential/i
  ],

  envAllowlist: [
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
  ],

  envBlocklist: [
    /key|secret|token|password|credential|auth|private/i
  ],

  piiScrubber: undefined,
  replaceDefaultScrubber: false,

  serialization: {
    maxDepth: 8,
    maxArrayItems: 20,
    maxObjectKeys: 50,
    maxStringLength: 2048,
    maxPayloadSize: 32768,
    maxTotalPackageSize: 5242880
  },

  rateLimitPerMinute: 60,
  rateLimitWindowMs: 60000,

  bufferSize: 200,
  bufferMaxBytes: 52428800,
  maxPayloadSize: 32768,
  maxConcurrentRequests: 50,
  maxLocalsCollectionsPerSecond: 20,
  maxCachedLocals: 50,
  maxLocalsFrames: 5,
  uncaughtExceptionExitDelayMs: 1500,
  useWorkerAssembly: false,
  deadLetterPath: undefined,

  // Resolve minified stack traces using source maps at capture time.
  // Requires your bundler to emit .map files for server-side code.
  // For Next.js, add to next.config.mjs:
  //   webpack: (config, { isServer }) => {
  //     if (isServer) config.devtool = "source-map";
  //     return config;
  //   },
  resolveSourceMaps: true,
};
