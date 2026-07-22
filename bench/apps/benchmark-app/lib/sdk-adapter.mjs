import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

function safeJson(value) {
  return JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === 'bigint') {
      return candidate.toString();
    }
    if (candidate instanceof Error) {
      return {
        name: candidate.name,
        message: candidate.message,
        stack: candidate.stack
      };
    }
    return candidate;
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeJson(body)
  });
  if (!response.ok) {
    throw new Error(`sink POST ${url} failed with HTTP ${response.status}`);
  }
}

function loadErrorcore() {
  const root = process.env.ERRORCORE_PACKAGE_ROOT;
  if (root !== undefined && root.length > 0) {
    return require(path.resolve(root));
  }
  return require('errorcore');
}

const ERRORCORE_CAPTURE_MODES_BY_SDK = Object.freeze({
  errorcore: 'forensic',
  'errorcore-safe': 'safe',
  'errorcore-balanced': 'balanced',
  'errorcore-forensic': 'forensic',
  'errorcore-fast': 'fast',
  'errorcore-adaptive': 'adaptive'
});

const FROZEN_DUMMY_CONTEXT = Object.freeze({
  requestId: 'bench-als-only',
  startTime: 0n,
  method: 'GET',
  url: '/bench-als-only',
  headers: Object.freeze({}),
  body: null,
  bodyTruncated: false,
  ioEvents: Object.freeze([]),
  stateReads: Object.freeze([]),
  stateWrites: Object.freeze([]),
  traceId: '11111111111111111111111111111111',
  spanId: '2222222222222222',
  parentSpanId: null,
  traceFlags: 1,
  isEntrySpan: true
});

function createAlsOnlyMiddleware(instance) {
  return {
    express: (_req, _res, next) => instance.als.runWithContext(FROZEN_DUMMY_CONTEXT, next),
    fastify: (fastify, _options, done) => {
      fastify.addHook('onRequest', (_request, _reply, next) => {
        instance.als.runWithContext(FROZEN_DUMMY_CONTEXT, next);
      });
      done();
    },
    koa: async (_ctx, next) => instance.als.runWithContext(FROZEN_DUMMY_CONTEXT, () => next()),
    hapi: {
      plugin: {
        name: 'errorcore-bench-als-only',
        register(server) {
          server.ext('onRequest', (_request, h) =>
            instance.als.runWithContext(FROZEN_DUMMY_CONTEXT, () => h.continue)
          );
        }
      },
      options: {}
    },
    hono: async (_ctx, next) => instance.als.runWithContext(FROZEN_DUMMY_CONTEXT, () => next())
  };
}

function captureModeForErrorcoreVariant(sdk) {
  return ERRORCORE_CAPTURE_MODES_BY_SDK[sdk] ?? null;
}

function resolveErrorcoreCaptureMode(config) {
  const fromConfig = config.errorcoreCaptureMode ?? captureModeForErrorcoreVariant(config.sdk);
  const fromEnv = process.env.BENCH_ERRORCORE_CAPTURE_MODE;
  const mode = fromEnv !== undefined && fromEnv !== '' ? fromEnv : fromConfig;
  if (!['safe', 'balanced', 'forensic', 'fast', 'adaptive'].includes(mode)) {
    throw new Error(`Unsupported Errorcore benchmark capture mode: ${String(mode)}`);
  }
  return mode;
}

function getHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value.join(', ');
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

function normalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    result[key.toLowerCase()] = Array.isArray(value)
      ? value.map((entry) => String(entry)).join(', ')
      : String(value);
  }
  return result;
}

function bodyStats(body) {
  if (body === undefined || body === null) {
    return { bodyLength: 0, bodyHash: null };
  }

  const serialized = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : safeJson(body);
  const bytes = Buffer.isBuffer(serialized)
    ? serialized
    : Buffer.from(serialized, 'utf8');
  return {
    bodyLength: bytes.length,
    bodyHash: bytes.length === 0
      ? null
      : `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  };
}

function buildFastRequestContext(config, context = {}) {
  const request = context.request ?? {};
  const headers = normalizeHeaders(request.headers ?? context.headers ?? {});
  const { bodyLength, bodyHash } = bodyStats(request.body ?? context.body);

  return {
    method: request.method ?? context.method ?? 'GET',
    url:
      request.url ??
      request.path ??
      context.url ??
      context.path ??
      `/benchmark/${context.scenarioId ?? config.scenarioId ?? 'unknown'}`,
    headers,
    statusCode: request.statusCode ?? context.statusCode ?? null,
    bodyLength,
    bodyHash,
    traceparent: request.traceparent ?? context.traceparent ?? getHeader(headers, 'traceparent'),
    tracestate: request.tracestate ?? context.tracestate ?? getHeader(headers, 'tracestate')
  };
}

async function createErrorcoreAdapter(config, logger) {
  const errorcore = loadErrorcore();
  const appRequire = createRequire(new URL('../package.json', import.meta.url));
  const pg = appRequire('pg');
  const ioredis = appRequire('ioredis');
  const sinkUrl = process.env.ERRORCORE_SINK_URL ?? 'http://127.0.0.1:3010';
  const encryptionKey =
    process.env.BENCH_ERRORCORE_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const captureMode = resolveErrorcoreCaptureMode(config);
  const adaptiveEnabled = captureMode === 'adaptive' || process.env.BENCH_ERRORCORE_ADAPTIVE === '1';
  const initialCaptureMode = adaptiveEnabled ? 'safe' : captureMode;
  // Diagnostic knob: BENCH_ERRORCORE_LOCALS=off disables local-variable
  // capture on top of the selected mode, isolating the armed-inspector cost
  // from the rest of the mode's per-request overhead.
  const localsOverride = process.env.BENCH_ERRORCORE_LOCALS;
  const instance = errorcore.init({
    service: config.serviceName,
    deploymentEnv: 'benchmark',
    transport: {
      type: 'http',
      url: `${sinkUrl}/ingest`,
      apiKey: process.env.ERRORCORE_API_KEY ?? 'ec_live_0123456789abcdef0123456789abcdef',
      timeoutMs: 750,
      protocol: 'http1',
      maxBackups: 1
    },
    allowPlainHttpTransport: true,
    encryptionKey,
    captureMode: initialCaptureMode,
    ...(adaptiveEnabled
      ? {
          adaptiveCapture: {
            enabled: true,
            base: 'safe',
            escalated: 'forensic'
          }
        }
      : {}),
    ...(localsOverride === 'off' ? { captureLocalVariables: false } : {}),
    deadLetterPath: path.join(
      config.resultsDir,
      `dead-letter${config.resultSuffix ?? ''}`,
      `${config.serviceName}-${config.scenarioId}.ndjson`
    ),
    flushIntervalMs: initialCaptureMode === 'fast' ? 0 : 1000,
    envAllowlist: [
      'BENCH_SCENARIO_ID',
      'BENCH_FRAMEWORK',
      'BENCH_SDK',
      'BENCH_SERVICE_NAME',
      'BENCH_ERRORCORE_CAPTURE_MODE',
      'BENCH_ERRORCORE_ADAPTIVE',
      'BENCH_ERRORCORE_MIDDLEWARE'
    ],
    traceContext: { vendorKey: 'ec' },
    drivers: { pg, ioredis },
    logLevel: 'error',
    onInternalWarning: (warning) => {
      logger.sdk('errorcore:warning', {
        code: warning.code,
        message: warning.message,
        context: warning.context
      });
    }
  });

  // Diagnostic knob: BENCH_ERRORCORE_MIDDLEWARE=off skips the framework
  // middleware while leaving the mode's standing recorders hooked,
  // isolating the per-request ALS/context cost from recorder cost.
  // BENCH_ERRORCORE_MIDDLEWARE=als-only installs only an ALS.run wrapper
  // around each framework handler so safe-mode middleware cost can be
  // compared against the AsyncLocalStorage floor.
  const middlewareMode = process.env.BENCH_ERRORCORE_MIDDLEWARE;
  const middlewareOff = middlewareMode === 'off';
  const middlewareAlsOnly = middlewareMode === 'als-only';
  return {
    name: config.sdk,
    frameworkMiddleware: middlewareAlsOnly
      ? createAlsOnlyMiddleware(instance)
      : captureMode === 'fast' || middlewareOff
      ? {}
      : {
          express: errorcore.expressMiddleware(instance),
          fastify: errorcore.fastifyPlugin(instance),
          koa: errorcore.koaMiddleware(instance),
          hapi: { plugin: errorcore.hapiPlugin, options: { sdk: instance } },
          hono: errorcore.honoMiddleware(instance)
        },
    captureException(error, context = {}) {
      error.scenarioId = context.scenarioId ?? config.scenarioId;
      error.benchmarkService = config.serviceName;
      error.benchmarkFramework = config.framework;
      const activeCaptureMode = instance.getCaptureMode?.() ?? initialCaptureMode;
      const options = activeCaptureMode === 'fast'
        ? { request: buildFastRequestContext(config, context) }
        : undefined;
      instance.captureError(error, options);
    },
    getTraceHeaders() {
      return errorcore.getTraceHeaders?.() ?? null;
    },
    async flush() {
      await errorcore.flush();
    },
    async shutdown() {
      await errorcore.shutdown();
    }
  };
}

async function createSentryAdapter(config, logger) {
  const Sentry = await import('@sentry/node');
  const sinkUrl = process.env.SENTRY_SINK_URL ?? 'http://127.0.0.1:3011';
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    includeLocalVariables: true,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
    environment: 'benchmark',
    release: 'errorcore-bench@0.1.0',
    beforeSend: async (event) => {
      try {
        await postJson(`${sinkUrl}/before-send`, {
          scenarioId: config.scenarioId,
          serviceName: config.serviceName,
          framework: config.framework,
          event
        });
      } catch (error) {
        logger.sdk('sentry:before-send-dump-failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return event;
    },
    transport: () => ({
      send: async (envelope) => {
        await postJson(`${sinkUrl}/envelope`, {
          scenarioId: config.scenarioId,
          serviceName: config.serviceName,
          framework: config.framework,
          envelope
        });
        return { statusCode: 200 };
      },
      flush: async () => true
    })
  });

  return {
    name: 'sentry',
    frameworkMiddleware: {},
    captureException(error, context = {}) {
      Sentry.withScope((scope) => {
        scope.setTag('bench.scenario_id', context.scenarioId ?? config.scenarioId);
        scope.setTag('bench.framework', config.framework);
        scope.setTag('bench.service', config.serviceName);
        scope.setContext('benchmark', {
          scenarioId: context.scenarioId ?? config.scenarioId,
          serviceName: config.serviceName,
          serviceRole: config.serviceRole
        });
        Sentry.captureException(error);
      });
    },
    getTraceHeaders() {
      return null;
    },
    async flush(timeoutMs = 3000) {
      await Sentry.flush(timeoutMs);
    },
    async shutdown() {
      await Sentry.close(3000);
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addBugsnagBenchmarkMetadata(event, config, context = {}) {
  const scenarioId = context.scenarioId ?? config.scenarioId;
  const benchmark = {
    scenarioId,
    serviceName: config.serviceName,
    serviceRole: config.serviceRole,
    framework: config.framework
  };
  if (context.phase !== undefined) {
    benchmark.phase = context.phase;
  }

  if (typeof event?.addMetadata === 'function') {
    event.addMetadata('benchmark', benchmark);
  } else if (event !== undefined && event !== null) {
    event.metaData = {
      ...(event.metaData ?? {}),
      benchmark
    };
  }
  if (event !== undefined && event !== null) {
    event.context = `${scenarioId}:${config.serviceName}`;
  }
}

async function createBugsnagAdapter(config, logger) {
  const imported = await import('@bugsnag/js');
  const Bugsnag = imported.default ?? imported;
  const sinkUrl = process.env.BUGSNAG_SINK_URL ?? 'http://127.0.0.1:3012';
  const pending = new Set();

  Bugsnag.start({
    apiKey: '00000000000000000000000000000000',
    appType: 'node-benchmark',
    appVersion: 'errorcore-bench@0.1.0',
    autoDetectErrors: true,
    autoTrackSessions: false,
    enabledReleaseStages: ['benchmark'],
    releaseStage: 'benchmark',
    endpoints: {
      notify: `${sinkUrl}/notify`,
      sessions: `${sinkUrl}/sessions`
    },
    metadata: {
      benchmark: {
        scenarioId: config.scenarioId,
        serviceName: config.serviceName,
        serviceRole: config.serviceRole,
        framework: config.framework
      }
    },
    onError: (event) => {
      addBugsnagBenchmarkMetadata(event, config);
      return true;
    },
    logger: {
      debug(message) {
        logger.sdk('bugsnag:debug', { message });
      },
      info(message) {
        logger.sdk('bugsnag:info', { message });
      },
      warn(message) {
        logger.sdk('bugsnag:warn', { message });
      },
      error(message, error) {
        logger.sdk('bugsnag:error', {
          message,
          error: error instanceof Error ? error.message : String(error ?? '')
        });
      }
    }
  });

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  }

  return {
    name: 'bugsnag',
    frameworkMiddleware: {},
    captureException(error, context = {}) {
      error.scenarioId = context.scenarioId ?? config.scenarioId;
      error.benchmarkService = config.serviceName;
      error.benchmarkFramework = config.framework;
      const sent = new Promise((resolve) => {
        try {
          Bugsnag.notify(error, (event) => {
            addBugsnagBenchmarkMetadata(event, config, context);
            return true;
          }, (notifyError) => {
            if (notifyError !== null && notifyError !== undefined) {
              logger.sdk('bugsnag:notify-failed', {
                message: notifyError instanceof Error ? notifyError.message : String(notifyError)
              });
            }
            resolve();
          });
        } catch (notifyError) {
          logger.sdk('bugsnag:notify-threw', {
            message: notifyError instanceof Error ? notifyError.message : String(notifyError)
          });
          resolve();
        }
      });
      track(sent);
    },
    getTraceHeaders() {
      return null;
    },
    async flush(timeoutMs = 3000) {
      const inFlight = [...pending];
      if (inFlight.length === 0) {
        await delay(100);
        return;
      }
      await Promise.race([
        Promise.allSettled(inFlight),
        delay(timeoutMs)
      ]);
    },
    async shutdown() {
      await this.flush(3000);
    }
  };
}

function createBaselineAdapter() {
  return {
    name: 'baseline',
    frameworkMiddleware: {},
    captureException() {},
    getTraceHeaders() {
      return null;
    },
    async flush() {},
    async shutdown() {}
  };
}

export async function createSdkAdapter(config, logger) {
  if (captureModeForErrorcoreVariant(config.sdk) !== null) {
    return createErrorcoreAdapter(config, logger);
  }
  if (config.sdk === 'sentry') {
    return createSentryAdapter(config, logger);
  }
  if (config.sdk === 'bugsnag') {
    return createBugsnagAdapter(config, logger);
  }
  return createBaselineAdapter();
}
