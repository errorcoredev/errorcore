
import { safeConsole } from '../debug-log';

interface DiagnosticsChannelModule {
  subscribe: (channelName: string, handler: (message: unknown, name: string) => void) => void;
  unsubscribe: (channelName: string, handler: (message: unknown, name: string) => void) => void;
}

interface HttpServerRecorderLike {
  handleRequestStart(message: unknown): void;
  handleResponseFinish(message: unknown): void;
}

interface HttpClientRecorderLike {
  handleRequestStart(message: unknown): void;
}

interface UndiciRecorderLike {
  handleRequestCreate(message: unknown): void;
  handleRequestHeaders(message: unknown): void;
  handleRequestTrailers(message: unknown): void;
  handleRequestError(message: unknown): void;
}

interface NetDnsRecorderLike {
  handleNetConnect(message: unknown): void;
}

interface Subscription {
  channelName: string;
  handler: (message: unknown, name: string) => void;
}

function getDiagnosticsChannelModule(): DiagnosticsChannelModule {
  return require('node:diagnostics_channel') as DiagnosticsChannelModule;
}

export class ChannelSubscriber {
  private readonly httpServer: HttpServerRecorderLike;

  private readonly httpClient: HttpClientRecorderLike;

  private readonly undiciRecorder: UndiciRecorderLike;

  private readonly netDns: NetDnsRecorderLike;

  private subscriptions: Subscription[] = [];

  public constructor(deps: {
    httpServer: HttpServerRecorderLike;
    httpClient: HttpClientRecorderLike;
    undiciRecorder: UndiciRecorderLike;
    netDns: NetDnsRecorderLike;
  }) {
    this.httpServer = deps.httpServer;
    this.httpClient = deps.httpClient;
    this.undiciRecorder = deps.undiciRecorder;
    this.netDns = deps.netDns;
  }

  public subscribeAll(): void {
    const diagnosticsChannel = getDiagnosticsChannelModule();
    const registry: Array<{
      channelName: string;
      handler: (message: unknown) => void;
    }> = [
      {
        channelName: 'http.server.request.start',
        handler: (message) => {
          this.httpServer.handleRequestStart(message);
        }
      },
      {
        channelName: 'http.server.response.finish',
        handler: (message) => {
          this.httpServer.handleResponseFinish(message);
        }
      },
      {
        channelName: 'http.server.response.created',
        handler: (message) => {
          this.httpServer.handleResponseFinish(message);
        }
      },
      {
        channelName: 'http.client.request.start',
        handler: (message) => {
          this.httpClient.handleRequestStart(message);
        }
      },
      {
        channelName: 'undici:request:create',
        handler: (message) => {
          this.undiciRecorder.handleRequestCreate(message);
        }
      },
      {
        channelName: 'undici:request:headers',
        handler: (message) => {
          this.undiciRecorder.handleRequestHeaders(message);
        }
      },
      {
        channelName: 'undici:request:trailers',
        handler: (message) => {
          this.undiciRecorder.handleRequestTrailers(message);
        }
      },
      {
        channelName: 'undici:request:error',
        handler: (message) => {
          this.undiciRecorder.handleRequestError(message);
        }
      },
      {
        channelName: 'net.client.socket',
        handler: (message) => {
          this.netDns.handleNetConnect(message);
        }
      }
    ];

    this.unsubscribeAll();

    for (const entry of registry) {
      const wrappedHandler = (message: unknown, name: string): void => {
        try {
          entry.handler(message);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          safeConsole.warn(
            `[ErrorCore] diagnostics_channel handler failed for ${name}: ${messageText}`
          );
        }
      };

      try {
        diagnosticsChannel.subscribe(entry.channelName, wrappedHandler);
        this.subscriptions.push({
          channelName: entry.channelName,
          handler: wrappedHandler
        });
      } catch {
        safeConsole.debug(
          `[ErrorCore] diagnostics_channel not available: ${entry.channelName}`
        );
      }
    }
  }

  public unsubscribeAll(): void {
    const diagnosticsChannel = getDiagnosticsChannelModule();

    for (const subscription of this.subscriptions) {
      diagnosticsChannel.unsubscribe(subscription.channelName, subscription.handler);
    }

    this.subscriptions = [];
  }
}
