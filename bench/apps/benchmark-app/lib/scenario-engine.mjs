import { randomBytes } from 'node:crypto';

function makeTraceparent() {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

function getHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function decorate(error, scenarioId, context) {
  error.scenarioId = scenarioId;
  error.benchmarkTarget = context.framework;
  error.benchmarkService = context.serviceName;
  return error;
}

function json(status, body) {
  return { status, body };
}

function assertParsedOrderBody(body) {
  const customerId = Number(body?.order?.customer?.id ?? 42);
  const sku = String(body?.order?.items?.[0]?.sku ?? 'sku-pro');
  const quantity = Number(body?.order?.items?.[0]?.quantity ?? 1);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new TypeError('order.customer.id must be a positive integer');
  }
  if (sku.length === 0 || !Number.isFinite(quantity)) {
    throw new TypeError('order item is malformed');
  }
  return { customerId, sku, quantity };
}

function applyPolicyLimit(account, parsedOrder) {
  const limitCents = account.profile?.limits?.monthly?.limitCents;
  const normalizedLimit = limitCents.toFixed(2);
  return {
    accountId: account.id,
    sku: parsedOrder.sku,
    normalizedLimit
  };
}

async function requireUpstreamOk(url, logger, fault) {
  logger.dependency('dependency:http-fetch', {
    dependency: 'upstream-http',
    fault,
    url
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`upstream dependency returned HTTP ${response.status}`);
  }
  return response;
}

function parserPluginLayer(raw) {
  return JSON.parse(raw);
}

function ormHydrationLayer(row) {
  return inventoryPluginLayer(row);
}

function inventoryPluginLayer(row) {
  if (row.inventory?.sku?.startsWith('sku-') !== true) {
    throw new Error('ORM hydration failed: inventory.sku missing after parser plugin');
  }
  return row;
}

export function createScenarioEngine(options) {
  const {
    sdk,
    dependencies,
    logger,
    framework,
    serviceName,
    serviceRole,
    upstreamUrl,
    serviceBUrl
  } = options;
  let perfCounter = 0;

  async function capture(error, context = {}) {
    sdk.captureException(error, context);
    await sdk.flush(3000);
  }

  async function runScenario(scenarioId, requestContext = {}) {
    logger.trigger('request:start', {
      scenarioId,
      method: requestContext.method,
      path: requestContext.path
    });

    if (scenarioId === 'S1') {
      const parsedOrder = assertParsedOrderBody(requestContext.body);
      const result = await dependencies.query(
        'select id, email, profile from bench_accounts where id = $1',
        [parsedOrder.customerId],
        { fault: 'schema-mismatch' }
      );
      const account = result.rows[0];
      if (account === undefined) {
        throw decorate(new Error(`account ${parsedOrder.customerId} not found`), scenarioId, options);
      }
      return json(200, applyPolicyLimit(account, parsedOrder));
    }

    if (scenarioId === 'S2') {
      await requireUpstreamOk(`${upstreamUrl}/fail?status=503&scenario=S2`, logger, 'http-503');
      return json(200, { ok: true });
    }

    if (scenarioId === 'S3') {
      void (async function esmBackgroundWorkerDependency() {
        try {
          await dependencies.redisGetRequired('bench:missing-worker-input');
        } catch (error) {
          throw decorate(error, scenarioId, options);
        }
      })();
      return json(202, { accepted: true, scenarioId });
    }

    if (scenarioId === 'S4') {
      await dependencies.query('select id from bench_accounts where id = $1', [42]);
      await dependencies.query('select profile from bench_accounts where id = $1', [84]);
      await dependencies.redisSet('bench:last-s4', new Date().toISOString());
      await requireUpstreamOk(`${upstreamUrl}/fail?status=502&scenario=S4`, logger, 'http-502-after-db');
      return json(200, { ok: true });
    }

    if (scenarioId === 'S5') {
      if (serviceRole === 'B') {
        await dependencies.query('select id from bench_accounts where id = $1', [42]);
        throw decorate(new Error('service-b inventory reservation failed'), scenarioId, options);
      }

      const traceparent =
        getHeader(requestContext.headers, 'traceparent') ??
        sdk.getTraceHeaders()?.traceparent ??
        makeTraceparent();
      const target = `${serviceBUrl}/scenario/S5`;
      logger.dependency('dependency:service-b-fetch', {
        dependency: 'service-b',
        fault: 'service-b-500',
        traceparent
      });
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          traceparent
        },
        body: JSON.stringify({ from: serviceName })
      });
      if (!response.ok) {
        throw decorate(new Error(`service-b failed with HTTP ${response.status}`), scenarioId, options);
      }
      return json(200, { ok: true });
    }

    if (scenarioId === 'S6') {
      setTimeout(() => {
        void (async function delayedUpstreamFailureAfterResponse() {
          try {
            await requireUpstreamOk(`${upstreamUrl}/delay?ms=250&status=504&scenario=S6`, logger, 'delayed-http-504');
          } catch (error) {
            const captured = decorate(
              new Error(`delayed upstream failed after response: ${error.message}`),
              scenarioId,
              options
            );
            captured.cause = error;
            await capture(captured, { scenarioId, phase: 'delayed' });
          }
        })();
      }, 25).unref();
      return json(202, { accepted: true, scenarioId });
    }

    if (scenarioId === 'S7') {
      const queue = 'bench:jobs';
      await dependencies.pushJob(queue, { jobType: 'reprice', payload: { malformed: true } });
      setTimeout(() => {
        void (async function queueConsumer() {
          try {
            const rawJob = await dependencies.popJob(queue);
            const job = JSON.parse(rawJob ?? '{"payload":{}}');
            const cents = job.payload.price.cents;
            if (!Number.isInteger(cents)) {
              throw new TypeError('job.payload.price.cents must be an integer');
            }
          } catch (error) {
            await capture(decorate(error, scenarioId, options), { scenarioId, phase: 'queue-consumer' });
          }
        })();
      }, 25).unref();
      return json(202, { accepted: true, scenarioId });
    }

    if (scenarioId === 'S8') {
      const parsed = parserPluginLayer('{"inventory":{"sku":null},"source":"parser-plugin"}');
      ormHydrationLayer(parsed);
      return json(200, { ok: true });
    }

    if (scenarioId === 'S9') {
      await dependencies.query('select id, profile from bench_accounts where id = $1', [42]);
      throw decorate(new Error('checkout failed while capture sink is unreachable'), scenarioId, options);
    }

    return json(404, { error: `unknown scenario ${scenarioId}` });
  }

  return {
    async handleScenario(scenarioId, requestContext) {
      try {
        return await runScenario(scenarioId, requestContext);
      } catch (error) {
        const captured = decorate(error, scenarioId, options);
        await capture(captured, { scenarioId, phase: 'request' });
        return json(500, {
          scenarioId,
          error: {
            type: captured.name,
            message: captured.message
          }
        });
      }
    },
    capture,
    flush: sdk.flush,
    async health() {
      return { ok: true, framework, sdk: sdk.name, serviceName, serviceRole };
    },
    async perfSuccess() {
      perfCounter += 1;
      const parsedOrder = assertParsedOrderBody({
        order: {
          customer: { id: 42 },
          items: [{ sku: 'sku-pro', quantity: 1 }]
        }
      });
      return {
        ok: true,
        framework,
        sdk: sdk.name,
        serviceName,
        counter: perfCounter,
        sku: parsedOrder.sku
      };
    },
    async perfErrorCapture() {
      perfCounter += 1;
      const error = decorate(new Error('perf capture synthetic error'), 'PERF', options);
      sdk.captureException(error, { scenarioId: 'PERF', phase: 'perf-error-capture' });
      return {
        ok: true,
        captured: true,
        framework,
        sdk: sdk.name,
        serviceName,
        counter: perfCounter
      };
    }
  };
}
