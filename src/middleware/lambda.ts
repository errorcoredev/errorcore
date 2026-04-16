
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike
} from './common';

export interface LambdaContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  awsRequestId: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMs(): number;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (headers == null || typeof headers !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.filter((v) => typeof v === 'string').join(', ');
    }
  }

  return result;
}

function detectEventSource(event: Record<string, unknown>): string {
  if (Array.isArray(event.Records) && event.Records.length > 0) {
    const first = event.Records[0] as Record<string, unknown>;
    if (first.eventSource === 'aws:sqs') return 'sqs';
    if (first.EventSource === 'aws:sns') return 'sns';
    if (first.eventSource === 'aws:s3') return 's3';
    if (first.eventSource === 'aws:dynamodb') return 'dynamodb';
    if (first.eventSource === 'aws:kinesis') return 'kinesis';
  }
  if (event.source && event['detail-type']) return 'eventbridge';
  return 'invoke';
}

function extractRequestContext(
  event: unknown,
  lambdaContext: LambdaContext
): { method: string; url: string; headers: Record<string, string>; eventSource: string; traceparent?: string } {
  if (event == null || typeof event !== 'object') {
    return { method: 'INVOKE', url: `invoke/${lambdaContext.functionName}`, headers: {}, eventSource: 'invoke' };
  }

  const ev = event as Record<string, unknown>;

  // API Gateway v2 / Function URL
  if (
    ev.requestContext != null &&
    typeof ev.requestContext === 'object' &&
    typeof (ev.requestContext as Record<string, unknown>).http === 'object'
  ) {
    const http = (ev.requestContext as Record<string, unknown>).http as Record<string, unknown>;
    const method = typeof http.method === 'string' ? http.method : 'GET';
    const url = typeof ev.rawPath === 'string' ? ev.rawPath : typeof ev.path === 'string' ? ev.path : '/';
    const headers = normalizeHeaders(ev.headers);
    return { method, url, headers, eventSource: 'apigateway-v2', traceparent: headers['traceparent'] };
  }

  // API Gateway v1 / REST API
  if (
    typeof ev.httpMethod === 'string' &&
    ev.requestContext != null &&
    typeof ev.requestContext === 'object' &&
    typeof (ev.requestContext as Record<string, unknown>).http !== 'object'
  ) {
    const method = ev.httpMethod as string;
    const url = typeof ev.path === 'string' ? ev.path : '/';
    const headers = normalizeHeaders(ev.headers);

    if (ev.multiValueHeaders != null && typeof ev.multiValueHeaders === 'object') {
      for (const [key, value] of Object.entries(ev.multiValueHeaders as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          headers[key.toLowerCase()] = value.filter((v) => typeof v === 'string').join(', ');
        }
      }
    }

    const isAlb = (ev.requestContext as Record<string, unknown>).elb != null;
    return { method, url, headers, eventSource: isAlb ? 'alb' : 'apigateway-v1', traceparent: headers['traceparent'] };
  }

  // Non-HTTP events (SQS, SNS, S3, DynamoDB, EventBridge, Kinesis, Step Functions)
  const eventSource = detectEventSource(ev);
  let traceparent: string | undefined;

  // Check SQS message attributes for traceparent
  if (eventSource === 'sqs' && Array.isArray(ev.Records)) {
    const first = ev.Records[0] as Record<string, unknown>;
    if (first.messageAttributes != null && typeof first.messageAttributes === 'object') {
      const attrs = first.messageAttributes as Record<string, unknown>;
      if (attrs.traceparent != null && typeof attrs.traceparent === 'object') {
        const tp = attrs.traceparent as Record<string, unknown>;
        if (typeof tp.stringValue === 'string') {
          traceparent = tp.stringValue;
        }
      }
    }
  }

  return {
    method: 'INVOKE',
    url: `${eventSource}/${lambdaContext.functionName}`,
    headers: {},
    eventSource,
    traceparent
  };
}

export function wrapLambda<TEvent = unknown, TResult = unknown>(
  handler: (event: TEvent, context: LambdaContext) => Promise<TResult>,
  sdk?: SDKInstanceLike
): (event: TEvent, context: LambdaContext) => Promise<TResult> {
  return async (event: TEvent, lambdaContext: LambdaContext): Promise<TResult> => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('wrapLambda()');
      return handler(event, lambdaContext);
    }

    const extracted = extractRequestContext(event, lambdaContext);
    let context: import('../types').RequestContext;

    try {
      const filteredHeaders = filterHeaders(instance, extracted.headers);
      context = instance.als.createRequestContext({
        method: extracted.method,
        url: extracted.url,
        headers: filteredHeaders,
        traceparent: extracted.traceparent
      });
    } catch {
      return handler(event, lambdaContext);
    }

    instance.processMetadata?.setServerlessMetadata({
      functionName: lambdaContext.functionName,
      functionVersion: lambdaContext.functionVersion,
      invokedFunctionArn: lambdaContext.invokedFunctionArn,
      lambdaRequestId: lambdaContext.awsRequestId
    });

    instance.requestTracker.add(context);

    const watchdog = instance.getWatchdog?.();
    watchdog?.notifyInvokeStart({
      requestId: context.requestId,
      lambdaRequestId: lambdaContext.awsRequestId,
      traceId: context.traceId,
      timeoutMs: lambdaContext.getRemainingTimeInMs(),
      eventSource: extracted.eventSource
    });

    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const remainingMs = lambdaContext.getRemainingTimeInMs();

    if (remainingMs > 3000) {
      safetyTimer = setTimeout(() => {
        safetyTimer = null;
        const err = new Error(
          `Timeout imminent: ${lambdaContext.functionName} (${lambdaContext.getRemainingTimeInMs()}ms left)`
        );
        err.name = 'LambdaTimeoutError';
        if (instance.captureError) {
          try { instance.captureError(err); } catch {}
        }
        void instance.flush?.().catch(() => undefined);
      }, remainingMs - 1500);
      safetyTimer.unref();
    }

    try {
      const result = await instance.als.runWithContext(context, async () =>
        handler(event, lambdaContext)
      );

      // Auto-capture 5xx API Gateway responses
      if (instance.captureError && result != null && typeof result === 'object') {
        const statusCode = (result as Record<string, unknown>).statusCode;
        if (typeof statusCode === 'number' && statusCode >= 500) {
          try {
            const err = new Error(`HTTP ${statusCode}`);
            err.name = 'ServerError';
            instance.captureError(err);
          } catch {}
        }
      }

      return result;
    } catch (error) {
      if (instance.captureError && error instanceof Error) {
        try { instance.captureError(error); } catch {}
      }
      throw error;
    } finally {
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
      }
      instance.requestTracker.remove(context.requestId);
      watchdog?.notifyInvokeEnd();
      try { await instance.flush?.(); } catch {}
    }
  };
}

export function wrapServerless<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => Promise<TResult>,
  options?: {
    extractContext?: (...args: TArgs) => { method: string; url: string; headers: Record<string, string> };
    getTimeoutMs?: (...args: TArgs) => number;
  }
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const instance = getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('wrapServerless()');
      return handler(...args);
    }

    const extracted = options?.extractContext?.(...args) ?? {
      method: 'INVOKE',
      url: 'serverless',
      headers: {}
    };

    let context: import('../types').RequestContext;

    try {
      context = instance.als.createRequestContext({
        method: extracted.method,
        url: extracted.url,
        headers: filterHeaders(instance, extracted.headers),
        traceparent: extracted.headers['traceparent']
      });
    } catch {
      return handler(...args);
    }

    instance.requestTracker.add(context);

    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = options?.getTimeoutMs?.(...args);

    if (timeoutMs !== undefined && timeoutMs > 3000) {
      safetyTimer = setTimeout(() => {
        safetyTimer = null;
        const err = new Error(`Timeout imminent (${timeoutMs}ms limit)`);
        err.name = 'ServerlessTimeoutError';
        if (instance.captureError) {
          try { instance.captureError(err); } catch {}
        }
        void instance.flush?.().catch(() => undefined);
      }, timeoutMs - 1500);
      safetyTimer.unref();
    }

    try {
      return await instance.als.runWithContext(context, async () =>
        handler(...args)
      );
    } catch (error) {
      if (instance.captureError && error instanceof Error) {
        try { instance.captureError(error); } catch {}
      }
      throw error;
    } finally {
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
      }
      instance.requestTracker.remove(context.requestId);
      try { await instance.flush?.(); } catch {}
    }
  };
}
