const fs = require('fs')
const path = require('path')

const errorcore = require('errorcore')
const Redis = require('ioredis')

const capturePath = process.env.ERRORCORE_CAPTURE_PATH || path.join(process.cwd(), '.errorcore', 'enrich-svc.ndjson')
fs.mkdirSync(path.dirname(capturePath), { recursive: true })

if (process.env.ERRORCORE_DISABLED !== 'true') {
  errorcore.init({
    service: process.env.OTEL_SERVICE_NAME || 'enrich-svc',
    deploymentEnv: process.env.ERRORCORE_ENVIRONMENT || 'validation',
    transport: {
      type: 'file',
      path: capturePath,
      maxBackups: 10,
    },
    allowUnencrypted: true,
    allowProductionPlaintext: true,
    captureLocalVariables: true,
    maxCachedLocals: 1000,
    maxLocalsCollectionsPerSecond: 200,
    captureDbBindParams: true,
    captureRequestBodies: true,
    captureResponseBodies: true,
    captureBody: true,
    captureBodyDigest: true,
    captureMiddlewareStatusCodes: [500],
    uncaughtExceptionExitDelayMs: 3000,
    resolveSourceMaps: true,
    sourceMapSyncThresholdBytes: 104857600,
    traceContext: {
      vendorKey: process.env.ERRORCORE_TRACE_VENDOR_KEY || 'ec',
    },
    drivers: {
      ioredis: Redis,
    },
    logLevel: process.env.ERRORCORE_LOG_LEVEL || 'warn',
    onInternalWarning(warning) {
      if (process.env.ERRORCORE_DEBUG) {
        console.error('[errorcore internal warning]', warning)
      }
    },
  })
}

module.exports = errorcore
