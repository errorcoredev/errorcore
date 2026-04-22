import Module = require('node:module');

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelSubscriber } from '../../src/recording/channel-subscriber';

const originalRequire = Module.prototype.require;

interface FakeDiagnosticsChannelModule {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function withDiagnosticsChannelMock<T>(
  diagnosticsChannel: FakeDiagnosticsChannelModule,
  run: () => Promise<T> | T
): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:diagnostics_channel') {
      return diagnosticsChannel;
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function createSubscriber() {
  return new ChannelSubscriber({
    httpServer: {
      handleRequestStart: vi.fn(),
      handleResponseFinish: vi.fn()
    },
    httpClient: {
      handleRequestStart: vi.fn()
    },
    undiciRecorder: {
      handleRequestCreate: vi.fn(),
      handleRequestHeaders: vi.fn(),
      handleRequestTrailers: vi.fn(),
      handleRequestError: vi.fn()
    },
    netDns: {
      handleNetConnect: vi.fn()
    }
  });
}

describe('ChannelSubscriber', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('subscribes to all known channel names', () => {
    const diagnosticsChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn()
    };

    withDiagnosticsChannelMock(diagnosticsChannel, () => {
      const subscriber = createSubscriber();

      subscriber.subscribeAll();
    });

    expect(diagnosticsChannel.subscribe.mock.calls.map((call) => call[0])).toEqual([
      'http.server.request.start',
      'http.server.response.finish',
      'http.server.response.created',
      'http.client.request.start',
      'undici:request:create',
      'undici:request:headers',
      'undici:request:trailers',
      'undici:request:error',
      'net.client.socket'
    ]);
  });

  it('unsubscribes all stored handlers', () => {
    const diagnosticsChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn()
    };

    withDiagnosticsChannelMock(diagnosticsChannel, () => {
      const subscriber = createSubscriber();

      subscriber.subscribeAll();
      subscriber.unsubscribeAll();
    });

    expect(diagnosticsChannel.unsubscribe).toHaveBeenCalledTimes(9);
    expect(diagnosticsChannel.unsubscribe.mock.calls.map((call) => call[0])).toEqual([
      'http.server.request.start',
      'http.server.response.finish',
      'http.server.response.created',
      'http.client.request.start',
      'undici:request:create',
      'undici:request:headers',
      'undici:request:trailers',
      'undici:request:error',
      'net.client.socket'
    ]);
  });

  it('catches handler exceptions and logs warnings instead of propagating', () => {
    const diagnosticsChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn()
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const subscriber = new ChannelSubscriber({
      httpServer: {
        handleRequestStart: vi.fn(() => {
          throw new Error('boom');
        }),
        handleResponseFinish: vi.fn()
      },
      httpClient: {
        handleRequestStart: vi.fn()
      },
      undiciRecorder: {
        handleRequestCreate: vi.fn(),
        handleRequestHeaders: vi.fn(),
        handleRequestTrailers: vi.fn(),
        handleRequestError: vi.fn()
      },
      netDns: {
        handleNetConnect: vi.fn()
      }
    });

    withDiagnosticsChannelMock(diagnosticsChannel, () => {
      subscriber.subscribeAll();
    });

    const handler = diagnosticsChannel.subscribe.mock.calls[0]?.[1] as
      | ((message: unknown, name: string) => void)
      | undefined;

    expect(() => handler?.({ request: {} }, 'http.server.request.start')).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('skips missing channels without throwing', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const diagnosticsChannel = {
      subscribe: vi.fn((channelName: string) => {
        if (channelName === 'net.client.socket') {
          throw new Error('missing channel');
        }
      }),
      unsubscribe: vi.fn()
    };

    expect(() =>
      withDiagnosticsChannelMock(diagnosticsChannel, () => {
        const subscriber = createSubscriber();

        subscriber.subscribeAll();
      })
    ).not.toThrow();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(diagnosticsChannel.subscribe).toHaveBeenCalledTimes(9);
  });

  it('is idempotent when subscribeAll is called twice', () => {
    const diagnosticsChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn()
    };

    withDiagnosticsChannelMock(diagnosticsChannel, () => {
      const subscriber = createSubscriber();

      subscriber.subscribeAll();
      subscriber.subscribeAll();
    });

    expect(diagnosticsChannel.subscribe).toHaveBeenCalledTimes(18);
    expect(diagnosticsChannel.unsubscribe).toHaveBeenCalledTimes(9);
  });
});

describe('G2 — response finish/created dual subscription', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('subscribes to both http.server.response.finish and http.server.response.created when available', () => {
    const subscribed: string[] = [];
    const diagnosticsChannel = {
      subscribe: vi.fn((name: string) => { subscribed.push(name); }),
      unsubscribe: vi.fn()
    };
    withDiagnosticsChannelMock(diagnosticsChannel, () => {
      const sub = new ChannelSubscriber({
        httpServer: {
          handleRequestStart: vi.fn(),
          handleResponseFinish: vi.fn()
        },
        httpClient: { handleRequestStart: vi.fn() },
        undiciRecorder: {
          handleRequestCreate: vi.fn(),
          handleRequestHeaders: vi.fn(),
          handleRequestTrailers: vi.fn(),
          handleRequestError: vi.fn()
        },
        netDns: { handleNetConnect: vi.fn() }
      });
      sub.subscribeAll();
    });

    expect(subscribed).toContain('http.server.response.finish');
    expect(subscribed).toContain('http.server.response.created');
  });
});
