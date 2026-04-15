
import type { RequestContext } from '../types';

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

export function filterHeaders(
  sdk: SDKInstanceLike,
  headers: Record<string, unknown>
): Record<string, string> {
  return sdk.headerFilter.filterAndNormalizeHeaders(headers);
}
