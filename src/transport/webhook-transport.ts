import { createHmac } from 'node:crypto';
import http = require('node:http');
import https = require('node:https');

import { markRequestAsInternal } from '../recording/internal';
import { runAsInternal } from '../recording/net-dns';
import type { InternalWarning } from '../types';
import { LocalEventStore, type LocalEventStoreRecord } from './local-event-store';
import { toTransportPayload, type TransportSendInput } from './payload';

interface WebhookTransportConfig {
  url: string;
  secret?: string;
  batchSize?: number;
  maxDelayMs?: number;
  retries?: number;
  timeoutMs?: number;
  maxBufferEvents?: number;
  storePath: string;
  retainOnAck?: boolean;
  allowPlainHttpTransport?: boolean;
  onInternalWarning?: (warning: InternalWarning) => void;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER_EVENTS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function retryDelayMs(attempt: number): number {
  const base = 50 * (2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function isRetryable(error: Error & { statusCode?: number; code?: string }): boolean {
  if (typeof error.statusCode === 'number') {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      error.statusCode >= 500
    );
  }

  if (error.code !== undefined) {
    return new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE'
    ]).has(error.code);
  }

  return false;
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export class WebhookTransport {
  private readonly url: URL;

  private readonly secret: string | undefined;

  private readonly batchSize: number;

  private readonly maxDelayMs: number;

  private readonly retries: number;

  private readonly timeoutMs: number;

  private readonly maxBufferEvents: number;

  private readonly retainOnAck: boolean;

  private readonly store: LocalEventStore;

  private readonly onInternalWarning: ((warning: InternalWarning) => void) | undefined;

  private readonly queue: LocalEventStoreRecord[] = [];

  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private drainPromise: Promise<void> | null = null;

  public constructor(config: WebhookTransportConfig) {
    this.url = new URL(config.url);
    this.secret = config.secret;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBufferEvents = config.maxBufferEvents ?? DEFAULT_MAX_BUFFER_EVENTS;
    this.retainOnAck = config.retainOnAck ?? true;
    this.onInternalWarning = config.onInternalWarning;

    if (this.url.protocol !== 'https:' && config.allowPlainHttpTransport !== true) {
      throw new Error(
        'Webhook transport requires an https:// URL. Set allowPlainHttpTransport: true to allow plain HTTP (not recommended).'
      );
    }

    this.store = new LocalEventStore(config.storePath, {
      onInternalWarning: config.onInternalWarning
    });
    this.enqueueExistingRecords();
  }

  public async send(input: TransportSendInput): Promise<void> {
    const payload = toTransportPayload(input);
    const id = this.store.append(payload);
    if (id === null) {
      throw new Error('Local event store write failed');
    }

    const record = this.store.readAll().find((candidate) => candidate.id === id);
    if (record === undefined) {
      throw new Error('Local event store record could not be read after append');
    }

    this.enqueue(record);
  }

  public async flush(): Promise<void> {
    this.clearTimer();
    if (this.drainPromise !== null) {
      await this.drainPromise;
    }
    await this.drainQueue({ stopOnFailure: true });
  }

  public async shutdown(): Promise<void> {
    this.clearTimer();
  }

  private enqueueExistingRecords(): void {
    for (const record of this.store.readAll()) {
      this.enqueue(record, false);
    }
  }

  private enqueue(record: LocalEventStoreRecord, schedule = true): void {
    if (this.queue.length >= this.maxBufferEvents) {
      this.queue.shift();
      this.emitWarning({
        code: 'EC_WEBHOOK_QUEUE_OVERFLOW',
        message: 'Webhook in-memory buffer exceeded maxBufferEvents; oldest queued event was deferred to local storage.',
        context: { maxBufferEvents: this.maxBufferEvents }
      });
    }

    this.queue.push(record);
    if (!schedule) {
      return;
    }
    if (this.queue.length >= this.batchSize) {
      void this.drainQueue({ stopOnFailure: true });
      return;
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) {
      return;
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drainQueue({ stopOnFailure: true });
    }, this.maxDelayMs);
    this.drainTimer.unref();
  }

  private clearTimer(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private async drainQueue(options: { stopOnFailure: boolean }): Promise<void> {
    if (this.drainPromise !== null) {
      await this.drainPromise;
      return;
    }

    this.drainPromise = this.drainQueueInner(options).finally(() => {
      this.drainPromise = null;
    });
    await this.drainPromise;
  }

  private async drainQueueInner(options: { stopOnFailure: boolean }): Promise<void> {
    this.clearTimer();

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.sendBatchWithRetries(batch);
        if (!this.retainOnAck) {
          this.store.remove(batch.map((record) => record.id));
        }
      } catch (error) {
        this.queue.unshift(...batch);
        this.emitWarning({
          code: 'EC_WEBHOOK_BATCH_FAILED',
          message: 'Webhook batch delivery failed; events remain in the local event store.',
          cause: error,
          context: { batchSize: batch.length }
        });
        if (options.stopOnFailure) {
          this.scheduleDrain();
          return;
        }
      }
    }
  }

  private async sendBatchWithRetries(records: LocalEventStoreRecord[]): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        await this.sendBatchOnce(records);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= this.retries - 1 || !isRetryable(lastError)) {
          throw lastError;
        }
        await delay(retryDelayMs(attempt));
      }
    }
    throw lastError ?? new Error('Webhook batch failed');
  }

  private sendBatchOnce(records: LocalEventStoreRecord[]): Promise<void> {
    const body = JSON.stringify({
      version: 1,
      kind: 'errorcore.webhook_batch',
      sentAt: new Date().toISOString(),
      events: records.map((record) => ({
        kind: record.payloadKind,
        payload: parsePayload(record.payload)
      }))
    });
    const bodyBuffer = Buffer.from(body, 'utf8');
    const timestamp = String(Date.now());
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(bodyBuffer.length),
      'X-Errorcore-Webhook-Timestamp': timestamp
    };

    if (this.secret !== undefined) {
      headers['X-Errorcore-Webhook-Signature'] =
        `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`;
    }

    return new Promise((resolve, reject) => {
      const useHttps = this.url.protocol === 'https:';
      const requestModule = useHttps ? https : http;

      runAsInternal(() => {
        const request = markRequestAsInternal(
          requestModule.request(
            {
              protocol: this.url.protocol,
              hostname: this.url.hostname,
              port: this.url.port === '' ? undefined : Number(this.url.port),
              path: `${this.url.pathname}${this.url.search}`,
              method: 'POST',
              headers
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

        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        request.on('error', (error) => {
          settle(() => reject(error));
        });
        request.setTimeout(this.timeoutMs, () => {
          const error = new Error('Webhook transport timeout') as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          request.destroy(error);
          settle(() => reject(error));
        });
        request.write(bodyBuffer);
        request.end();
      });
    });
  }

  private emitWarning(warning: InternalWarning): void {
    try {
      this.onInternalWarning?.(warning);
    } catch {
    }
  }
}
