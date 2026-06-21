
import type { RequestContext } from '../types';
import { safeConsole } from '../debug-log';

export interface SDKInstanceLike {
  isActive(): boolean;
  captureError?(error: unknown): void;
  flush?(): Promise<void>;
  prepareForRequestStart?(): void;
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
    enterWithContext?(ctx: RequestContext): void;
    formatTraceparent?(): string | null;
  };
  requestTracker: {
    add(ctx: RequestContext): void;
    remove(requestId: string): void;
  };
  getRequestContextForRequest?(request: object): RequestContext | undefined;
  setRequestContextForRequest?(request: object, context: RequestContext): void;
  claimRequestCleanupForRequest?(request: object): boolean;
  releaseCompletedRequestContext?(ctx: RequestContext, clearContext?: boolean): void;
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

    const moduleInstance = moduleRef.getModuleInstance?.() ?? null;
    if (moduleInstance !== null) {
      return moduleInstance;
    }
  } catch {
  }

  return (
    (globalThis as Record<symbol, SDKInstanceLike | null | undefined>)[
      Symbol.for('errorcore.sdk.instance')
    ] ?? null
  );
}

export function resolveLiveSDK(
  sdk: SDKInstanceLike | null | undefined
): SDKInstanceLike | null {
  if (sdk !== null && sdk !== undefined && sdk.isActive()) {
    return sdk;
  }

  const moduleInstance = getModuleInstance();
  if (moduleInstance !== null && moduleInstance.isActive()) {
    return moduleInstance;
  }

  return sdk ?? moduleInstance;
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

function isRequestObject(request: unknown): request is object {
  return (typeof request === 'object' && request !== null) || typeof request === 'function';
}

export function getCarriedRequestContext(
  sdk: SDKInstanceLike,
  request: unknown
): RequestContext | undefined {
  if (!isRequestObject(request)) {
    return undefined;
  }

  try {
    return sdk.getRequestContextForRequest?.(request);
  } catch {
    return undefined;
  }
}

export function setCarriedRequestContext(
  sdk: SDKInstanceLike,
  request: unknown,
  context: RequestContext
): void {
  if (!isRequestObject(request)) {
    return;
  }

  try {
    sdk.setRequestContextForRequest?.(request, context);
  } catch {
  }
}

export function claimRequestCleanupRegistration(
  sdk: SDKInstanceLike,
  request: unknown
): boolean {
  if (!isRequestObject(request)) {
    return true;
  }

  try {
    return sdk.claimRequestCleanupForRequest?.(request) ?? true;
  } catch {
    return true;
  }
}

export function prepareForRequestStart(sdk: SDKInstanceLike): void {
  try {
    sdk.prepareForRequestStart?.();
  } catch {
    // Request middleware must never fail because inspector re-arming failed.
  }
}

export function releaseCompletedRequestIfSuccessful(
  sdk: SDKInstanceLike,
  context: RequestContext,
  statusCode: unknown
): void {
  if (typeof statusCode === 'number' && statusCode >= 500) {
    return;
  }

  try {
    sdk.releaseCompletedRequestContext?.(context, true);
  } catch {
    // Request cleanup must remain best-effort.
  }
}
