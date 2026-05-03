import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

fs.rmSync('./smoke-errors.ndjson', { force: true });

// Port can be overridden via SMOKE_PORT so a developer with 3099 already
// bound (another Next.js dev server, an HTTP echo, etc.) is not blocked.
const port = process.env.SMOKE_PORT || '3099';

console.log('[smoke] building...');
const build = spawnSync('npx', ['next', 'build'], { stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error('[smoke] build failed');
  process.exit(1);
}

console.log(`[smoke] starting server on port ${port}...`);
const server = spawn('npx', ['next', 'start', '-p', port], { stdio: 'inherit', shell: true });

// Poll a throwaway request until the server is up. Next.js 14 with `next
// start` routes the first request through a cold-start path that does not
// emit the http.server.request.start diagnostic channel; subsequent
// requests use the normal hot path. The smoke hits the test endpoint
// twice so the ioTimeline assertion sees the hot path.
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline && !ready) {
  try {
    await fetch(`http://localhost:${port}/api/test-error`);
    ready = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) {
  console.error('[smoke] server did not become ready within 30s');
  server.kill();
  process.exit(1);
}

// Second, hot-path request — the one the assertions are made against.
await fetch(`http://localhost:${port}/api/test-error`).catch(() => undefined);

// Wait for flush interval
await new Promise((r) => setTimeout(r, 3000));

try {
  server.kill();
  await new Promise((r) => setTimeout(r, 1000));
} catch {}

function fail(msg) {
  console.error('[smoke] FAIL:', msg);
  process.exit(1);
}

if (!fs.existsSync('./smoke-errors.ndjson')) fail('ndjson not created');
const raw = fs.readFileSync('./smoke-errors.ndjson', 'utf8').trim();
if (raw.length === 0) fail('ndjson is empty');

const entries = raw.split('\n').map((l) => JSON.parse(l));
if (entries.length === 0) fail('no entries parsed');

// Cross-entry assertions. Next.js 14 with `next start` routes the first
// request through a cold path that skips http.server.request.start; the
// second+ requests use the hot path that emits the channel. Meanwhile,
// the inspector's rate limiter can saturate under Next.js's internal
// exception noise, so any one entry may miss locals OR ioTimeline but
// not both. The smoke asserts the full capability is exercised across
// the entries.
const someHasIo = entries.some((e) =>
  e.completeness.ioTimelineCaptured === true &&
  e.ioTimeline.some((ev) => ev.type === 'http-server')
);
if (!someHasIo) fail('no entry has http-server inbound ioTimeline — G2 regression');

// G1 assertion: at least one entry has locals captured via Layer 1 or
// Layer 2. We don't assert on specific variable NAMES because production
// webpack builds minify them (user → e, cart → t, etc.). Proving the
// mechanism works = >=1 entry with >=1 frame with >=2 local variables.
const localsEntry = entries.find((e) => {
  if (e.completeness.localVariablesCaptured !== true) return false;
  const frames = e.localVariables ?? [];
  return frames.some((f) => f.locals && Object.keys(f.locals).length >= 2);
});
if (!localsEntry) fail('no entry has locals captured — G1 regression');

if (!['tag', 'identity'].includes(localsEntry.completeness.localVariablesCaptureLayer)) {
  fail(`locals entry has unexpected captureLayer: ${localsEntry.completeness.localVariablesCaptureLayer}`);
}

const someSourceMapped = entries.some((e) => {
  const first = (e.error.stack ?? '').split('\n')[1] ?? '';
  if (/\.next[\\/]server[\\/].*route\.js/.test(first)) return false;
  return /webpack:|route\.ts/.test(first);
});
if (!someSourceMapped) fail('no entry has a source-mapped first frame — G3 regression');

// G3 telemetry assertion: sourceMapResolution is present on every entry.
// framesResolved counts errorcore's own resolutions; under Node's
// --enable-source-maps flag the native Error.prepareStackTrace hook runs
// first and errorcore sees an already-resolved stack (framesResolved=0).
// someSourceMapped above already validates the outcome; here we only
// require the telemetry structure exists.
const allHaveSmTelemetry = entries.every((e) => e.completeness.sourceMapResolution !== undefined);
if (!allHaveSmTelemetry) fail('some entry missing sourceMapResolution telemetry — G3 regression');

const layers = new Set(entries.map((e) => e.completeness.localVariablesCaptureLayer).filter(Boolean));
console.log(`[smoke] OK — ${entries.length} entries, layers=${[...layers].join(',') || 'none'}, source-mapped ✓, ioTimeline ✓`);
