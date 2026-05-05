
import http = require('node:http');
import http2 = require('node:http2');
import https = require('node:https');

import { createDebug } from '../debug';
import { markRequestAsInternal } from '../recording/internal';
import { runAsInternal } from '../recording/net-dns';
import { toTransportPayload, type TransportSendInput } from './payload';

const debug = createDebug('http-transport');

interface HttpTransportConfig {
  url: string;
  authorization?: string;
  timeoutMs?: number;
  protocol?: 'auto' | 'http1' | 'http2';
  allowPlainHttpTransport?: boolean;
  allowInvalidCollectorCertificates?: boolean;
}

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [200, 600, 1800, 5400];
const RETRY_BUDGET_MS = 30000;

// Shared with error-capturer.ts so both sides agree on the exact string
// used to distinguish a timeout from other transport failures. Exported
// as a const so the dispatcher can classify the thrown error without a
// magic-string duplication.
export const HTTP_TRANSPORT_TIMEOUT_MESSAGE = 'HTTP transport timeout';

const INVALID_CERTIFICATE_WARNING =
  '[ErrorCore] HTTPS collector certificate validation is disabled; use allowInvalidCollectorCertificates only for local development.';
const INVALID_CERTIFICATE_WARNING_FLAG =
  '__errorcoreInvalidCollectorCertificatesWarningEmitted';
type GlobalWarningState = typeof globalThis & {
  [INVALID_CERTIFICATE_WARNING_FLAG]?: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

class Http2UnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'Http2UnavailableError';
  }
}

function warnOnInvalidCertificatesOnce(
  url: URL,
  allowInvalidCollectorCertificates: boolean
): void {
  if (url.protocol !== 'https:' || !allowInvalidCollectorCertificates) {
    return;
  }

  const globalWarningState = globalThis as GlobalWarningState;

  if (globalWarningState[INVALID_CERTIFICATE_WARNING_FLAG] === true) {
    return;
  }

  globalWarningState[INVALID_CERTIFICATE_WARNING_FLAG] = true;
  console.warn(INVALID_CERTIFICATE_WARNING);
}

export class HttpTransport {
  private readonly url: URL;

  private readonly authorization: string | undefined;

  private readonly timeoutMs: number;

  private readonly allowPlainHttpTransport: boolean;

  private readonly allowInvalidCollectorCertificates: boolean;

  private readonly agent: http.Agent | https.Agent;

  private readonly protocol: 'auto' | 'http1' | 'http2';

  private http2Session: http2.ClientHttp2Session | null = null;

  private negotiatedProtocol: 'http1' | 'http2' | null = null;

  public constructor(config: HttpTransportConfig) {
    this.url = new URL(config.url);
    this.authorization = config.authorization;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.allowPlainHttpTransport = config.allowPlainHttpTransport ?? false;
    this.allowInvalidCollectorCertificates =
      config.allowInvalidCollectorCertificates ?? false;
    this.protocol = config.protocol ?? 'auto';

    if (this.url.protocol !== 'https:' && !this.allowPlainHttpTransport) {
      throw new Error(
        'HTTP transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
      );
    }

    if (this.protocol === 'http2' && this.url.protocol !== 'https:') {
      throw new Error('HTTP/2 collector transport requires an https:// URL; h2c is not supported.');
    }

    this.agent = this.url.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets: 1 })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    warnOnInvalidCertificatesOnce(
      this.url,
      this.allowInvalidCollectorCertificates
    );
  }

  public async send(input: TransportSendInput): Promise<void> {
    const payload = toTransportPayload(input);
    let lastError: Error | null = null;
    const startedAt = Date.now();

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.sendOnce(payload);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const retryDelay = this.getRetryDelay(lastError, attempt, startedAt);
        if (retryDelay !== null) {
          await delay(retryDelay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error('HTTP transport failed after retries');
  }

  public async flush(): Promise<void> {
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    this.agent.destroy();
    this.destroyHttp2Session();
  }

  private async sendOnce(payload: ReturnType<typeof toTransportPayload>): Promise<void> {
    if (this.protocol === 'http1' || this.url.protocol !== 'https:') {
      await this.sendHttp1Once(payload);
      return;
    }

    try {
      await this.sendHttp2Once(payload);
    } catch (error) {
      if (this.protocol === 'auto' && error instanceof Http2UnavailableError) {
        debug(`HTTP/2 unavailable for collector; falling back to HTTP/1.1: ${error.message}`);
        await this.sendHttp1Once(payload);
        return;
      }

      throw error;
    }
  }

  private sendHttp1Once(payload: ReturnType<typeof toTransportPayload>): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.isBuffer(payload.serialized)
        ? payload.serialized
        : Buffer.from(payload.serialized);
      const useHttps = this.url.protocol === 'https:';
      const requestModule =
        useHttps ? https : this.allowPlainHttpTransport ? http : null;

      if (requestModule === null) {
        reject(
          new Error(
            'HTTP transport requires HTTPS unless allowPlainHttpTransport is true'
          )
        );
        return;
      }

      const tlsOptions = useHttps
        ? { rejectUnauthorized: !this.allowInvalidCollectorCertificates }
        : {};

      runAsInternal(() => {
        const request = markRequestAsInternal(
          requestModule.request(
            {
              protocol: this.url.protocol,
              hostname: this.url.hostname,
              port: this.url.port === '' ? undefined : Number(this.url.port),
              path: `${this.url.pathname}${this.url.search}`,
              method: 'POST',
              agent: this.agent,
              headers: {
                'content-type': 'application/errorcore+json',
                'content-length': String(body.length),
                ...(payload.envelope?.keyId === undefined
                  ? {}
                  : { 'X-Errorcore-Key-Id': payload.envelope.keyId }),
                ...(payload.envelope?.eventId === undefined
                  ? {}
                  : { 'X-Errorcore-Event-Id': payload.envelope.eventId }),
                ...(this.authorization === undefined
                  ? {}
                  : { Authorization: this.authorization })
              },
              ...tlsOptions
            },
            (response) => {
              const statusCode = response.statusCode ?? 500;

              response.on('data', () => undefined);
              response.on('end', () => {
                if (statusCode >= 200 && statusCode < 300) {
                  resolve();
                  return;
                }

                const statusError = new Error(`HTTP ${statusCode}`) as Error & {
                  statusCode?: number;
                  retryAfterMs?: number;
                };
                statusError.statusCode = statusCode;
                statusError.retryAfterMs = parseRetryAfter(response.headers?.['retry-after']);
                reject(statusError);
              });
            }
          )
        );

        request.on('error', (error) => {
          reject(error);
        });

        request.setTimeout(this.timeoutMs, () => {
          request.destroy(new Error(HTTP_TRANSPORT_TIMEOUT_MESSAGE));
        });

        request.write(body);
        request.end();
      });
    });
  }

  private sendHttp2Once(payload: ReturnType<typeof toTransportPayload>): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.isBuffer(payload.serialized)
        ? payload.serialized
        : Buffer.from(payload.serialized);

      runAsInternal(() => {
        this.getHttp2Session()
          .then((session) => {
            if (this.negotiatedProtocol !== 'http2') {
              this.negotiatedProtocol = 'http2';
              debug('collector negotiated protocol: h2');
            }

            const requestHeaders: http2.OutgoingHttpHeaders = {
              [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
              [http2.constants.HTTP2_HEADER_PATH]: `${this.url.pathname}${this.url.search}`,
              [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
              [http2.constants.HTTP2_HEADER_AUTHORITY]: this.url.host,
              'content-type': 'application/errorcore+json',
              'content-length': String(body.length),
              ...(payload.envelope?.keyId === undefined
                ? {}
                : { 'x-errorcore-key-id': payload.envelope.keyId }),
              ...(payload.envelope?.eventId === undefined
                ? {}
                : { 'x-errorcore-event-id': payload.envelope.eventId }),
              ...(this.authorization === undefined
                ? {}
                : { authorization: this.authorization })
            };

            const stream = markRequestAsInternal(session.request(requestHeaders));
            let settled = false;
            let statusCode = 500;
            let retryAfterMs: number | undefined;

            const settle = (fn: () => void): void => {
              if (settled) return;
              settled = true;
              fn();
            };

            stream.setTimeout(this.timeoutMs, () => {
              stream.close();
              settle(() => reject(new Error(HTTP_TRANSPORT_TIMEOUT_MESSAGE)));
            });

            stream.on('response', (headers) => {
              const rawStatus = headers[http2.constants.HTTP2_HEADER_STATUS];
              statusCode = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 500);
              const retryAfter = headers['retry-after'];
              retryAfterMs = parseRetryAfter(
                typeof retryAfter === 'string' || Array.isArray(retryAfter)
                  ? retryAfter
                  : undefined
              );
            });

            stream.on('data', () => undefined);
            stream.on('error', (error) => {
              this.destroyHttp2Session();
              settle(() => reject(error));
            });
            stream.on('end', () => {
              if (statusCode >= 200 && statusCode < 300) {
                settle(resolve);
                return;
              }

              const statusError = new Error(`HTTP ${statusCode}`) as Error & {
                statusCode?: number;
                retryAfterMs?: number;
              };
              statusError.statusCode = statusCode;
              statusError.retryAfterMs = retryAfterMs;
              settle(() => reject(statusError));
            });

            stream.end(body);
          })
          .catch((error) => {
            reject(
              this.protocol === 'auto'
                ? new Http2UnavailableError(error instanceof Error ? error.message : String(error))
                : error instanceof Error ? error : new Error(String(error))
            );
          });
      });
    });
  }

  private getHttp2Session(): Promise<http2.ClientHttp2Session> {
    if (
      this.http2Session !== null &&
      !this.http2Session.destroyed &&
      !this.http2Session.closed
    ) {
      return Promise.resolve(this.http2Session);
    }

    return new Promise((resolve, reject) => {
      const session = http2.connect(this.url.origin, {
        rejectUnauthorized: !this.allowInvalidCollectorCertificates
      });
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        session.destroy();
        reject(error);
      };

      const timeout = setTimeout(() => {
        fail(new Error(HTTP_TRANSPORT_TIMEOUT_MESSAGE));
      }, this.timeoutMs);
      timeout.unref();

      session.once('connect', () => {
        if (settled) return;
        const negotiatedProtocol = (
          session.socket as { alpnProtocol?: string | false | null } | undefined
        )?.alpnProtocol;
        if (typeof negotiatedProtocol === 'string' && negotiatedProtocol !== 'h2') {
          fail(new Error(`collector did not negotiate HTTP/2 via ALPN (got ${negotiatedProtocol})`));
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.http2Session = session;
        session.once('close', () => {
          if (this.http2Session === session) {
            this.http2Session = null;
          }
        });
        session.once('error', () => {
          if (this.http2Session === session) {
            this.http2Session = null;
          }
        });
        resolve(session);
      });

      session.once('error', fail);
    });
  }

  private destroyHttp2Session(): void {
    if (this.http2Session !== null) {
      this.http2Session.destroy();
      this.http2Session = null;
    }
  }

  private isRetryableError(error: Error & { statusCode?: number; code?: string }): boolean {
    if (typeof error.statusCode === 'number') {
      return (
        error.statusCode === 408 ||
        error.statusCode === 429 ||
        error.statusCode === 500 ||
        error.statusCode === 502 ||
        error.statusCode === 503 ||
        error.statusCode === 504
      );
    }

    if (error.message === HTTP_TRANSPORT_TIMEOUT_MESSAGE) {
      return true;
    }

    // Explicit allowlist: only retry known-transient network conditions.
    // Previously anything with an `error.code` property was retried, which
    // included EACCES, ENOSPC, EISDIR, etc. Those are not going to be
    // fixed by retrying so they correctly belong in the non-retryable set.
    if (error.code !== undefined) {
      const RETRYABLE_NET_CODES = new Set<string>([
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE'
      ]);
      return RETRYABLE_NET_CODES.has(error.code);
    }

    return false;
  }

  private getRetryDelay(
    error: Error & { statusCode?: number; code?: string; retryAfterMs?: number },
    attempt: number,
    startedAt: number
  ): number | null {
    if (attempt >= MAX_ATTEMPTS - 1 || !this.isRetryableError(error)) {
      return null;
    }

    const elapsed = Date.now() - startedAt;
    const remainingBudget = RETRY_BUDGET_MS - elapsed;
    if (remainingBudget <= 0) {
      return null;
    }

    const configuredDelay = error.retryAfterMs ?? RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    return Math.min(configuredDelay, remainingBudget);
  }
}
