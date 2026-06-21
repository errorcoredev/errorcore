import path from 'node:path';
import { createRequire } from 'node:module';

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

async function createErrorcoreAdapter(config, logger) {
  const errorcore = loadErrorcore();
  const appRequire = createRequire(new URL('../package.json', import.meta.url));
  const pg = appRequire('pg');
  const ioredis = appRequire('ioredis');
  const sinkUrl = process.env.ERRORCORE_SINK_URL ?? 'http://127.0.0.1:3010';
  const encryptionKey =
    process.env.BENCH_ERRORCORE_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const instance = errorcore.init({
    service: config.serviceName,
    deploymentEnv: 'benchmark',
    transport: {
      type: 'http',
      url: `${sinkUrl}/ingest`,
      timeoutMs: 750,
      protocol: 'http1',
      maxBackups: 1
    },
    allowPlainHttpTransport: true,
    encryptionKey,
    captureLocalVariables: true,
    captureDbBindParams: true,
    captureRequestBodies: true,
    captureResponseBodies: true,
    captureBodyDigest: true,
    resolveSourceMaps: true,
    deadLetterPath: path.join(
      config.resultsDir,
      `dead-letter${config.resultSuffix ?? ''}`,
      `${config.serviceName}-${config.scenarioId}.ndjson`
    ),
    flushIntervalMs: 1000,
    envAllowlist: ['BENCH_SCENARIO_ID', 'BENCH_FRAMEWORK', 'BENCH_SDK', 'BENCH_SERVICE_NAME'],
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

  return {
    name: 'errorcore',
    frameworkMiddleware: {
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
      errorcore.captureError(error);
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
  if (config.sdk === 'errorcore') {
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
