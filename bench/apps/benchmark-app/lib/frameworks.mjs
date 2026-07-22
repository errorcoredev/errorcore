import http from 'node:http';

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function headersToObject(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.join(',');
  }
  return result;
}

function sendNodeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function startExpress({ port, sdk, engine }) {
  const express = (await import('express')).default;
  const app = express();
  if (sdk.frameworkMiddleware.express !== undefined) {
    app.use(sdk.frameworkMiddleware.express);
  }
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', async (_req, res) => res.json(await engine.health()));
  app.get('/perf/success', async (_req, res) => res.json(await engine.perfSuccess()));
  app.get('/perf/error-capture', async (_req, res) => res.json(await engine.perfErrorCapture()));
  app.post('/scenario/:id', async (req, res) => {
    const result = await engine.handleScenario(req.params.id, {
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      body: req.body
    });
    res.status(result.status).json(result.body);
  });
  app.post('/__flush', async (_req, res) => {
    await engine.flush();
    res.json({ ok: true });
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(port, () => resolve(instance));
  });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startFastify({ port, sdk, engine }) {
  const fastify = (await import('fastify')).default;
  const app = fastify({ logger: false });
  if (sdk.frameworkMiddleware.fastify !== undefined) {
    await app.register(sdk.frameworkMiddleware.fastify);
  }
  app.get('/healthz', async () => engine.health());
  app.get('/perf/success', async () => engine.perfSuccess());
  app.get('/perf/error-capture', async () => engine.perfErrorCapture());
  app.post('/scenario/:id', async (request, reply) => {
    const result = await engine.handleScenario(request.params.id, {
      method: request.raw.method,
      path: request.raw.url,
      headers: request.raw.headers,
      body: request.body
    });
    return reply.code(result.status).send(result.body);
  });
  app.post('/__flush', async () => {
    await engine.flush();
    return { ok: true };
  });
  await app.listen({ host: '0.0.0.0', port });
  return { close: () => app.close() };
}

async function startKoa({ port, sdk, engine }) {
  const Koa = (await import('koa')).default;
  const Router = (await import('@koa/router')).default;
  const app = new Koa();
  const router = new Router();
  if (sdk.frameworkMiddleware.koa !== undefined) {
    app.use(sdk.frameworkMiddleware.koa);
  }
  router.get('/healthz', async (ctx) => {
    ctx.body = await engine.health();
  });
  router.get('/perf/success', async (ctx) => {
    ctx.body = await engine.perfSuccess();
  });
  router.get('/perf/error-capture', async (ctx) => {
    ctx.body = await engine.perfErrorCapture();
  });
  router.post('/scenario/:id', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const result = await engine.handleScenario(ctx.params.id, {
      method: ctx.method,
      path: ctx.path,
      headers: ctx.headers,
      body
    });
    ctx.status = result.status;
    ctx.body = result.body;
  });
  router.post('/__flush', async (ctx) => {
    await engine.flush();
    ctx.body = { ok: true };
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  const server = await new Promise((resolve) => {
    const instance = app.listen(port, () => resolve(instance));
  });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startHapi({ port, sdk, engine }) {
  const Hapi = await import('@hapi/hapi');
  const server = Hapi.server({ host: '0.0.0.0', port });
  if (sdk.frameworkMiddleware.hapi !== undefined) {
    await server.register(sdk.frameworkMiddleware.hapi);
  }
  server.route({
    method: 'GET',
    path: '/healthz',
    handler: async () => engine.health()
  });
  server.route({
    method: 'GET',
    path: '/perf/success',
    handler: async () => engine.perfSuccess()
  });
  server.route({
    method: 'GET',
    path: '/perf/error-capture',
    handler: async () => engine.perfErrorCapture()
  });
  server.route({
    method: 'POST',
    path: '/scenario/{id}',
    handler: async (request, h) => {
      const result = await engine.handleScenario(request.params.id, {
        method: request.method.toUpperCase(),
        path: request.path,
        headers: request.headers,
        body: request.payload ?? {}
      });
      return h.response(result.body).code(result.status);
    }
  });
  server.route({
    method: 'POST',
    path: '/__flush',
    handler: async () => {
      await engine.flush();
      return { ok: true };
    }
  });
  await server.start();
  return { close: () => server.stop({ timeout: 1000 }) };
}

async function startHono({ port, sdk, engine }) {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const app = new Hono();
  if (sdk.frameworkMiddleware.hono !== undefined) {
    app.use('*', sdk.frameworkMiddleware.hono);
  }
  app.get('/healthz', async (ctx) => ctx.json(await engine.health()));
  app.get('/perf/success', async (ctx) => ctx.json(await engine.perfSuccess()));
  app.get('/perf/error-capture', async (ctx) => ctx.json(await engine.perfErrorCapture()));
  app.post('/scenario/:id', async (ctx) => {
    const body = await ctx.req.json().catch(() => ({}));
    const result = await engine.handleScenario(ctx.req.param('id'), {
      method: ctx.req.method,
      path: new URL(ctx.req.url).pathname,
      headers: Object.fromEntries(ctx.req.raw.headers.entries()),
      body
    });
    return ctx.json(result.body, result.status);
  });
  app.post('/__flush', async (ctx) => {
    await engine.flush();
    return ctx.json({ ok: true });
  });
  const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startPlainNode({ port, engine }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendNodeJson(res, 200, await engine.health());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/perf/success') {
      sendNodeJson(res, 200, await engine.perfSuccess());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/perf/error-capture') {
      sendNodeJson(res, 200, await engine.perfErrorCapture());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__flush') {
      await engine.flush();
      sendNodeJson(res, 200, { ok: true });
      return;
    }
    const match = url.pathname.match(/^\/scenario\/([^/]+)$/);
    if (req.method === 'POST' && match !== null) {
      const result = await engine.handleScenario(match[1], {
        method: req.method,
        path: url.pathname,
        headers: headersToObject(req.headers),
        body: await readJsonBody(req)
      });
      sendNodeJson(res, result.status, result.body);
      return;
    }
    sendNodeJson(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function startFrameworkServer(config) {
  if (config.framework === 'express') return startExpress(config);
  if (config.framework === 'fastify') return startFastify(config);
  if (config.framework === 'koa') return startKoa(config);
  if (config.framework === 'hapi') return startHapi(config);
  if (config.framework === 'hono') return startHono(config);
  return startPlainNode(config);
}
