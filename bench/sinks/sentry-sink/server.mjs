import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.PORT ?? 3011);
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.resolve('results');
const sinkDir = path.join(resultsDir, 'raw', 'sentry-sink');

fs.mkdirSync(sinkDir, { recursive: true });

let failMode = false;
let events = [];
let envelopeSummaries = [];

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function append(file, record) {
  fs.appendFileSync(path.join(sinkDir, file), JSON.stringify(record) + '\n');
}

function scenarioFromEvent(record) {
  return (
    record.scenarioId ??
    record.event?.tags?.['bench.scenario_id'] ??
    record.event?.contexts?.benchmark?.scenarioId ??
    'unknown'
  );
}

function serviceFromEvent(record) {
  return record.serviceName ?? record.event?.tags?.['bench.service'] ?? record.event?.server_name ?? 'unknown';
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

function filteredEnvelopeSummaries(url) {
  const scenarioId = url.searchParams.get('scenarioId');
  const serviceName = url.searchParams.get('serviceName');
  return envelopeSummaries.filter((envelope) => {
    if (scenarioId !== null && envelope.scenarioId !== scenarioId) return false;
    if (serviceName !== null && envelope.serviceName !== serviceName) return false;
    return true;
  });
}

function summarizeEnvelope(record) {
  const envelope = record.envelope;
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope ?? null));
  return {
    sdk: record.sdk,
    receivedAt: record.receivedAt,
    scenarioId: record.scenarioId,
    serviceName: record.serviceName,
    framework: record.framework,
    envelopeBytes,
    itemCount: Array.isArray(envelope) ? envelope.length : undefined
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { ok: true, failMode, events: events.length, envelopes: envelopeSummaries.length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const matchingEnvelopeSummaries = filteredEnvelopeSummaries(url);
      const body = {
        events: filteredEvents(url),
        envelopeCount: matchingEnvelopeSummaries.length
      };
      if (url.searchParams.get('includeEnvelopes') === 'true') {
        body.envelopes = matchingEnvelopeSummaries;
      }
      writeJson(res, 200, body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/reset') {
      events = [];
      envelopeSummaries = [];
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/fail') {
      const body = await readJson(req);
      failMode = body.enabled === true;
      writeJson(res, 200, { ok: true, failMode });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/before-send') {
      if (failMode) {
        writeJson(res, 503, { error: 'sink intentionally unavailable' });
        return;
      }
      const body = await readJson(req);
      const record = {
        sdk: 'sentry',
        receivedAt: new Date().toISOString(),
        scenarioId: scenarioFromEvent(body),
        serviceName: serviceFromEvent(body),
        framework: body.framework,
        event: body.event
      };
      events.push(record);
      append('before-send.ndjson', record);
      writeJson(res, 202, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/envelope') {
      if (failMode) {
        writeJson(res, 503, { error: 'sink intentionally unavailable' });
        return;
      }
      const body = await readJson(req);
      const record = {
        sdk: 'sentry',
        receivedAt: new Date().toISOString(),
        scenarioId: body.scenarioId ?? 'unknown',
        serviceName: body.serviceName ?? 'unknown',
        framework: body.framework,
        envelope: body.envelope
      };
      envelopeSummaries.push(summarizeEnvelope(record));
      append('envelopes.ndjson', record);
      writeJson(res, 202, { ok: true });
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`sentry sink listening on ${port}`);
});
