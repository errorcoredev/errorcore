import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { requestJson, waitFor } from './http.mjs';

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

export function spawnBenchmarkApp(config) {
  const logs = [];
  const rawLogs = [];
  const child = spawn(process.execPath, [path.join(appRoot, 'server.mjs')], {
    cwd: appRoot,
    env: {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
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
      await waitFor(`app ${config.serviceName}`, async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `app ${config.serviceName} exited with code ${child.exitCode}\n${tailLines(rawLogs)}`
          );
        }
        const response = await requestJson(`http://127.0.0.1:${config.port}/healthz`);
        return response.ok ? response : false;
      }, { timeoutMs: 30_000 });
    },
    async flush() {
      await requestJson(`http://127.0.0.1:${config.port}/__flush`, { method: 'POST', body: {} }).catch(() => null);
    },
    async stop() {
      await this.flush();
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}
