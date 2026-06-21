import { createDependencies } from './lib/dependencies.mjs';
import { createScenarioEngine } from './lib/scenario-engine.mjs';
import { createSdkAdapter } from './lib/sdk-adapter.mjs';
import { startFrameworkServer } from './lib/frameworks.mjs';
import { createBenchLogger } from './lib/logger.mjs';

const config = {
  framework: process.env.BENCH_FRAMEWORK ?? 'express',
  sdk: process.env.BENCH_SDK ?? 'baseline',
  scenarioId: process.env.BENCH_SCENARIO_ID ?? 'unknown',
  serviceName: process.env.BENCH_SERVICE_NAME ?? 'bench-app',
  serviceRole: process.env.BENCH_SERVICE_ROLE ?? 'single',
  port: Number(process.env.PORT ?? 3000),
  upstreamUrl: process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3020',
  serviceBUrl: process.env.SERVICE_B_URL,
  resultsDir: process.env.BENCH_RESULTS_DIR ?? './results',
  resultSuffix: process.env.BENCH_RESULTS_RUN_SUFFIX ?? ''
};

const logger = createBenchLogger({
  scenarioId: config.scenarioId,
  framework: config.framework,
  sdk: config.sdk,
  serviceName: config.serviceName,
  serviceRole: config.serviceRole
});

async function main() {
  logger.lifecycle('sdk:init:start');
  const sdk = await createSdkAdapter(config, logger);
  logger.lifecycle('sdk:init:done');

  logger.lifecycle('dependencies:init:start');
  const dependencies = await createDependencies(config, logger);
  logger.lifecycle('dependencies:init:done');

  const engine = createScenarioEngine({
    ...config,
    sdk,
    dependencies,
    logger
  });

  logger.lifecycle('server:start');
  const server = await startFrameworkServer({
    ...config,
    sdk,
    engine,
    logger
  });

  logger.lifecycle('app:ready', { port: config.port });

  async function shutdown(signal) {
    logger.lifecycle('app:shutdown', { signal });
    try {
      await sdk.flush(3000);
    } finally {
      await server.close();
      await dependencies.close();
      await sdk.shutdown();
    }
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.lifecycle('app:start:failed', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  console.error(error);
  process.exit(1);
});
