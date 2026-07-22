import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.PORT ?? 3012);
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.resolve('results');
const sinkDir = path.join(resultsDir, 'raw', 'bugsnag-sink');

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function appendRecord(record) {
  events.push(record);
  fs.appendFileSync(path.join(sinkDir, 'events.ndjson'), JSON.stringify(record) + '\n');
}

function scenarioFromEvent(event, body) {
  return (
    event?.metaData?.benchmark?.scenarioId ??
    event?.metadata?.benchmark?.scenarioId ??
    event?.metaData?.['bench']?.scenarioId ??
    body?.scenarioId ??
    'unknown'
  );
}

function serviceFromEvent(event, body) {
  return (
    event?.metaData?.benchmark?.serviceName ??
    event?.metadata?.benchmark?.serviceName ??
    event?.metaData?.['bench']?.serviceName ??
    body?.serviceName ??
    'unknown'
  );
}

function frameworkFromEvent(event, body) {
  return (
    event?.metaData?.benchmark?.framework ??
    event?.metadata?.benchmark?.framework ??
    body?.framework
  );
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

function storeNotifyBody(body) {
  const notifyEvents = Array.isArray(body.events) ? body.events : [];
  const records = [];
  for (const event of notifyEvents) {
    const record = {
      sdk: 'bugsnag',
      receivedAt: new Date().toISOString(),
      scenarioId: scenarioFromEvent(event, body),
      serviceName: serviceFromEvent(event, body),
      framework: frameworkFromEvent(event, body),
      event
    };
    appendRecord(record);
    records.push(record);
  }
  return records;
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
      const body = await readJson(req);
      failMode = body.enabled === true;
      writeJson(res, 200, { ok: true, failMode });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/notify') {
      if (failMode) {
        writeJson(res, 503, { error: 'sink intentionally unavailable' });
        return;
      }
      const records = storeNotifyBody(await readJson(req));
      writeJson(res, 200, { ok: true, accepted: records.length });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (failMode) {
        writeJson(res, 503, { error: 'sink intentionally unavailable' });
        return;
      }
      await readJson(req);
      writeJson(res, 202, { ok: true, accepted: 1 });
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`bugsnag sink listening on ${port}`);
});
