#!/usr/bin/env node
// Benchmark for the structural JSON walk in Scrubber.scrubBodyBuffer.
//
// Run: node perf/scrubber-bench.js
//
// Target: under 1ms median for a 5KB JSON body. Above the budget means the
// structural walk is too slow under burst load (scenario 16: 100 concurrent
// captures), and the regex-over-JSON-string fallback should be considered.
//
// Not wired into CI. Runs on demand for sanity-checking after scrubber
// changes.

'use strict';

const { Scrubber } = require('../dist/pii/scrubber');
const { resolveConfig } = require('../dist/config');

const config = resolveConfig({ transport: { type: 'stdout' }, allowUnencrypted: true });
const scrubber = new Scrubber(config);

// Build a representative ~5KB JSON body. Mix of:
//   - sensitive keys at various depths (cvc, password, token)
//   - PII values caught by regex (CC numbers, JWTs)
//   - clean fields preserved verbatim
//   - moderate nesting (depth ~5)
function buildBody() {
  const items = [];
  for (let i = 0; i < 30; i++) {
    items.push({
      sku: `SKU-${i.toString().padStart(4, '0')}`,
      name: `Widget ${String.fromCharCode(65 + (i % 26))}`,
      qty: (i % 5) + 1,
      price: 1999 + i * 100,
      tags: ['retail', 'shipped', 'q4'],
      meta: {
        warehouseId: `wh-${i % 4}`,
        lane: (i * 7) % 13,
        cvc: i.toString().padStart(3, '0')
      }
    });
  }
  return JSON.stringify({
    orderId: '0123-4567-89ab-cdef',
    user: {
      id: 'user_aaaaaaaaaaaa',
      email: 'demo@example.com',
      session: 'sess_xyz123abc',
      profile: {
        name: 'Demo User',
        address: '123 Main St',
        password: 'do-not-leak'
      }
    },
    payment: {
      card: { number: '4111111111111111', cvc: '424', exp: '12/30' },
      access_token: 'tok_abc'
    },
    items,
    notes: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
  });
}

const bodyString = buildBody();
const buffer = Buffer.from(bodyString, 'utf8');
const headers = { 'content-type': 'application/json' };

const N = 10_000;
console.log(`bench: scrubBodyBuffer x ${N} on a ${buffer.length}-byte JSON body`);

// Warm up V8 — first few iterations have JIT compilation overhead.
for (let i = 0; i < 200; i++) scrubber.scrubBodyBuffer(buffer, headers);

const times = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const start = process.hrtime.bigint();
  scrubber.scrubBodyBuffer(buffer, headers);
  const end = process.hrtime.bigint();
  times[i] = Number(end - start) / 1_000_000; // ms
}

times.sort();
const median = times[Math.floor(N * 0.5)];
const p95 = times[Math.floor(N * 0.95)];
const p99 = times[Math.floor(N * 0.99)];
const max = times[N - 1];
const mean = Array.prototype.reduce.call(times, (a, b) => a + b, 0) / N;

console.log(`  median: ${median.toFixed(3)} ms`);
console.log(`     p95: ${p95.toFixed(3)} ms`);
console.log(`     p99: ${p99.toFixed(3)} ms`);
console.log(`     max: ${max.toFixed(3)} ms`);
console.log(`    mean: ${mean.toFixed(3)} ms`);

// Verify the scrubber actually produced a redacted output (cheap sanity).
const out = scrubber.scrubBodyBuffer(buffer, headers).toString('utf8');
const parsed = JSON.parse(out);
const cvcOk = parsed.payment.card.cvc === '[REDACTED]';
const tokenOk = parsed.payment.access_token === '[REDACTED]';
const passwordOk = parsed.user.profile.password === '[REDACTED]';
const cleanOk = parsed.user.profile.name === 'Demo User';
console.log('');
console.log(`  cvc redacted:   ${cvcOk}`);
console.log(`  token redacted: ${tokenOk}`);
console.log(`  password red:   ${passwordOk}`);
console.log(`  name preserved: ${cleanOk}`);

const TARGET_MS = 1.0;
if (median > TARGET_MS) {
  console.error(`\n[FAIL] median ${median.toFixed(3)}ms exceeds ${TARGET_MS}ms budget.`);
  console.error('       structural walk is too slow under burst; consider falling back to');
  console.error('       a regex-over-JSON-string scrub.');
  process.exit(1);
}
console.log(`\n[OK] median ${median.toFixed(3)}ms within ${TARGET_MS}ms budget.`);
