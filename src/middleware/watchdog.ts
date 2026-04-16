
import type { ResolvedConfig } from '../types';

interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (
    filename: string,
    options: { eval: true; workerData: unknown }
  ) => WorkerLike;
}

function getWorkerThreads(): WorkerThreadsModule {
  return require('node:worker_threads') as WorkerThreadsModule;
}

function createWatchdogWorkerSource(): string {
  return `
const { parentPort, workerData } = require('node:worker_threads');
const https = require('node:https');
const http = require('node:http');

let timer = null;
let invocationMeta = null;
let lastCapturedError = null;
const collectorUrl = workerData.collectorUrl;
const collectorAuth = workerData.collectorAuth;
const functionName = workerData.functionName;
const keepAliveAgent = collectorUrl && collectorUrl.startsWith('https')
  ? new https.Agent({ keepAlive: true, maxSockets: 1 })
  : collectorUrl ? new http.Agent({ keepAlive: true, maxSockets: 1 }) : null;

parentPort.on('message', (msg) => {
  if (msg.type === 'invoke_start') {
    if (timer) clearTimeout(timer);
    invocationMeta = {
      requestId: msg.requestId,
      lambdaRequestId: msg.lambdaRequestId,
      traceId: msg.traceId,
      startedAt: Date.now(),
      timeoutMs: msg.timeoutMs,
      eventSource: msg.eventSource
    };
    lastCapturedError = null;
    const deadline = msg.timeoutMs - 1500;
    if (deadline > 0) {
      timer = setTimeout(() => onTimeout(), deadline);
      timer.unref();
    }
  }

  if (msg.type === 'invoke_end') {
    if (timer) { clearTimeout(timer); timer = null; }
    invocationMeta = null;
    lastCapturedError = null;
  }

  if (msg.type === 'error_captured') {
    lastCapturedError = {
      name: msg.errorName,
      message: msg.errorMessage,
      stack: msg.errorStack
    };
  }

  if (msg.type === 'shutdown') {
    if (timer) clearTimeout(timer);
    if (keepAliveAgent) keepAliveAgent.destroy();
    parentPort.close();
  }
});

function onTimeout() {
  timer = null;
  if (!invocationMeta || !collectorUrl) return;

  const payload = JSON.stringify({
    schemaVersion: '1.0.0',
    capturedAt: new Date().toISOString(),
    source: 'watchdog',
    error: lastCapturedError || {
      type: 'LambdaTimeoutError',
      message: 'Function timed out: ' + functionName + ' (' + invocationMeta.timeoutMs + 'ms limit)',
      stack: ''
    },
    invocation: {
      functionName: functionName,
      requestId: invocationMeta.requestId,
      lambdaRequestId: invocationMeta.lambdaRequestId,
      traceId: invocationMeta.traceId,
      eventSource: invocationMeta.eventSource,
      startedAt: new Date(invocationMeta.startedAt).toISOString(),
      durationMs: Date.now() - invocationMeta.startedAt,
      timeoutMs: invocationMeta.timeoutMs
    }
  });

  const url = new URL(collectorUrl);
  const mod = url.protocol === 'https:' ? https : http;
  const req = mod.request({
    hostname: url.hostname,
    port: url.port || undefined,
    path: url.pathname + url.search,
    method: 'POST',
    agent: keepAliveAgent,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...(collectorAuth ? { 'Authorization': collectorAuth } : {})
    }
  }, (res) => { res.on('data', () => {}); });
  req.on('error', (err) => {
    // This worker cannot reach onInternalWarning. Write to stderr so the
    // failure shows up in CloudWatch (the Lambda use case this watchdog
    // was built for). Silent swallowing in the original implementation
    // masked ECONNREFUSED/DNS failures that operators needed to see.
    try { process.stderr.write('[errorcore][watchdog] post failed: ' + ((err && err.message) || String(err)) + '\\n'); } catch (e) { /* stderr itself failed */ }
  });
  req.setTimeout(3000, () => {
    // Destroy with an explicit error so the 'error' listener logs it and
    // socket teardown propagates to any in-flight write buffers.
    try { req.destroy(new Error('watchdog post timeout')); } catch (e) { /* already destroyed */ }
  });
  req.write(payload);
  req.end();
}
`;
}

export class WatchdogManager {
  private worker: WorkerLike | null = null;

  private readonly collectorUrl: string | null;

  private readonly collectorAuth: string | undefined;

  private readonly functionName: string;

  public constructor(config: ResolvedConfig, transportAuth?: string) {
    this.collectorUrl = config.transport.type === 'http' ? config.transport.url : null;
    this.collectorAuth = transportAuth;
    this.functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'unknown';
  }

  public start(): void {
    try {
      const workerThreads = getWorkerThreads();
      this.worker = new workerThreads.Worker(createWatchdogWorkerSource(), {
        eval: true,
        workerData: {
          collectorUrl: this.collectorUrl,
          collectorAuth: this.collectorAuth,
          functionName: this.functionName
        }
      });

      this.worker.on('error', () => {
        this.worker = null;
      });

      this.worker.on('exit', () => {
        this.worker = null;
      });
    } catch {
      console.warn('[ErrorCore] Watchdog worker thread init failed');
      this.worker = null;
    }
  }

  public notifyInvokeStart(meta: {
    requestId: string;
    lambdaRequestId: string;
    traceId?: string;
    timeoutMs: number;
    eventSource: string;
  }): void {
    this.worker?.postMessage({ type: 'invoke_start', ...meta });
  }

  public notifyInvokeEnd(): void {
    this.worker?.postMessage({ type: 'invoke_end' });
  }

  public notifyErrorCaptured(error: Error): void {
    this.worker?.postMessage({
      type: 'error_captured',
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack || ''
    });
  }

  public async shutdown(): Promise<void> {
    if (this.worker === null) return;

    this.worker.postMessage({ type: 'shutdown' });

    const worker = this.worker;
    this.worker = null;

    await Promise.race([
      worker.terminate(),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        timeout.unref();
      })
    ]);
  }
}
