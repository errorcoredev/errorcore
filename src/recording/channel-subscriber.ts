
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

interface ChannelRegistration {
  channelName: string;
  enabled: keyof ChannelSubscriptionOptions;
  handler: (message: unknown) => void;
}

export interface ChannelSubscriptionOptions {
  httpServer: boolean;
  httpClient: boolean;
  undici: boolean;
  netDns: boolean;
}

const ALL_CHANNELS: ChannelSubscriptionOptions = {
  httpServer: true,
  httpClient: true,
  undici: true,
  netDns: true
};

function getDiagnosticsChannelModule(): DiagnosticsChannelModule {
  return require('node:diagnostics_channel') as DiagnosticsChannelModule;
}

export class ChannelSubscriber {
  private readonly httpServer: HttpServerRecorderLike;

  private readonly httpClient: HttpClientRecorderLike;

  private readonly undiciRecorder: UndiciRecorderLike;

  private readonly netDns: NetDnsRecorderLike;

  private readonly registrations: ChannelRegistration[];

  private subscriptions = new Map<string, Subscription>();

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
    this.registrations = [
      {
        channelName: 'http.server.request.start',
        enabled: 'httpServer',
        handler: (message) => {
          this.httpServer.handleRequestStart(message);
        }
      },
      {
        channelName: 'http.server.response.finish',
        enabled: 'httpServer',
        handler: (message) => {
          this.httpServer.handleResponseFinish(message);
        }
      },
      {
        channelName: 'http.client.request.start',
        enabled: 'httpClient',
        handler: (message) => {
          this.httpClient.handleRequestStart(message);
        }
      },
      {
        channelName: 'undici:request:create',
        enabled: 'undici',
        handler: (message) => {
          this.undiciRecorder.handleRequestCreate(message);
        }
      },
      {
        channelName: 'undici:request:headers',
        enabled: 'undici',
        handler: (message) => {
          this.undiciRecorder.handleRequestHeaders(message);
        }
      },
      {
        channelName: 'undici:request:trailers',
        enabled: 'undici',
        handler: (message) => {
          this.undiciRecorder.handleRequestTrailers(message);
        }
      },
      {
        channelName: 'undici:request:error',
        enabled: 'undici',
        handler: (message) => {
          this.undiciRecorder.handleRequestError(message);
        }
      },
      {
        channelName: 'net.client.socket',
        enabled: 'netDns',
        handler: (message) => {
          this.netDns.handleNetConnect(message);
        }
      }
    ];
  }

  public subscribeAll(options: ChannelSubscriptionOptions = ALL_CHANNELS): void {
    const diagnosticsChannel = getDiagnosticsChannelModule();
    const desired = new Set(
      this.registrations
        .filter((registration) => options[registration.enabled])
        .map((registration) => registration.channelName)
    );

    for (const [channelName, subscription] of this.subscriptions.entries()) {
      if (desired.has(channelName)) {
        continue;
      }
      diagnosticsChannel.unsubscribe(subscription.channelName, subscription.handler);
      this.subscriptions.delete(channelName);
    }

    for (const entry of this.registrations) {
      if (!desired.has(entry.channelName) || this.subscriptions.has(entry.channelName)) {
        continue;
      }

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
        this.subscriptions.set(entry.channelName, {
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

    for (const subscription of this.subscriptions.values()) {
      diagnosticsChannel.unsubscribe(subscription.channelName, subscription.handler);
    }

    this.subscriptions.clear();
  }
}
