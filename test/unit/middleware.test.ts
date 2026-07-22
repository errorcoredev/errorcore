import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { HeaderFilter } from '../../src/pii/header-filter';
import { expressMiddleware } from '../../src/middleware/express';
import { fastifyPlugin } from '../../src/middleware/fastify';
import { koaMiddleware } from '../../src/middleware/koa';
import { hapiPlugin } from '../../src/middleware/hapi';
import { honoMiddleware } from '../../src/middleware/hono';
import { wrapHandler } from '../../src/middleware/raw-http';
import { withErrorcore } from '../../src/middleware/nextjs';
import { resolveTestConfig } from '../helpers/test-config';

function createSdk(options?: { active?: boolean; throwOnCreate?: boolean }) {
  const headerFilter = new HeaderFilter(resolveTestConfig());
  const als = new ALSManager({
    headerFilter: (headers) => headerFilter.filterAndNormalizeHeaders(headers)
  });
  let addedContext:
    | {
        requestId: string;
        headers?: Record<string, string>;
        method?: string;
        url?: string;
      }
    | undefined;

  return {
    sdk: {
      isActive: () => options?.active ?? true,
      captureError: vi.fn(),
      flush: vi.fn(async () => undefined),
      als: {
        createRequestContext: vi.fn((input: {
          method: string;
          url: string;
          headers: unknown;
        }) => {
          if (options?.throwOnCreate) {
            throw new Error('sdk failure');
          }

          return als.createRequestContext(input);
        }),
        runWithContext: als.runWithContext.bind(als),
        enterWithContext: vi.fn(als.enterWithContext.bind(als)),
        getContext: als.getContext.bind(als),
        getRequestId: als.getRequestId.bind(als),
        getStore: als.getStore.bind(als),
        attachRequestContextMaterializationHook:
          als.attachRequestContextMaterializationHook.bind(als),
        isRequestContextMaterialized: als.isRequestContextMaterialized.bind(als),
        ensureRequestContextMaterialized: als.ensureRequestContextMaterialized.bind(als)
      },
      prepareForRequestStart: vi.fn(),
      requestTracker: {
        add: vi.fn((ctx: { requestId: string }) => {
          addedContext = ctx;
        }),
        remove: vi.fn()
      },
      releaseCompletedRequestContext: vi.fn(),
      headerFilter
    },
    als,
    getAddedContext: () => addedContext
  };
}

function createEmitter<T extends object>(fields: T): EventEmitter & T {
  return Object.assign(new EventEmitter(), fields);
}

function createHonoContext(options?: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  status?: number;
}) {
  return {
    req: {
      method: options?.method ?? 'GET',
      url: options?.url ?? 'http://localhost/hono',
      raw: {
        headers: new Headers(options?.headers ?? {})
      }
    },
    res: {
      status: options?.status ?? 200
    }
  };
}

describe('middleware adapters', () => {
  it('express propagates ALS context through async handlers and cleans up on finish', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    const middleware = expressMiddleware(sdk);
    const req = {
      method: 'GET',
      url: '/users',
      headers: {
        host: 'service.local',
        authorization: 'secret',
        cookie: 'session=secret',
        'x-request-id': ['req-1', 'req-2']
      }
    };
    const res = new EventEmitter() as EventEmitter & { finished?: boolean };
    let observedRequestId: string | undefined;

    await new Promise<void>((resolve) => {
      middleware(req, res, () => {
        setTimeout(() => {
          observedRequestId = als.getRequestId();
          void als.getContext()?.headers;
          resolve();
        }, 0);
      });
    });

    const captured = getAddedContext();

    req.method = 'POST';
    req.url = '/mutated';
    req.headers.host = 'changed.local';
    res.emit('finish');

    expect(observedRequestId).toBe(captured?.requestId);
    expect(captured).toMatchObject({
      method: 'GET',
      url: '/users',
      headers: {
        host: 'service.local',
        'x-request-id': 'req-1, req-2'
      }
    });
    expect((captured as Record<string, unknown>)?.req).toBeUndefined();
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
    expect(captured?.headers).not.toHaveProperty('authorization');
    expect(captured?.headers).not.toHaveProperty('cookie');
  });

  it('express does not track or register cleanup for an unmaterialized successful request', () => {
    const { sdk } = createSdk();
    const middleware = expressMiddleware(sdk);
    const req = createEmitter({
      method: 'GET',
      url: '/success',
      headers: { host: 'service.local' }
    });
    const res = createEmitter({ statusCode: 200, finished: false });
    const next = vi.fn();

    middleware(req as never, res as never, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
    expect(sdk.requestTracker.remove).not.toHaveBeenCalled();
    expect(sdk.releaseCompletedRequestContext).not.toHaveBeenCalled();
  });

  it('express snapshots method and url but reads headers at first materialization', () => {
    const { sdk, als } = createSdk();
    let context = undefined as ReturnType<typeof als.getContext>;
    const req = {
      method: 'GET',
      url: '/before',
      headers: {
        host: 'before.local',
        'x-request-id': 'req-before'
      }
    };

    expressMiddleware(sdk)(req, new EventEmitter() as never, () => {
      context = als.getContext();
    });

    req.method = 'POST';
    req.url = '/after';
    req.headers.host = 'after.local';
    req.headers['x-request-id'] = 'req-after';

    expect(context?.method).toBe('GET');
    expect(context?.url).toBe('/before');
    expect(context?.headers).toMatchObject({
      host: 'after.local',
      'x-request-id': 'req-after'
    });
  });

  it('express delayed materialization after finish preserves request data until post-capture cleanup', () => {
    const { sdk, als } = createSdk();
    let context = undefined as ReturnType<typeof als.getContext>;
    const req = createEmitter({
      method: 'GET',
      url: '/delayed',
      headers: {
        host: 'before.local',
        'x-request-id': 'req-delayed'
      }
    });
    const res = createEmitter({ statusCode: 200, finished: false });

    expressMiddleware(sdk)(req as never, res as never, () => {
      context = als.getContext();
    });

    res.finished = true;
    res.emit('finish');
    req.headers.host = 'after.local';

    expect(sdk.releaseCompletedRequestContext).not.toHaveBeenCalled();
    expect(context?.headers).toMatchObject({
      host: 'after.local',
      'x-request-id': 'req-delayed'
    });
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();

    if (context !== undefined) {
      als.runPostCaptureCleanup(context);
    }

    expect(sdk.releaseCompletedRequestContext).toHaveBeenCalledWith(context, true);
  });

  it('express reuses a recorder-owned request context when ALS is missing at the middleware boundary', () => {
    const { sdk, als } = createSdk();
    const middleware = expressMiddleware(sdk as never);
    const req = {
      method: 'GET',
      url: '/recorder-owned',
      headers: { host: 'service.local' }
    };
    const res = new EventEmitter() as EventEmitter & { finished?: boolean };
    const carried = als.createRequestContext({
      method: 'GET',
      url: '/recorder-owned',
      headers: { host: 'service.local' }
    });
    const getRequestContextForRequest = vi.fn(() => carried);
    const claimRequestCleanupForRequest = vi.fn(() => false);
    let observedRequestId: string | undefined;

    (sdk as Record<string, unknown>).getRequestContextForRequest = getRequestContextForRequest;
    (sdk as Record<string, unknown>).claimRequestCleanupForRequest = claimRequestCleanupForRequest;

    middleware(req, res, () => {
      observedRequestId = als.getRequestId();
    });

    expect(observedRequestId).toBe(carried.requestId);
    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(getRequestContextForRequest).toHaveBeenCalledWith(req);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('express passes through when SDK is not active', () => {
    const { sdk } = createSdk({ active: false });
    const middleware = expressMiddleware(sdk);
    const next = vi.fn();

    middleware(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('falls back to the active module SDK when a bound middleware SDK was shut down', () => {
    const stale = createSdk({ active: false });
    const active = createSdk();
    const globalKey = Symbol.for('errorcore.sdk.instance');
    const previous = (globalThis as Record<symbol, unknown>)[globalKey];
    (globalThis as Record<symbol, unknown>)[globalKey] = active.sdk;

    try {
      const next = vi.fn(() => {
        void active.als.getContext()?.headers;
      });
      expressMiddleware(stale.sdk)(
        { method: 'GET', url: '/live', headers: {} },
        new EventEmitter() as never,
        next
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(stale.sdk.requestTracker.add).not.toHaveBeenCalled();
      expect(active.sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete (globalThis as Record<symbol, unknown>)[globalKey];
      } else {
        (globalThis as Record<symbol, unknown>)[globalKey] = previous;
      }
    }
  });

  it('re-arms local capture before active framework handlers run', async () => {
    const express = createSdk();
    expressMiddleware(express.sdk)(
      { method: 'GET', url: '/express', headers: {} },
      new EventEmitter() as never,
      () => {
        expect(express.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);
      }
    );

    const fastify = createSdk();
    let fastifyHook:
      | ((request: { raw: { method: string; url: string; headers: Record<string, unknown> } }, reply: {
          raw: EventEmitter & { finished?: boolean; on(event: 'finish', listener: () => void): void };
        }, done: () => void) => void)
      | undefined;
    fastifyPlugin(fastify.sdk)(
      {
        addHook: vi.fn((_name, handler) => {
          fastifyHook = handler;
        })
      } as never,
      {},
      () => undefined
    );
    fastifyHook?.(
      { raw: { method: 'GET', url: '/fastify', headers: {} } },
      { raw: new EventEmitter() as EventEmitter & { finished?: boolean } },
      () => {
        expect(fastify.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);
      }
    );

    const koa = createSdk();
    await koaMiddleware(koa.sdk)(
      {
        request: { method: 'GET', url: '/koa', headers: {} },
        res: new EventEmitter() as EventEmitter & { finished?: boolean }
      } as never,
      async () => {
        expect(koa.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);
      }
    );

    const hapi = createSdk();
    let hapiHandler:
      | ((request: {
          method: string;
          url: { pathname: string };
          headers: Record<string, unknown>;
          raw: { res: EventEmitter & { finished?: boolean } };
        }, h: { continue: symbol }) => symbol)
      | undefined;
    hapiPlugin.register(
      {
        ext: vi.fn((_name, handler) => {
          hapiHandler = handler;
        })
      } as never,
      { sdk: hapi.sdk }
    );
    hapiHandler?.(
      {
        method: 'get',
        url: { pathname: '/hapi' },
        headers: {},
        raw: { res: new EventEmitter() as EventEmitter & { finished?: boolean } }
      },
      { continue: Symbol('continue') }
    );
    expect(hapi.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);

    const raw = createSdk();
    wrapHandler((_req, _res) => {
      expect(raw.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);
    }, raw.sdk)(
      { method: 'GET', url: '/raw', headers: {} },
      new EventEmitter() as never
    );

    const next = createSdk();
    await withErrorcore(async () => {
      expect(next.sdk.prepareForRequestStart).toHaveBeenCalledTimes(1);
      return { status: 200 };
    }, next.sdk)(createNextRequest());
  });

  it('does not re-arm local capture when SDK is inactive', async () => {
    const express = createSdk({ active: false });
    expressMiddleware(express.sdk)(
      { method: 'GET', url: '/express', headers: {} },
      new EventEmitter() as never,
      () => undefined
    );

    const raw = createSdk({ active: false });
    wrapHandler((_req, _res) => undefined, raw.sdk)(
      { method: 'GET', url: '/raw', headers: {} },
      new EventEmitter() as never
    );

    const next = createSdk({ active: false });
    await withErrorcore(async () => ({ status: 200 }), next.sdk)(createNextRequest());

    expect(express.sdk.prepareForRequestStart).not.toHaveBeenCalled();
    expect(raw.sdk.prepareForRequestStart).not.toHaveBeenCalled();
    expect(next.sdk.prepareForRequestStart).not.toHaveBeenCalled();
  });

  it('fastify hook sets up ALS context', () => {
    const { sdk, als, getAddedContext } = createSdk();
    let hook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: { finished?: boolean; on(event: 'finish', listener: () => void): void };
          },
          done: () => void
        ) => void)
      | undefined;
    const fastify = {
      addHook: vi.fn((_name, handler) => {
        hook = handler;
      })
    };

    fastifyPlugin(sdk)(fastify as never, {}, () => undefined);

    let requestId: string | undefined;

    hook?.(
      {
        raw: {
          method: 'POST',
          url: '/items',
          headers: {
            host: 'service.local',
            authorization: 'secret',
            cookie: 'session=secret',
            'x-request-id': ['req-fastify-1', 'req-fastify-2']
          }
        }
      },
      {
        raw: new EventEmitter() as EventEmitter & {
          finished?: boolean;
          on(event: 'finish', listener: () => void): void;
        }
      },
      () => {
        requestId = als.getRequestId();
        void als.getContext()?.headers;
      }
    );

    expect(requestId).toBeDefined();
    expect(getAddedContext()).toMatchObject({
      headers: {
        host: 'service.local',
        'x-request-id': 'req-fastify-1, req-fastify-2'
      }
    });
    expect(getAddedContext()?.headers).not.toHaveProperty('authorization');
    expect(getAddedContext()?.headers).not.toHaveProperty('cookie');
  });

  it('fastify enters context for the lifecycle after the onRequest hook returns', () => {
    const { sdk, als } = createSdk();
    let hook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: { finished?: boolean; on(event: 'finish', listener: () => void): void };
          },
          done: () => void
        ) => void)
      | undefined;
    const fastify = {
      addHook: vi.fn((_name, handler) => {
        hook = handler;
      })
    };

    fastifyPlugin(sdk)(fastify as never, {}, () => undefined);

    hook?.(
      {
        raw: {
          method: 'GET',
          url: '/fastify-enter',
          headers: {}
        }
      },
      {
        raw: new EventEmitter() as EventEmitter & {
          finished?: boolean;
          on(event: 'finish', listener: () => void): void;
        }
      },
      () => undefined
    );

    expect(sdk.als.enterWithContext).toHaveBeenCalledTimes(1);
    expect(als.getRequestId()).toBeDefined();
  });

  it('fastify reuses a recorder-owned request context when ALS is missing at the hook boundary', () => {
    const { sdk, als } = createSdk();
    const carried = als.createRequestContext({
      method: 'GET',
      url: '/fastify-recorder-owned',
      headers: { host: 'service.local' }
    });
    let hook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: { finished?: boolean; on(event: 'finish', listener: () => void): void };
          },
          done: () => void
        ) => void)
      | undefined;
    const raw = {
      method: 'GET',
      url: '/fastify-recorder-owned',
      headers: { host: 'service.local' }
    };
    const getRequestContextForRequest = vi.fn(() => carried);
    const claimRequestCleanupForRequest = vi.fn(() => false);
    let observedRequestId: string | undefined;

    (sdk as Record<string, unknown>).getRequestContextForRequest = getRequestContextForRequest;
    (sdk as Record<string, unknown>).claimRequestCleanupForRequest = claimRequestCleanupForRequest;

    fastifyPlugin(sdk as never)(
      {
        addHook: vi.fn((_name, handler) => {
          hook = handler;
        })
      } as never,
      {},
      () => undefined
    );

    hook?.(
      { raw },
      {
        raw: new EventEmitter() as EventEmitter & {
          finished?: boolean;
          on(event: 'finish', listener: () => void): void;
        }
      },
      () => {
        observedRequestId = als.getRequestId();
      }
    );

    expect(observedRequestId).toBe(carried.requestId);
    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(getRequestContextForRequest).toHaveBeenCalledWith(raw);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('koa propagates context through the async middleware chain', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    const middleware = koaMiddleware(sdk);
    const ctx = {
      request: {
        method: 'PUT',
        url: '/account',
        headers: {
          host: 'service.local',
          authorization: 'secret',
          cookie: 'session=secret',
          'x-request-id': ['req-3', 'req-4']
        }
      },
      res: new EventEmitter() as EventEmitter & {
        finished?: boolean;
        on(event: 'finish', listener: () => void): void;
      }
    };
    let requestId: string | undefined;

    await middleware(ctx as never, async () => {
      await Promise.resolve();
      requestId = als.getRequestId();
      void als.getContext()?.headers;
    });

    expect(requestId).toBeDefined();
    expect(getAddedContext()).toMatchObject({
      headers: {
        host: 'service.local',
        'x-request-id': 'req-3, req-4'
      }
    });
    expect(getAddedContext()?.headers).not.toHaveProperty('authorization');
    expect(getAddedContext()?.headers).not.toHaveProperty('cookie');
  });

  it('hono middleware propagates trace context and cleans up successful requests', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    const middleware = honoMiddleware(sdk);
    const ctx = createHonoContext({
      method: 'POST',
      url: 'http://localhost/hono?ok=true',
      headers: {
        host: 'service.local',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'partner=quickstart',
        authorization: 'secret',
        cookie: 'session=secret'
      },
      status: 204
    });
    let requestId: string | undefined;

    await middleware(ctx, async () => {
      await Promise.resolve();
      requestId = als.getRequestId();
      void als.getContext()?.headers;
    });

    const captured = getAddedContext();
    expect(requestId).toBe(captured?.requestId);
    expect(captured).toMatchObject({
      method: 'POST',
      url: 'http://localhost/hono?ok=true',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      headers: {
        host: 'service.local',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'partner=quickstart'
      }
    });
    expect(captured?.headers).not.toHaveProperty('authorization');
    expect(captured?.headers).not.toHaveProperty('cookie');
    expect(sdk.releaseCompletedRequestContext).toHaveBeenCalledWith(captured, true);
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('hono middleware captures thrown route errors and rethrows them', async () => {
    const { sdk, getAddedContext } = createSdk();
    const middleware = honoMiddleware(sdk);
    const boom = new Error('hono boom');

    await expect(
      middleware(createHonoContext(), async () => {
        void sdk.als.getContext?.()?.headers;
        throw boom;
      })
    ).rejects.toThrow('hono boom');

    const captured = getAddedContext();
    expect(sdk.captureError).toHaveBeenCalledWith(boom);
    expect(sdk.releaseCompletedRequestContext).not.toHaveBeenCalled();
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('hono middleware retains 5xx request context and passes through inactive SDKs', async () => {
    const active = createSdk();
    await honoMiddleware(active.sdk)(createHonoContext({ status: 503 }), async () => {
      void active.als.getContext()?.headers;
    });

    expect(active.sdk.releaseCompletedRequestContext).not.toHaveBeenCalled();
    expect(active.sdk.requestTracker.remove).toHaveBeenCalledWith(active.getAddedContext()?.requestId);

    const inactive = createSdk({ active: false });
    const next = vi.fn(async () => undefined);
    await honoMiddleware(inactive.sdk)(createHonoContext(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(inactive.sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('hapi plugin keeps ALS context active for the route lifecycle', () => {
    const { sdk, als, getAddedContext } = createSdk();
    let handler:
      | ((
          request: {
            method: string;
            url: { pathname: string };
            headers: Record<string, unknown>;
            raw: { res: EventEmitter & { finished?: boolean } };
          },
          h: { continue: symbol }
        ) => symbol)
      | undefined;
    const res = new EventEmitter() as EventEmitter & { finished?: boolean };
    const marker = Symbol('continue');
    const server = {
      ext: vi.fn((_name, extHandler) => {
        handler = extHandler;
      })
    };

    hapiPlugin.register(server as never, { sdk });

    const result = handler?.(
      {
        method: 'get',
        url: { pathname: '/hapi' },
        headers: {
          host: 'service.local',
          authorization: 'secret',
          cookie: 'session=secret',
          'x-request-id': 'req-hapi'
        },
        raw: { res }
      },
      { continue: marker }
    );
    const routeRequestId = als.getRequestId();
    void als.getContext()?.headers;
    const captured = getAddedContext();

    expect(result).toBe(marker);
    expect(routeRequestId).toBe(captured?.requestId);
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      headers: {
        host: 'service.local',
        'x-request-id': 'req-hapi'
      }
    });
    expect(captured?.headers).not.toHaveProperty('authorization');
    expect(captured?.headers).not.toHaveProperty('cookie');

    res.emit('finish');
    expect(als.getRequestId()).toBeUndefined();
  });

  it('hapi plugin cleans an unmaterialized persistent context after a successful response', () => {
    const { sdk, als } = createSdk();
    let handler:
      | ((
          request: {
            method: string;
            url: { pathname: string };
            headers: Record<string, unknown>;
            raw: {
              req: EventEmitter & { method: string; url: string; headers: Record<string, unknown> };
              res: EventEmitter & { finished?: boolean; statusCode?: number };
            };
          },
          h: { continue: symbol }
        ) => symbol)
      | undefined;
    const server = {
      ext: vi.fn((_name, extHandler) => {
        handler = extHandler;
      })
    };
    const marker = Symbol('continue');

    hapiPlugin.register(server as never, { sdk });

    const req1 = createEmitter({ method: 'GET', url: '/hapi-one', headers: {} });
    const res1 = createEmitter({ finished: false, statusCode: 204 });
    const result1 = handler?.(
      {
        method: 'get',
        url: { pathname: '/hapi-one' },
        headers: { host: 'service.local' },
        raw: { req: req1, res: res1 }
      },
      { continue: marker }
    );
    const firstContext = als.getContext();
    const firstRequestId = als.getRequestId();

    expect(result1).toBe(marker);
    expect(firstRequestId).toBeDefined();
    expect(firstContext).toBeDefined();
    expect(firstContext === undefined || als.isRequestContextMaterialized(firstContext)).toBe(false);

    res1.emit('finish');

    expect(als.getRequestId()).toBeUndefined();
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(firstRequestId);
    expect(sdk.releaseCompletedRequestContext).not.toHaveBeenCalled();
    expect(firstContext === undefined || als.isRequestContextMaterialized(firstContext)).toBe(false);

    const req2 = createEmitter({ method: 'GET', url: '/hapi-two', headers: {} });
    const res2 = createEmitter({ finished: false, statusCode: 204 });

    handler?.(
      {
        method: 'get',
        url: { pathname: '/hapi-two' },
        headers: { host: 'service.local' },
        raw: { req: req2, res: res2 }
      },
      { continue: marker }
    );

    const secondRequestId = als.getRequestId();
    expect(secondRequestId).toBeDefined();
    expect(secondRequestId).not.toBe(firstRequestId);

    res2.emit('finish');
  });

  it('raw handler wrapper exposes ALS context inside the handler', () => {
    const { sdk, als, getAddedContext } = createSdk();
    let requestId: string | undefined;
    const wrapped = wrapHandler(
      (_req, _res) => {
        requestId = als.getRequestId();
      },
      sdk
    );

    wrapped(
      {
        method: 'DELETE',
        url: '/raw',
        headers: {
          host: 'service.local',
          authorization: 'secret',
          cookie: 'session=secret',
          'x-request-id': 'req-raw'
        }
      },
      new EventEmitter() as never
    );

    expect(requestId).toBeDefined();
    expect(getAddedContext()).toMatchObject({
      headers: {
        host: 'service.local',
        'x-request-id': 'req-raw'
      }
    });
    expect(getAddedContext()?.headers).not.toHaveProperty('authorization');
    expect(getAddedContext()?.headers).not.toHaveProperty('cookie');
  });

  it('SDK exceptions do not break the request pipeline', async () => {
    const expressSdk = createSdk({ throwOnCreate: true }).sdk;
    const next = vi.fn();

    expressMiddleware(expressSdk)(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);

    const rawSdk = createSdk({ throwOnCreate: true }).sdk;
    const handler = vi.fn();

    wrapHandler(handler, rawSdk)(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter user handlers when user code throws', async () => {
    const expressSdk = createSdk().sdk;
    const expressNext = vi.fn(() => {
      throw new Error('express user boom');
    });

    expect(() =>
      expressMiddleware(expressSdk)(
        { method: 'GET', url: '/express-throw', headers: {} },
        new EventEmitter() as never,
        expressNext
      )
    ).toThrow('express user boom');
    expect(expressNext).toHaveBeenCalledTimes(1);

    const fastifySdk = createSdk().sdk;
    let fastifyHook:
      | ((request: { raw: { method: string; url: string; headers: Record<string, unknown> } }, reply: {
          raw: EventEmitter & { finished?: boolean; on(event: 'finish', listener: () => void): void };
        }, done: () => void) => void)
      | undefined;
    fastifyPlugin(fastifySdk)(
      {
        addHook: vi.fn((_name, handler) => {
          fastifyHook = handler;
        })
      } as never,
      {},
      () => undefined
    );
    const fastifyNext = vi.fn(() => {
      throw new Error('fastify user boom');
    });

    expect(() =>
      fastifyHook?.(
        { raw: { method: 'GET', url: '/fastify-throw', headers: {} } },
        { raw: new EventEmitter() as EventEmitter & { finished?: boolean } },
        fastifyNext
      )
    ).toThrow('fastify user boom');
    expect(fastifyNext).toHaveBeenCalledTimes(1);

    const koaSdk = createSdk().sdk;
    const koaNext = vi.fn(async () => {
      throw new Error('koa user boom');
    });

    await expect(
      koaMiddleware(koaSdk)(
        {
          request: { method: 'GET', url: '/koa-throw', headers: {} },
          res: new EventEmitter() as EventEmitter & { finished?: boolean }
        } as never,
        koaNext
      )
    ).rejects.toThrow('koa user boom');
    expect(koaNext).toHaveBeenCalledTimes(1);

    const rawSdk = createSdk().sdk;
    const rawHandler = vi.fn(() => {
      throw new Error('raw user boom');
    });

    expect(() =>
      wrapHandler(rawHandler, rawSdk)(
        { method: 'GET', url: '/raw-throw', headers: {} },
        new EventEmitter() as never
      )
    ).toThrow('raw user boom');
    expect(rawHandler).toHaveBeenCalledTimes(1);
  });

  it('cleans request tracking on close and only removes once', () => {
    const express = createSdk();
    const expressReq = createEmitter({ method: 'GET', url: '/express-close', headers: {} });
    const expressRes = new EventEmitter() as EventEmitter & { finished?: boolean };

    expressMiddleware(express.sdk)(expressReq as never, expressRes as never, () => {
      void express.als.getContext()?.headers;
    });
    expressRes.emit('close');
    expect(express.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(express.sdk.requestTracker.remove).toHaveBeenCalledWith(express.getAddedContext()?.requestId);
    expressRes.emit('finish');
    expect(express.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);

    const fastify = createSdk();
    let fastifyHook:
      | ((request: { raw: EventEmitter & { method: string; url: string; headers: Record<string, unknown> } }, reply: {
          raw: EventEmitter & { finished?: boolean; on(event: 'finish', listener: () => void): void };
        }, done: () => void) => void)
      | undefined;
    fastifyPlugin(fastify.sdk)(
      {
        addHook: vi.fn((_name, handler) => {
          fastifyHook = handler;
        })
      } as never,
      {},
      () => undefined
    );
    const fastifyReq = createEmitter({ method: 'GET', url: '/fastify-close', headers: {} });
    const fastifyRes = new EventEmitter() as EventEmitter & { finished?: boolean };

    fastifyHook?.({ raw: fastifyReq }, { raw: fastifyRes }, () => {
      void fastify.als.getContext()?.headers;
    });
    fastifyRes.emit('close');
    expect(fastify.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(fastify.sdk.requestTracker.remove).toHaveBeenCalledWith(fastify.getAddedContext()?.requestId);
    fastifyRes.emit('finish');
    expect(fastify.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);

    const koa = createSdk();
    const koaReq = createEmitter({ method: 'GET', url: '/koa-close', headers: {} });
    const koaRes = new EventEmitter() as EventEmitter & { finished?: boolean };

    void koaMiddleware(koa.sdk)(
      {
        request: { method: 'GET', url: '/koa-close', headers: {} },
        req: koaReq,
        res: koaRes
      } as never,
      async () => {
        void koa.als.getContext()?.headers;
      }
    );
    koaRes.emit('close');
    expect(koa.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(koa.sdk.requestTracker.remove).toHaveBeenCalledWith(koa.getAddedContext()?.requestId);
    koaRes.emit('finish');
    expect(koa.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);

    const hapi = createSdk();
    let hapiHandler:
      | ((request: {
          method: string;
          url: { pathname: string };
          headers: Record<string, unknown>;
          raw: {
            req: EventEmitter & { method: string; url: string; headers: Record<string, unknown> };
            res: EventEmitter & { finished?: boolean };
          };
        }, h: { continue: symbol }) => symbol)
      | undefined;
    hapiPlugin.register(
      {
        ext: vi.fn((_name, handler) => {
          hapiHandler = handler;
        })
      } as never,
      { sdk: hapi.sdk }
    );
    const hapiReq = createEmitter({ method: 'GET', url: '/hapi-close', headers: {} });
    const hapiRes = new EventEmitter() as EventEmitter & { finished?: boolean };

    hapiHandler?.(
      {
        method: 'get',
        url: { pathname: '/hapi-close' },
        headers: {},
        raw: { req: hapiReq, res: hapiRes }
      },
      { continue: Symbol('continue') }
    );
    void hapi.als.getContext()?.headers;
    hapiRes.emit('close');
    expect(hapi.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(hapi.sdk.requestTracker.remove).toHaveBeenCalledWith(hapi.getAddedContext()?.requestId);
    hapiRes.emit('finish');
    expect(hapi.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);

    const raw = createSdk();
    const rawReq = createEmitter({ method: 'GET', url: '/raw-close', headers: {} });
    const rawRes = new EventEmitter() as EventEmitter & { finished?: boolean };

    wrapHandler((_req, _res) => undefined, raw.sdk)(rawReq, rawRes);
    rawRes.emit('close');
    expect(raw.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
    expect(raw.sdk.requestTracker.remove).toHaveBeenCalledWith(raw.getAddedContext()?.requestId);
    rawRes.emit('finish');
    expect(raw.sdk.requestTracker.remove).toHaveBeenCalledTimes(1);
  });

  it('cleans request tracking when the incoming request is aborted', () => {
    const express = createSdk();
    const expressReq = createEmitter({ method: 'GET', url: '/express-abort', headers: {} });

    expressMiddleware(express.sdk)(
      expressReq as never,
      new EventEmitter() as EventEmitter & { finished?: boolean } as never,
      () => {
        void express.als.getContext()?.headers;
      }
    );
    expressReq.emit('aborted');
    expect(express.sdk.requestTracker.remove).toHaveBeenCalledWith(express.getAddedContext()?.requestId);

    const fastify = createSdk();
    let fastifyHook:
      | ((request: { raw: EventEmitter & { method: string; url: string; headers: Record<string, unknown> } }, reply: {
          raw: EventEmitter & { finished?: boolean; on(event: 'finish', listener: () => void): void };
        }, done: () => void) => void)
      | undefined;
    fastifyPlugin(fastify.sdk)(
      {
        addHook: vi.fn((_name, handler) => {
          fastifyHook = handler;
        })
      } as never,
      {},
      () => undefined
    );
    const fastifyReq = createEmitter({ method: 'GET', url: '/fastify-abort', headers: {} });

    fastifyHook?.(
      { raw: fastifyReq },
      { raw: new EventEmitter() as EventEmitter & { finished?: boolean } },
      () => {
        void fastify.als.getContext()?.headers;
      }
    );
    fastifyReq.emit('aborted');
    expect(fastify.sdk.requestTracker.remove).toHaveBeenCalledWith(fastify.getAddedContext()?.requestId);

    const koa = createSdk();
    const koaReq = createEmitter({ method: 'GET', url: '/koa-abort', headers: {} });

    void koaMiddleware(koa.sdk)(
      {
        request: { method: 'GET', url: '/koa-abort', headers: {} },
        req: koaReq,
        res: new EventEmitter() as EventEmitter & { finished?: boolean }
      } as never,
      async () => {
        void koa.als.getContext()?.headers;
      }
    );
    koaReq.emit('aborted');
    expect(koa.sdk.requestTracker.remove).toHaveBeenCalledWith(koa.getAddedContext()?.requestId);

    const hapi = createSdk();
    let hapiHandler:
      | ((request: {
          method: string;
          url: { pathname: string };
          headers: Record<string, unknown>;
          raw: {
            req: EventEmitter & { method: string; url: string; headers: Record<string, unknown> };
            res: EventEmitter & { finished?: boolean };
          };
        }, h: { continue: symbol }) => symbol)
      | undefined;
    hapiPlugin.register(
      {
        ext: vi.fn((_name, handler) => {
          hapiHandler = handler;
        })
      } as never,
      { sdk: hapi.sdk }
    );
    const hapiReq = createEmitter({ method: 'GET', url: '/hapi-abort', headers: {} });

    hapiHandler?.(
      {
        method: 'get',
        url: { pathname: '/hapi-abort' },
        headers: {},
        raw: {
          req: hapiReq,
          res: new EventEmitter() as EventEmitter & { finished?: boolean }
        }
      },
      { continue: Symbol('continue') }
    );
    void hapi.als.getContext()?.headers;
    hapiReq.emit('aborted');
    expect(hapi.sdk.requestTracker.remove).toHaveBeenCalledWith(hapi.getAddedContext()?.requestId);

    const raw = createSdk();
    const rawReq = createEmitter({ method: 'GET', url: '/raw-abort', headers: {} });

    wrapHandler((_req, _res) => undefined, raw.sdk)(
      rawReq,
      new EventEmitter() as EventEmitter & { finished?: boolean }
    );
    rawReq.emit('aborted');
    expect(raw.sdk.requestTracker.remove).toHaveBeenCalledWith(raw.getAddedContext()?.requestId);
  });

  it('skips duplicate context creation when a request context already exists', async () => {
    const { sdk, als } = createSdk();

    const existing = als.createRequestContext({
      method: 'GET',
      url: '/existing',
      headers: { host: 'service.local' }
    });

    let fastifyHook:
      | ((request: { raw: { method: string; url: string; headers: Record<string, unknown> } }, reply: {
          raw: EventEmitter & { finished?: boolean; on(event: 'finish', listener: () => void): void };
        }, done: () => void) => void)
      | undefined;
    fastifyPlugin(sdk)(
      {
        addHook: vi.fn((_name, handler) => {
          fastifyHook = handler;
        })
      } as never,
      {},
      () => undefined
    );

    let hapiHandler:
      | ((request: {
          method: string;
          url: { pathname: string };
          headers: Record<string, unknown>;
          raw: { res: EventEmitter & { finished?: boolean } };
        }, h: { continue: symbol }) => symbol)
      | undefined;
    const continueMarker = Symbol('continue');
    hapiPlugin.register(
      {
        ext: vi.fn((_name, handler) => {
          hapiHandler = handler;
        })
      } as never,
      { sdk }
    );

    const koa = koaMiddleware(sdk);
    const raw = wrapHandler((_req, _res) => undefined, sdk);

    await als.runWithContext(existing, async () => {
      fastifyHook?.(
        {
          raw: {
            method: 'POST',
            url: '/fastify',
            headers: { host: 'service.local' }
          }
        },
        {
          raw: new EventEmitter() as EventEmitter & {
            finished?: boolean;
            on(event: 'finish', listener: () => void): void;
          }
        },
        () => undefined
      );

      await koa(
        {
          request: {
            method: 'PUT',
            url: '/koa',
            headers: { host: 'service.local' }
          },
          res: new EventEmitter() as EventEmitter & {
            finished?: boolean;
            on(event: 'finish', listener: () => void): void;
          }
        } as never,
        async () => undefined
      );

      hapiHandler?.(
        {
          method: 'get',
          url: { pathname: '/hapi' },
          headers: { host: 'service.local' },
          raw: { res: new EventEmitter() as EventEmitter & { finished?: boolean } }
        },
        { continue: continueMarker }
      );

      raw(
        { method: 'DELETE', url: '/raw', headers: { host: 'service.local' } },
        new EventEmitter() as never
      );
    });

    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  function createNextRequest(overrides?: {
    method?: string;
    url?: string;
    headers?: Map<string, string>;
  }) {
    const hdrs = overrides?.headers ?? new Map([
      ['host', 'service.local'],
      ['authorization', 'secret'],
      ['cookie', 'session=secret'],
      ['x-request-id', 'req-next-1']
    ]);

    return {
      method: overrides?.method ?? 'GET',
      url: overrides?.url ?? 'http://localhost:3000/api/test',
      headers: {
        forEach: (cb: (value: string, key: string) => void) =>
          hdrs.forEach((v, k) => cb(v, k))
      }
    };
  }

  it('withErrorcore propagates ALS context through async Next.js handler and cleans up', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    let observedRequestId: string | undefined;

    const handler = withErrorcore(async () => {
      await Promise.resolve();
      observedRequestId = als.getRequestId();
      return { status: 'ok' };
    }, sdk);

    await handler(createNextRequest());

    const captured = getAddedContext();

    expect(observedRequestId).toBe(captured?.requestId);
    expect(captured).toMatchObject({
      method: 'GET',
      url: 'http://localhost:3000/api/test',
      headers: {
        host: 'service.local',
        'x-request-id': 'req-next-1'
      }
    });
    expect(captured?.headers).not.toHaveProperty('authorization');
    expect(captured?.headers).not.toHaveProperty('cookie');
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('withErrorcore passes through when SDK is not active', async () => {
    const { sdk } = createSdk({ active: false });
    const result = await withErrorcore(async () => 'ok', sdk)(createNextRequest());

    expect(result).toBe('ok');
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('withErrorcore passes through when context already exists', async () => {
    const { sdk, als } = createSdk();
    const existing = als.createRequestContext({
      method: 'GET',
      url: '/existing',
      headers: { host: 'service.local' }
    });

    await als.runWithContext(existing, async () => {
      await withErrorcore(async () => 'ok', sdk)(createNextRequest());
    });

    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('withErrorcore flushes a captured error in an existing context before rethrowing', async () => {
    const { sdk, als } = createSdk();
    const existing = als.createRequestContext({
      method: 'GET',
      url: '/existing-error',
      headers: { host: 'service.local' }
    });
    const boom = new Error('nested handler boom');

    await als.runWithContext(existing, async () => {
      await expect(
        withErrorcore(async () => {
          throw boom;
        }, sdk)(createNextRequest())
      ).rejects.toBe(boom);
    });

    expect(sdk.captureError).toHaveBeenCalledWith(boom);
    expect(sdk.flush).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('withErrorcore still calls handler when SDK throws during setup', async () => {
    const { sdk } = createSdk({ throwOnCreate: true });
    const result = await withErrorcore(async () => 'recovered', sdk)(createNextRequest());

    expect(result).toBe('recovered');
  });

  it('withErrorcore cleans up tracker even when handler throws', async () => {
    const { sdk, getAddedContext } = createSdk();

    await expect(
      withErrorcore(async () => {
        throw new Error('handler boom');
      }, sdk)(createNextRequest())
    ).rejects.toThrow('handler boom');

    const captured = getAddedContext();
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
    expect(sdk.flush).toHaveBeenCalledTimes(1);
  });

  it('withErrorcore captures 5xx results without reading the response body', async () => {
    // Regression: the previous implementation called
    // (result as Response).clone().json() on any 5xx return. If the body
    // was a streaming response or the framework had already consumed
    // it, the clone/json path threw. The fix is to skip the body read
    // entirely and capture only the status-coded error.
    const { sdk } = createSdk();
    const captureSpy = sdk.captureError as unknown as ReturnType<typeof vi.fn>;

    // A response-like object whose clone() would throw if invoked.
    const responseLike = {
      status: 500,
      clone() { throw new Error('clone was invoked but must not be'); }
    };

    const result = await withErrorcore(async () => responseLike, sdk)(createNextRequest());

    expect(result).toBe(responseLike);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(sdk.flush).toHaveBeenCalledTimes(1);
    const capturedError = captureSpy.mock.calls[0]?.[0] as Error;
    expect(capturedError.message).toBe('HTTP 500');
    expect(capturedError.name).toBe('ServerError');
  });
});
