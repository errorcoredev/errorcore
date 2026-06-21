import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { decryptErrorcoreEnvelope } from './decrypt.mjs';

const port = Number(process.env.PORT ?? 3010);
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.resolve('results');
const sinkDir = path.join(resultsDir, 'raw', 'errorcore-sink');
const encryptionKey =
  process.env.BENCH_ERRORCORE_KEY ??
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const webhookSecret = process.env.BENCH_ERRORCORE_WEBHOOK_SECRET;

fs.mkdirSync(sinkDir, { recursive: true });

let failMode = false;
let events = [];

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function appendRecord(record) {
  events.push(record);
  fs.appendFileSync(path.join(sinkDir, 'events.ndjson'), JSON.stringify(record) + '\n');
}

function scenarioFromPackage(packageObject) {
  return (
    packageObject?.environment?.BENCH_SCENARIO_ID ??
    packageObject?.error?.properties?.scenarioId ??
    packageObject?.error?.properties?.benchmark?.scenarioId ??
    'unknown'
  );
}

function parseEnvelopePayload(payload) {
  const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const plaintext = decryptErrorcoreEnvelope(envelope, { encryptionKey });
  const packageObject = JSON.parse(plaintext);
  return { envelope, packageObject };
}

function verifyWebhookSignature(raw, signature) {
  if (webhookSecret === undefined || webhookSecret.length === 0) {
    return true;
  }
  const expected = createHmac('sha256', webhookSecret).update(raw).digest('hex');
  const actual = String(signature ?? '').replace(/^sha256=/, '');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function storeEnvelope(payload, metadata) {
  const { envelope, packageObject } = parseEnvelopePayload(payload);
  const record = {
    sdk: 'errorcore',
    receivedAt: new Date().toISOString(),
    scenarioId: scenarioFromPackage(packageObject),
    serviceName: packageObject.service,
    eventId: envelope.eventId,
    keyId: envelope.keyId,
    metadata,
    package: packageObject
  };
  appendRecord(record);
  return record;
}

function filteredEvents(url) {
  const scenarioId = url.searchParams.get('scenarioId');
  const serviceName = url.searchParams.get('serviceName');
  return events.filter((event) => {
    if (scenarioId !== null && event.scenarioId !== scenarioId) return false;
    if (serviceName !== null && event.serviceName !== serviceName) return false;
    return true;
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { ok: true, failMode, events: events.length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      writeJson(res, 200, { events: filteredEvents(url) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/reset') {
      events = [];
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/fail') {
      const raw = await readBody(req);
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      failMode = body.enabled === true;
      writeJson(res, 200, { ok: true, failMode });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/ingest' || url.pathname === '/webhook')) {
      if (failMode) {
        writeJson(res, 503, { error: 'sink intentionally unavailable' });
        return;
      }
      const raw = await readBody(req);
      if (url.pathname === '/webhook') {
        if (!verifyWebhookSignature(raw, req.headers['x-errorcore-webhook-signature'])) {
          writeJson(res, 401, { error: 'invalid signature' });
          return;
        }
        const batch = JSON.parse(raw);
        const records = [];
        for (const event of batch.events ?? []) {
          if (event.kind === 'payload_blob') continue;
          records.push(storeEnvelope(event.payload, { transport: 'webhook' }));
        }
        writeJson(res, 202, { ok: true, accepted: records.length });
        return;
      }
      const record = storeEnvelope(raw, {
        transport: 'http',
        headers: {
          eventId: req.headers['x-errorcore-event-id'],
          keyId: req.headers['x-errorcore-key-id'],
          kind: req.headers['x-errorcore-payload-kind']
        }
      });
      writeJson(res, 202, { ok: true, eventId: record.eventId });
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`errorcore sink listening on ${port}`);
});
