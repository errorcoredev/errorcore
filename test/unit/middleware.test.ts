import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { HeaderFilter } from '../../src/pii/header-filter';
import { expressMiddleware } from '../../src/middleware/express';
import { fastifyPlugin } from '../../src/middleware/fastify';
import { koaMiddleware } from '../../src/middleware/koa';
import { hapiPlugin } from '../../src/middleware/hapi';
import { wrapHandler } from '../../src/middleware/raw-http';
import { withErrorcore } from '../../src/middleware/nextjs';
import { resolveTestConfig } from '../helpers/test-config';

function createSdk(options?: { active?: boolean; throwOnCreate?: boolean }) {
  const als = new ALSManager();
  const headerFilter = new HeaderFilter(resolveTestConfig());
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
      als: {
        createRequestContext: vi.fn((input: {
          method: string;
          url: string;
          headers: Record<string, string>;
        }) => {
          if (options?.throwOnCreate) {
            throw new Error('sdk failure');
          }

          return als.createRequestContext(input);
        }),
        runWithContext: als.runWithContext.bind(als),
        getContext: als.getContext.bind(als),
        getRequestId: als.getRequestId.bind(als)
      },
      requestTracker: {
        add: vi.fn((ctx: { requestId: string }) => {
          addedContext = ctx;
        }),
        remove: vi.fn()
      },
      headerFilter
    },
    als,
    getAddedContext: () => addedContext
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

  it('hapi plugin registers onRequest and enters ALS context', () => {
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
        raw: { res: new EventEmitter() as EventEmitter & { finished?: boolean } }
      },
      { continue: marker }
    );

    expect(result).toBe(marker);
    expect(als.getRequestId()).toBeUndefined();
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(getAddedContext()).toMatchObject({
      headers: {
        host: 'service.local',
        'x-request-id': 'req-hapi'
      }
    });
    expect(getAddedContext()?.headers).not.toHaveProperty('authorization');
    expect(getAddedContext()?.headers).not.toHaveProperty('cookie');
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
  });
});
