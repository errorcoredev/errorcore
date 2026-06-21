'use strict';

/*
 * pause-probe.js  —  one-question diagnostic (untracked, safe to delete)
 *
 * Answers the ONLY question that decides whether ErrorCore's V8 inspector is a
 * real performance cost on YOUR traffic:
 *
 *     "How many caught exceptions per 1000 requests does my hot path throw?"
 *
 * Why it matters (measured 2026-06-06):
 *   - Every caught throw, while the inspector is armed with pauseOnExceptions:'all',
 *     costs a synchronous V8 pause/resume round-trip. With a no-op handler that is
 *     already a ~78% throughput hit per-throw; it is unavoidable while paused.
 *   - A clean Hono + JSON-parse + validation path throws ZERO caught exceptions,
 *     so on that traffic the inspector tax is ~0 and the per-throw cost is a ghost.
 *
 *   pauses/1k  ~ 0          -> inspector is ~free on your traffic. Do NOT optimize it.
 *   pauses/1k  in the 10s+  -> each request pays one+ pause round-trip. Real tax. Different conversation.
 *
 * It attaches its OWN inspector session (it does NOT need ErrorCore loaded), so it
 * measures your APP's intrinsic caught-throw rate. Run it against your real workload
 * with ErrorCore DISABLED (or captureLocalVariables:false) for a clean reading.
 *
 * IMPORTANT: while the probe runs it imposes the same pause tax it is measuring, so
 * THROUGHPUT during a probe run is depressed and meaningless. Read ONLY pauses/1k.
 *
 * Wire-up (Hono):
 *     const { PauseProbe } = require('./perf/pause-probe');
 *     const probe = new PauseProbe().start();
 *     app.use('*', async (c, next) => { probe.markRequest(); await next(); });
 *     // ...run your normal load test, watch the periodic stderr line...
 *     // optional: process.on('SIGINT', () => { console.log(probe.stop()); process.exit(0); });
 *
 * Wire-up (Express):
 *     const probe = new PauseProbe().start();
 *     app.use((req, res, next) => { probe.markRequest(); next(); });
 *
 * No framework / can't mark requests? Just read pauses/sec from the log line and
 * divide by your load tool's reported req/sec.
 */

const inspector = require('node:inspector');

function bucketize(url) {
  const u = String(url || '<unknown>').replace(/\\/g, '/');
  if (u.startsWith('node:')) return u.split('/')[0];
  const i = u.lastIndexOf('/node_modules/');
  if (i !== -1) {
    const parts = u.slice(i + '/node_modules/'.length).split('/').filter(Boolean);
    if (parts[0] && parts[0][0] === '@' && parts[1]) return `node_modules/${parts[0]}/${parts[1]}`;
    return `node_modules/${parts[0] || '<unknown>'}`;
  }
  return 'app';
}

function topBuckets(buckets, n = 3) {
  if (buckets.size === 0) return '';
  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}:${v}`).join(', ');
  return `  [top: ${top}]`;
}

class PauseProbe {
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs || 2000;
    this.log = opts.log || ((s) => process.stderr.write(s + '\n'));
    this.session = null;
    this.timer = null;
    this.pauses = 0;
    this.requests = 0;
    this._lastP = 0;
    this._lastR = 0;
    this._lastT = 0;
    this.buckets = new Map();
  }

  start() {
    this.session = new inspector.Session();
    this.session.connect();
    this.session.on('Debugger.paused', (ev) => {
      this.pauses += 1;
      const frame = ev && ev.params && ev.params.callFrames && ev.params.callFrames[0];
      const key = bucketize(frame && frame.url);
      this.buckets.set(key, (this.buckets.get(key) || 0) + 1);
      // Standalone session: we own resume. (If ErrorCore is also attached it resumes too; harmless.)
      this.session.post('Debugger.resume', () => undefined);
    });
    this.session.post('Debugger.enable', () => {
      this.session.post('Debugger.setPauseOnExceptions', { state: 'all' }, () => undefined);
    });
    this._lastT = Date.now();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.log('[pause-probe] armed (pauseOnExceptions=all). Ignore throughput while this runs; read pauses/1k only.');
    return this;
  }

  markRequest() { this.requests += 1; }

  _tick() {
    const now = Date.now();
    const dP = this.pauses - this._lastP;
    const dR = this.requests - this._lastR;
    const secs = (now - this._lastT) / 1000 || 1;
    const per1k = dR > 0 ? `${(dP / dR * 1000).toFixed(1)} pauses/1k` : 'n/a (call markRequest for pauses/1k)';
    this.log(`[pause-probe] ${dP} pauses / ${dR} req in ${secs.toFixed(1)}s (${(dP / secs).toFixed(0)}/s) → ${per1k}${topBuckets(this.buckets)}`);
    this._lastP = this.pauses;
    this._lastR = this.requests;
    this._lastT = now;
  }

  snapshot() {
    return {
      pauses: this.pauses,
      requests: this.requests,
      pausesPer1k: this.requests ? this.pauses / this.requests * 1000 : null,
      verdict: this._verdict(),
      topSources: [...this.buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    };
  }

  _verdict() {
    if (!this.requests) return 'unknown (no requests marked)';
    const p = this.pauses / this.requests * 1000;
    if (p < 1) return 'CLEAN regime: inspector tax ~0 on this workload. Do not optimize the inspector.';
    if (p < 50) return 'LOW: a few throws per 1k req. Inspector cost minor; watch it.';
    return 'THROWING regime: hot path throws caught exceptions; inspector round-trip is a real tax here.';
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    try {
      this.session.post('Debugger.setPauseOnExceptions', { state: 'none' }, () => undefined);
      this.session.disconnect();
    } catch { /* ignore */ }
    return this.snapshot();
  }
}

module.exports = { PauseProbe };
