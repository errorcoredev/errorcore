import http from 'node:http';

const port = Number(process.env.PORT ?? 3020);

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/healthz') {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/ok') {
    writeJson(res, 200, { ok: true, scenario: url.searchParams.get('scenario') });
    return;
  }
  if (url.pathname === '/malformed-json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":');
    return;
  }
  if (url.pathname === '/delay') {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 250), 5000);
    const status = Number(url.searchParams.get('status') ?? 504);
    setTimeout(() => {
      writeJson(res, status, {
        error: 'delayed upstream failure',
        scenario: url.searchParams.get('scenario')
      });
    }, ms);
    return;
  }
  if (url.pathname === '/fail') {
    const status = Number(url.searchParams.get('status') ?? 503);
    writeJson(res, status, {
      error: 'upstream failure',
      scenario: url.searchParams.get('scenario')
    });
    return;
  }
  writeJson(res, 404, { error: 'not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`upstream mock listening on ${port}`);
});
