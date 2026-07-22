import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { requestJson } from './http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');
const appRoot = path.join(benchRoot, 'apps', 'benchmark-app');

function parseBenchLog(line) {
  if (!line.startsWith('BENCH_LOG ')) return null;
  try {
    return JSON.parse(line.slice('BENCH_LOG '.length));
  } catch {
    return null;
  }
}

function tailLines(lines, count = 80) {
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export function formatSpawnFailure(error, details) {
  const code = typeof error?.code === 'string' ? ` ${error.code}` : '';
  return (
    `benchmark app spawn failed${code}: ${error instanceof Error ? error.message : String(error)}; ` +
    `executable=${details.executable}; cwd=${details.cwd}; platform=${process.platform}; ` +
    `environmentEntries=${details.environmentEntries}. ` +
    'Verify the executable and working directory, and check host process/environment limits.'
  );
}

export function spawnBenchmarkApp(config) {
  const logs = [];
  const rawLogs = [];
  const executable = process.execPath;
  const args = [path.join(appRoot, 'server.mjs')];
  const env = {
    ...process.env,
    PORT: String(config.port),
    BENCH_FRAMEWORK: config.framework,
    BENCH_SDK: config.sdk,
    BENCH_SCENARIO_ID: config.scenarioId,
    BENCH_SERVICE_NAME: config.serviceName,
    BENCH_SERVICE_ROLE: config.serviceRole ?? 'single',
    SERVICE_B_URL: config.serviceBUrl ?? '',
    BENCH_RESULTS_DIR: config.resultsDir,
    BENCH_RESULTS_RUN_SUFFIX: config.resultSuffix ?? process.env.BENCH_RESULTS_RUN_SUFFIX ?? '',
    UPSTREAM_URL: process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3020',
    ERRORCORE_SINK_URL: process.env.ERRORCORE_SINK_URL ?? 'http://127.0.0.1:3010',
    SENTRY_SINK_URL: process.env.SENTRY_SINK_URL ?? 'http://127.0.0.1:3011',
    BUGSNAG_SINK_URL: process.env.BUGSNAG_SINK_URL ?? 'http://127.0.0.1:3012',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    REDIS_URL: process.env.REDIS_URL ?? '',
    ERRORCORE_PACKAGE_ROOT: process.env.ERRORCORE_PACKAGE_ROOT ?? path.resolve(benchRoot, '..')
  };
  const spawnDetails = {
    executable,
    cwd: appRoot,
    environmentEntries: Object.keys(env).length
  };

  let child;
  try {
    child = spawn(executable, args, {
      cwd: appRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    throw new Error(formatSpawnFailure(error, spawnDetails), { cause: error });
  }

  let spawnError = null;
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  function handleLine(line) {
    rawLogs.push(line);
    console.log(`[${config.sdk}:${config.scenarioId}:${config.serviceName}] ${line}`);
    const parsed = parseBenchLog(line);
    if (parsed !== null) logs.push(parsed);
  }

  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        handleLine(buffer.slice(0, index).trimEnd());
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) handleLine(buffer.trimEnd());
    });
  }

  return {
    child,
    logs,
    rawLogs,
    baseUrl: `http://127.0.0.1:${config.port}`,
    async waitUntilReady() {
      const started = Date.now();
      let lastError = null;
      while (Date.now() - started < 30_000) {
        if (spawnError !== null) {
          throw new Error(formatSpawnFailure(spawnError, spawnDetails), { cause: spawnError });
        }
        if (child.exitCode !== null) {
          throw new Error(
            `app ${config.serviceName} exited with code ${child.exitCode}\n${tailLines(rawLogs)}`
          );
        }
        try {
          const response = await requestJson(`http://127.0.0.1:${config.port}/healthz`);
          if (response.ok) return;
          lastError = new Error(`health check returned HTTP ${response.status}`);
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `timed out waiting for app ${config.serviceName}; ` +
        `last=${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    },
    async flush() {
      await requestJson(`http://127.0.0.1:${config.port}/__flush`, { method: 'POST', body: {} }).catch(() => null);
    },
    async stop() {
      if (child.exitCode === null && spawnError === null) {
        await this.flush();
      }
      if (!closed && child.exitCode === null && spawnError === null) {
        child.kill('SIGTERM');
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!closed && child.exitCode === null && spawnError === null) {
            child.kill('SIGKILL');
          }
          const forceCloseTimer = setTimeout(resolve, 1000);
          closedPromise.then(() => {
            clearTimeout(forceCloseTimer);
            resolve();
          });
        }, 5000);
        closedPromise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}
