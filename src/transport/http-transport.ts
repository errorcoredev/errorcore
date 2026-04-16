
import http = require('node:http');
import https = require('node:https');

import { markRequestAsInternal } from '../recording/internal';
import { runAsInternal } from '../recording/net-dns';

interface HttpTransportConfig {
  url: string;
  authorization?: string;
  timeoutMs?: number;
  allowPlainHttpTransport?: boolean;
  allowInvalidCollectorCertificates?: boolean;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [200, 600, 1800];
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

  public constructor(config: HttpTransportConfig) {
    this.url = new URL(config.url);
    this.authorization = config.authorization;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.allowPlainHttpTransport = config.allowPlainHttpTransport ?? false;
    this.allowInvalidCollectorCertificates =
      config.allowInvalidCollectorCertificates ?? false;

    if (this.url.protocol !== 'https:' && !this.allowPlainHttpTransport) {
      throw new Error(
        'HTTP transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
      );
    }

    this.agent = this.url.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets: 1 })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    warnOnInvalidCertificatesOnce(
      this.url,
      this.allowInvalidCollectorCertificates
    );
  }

  public async send(payload: string | Buffer): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.sendOnce(payload);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_ATTEMPTS - 1 && this.isRetryableError(lastError)) {
          await delay(RETRY_DELAYS_MS[attempt]);
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
  }

  private sendOnce(payload: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const body = Buffer.concat([raw, Buffer.from('\n')]);
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
                'content-type': 'application/x-ndjson',
                'content-length': String(body.length),
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
                };
                statusError.statusCode = statusCode;
                reject(statusError);
              });
            }
          )
        );

        request.on('error', (error) => {
          reject(error);
        });

        request.setTimeout(this.timeoutMs, () => {
          request.destroy(new Error('HTTP transport timeout'));
        });

        request.write(body);
        request.end();
      });
    });
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

    if (error.message === 'HTTP transport timeout') {
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
}
