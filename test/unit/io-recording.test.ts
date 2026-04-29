import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { IncomingMessage, ClientRequest, ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import { ALSManager } from '../../src/context/als-manager';
import { EventClock } from '../../src/context/event-clock';
import { RequestTracker } from '../../src/context/request-tracker';

function makeBuffer(opts: { capacity: number; maxBytes: number }): IOEventBuffer {
  const Ctor = IOEventBuffer;
  return new Ctor({ ...opts, eventClock: new EventClock() });
}
import { HeaderFilter } from '../../src/pii/header-filter';
import { Scrubber } from '../../src/pii/scrubber';
import { BodyCapture } from '../../src/recording/body-capture';
import { HttpServerRecorder } from '../../src/recording/http-server';
import { resolveTestConfig as resolveConfig } from '../helpers/test-config';
import { ERRORCORE_INTERNAL, HttpClientRecorder } from '../../src/recording/http-client';
import { UndiciRecorder } from '../../src/recording/undici';
import { NetDnsRecorder, runAsInternal } from '../../src/recording/net-dns';
import { fastifyPlugin } from '../../src/middleware/fastify';
import { createSDK } from '../../src/sdk';
import type { RequestContext } from '../../src/types';

const require = createRequire(import.meta.url);
const dnsModule = require('node:dns') as typeof import('node:dns');
const netModule = require('node:net') as typeof import('node:net');

class MockIncomingRequest extends EventEmitter {
  public method = 'GET';

  public url = '/resource';

  public headers: Record<string, string> = {
    host: 'service.local',
    'content-type': 'application/json',
    authorization: 'secret-token'
  };

  public socket = {
    _handle: {
      fd: 11
    }
  };
}

class MockIncomingResponse extends EventEmitter {
  public statusCode = 200;

  public headers: Record<string, string> = {
    'content-type': 'application/json',
    'set-cookie': 'secret'
  };
}

class MockServerResponse extends EventEmitter {
  public statusCode = 200;

  public writableEnded = false;

  public writableFinished = false;

  private readonly headers: Record<string, string> = {};

  public setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  public getHeaderNames(): string[] {
    return Object.keys(this.headers);
  }

  public write(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    return true;
  }

  public end(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): this {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }
}

class MockClientRequest extends EventEmitter {
  public method = 'POST';

  public protocol = 'https:';

  public host = 'api.example.com';

  public port = 443;

  public path = '/v1/items';

  public socket = {
    _handle: {
      fd: 22
    }
  };

  private readonly headers: Record<string, string> = {
    host: 'api.example.com',
    authorization: 'top-secret',
    'user-agent': 'test-client'
  };

  public getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name];
  }
}

function createConfig() {
  return resolveConfig({
    maxPayloadSize: 1024,
    maxConcurrentRequests: 10,
    captureBody: true,
    allowUnencrypted: true
  });
}

function createRequestContext(als: ALSManager, requestId = 'req-ctx'): RequestContext {
  const context = als.createRequestContext({
    method: 'GET',
    url: '/origin',
    headers: { host: 'localhost' }
  });

  context.requestId = requestId;
  return context;
}

describe('Module 08 recorders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records inbound HTTP requests, propagates ALS context, and attaches body capture', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const scrubber = new Scrubber(config);
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture,
      headerFilter,
      scrubber,
      config
    });
    const server = new Server();
    const originalEmit = Server.prototype.emit;
    const req = new MockIncomingRequest();
    const res = new MockServerResponse();
    let observedRequestId: string | undefined;

    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'hidden');
    recorder.install();

    // Post-fix invariant: emit-patch is always installed, so emit('request')
    // runs inside als.runWithContext() automatically.
    expect(Server.prototype.emit).not.toBe(originalEmit);

    server.on('request', () => {
      observedRequestId = als.getRequestId();
    });

    try {
      server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);

      recorder.handleRequestStart({
        request: req as unknown as IncomingMessage,
        response: res as unknown as ServerResponse,
        socket: req.socket as never,
        server
      });

      req.headers.host = 'mutated.local';
      req.on('data', () => undefined);
      req.emit('data', Buffer.from('hello'));
      req.emit('end');
      res.write('wor');
      res.end('ld');
      const [slot] = buffer.drain();
      if (slot) {
        bodyCapture.materializeSlotBodies(slot);
      }

      expect(observedRequestId).toBe(slot?.requestId ?? undefined);
      expect(slot).toMatchObject({
        type: 'http-server',
        direction: 'inbound',
        method: 'GET',
        url: '/resource',
        statusCode: 201,
        requestHeaders: { host: 'service.local', 'content-type': 'application/json' },
        responseHeaders: { 'content-type': 'application/json' },
        aborted: false,
        contextLost: false
      });
      expect(slot?.requestBody?.toString()).toBe('hello');
      expect(slot?.responseBody?.toString()).toBe('world');
      expect(tracker.getCount()).toBe(0);
      expect((slot as Record<string, unknown> | undefined)?.request).toBeUndefined();
      expect((slot as Record<string, unknown> | undefined)?.response).toBeUndefined();
    } finally {
      recorder.shutdown();
      tracker.shutdown();
      server.close();
    }
  });

  it('reports whether bindStore or the emit patch is active at install time', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const emitSpy = vi.spyOn(process, 'emit');
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config),
      scrubber: new Scrubber(config),
      config
    });
    const originalEmit = Server.prototype.emit;

    try {
      recorder.install();

      // Post-fix: emit-patch is always installed, so Server.prototype.emit is
      // always patched. getBindStorePath() reflects whether the bindStore
      // subscription channel was available — not whether the emit-patch ran.
      const bindStorePath = recorder.getBindStorePath();

      expect(emitSpy).toHaveBeenCalledWith(
        'errorcore:init',
        expect.objectContaining({ path: bindStorePath })
      );
    } finally {
      recorder.shutdown();
      tracker.shutdown();
    }
  });

  it('restores Server.prototype.emit on shutdown when the SDK owns the top wrapper', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config),
      scrubber: new Scrubber(config),
      config
    });
    const originalEmit = Server.prototype.emit;

    try {
      (recorder as unknown as { installEmitPatch(): void }).installEmitPatch();

      expect(Server.prototype.emit).not.toBe(originalEmit);

      recorder.shutdown();

      expect(Server.prototype.emit).toBe(originalEmit);
    } finally {
      Server.prototype.emit = originalEmit;
      tracker.shutdown();
    }
  });

  it('leaves a third-party Server.prototype.emit wrapper in place during shutdown', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config),
      scrubber: new Scrubber(config),
      config
    });
    const originalEmit = Server.prototype.emit;

    try {
      (recorder as unknown as { installEmitPatch(): void }).installEmitPatch();
      const sdkEmit = Server.prototype.emit;
      const thirdPartyEmit = function wrappedAfterSdk(this: Server, ...args: unknown[]) {
        return Reflect.apply(sdkEmit, this, args);
      };

      Server.prototype.emit = thirdPartyEmit as typeof Server.prototype.emit;

      recorder.shutdown();

      expect(Server.prototype.emit).toBe(thirdPartyEmit);
    } finally {
      Server.prototype.emit = originalEmit;
      tracker.shutdown();
    }
  });

  it('marks aborted inbound requests', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config),
      scrubber: new Scrubber(config),
      config
    });
    const req = new MockIncomingRequest();
    const res = new MockServerResponse();

    try {
      recorder.handleRequestStart({
        request: req as unknown as IncomingMessage,
        response: res as unknown as ServerResponse,
        socket: req.socket as never,
        server: new Server()
      });

      req.emit('aborted');
      res.emit('close');

      const [slot] = buffer.drain();

      expect(slot?.aborted).toBe(true);
      expect(slot?.phase).toBe('done');
    } finally {
      recorder.shutdown();
      tracker.shutdown();
    }
  });

  it('keeps the original request context when Fastify middleware runs inside a recorder-managed request', async () => {
    const sdk = createSDK({
      transport: { type: 'stdout' },
      allowUnencrypted: true
    });
    let fastifyHook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: EventEmitter & {
              finished?: boolean;
              on(event: 'finish', listener: () => void): void;
            };
          },
          done: () => void
        ) => void)
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

    const createContextSpy = vi.spyOn(sdk.als, 'createRequestContext');
    const request = new MockIncomingRequest();
    const response = new MockServerResponse();
    const outboundRequest = new MockClientRequest();
    const outboundResponse = new MockIncomingResponse();
    const httpServerRecorder = sdk['httpServerRecorder'] as HttpServerRecorder & {
      getOrCreateContext(request: IncomingMessage): RequestContext;
    };
    const httpClientRecorder = sdk['httpClientRecorder'] as HttpClientRecorder;

    try {
      sdk.activate();

      const context = httpServerRecorder.getOrCreateContext(
        request as unknown as IncomingMessage
      );
      let hookRequestId: string | undefined;

      sdk.als.runWithContext(context, () => {
        httpServerRecorder.handleRequestStart({
          request: request as unknown as IncomingMessage,
          response: response as unknown as ServerResponse,
          socket: request.socket as never,
          server: new Server()
        });

        fastifyHook?.(
          {
            raw: {
              method: request.method,
              url: request.url,
              headers: request.headers
            }
          },
          {
            raw: response as EventEmitter & {
              finished?: boolean;
              on(event: 'finish', listener: () => void): void;
            }
          },
          () => {
            hookRequestId = sdk.als.getRequestId();
            httpClientRecorder.handleRequestStart({
              request: outboundRequest as unknown as ClientRequest
            });
            outboundRequest.emit('response', outboundResponse as unknown as IncomingMessage);
            outboundResponse.emit('end');
          }
        );
      });

      expect(createContextSpy).toHaveBeenCalledTimes(1);
      expect(hookRequestId).toBe(context.requestId);
      expect(sdk.requestTracker.getCount()).toBe(1);

      response.end('done');

      const slots = sdk.buffer.drain();

      expect(slots).toHaveLength(2);
      expect(slots.map((slot) => slot.requestId)).toEqual([
        context.requestId,
        context.requestId
      ]);
      expect(slots[1]).toMatchObject({
        type: 'http-client',
        requestId: context.requestId,
        contextLost: false
      });
      expect(sdk.requestTracker.getCount()).toBe(0);
    } finally {
      await sdk.shutdown();
    }
  });

  it('records outbound HTTP client requests and response metadata', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const context = createRequestContext(als);
    const bodyCapture = new BodyCapture(config);
    const recorder = new HttpClientRecorder({
      buffer,
      als,
      bodyCapture,
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest();
    const response = new MockIncomingResponse();

    als.runWithContext(context, () => {
      recorder.handleRequestStart({ request: request as unknown as ClientRequest });
    });

    request.emit('response', response as unknown as IncomingMessage);
    response.emit('data', Buffer.from('ok'));
    response.emit('end');
    const [slot] = buffer.drain();
    if (slot) {
      bodyCapture.materializeSlotBodies(slot);
    }

    expect(slot).toMatchObject({
      type: 'http-client',
      target: 'https://api.example.com:443',
      url: 'https://api.example.com:443/v1/items',
      statusCode: 200,
      requestHeaders: {
        host: 'api.example.com',
        'user-agent': 'test-client'
      },
      responseHeaders: {
        'content-type': 'application/json'
      },
      contextLost: false,
      requestId: 'req-ctx'
    });
    expect(slot?.responseBody?.toString()).toBe('ok');
    expect(context.ioEvents[0]).toBe(slot);
    recorder.shutdown();
  });

  it('ignores SDK-internal outbound HTTP client requests', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new HttpClientRecorder({
      buffer,
      als: new ALSManager(),
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest() as MockClientRequest & {
      [ERRORCORE_INTERNAL]?: boolean;
    };

    request[ERRORCORE_INTERNAL] = true;
    recorder.handleRequestStart({ request: request as unknown as ClientRequest });

    expect(buffer.drain()).toEqual([]);
    recorder.shutdown();
  });

  it('records outbound HTTP client errors with contextLost when ALS is unavailable', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new HttpClientRecorder({
      buffer,
      als: new ALSManager(),
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest();

    recorder.handleRequestStart({ request: request as unknown as ClientRequest });
    request.emit('error', new Error('connect failed'));

    const [slot] = buffer.drain();

    expect(slot).toMatchObject({
      contextLost: true,
      requestId: null,
      error: {
        type: 'Error',
        message: 'connect failed'
      }
    });
    recorder.shutdown();
  });

  it('records undici request create, headers, and trailers without stale correlation', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const recorder = new UndiciRecorder({
      buffer,
      als,
      headerFilter: new HeaderFilter(config)
    });
    const firstRequest = {
      method: 'POST',
      origin: 'https://undici.example.com',
      path: '/items',
      headers: {
        authorization: 'secret',
        'user-agent': 'undici-test'
      }
    };
    const secondRequest = {
      method: 'GET',
      origin: 'https://undici.example.com',
      path: '/health',
      headers: {
        'user-agent': 'undici-test'
      }
    };
    const context = createRequestContext(als, 'req-undici');

    als.runWithContext(context, () => {
      recorder.handleRequestCreate({ request: firstRequest });
    });
    recorder.handleRequestHeaders({
      request: firstRequest,
      response: {
        statusCode: 202,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'secret'
        }
      }
    });
    recorder.handleRequestTrailers({ request: firstRequest, trailers: {} });
    recorder.handleRequestCreate({ request: secondRequest });
    recorder.handleRequestError({
      request: secondRequest,
      error: new Error('upstream failed')
    });

    const slots = buffer.drain();

    expect(slots[0]).toMatchObject({
      type: 'undici',
      target: 'https://undici.example.com',
      url: 'https://undici.example.com/items',
      statusCode: 202,
      requestHeaders: { 'user-agent': 'undici-test' },
      responseHeaders: { 'content-type': 'application/json' },
      requestId: 'req-undici',
      contextLost: false
    });
    expect(slots[1]).toMatchObject({
      type: 'undici',
      url: 'https://undici.example.com/health',
      error: {
        type: 'Error',
        message: 'upstream failed'
      }
    });
    recorder.shutdown();
  });

  it('ignores SDK-internal undici requests', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new UndiciRecorder({
      buffer,
      als: new ALSManager(),
      headerFilter: new HeaderFilter(config)
    });
    const request = {
      method: 'POST',
      origin: 'https://undici.example.com',
      path: '/items',
      headers: {},
      [ERRORCORE_INTERNAL]: true
    };

    recorder.handleRequestCreate({ request });

    expect(buffer.drain()).toEqual([]);
    recorder.shutdown();
  });

  it('records DNS lookups through the internal patch and marks contextLost when ALS is unavailable', async () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;
    
    dnsModule.lookup = ((
      hostname: string,
      callback: (error: null, address: string, family: number) => void
    ) => {
      callback(null, '127.0.0.1', 4);
      return {} as never;
    }) as typeof dnsModule.lookup;

    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      await new Promise<void>((resolve, reject) => {
        (dnsModule.lookup as unknown as (
        hostname: string,
          callback: (error: Error | null, address: string, family: number) => void
        ) => void)('example.com', (error) => {
          if (error !== null) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      const [slot] = buffer.drain();

      expect(slot).toMatchObject({
        type: 'dns',
        target: 'example.com',
        contextLost: true,
        requestId: null
      });
      expect(slot?.durationMs).not.toBeNull();
    } finally {
      dnsModule.lookup = originalLookup;
      recorder.shutdown();
    }
  });

  it('restores dns and net wrappers on shutdown when the SDK owns the top layer', () => {
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;
    const originalConnect = netModule.connect;
    const originalCreateConnection = netModule.createConnection;
    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      expect(dnsModule.lookup).not.toBe(originalLookup);
      expect(netModule.connect).not.toBe(originalConnect);
      expect(netModule.createConnection).not.toBe(originalCreateConnection);

      recorder.shutdown();

      expect(dnsModule.lookup).toBe(originalLookup);
      expect(netModule.connect).toBe(originalConnect);
      expect(netModule.createConnection).toBe(originalCreateConnection);
    } finally {
      dnsModule.lookup = originalLookup;
      netModule.connect = originalConnect;
      netModule.createConnection = originalCreateConnection;
    }
  });

  it('leaves later third-party dns and net wrappers in place during shutdown', () => {
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;
    const originalConnect = netModule.connect;
    const originalCreateConnection = netModule.createConnection;
    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      const sdkLookup = dnsModule.lookup;
      const sdkConnect = netModule.connect;
      const sdkCreateConnection = netModule.createConnection;
      const thirdPartyLookup = function wrappedLookup(
        this: typeof dnsModule,
        ...args: Parameters<typeof dnsModule.lookup>
      ) {
        return Reflect.apply(sdkLookup, this, args);
      };
      const thirdPartyConnect = function wrappedConnect(
        this: typeof netModule,
        ...args: Parameters<typeof netModule.connect>
      ) {
        return Reflect.apply(sdkConnect, this, args);
      };
      const thirdPartyCreateConnection = function wrappedCreateConnection(
        this: typeof netModule,
        ...args: Parameters<typeof netModule.createConnection>
      ) {
        return Reflect.apply(sdkCreateConnection, this, args);
      };

      dnsModule.lookup = thirdPartyLookup as typeof dnsModule.lookup;
      netModule.connect = thirdPartyConnect as typeof netModule.connect;
      netModule.createConnection =
        thirdPartyCreateConnection as typeof netModule.createConnection;

      recorder.shutdown();

      expect(dnsModule.lookup).toBe(thirdPartyLookup);
      expect(netModule.connect).toBe(thirdPartyConnect);
      expect(netModule.createConnection).toBe(thirdPartyCreateConnection);
    } finally {
      dnsModule.lookup = originalLookup;
      netModule.connect = originalConnect;
      netModule.createConnection = originalCreateConnection;
    }
  });

  it('skips DNS lookups executed through runAsInternal', async () => {
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;

    dnsModule.lookup = ((
      hostname: string,
      callback: (error: null, address: string, family: number) => void
    ) => {
      callback(null, '127.0.0.1', 4);
      return {} as never;
    }) as typeof dnsModule.lookup;

    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      await new Promise<void>((resolve, reject) => {
        runAsInternal(() => {
          (dnsModule.lookup as unknown as (
            hostname: string,
            callback: (error: Error | null, address: string, family: number) => void
          ) => void)('example.com', (error) => {
            if (error !== null) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      });

      expect(buffer.drain()).toEqual([]);
    } finally {
      dnsModule.lookup = originalLookup;
      recorder.shutdown();
    }
  });

  it('records TCP connect events via the net handler with contextLost when ALS is unavailable', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      recorder.handleNetConnect({
        target: '127.0.0.1:5432',
        startTime: 1n,
        endTime: 2n,
        socket: { _handle: { fd: 33 } } as never
      });

      const [slot] = buffer.drain();

      expect(slot).toMatchObject({
        type: 'tcp',
        target: '127.0.0.1:5432',
        fd: 33,
        contextLost: true,
        requestId: null
      });
    } finally {
      recorder.shutdown();
    }
  });
});

describe('G2 — http-server shape: message.socket is optional', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records request when diagnostic-channel payload omits socket', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const scrubber = new Scrubber(config);
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture,
      headerFilter,
      scrubber,
      config
    });

    const request = new MockIncomingRequest();
    request.method = 'GET';
    request.url = '/api/test';

    const response = new MockServerResponse();
    const server = new Server();

    const pushSpy = vi.spyOn(buffer, 'push');

    try {
      // Payload without top-level socket — the real diagnostic-channel shape
      recorder.handleRequestStart({
        request: request as unknown as IncomingMessage,
        response: response as unknown as ServerResponse,
        server
      } as never);

      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'http-server',
          direction: 'inbound',
          method: 'GET',
          url: '/api/test'
        })
      );
    } finally {
      recorder.shutdown();
      tracker.shutdown();
      server.close();
    }
  });

  it('still records when socket is present (backward compat)', () => {
    const config = createConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const scrubber = new Scrubber(config);
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture,
      headerFilter,
      scrubber,
      config
    });

    const request = new MockIncomingRequest();
    const response = new MockServerResponse();
    const server = new Server();

    const pushSpy = vi.spyOn(buffer, 'push');

    try {
      // Payload with socket present — backward-compat path
      recorder.handleRequestStart({
        request: request as unknown as IncomingMessage,
        response: response as unknown as ServerResponse,
        socket: request.socket as never,
        server
      });

      expect(pushSpy).toHaveBeenCalled();
    } finally {
      recorder.shutdown();
      tracker.shutdown();
      server.close();
    }
  });
});

describe('G2 — undici shape: RequestImpl, not ClientRequest', () => {
  it('records outbound fetch when payload matches undici:request:create shape', () => {
    const config = resolveConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const headerFilter = new HeaderFilter(config);
    const recorder = new UndiciRecorder({
      buffer,
      als,
      headerFilter
    });
    const pushSpy = vi.spyOn(buffer, 'push');

    // undici RequestImpl shape. Headers often arrive as a flat array; the
    // recorder must not assume Node core ClientRequest APIs (getHeader,
    // socket, setHeader) exist on this object.
    const request = {
      origin: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      headers: ['host', 'api.example.com', 'user-agent', 'test'],
      body: null,
      addHeader: () => undefined
    };
    recorder.handleRequestCreate({ request } as never);

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'undici',
        direction: 'outbound',
        method: 'GET',
        url: 'https://api.example.com/v1/x'
      })
    );
  });
});

describe('G2 — http-client shape: { request } only', () => {
  it('records outbound request when payload contains only request', () => {
    const config = resolveConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const recorder = new HttpClientRecorder({
      buffer,
      als,
      bodyCapture,
      headerFilter
    });
    const pushSpy = vi.spyOn(buffer, 'push');

    // Construct a minimal ClientRequest-like object. Node's real
    // http.client.request.start payload is literally { request } only.
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      host: 'api.example.com',
      path: '/v1/x',
      protocol: 'https:',
      getHeaders: () => ({ host: 'api.example.com' }),
      getHeader: (_: string) => 'api.example.com',
      setHeader: () => undefined,
    });

    recorder.handleRequestStart({ request: request as unknown as ClientRequest });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http-client',
        direction: 'outbound',
        method: 'POST'
      })
    );
  });
});

describe('G2 — ALS context propagation through server.emit', () => {
  it('propagates ALS to handlers registered via server.on("request")', () => {
    const config = resolveConfig();
    const buffer = makeBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const scrubber = new Scrubber(config);
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture,
      headerFilter,
      scrubber,
      config
    });

    const server = new Server();
    const originalEmit = Server.prototype.emit;
    const req = new MockIncomingRequest();
    const res = new MockServerResponse();

    recorder.install();

    // Invariant under the fix: install() ALWAYS patches Server.prototype.emit,
    // regardless of bindStore availability. This is the mechanism that makes
    // ALS available to framework request handlers.
    expect(Server.prototype.emit).not.toBe(originalEmit);

    let contextInHandler: string | undefined;
    server.on('request', () => {
      contextInHandler = als.getRequestId();
    });

    try {
      server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(contextInHandler).not.toBeUndefined();
      expect(typeof contextInHandler).toBe('string');
    } finally {
      recorder.shutdown();
      tracker.shutdown();
      server.close();
    }
  });
});
