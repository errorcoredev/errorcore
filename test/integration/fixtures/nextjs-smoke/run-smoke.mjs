import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const nextBin = path.join(here, 'node_modules', 'next', 'dist', 'bin', 'next');
const capturePath = path.resolve(here, process.env.ERRORCORE_SMOKE_FILE || './smoke-errors.ndjson');
const host = '127.0.0.1';
const runId = `nextjs-smoke-${Date.now()}-${crypto.randomUUID()}`;

fs.mkdirSync(path.dirname(capturePath), { recursive: true });
fs.rmSync(capturePath, { force: true });
fs.rmSync(path.join(here, '.next', 'dev'), { recursive: true, force: true });

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`SMOKE_PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

function withTemporaryServer(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(address);
      });
    });
  });
}

async function choosePort() {
  if (process.env.SMOKE_PORT !== undefined && process.env.SMOKE_PORT !== '') {
    const port = parsePort(process.env.SMOKE_PORT);
    try {
      await withTemporaryServer(port);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`SMOKE_PORT ${port} is already in use or unavailable: ${detail}`);
    }
    return port;
  }

  const address = await withTemporaryServer(0);
  if (address === null || typeof address === 'string') {
    fail('could not allocate an ephemeral smoke port');
  }
  return address.port;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(condition, description, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      if (error instanceof Error && error.fatal === true) {
        throw error;
      }
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.${suffix}`);
}

function decodeCaptureLine(line) {
  const parsed = JSON.parse(line);
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    parsed.v === 1 &&
    typeof parsed.ciphertext === 'string'
  ) {
    const decoded = Buffer.from(parsed.ciphertext, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
  return parsed;
}

function withSmokeNodeOptions(env) {
  const requested = process.env.ERRORCORE_SMOKE_NODE_OPTIONS;
  if (typeof requested !== 'string' || requested.length === 0) {
    return env;
  }

  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, requested].filter(Boolean).join(' '),
  };
}

function readDecodedCaptures() {
  if (!fs.existsSync(capturePath)) return [];

  const raw = fs.readFileSync(capturePath, 'utf8').trim();
  if (raw.length === 0) return [];

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => decodeCaptureLine(line));
}

function captureMatchesRun(entry) {
  return typeof entry?.error?.message === 'string' && entry.error.message.includes(runId);
}

function runNextSync(args, label) {
  if (!fs.existsSync(nextBin)) {
    fail(`Next.js CLI not found at ${nextBin}; prepare the Next.js smoke fixture first`);
  }

  const result = spawnSync(process.execPath, [nextBin, ...args], {
    cwd: here,
    env: {
      ...process.env,
      ERRORCORE_SMOKE_FILE: capturePath,
    },
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${label} failed with exit ${result.status}`);
  }
}

function spawnNextServer(port) {
  const outputTail = [];
  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', host], {
    cwd: here,
    env: withSmokeNodeOptions({
      ...process.env,
      PORT: String(port),
      ERRORCORE_SMOKE_FILE: capturePath,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  function pipe(stream, sink) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      outputTail.push(chunk);
      while (outputTail.join('').length > 4_000) outputTail.shift();
      sink.write(chunk);
    });
  }

  pipe(server.stdout, process.stdout);
  pipe(server.stderr, process.stderr);

  let exitInfo = null;
  server.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  server.once('error', (error) => {
    exitInfo = { error };
  });

  return {
    server,
    getExitInfo: () => exitInfo,
    getOutputTail: () => outputTail.join('').slice(-4_000),
  };
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        server.kill('SIGKILL');
      } catch {}
    }, 2_000);
    timer.unref();

    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      server.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

const port = await choosePort();
const baseUrl = `http://${host}:${port}`;

console.log(`[smoke] runId=${runId}`);
console.log(`[smoke] capture file=${capturePath}`);
console.log('[smoke] building...');
runNextSync(['build', '--webpack'], 'next build --webpack');

console.log(`[smoke] starting server on port ${port}...`);
const { server, getExitInfo, getOutputTail } = spawnNextServer(port);

try {
  await waitFor(async () => {
    const exitInfo = getExitInfo();
    if (exitInfo !== null) {
      const reason = exitInfo.error instanceof Error
        ? `spawn error=${exitInfo.error.message}`
        : `code=${exitInfo.code}, signal=${exitInfo.signal}`;
      throw Object.assign(new Error(
        `Next server exited before readiness (${reason}). ${getOutputTail()}`
      ), { fatal: true });
    }

    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/api/smoke-health?runId=${encodeURIComponent(runId)}`
      );
      if (!response.ok) return false;
      const body = await response.json();
      return body?.ok === true && body?.service === 'errorcore-nextjs-smoke-fixture' && body?.runId === runId;
    } catch {
      return false;
    }
  }, 'Next.js smoke health route', 30_000);

  const response = await fetchWithTimeout(
    `${baseUrl}/api/test-error?runId=${encodeURIComponent(runId)}`
  );
  if (response.status < 500) {
    fail(`test-error route returned ${response.status}; expected a 5xx response`);
  }

  const entries = await waitFor(() => {
    const decoded = readDecodedCaptures();
    const currentRunEntries = decoded.filter(captureMatchesRun);
    return currentRunEntries.length > 0 ? currentRunEntries : false;
  }, 'current-run decoded smoke capture', 10_000);

  if (entries.length !== 1) {
    fail(`expected exactly 1 current-run capture, found ${entries.length}`);
  }

  const entry = entries[0];
  if (entry.completeness?.requestCaptured !== true) {
    fail('current-run capture is missing request metadata');
  }
  if (
    entry.completeness?.ioTimelineCaptured !== true ||
    !entry.ioTimeline?.some((event) => event.type === 'http-server')
  ) {
    fail('current-run capture is missing http-server inbound ioTimeline');
  }

  const hasLocals =
    entry.completeness?.localVariablesCaptured === true &&
    (entry.localVariables ?? []).some(
      (frame) => frame.locals && Object.keys(frame.locals).length >= 2
    );
  if (!hasLocals) {
    fail(`current-run capture is missing locals; failures=${JSON.stringify(entry.completeness?.captureFailures ?? [])}`);
  }

  if (!['tag', 'identity'].includes(entry.completeness.localVariablesCaptureLayer)) {
    fail(`locals entry has unexpected captureLayer: ${entry.completeness.localVariablesCaptureLayer}`);
  }

  const firstFrame = (entry.error.stack ?? '').split('\n')[1] ?? '';
  if (/\.next[\\/]server[\\/].*route\.js/.test(firstFrame) || !/webpack:|route\.ts/.test(firstFrame)) {
    fail('current-run capture does not have a source-mapped first frame');
  }

  if (entry.completeness?.sourceMapResolution === undefined) {
    fail('current-run capture is missing sourceMapResolution telemetry');
  }

  console.log(
    `[smoke] OK - runId=${runId}, captures=${entries.length}, layer=${entry.completeness.localVariablesCaptureLayer}, source-mapped, ioTimeline`
  );
} finally {
  await stopServer(server);
}
