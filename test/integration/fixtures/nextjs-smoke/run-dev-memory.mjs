import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

const host = '127.0.0.1';
const nextBin = path.join(here, 'node_modules', 'next', 'dist', 'bin', 'next');
const generatedDir = path.join(here, 'app', 'api', 'hmr-memory');
const routePath = path.join(generatedDir, 'route.ts');
const cycles = Number(process.env.EC_SMOKE_NEXTJS_HMR_CYCLES ?? '25');
const maxGrowthBytes = Number(
  process.env.EC_SMOKE_NEXTJS_HEAP_GROWTH_BYTES ?? String(192 * 1024 * 1024),
);

function fail(message) {
  console.error(`[next-dev-memory] FAIL: ${message}`);
  process.exit(1);
}

function parsePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

parsePositiveInteger('EC_SMOKE_NEXTJS_HMR_CYCLES', cycles);
parsePositiveInteger('EC_SMOKE_NEXTJS_HEAP_GROWTH_BYTES', maxGrowthBytes);

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

function writeProbeRoute(cycle) {
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(
    routePath,
    `export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cycle = ${cycle};

export async function GET() {
  const memory = process.memoryUsage();
  return Response.json({
    ok: true,
    cycle,
    heapUsed: memory.heapUsed,
    rss: memory.rss,
  });
}
`,
    'utf8',
  );
}

async function fetchWithTimeout(url, timeoutMs = 2_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
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

function spawnNextDev(port) {
  if (!fs.existsSync(nextBin)) {
    fail(`Next.js CLI not found at ${nextBin}; prepare the Next.js smoke fixture first`);
  }

  const outputTail = [];
  const server = spawn(process.execPath, [nextBin, 'dev', '--webpack', '-p', String(port), '-H', host], {
    cwd: here,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
    },
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

async function readCycle(baseUrl, expectedCycle) {
  const response = await fetchWithTimeout(`${baseUrl}/api/hmr-memory?t=${Date.now()}`);
  if (!response.ok) return false;
  const body = await response.json();
  if (body?.ok !== true || body?.cycle !== expectedCycle) return false;
  if (!Number.isFinite(body.heapUsed)) {
    throw Object.assign(new Error('hmr-memory route returned a non-numeric heapUsed'), {
      fatal: true,
    });
  }
  return body;
}

const port = await choosePort();
const baseUrl = `http://${host}:${port}`;
writeProbeRoute(0);

console.log(`[next-dev-memory] starting next dev on port ${port}...`);
const { server, getExitInfo, getOutputTail } = spawnNextDev(port);
const samples = [];

try {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    writeProbeRoute(cycle);
    const sample = await waitFor(
      async () => {
        const exitInfo = getExitInfo();
        if (exitInfo !== null) {
          const reason = exitInfo.error instanceof Error
            ? `spawn error=${exitInfo.error.message}`
            : `code=${exitInfo.code}, signal=${exitInfo.signal}`;
          throw Object.assign(new Error(
            `Next dev exited before cycle ${cycle} completed (${reason}). ${getOutputTail()}`,
          ), { fatal: true });
        }
        return readCycle(baseUrl, cycle);
      },
      `HMR cycle ${cycle}`,
      cycle === 0 ? 45_000 : 20_000,
    );
    samples.push(sample);
    console.log(
      `[next-dev-memory] cycle=${cycle} heap=${sample.heapUsed} rss=${sample.rss}`,
    );
  }

  const warmup = Math.max(5, Math.floor(samples.length / 4));
  const stableSamples = samples.slice(warmup);
  const heapValues = stableSamples.map((sample) => sample.heapUsed);
  const minHeap = Math.min(...heapValues);
  const maxHeap = Math.max(...heapValues);
  const firstHeap = heapValues[0];
  const lastHeap = heapValues[heapValues.length - 1];
  const range = maxHeap - minHeap;
  const trend = lastHeap - firstHeap;

  console.log(
    `[next-dev-memory] post-warmup heap range=${range} trend=${trend} limit=${maxGrowthBytes}`,
  );

  if (range > maxGrowthBytes && trend > Math.floor(maxGrowthBytes / 2)) {
    fail(`heap did not stabilize after warmup: range=${range}, trend=${trend}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await stopServer(server);
  fs.rmSync(generatedDir, { recursive: true, force: true });
}
