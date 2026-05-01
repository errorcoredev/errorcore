
import type { RequestContext } from '../types';
import { safeConsole } from '../debug-log';

export interface SDKInstanceLike {
  isActive(): boolean;
  captureError?(error: Error): void;
  flush?(): Promise<void>;
  als: {
    createRequestContext(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
      traceparent?: string;
      tracestate?: string;
    }): RequestContext;
    getContext?(): RequestContext | undefined;
    runWithContext<T>(ctx: RequestContext, fn: () => T): T;
    formatTraceparent?(): string | null;
  };
  requestTracker: {
    add(ctx: RequestContext): void;
    remove(requestId: string): void;
  };
  headerFilter: {
    filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
  };
  processMetadata?: {
    setServerlessMetadata(meta: {
      functionName: string;
      functionVersion: string;
      invokedFunctionArn: string;
      lambdaRequestId: string;
    }): void;
  };
  getWatchdog?(): {
    notifyInvokeStart(meta: {
      requestId: string;
      lambdaRequestId: string;
      traceId?: string;
      timeoutMs: number;
      eventSource: string;
    }): void;
    notifyInvokeEnd(): void;
  } | null;
}

export function getModuleInstance(): SDKInstanceLike | null {
  try {
    const moduleRef = require('../index') as {
      getModuleInstance?: () => SDKInstanceLike | null;
    };

    return moduleRef.getModuleInstance?.() ?? null;
  } catch {
    return null;
  }
}

let middlewareWarningEmitted = false;

export function warnIfUninitialized(source: string): void {
  if (!middlewareWarningEmitted) {
    middlewareWarningEmitted = true;
    safeConsole.warn(
      `[errorcore] ${source} is active but init() was not called. ` +
      'Requests are not being tracked. Call errorcore.init() at the top of your application entry point.'
    );
  }
}

export function resetMiddlewareWarning(): void {
  middlewareWarningEmitted = false;
}

export function filterHeaders(
  sdk: SDKInstanceLike,
  headers: Record<string, unknown>
): Record<string, string> {
  return sdk.headerFilter.filterAndNormalizeHeaders(headers);
}
