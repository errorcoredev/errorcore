
import type { RequestContext } from '../types';
import { safeConsole } from '../debug-log';
import { registerRequestCleanup } from '../context/request-tracker';
import type { RequestContextMaterializationHook } from '../context/als-manager';

export interface SDKInstanceLike {
  isActive(): boolean;
  captureError?(error: unknown): void;
  flush?(): Promise<void>;
  prepareForRequestStart?(): void;
  als: {
    createRequestContext(input: {
      method: string;
      url: string;
      headers: unknown;
      traceparent?: string;
      tracestate?: string;
    }): RequestContext;
    getContext?(): RequestContext | undefined;
    runWithContext<T>(ctx: RequestContext, fn: () => T): T;
    enterWithContext?(ctx: RequestContext): void;
    formatTraceparent?(): string | null;
    attachRequestContextMaterializationHook?(
      ctx: RequestContext,
      hook: RequestContextMaterializationHook
    ): void;
    isRequestContextMaterialized?(ctx: RequestContext): boolean;
    ensureRequestContextMaterialized?(ctx: RequestContext): void;
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

interface ModuleInstanceApi {
  getModuleInstance?: () => SDKInstanceLike | null;
  getModuleInstanceGeneration?: () => number;
}

let moduleApiLoaded = false;
let moduleApi: ModuleInstanceApi | null = null;
let cachedModuleGeneration = -1;
let cachedModuleInstance: SDKInstanceLike | null = null;

export function getModuleInstance(): SDKInstanceLike | null {
  if (!moduleApiLoaded) {
    moduleApiLoaded = true;
    try {
      moduleApi = require('../index') as ModuleInstanceApi;
    } catch {
      moduleApi = null;
    }
  }

  if (moduleApi !== null) {
    const generation = moduleApi.getModuleInstanceGeneration?.() ?? 0;
    if (generation !== cachedModuleGeneration) {
      cachedModuleGeneration = generation;
      cachedModuleInstance = moduleApi.getModuleInstance?.() ?? null;
    }
    if (cachedModuleInstance !== null) {
      return cachedModuleInstance;
    }
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

function extractHeader(headers: unknown, headerName: string): string | undefined {
  const expected = headerName.toLowerCase();

  try {
    if (Array.isArray(headers)) {
      if (headers.length === 0) return undefined;
      if (typeof headers[0] === 'string') {
        for (let index = 0; index + 1 < headers.length; index += 2) {
          const name = headers[index];
          const value = headers[index + 1];
          if (typeof name === 'string' && name.toLowerCase() === expected) {
            return typeof value === 'string' ? value : undefined;
          }
        }
        return undefined;
      }

      if (Array.isArray(headers[0])) {
        for (const entry of headers) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            entry[0].toLowerCase() === expected
          ) {
            return typeof entry[1] === 'string' ? entry[1] : undefined;
          }
        }
        return undefined;
      }
    }

    if (headers instanceof Map) {
      for (const [name, value] of headers.entries()) {
        if (typeof name === 'string' && name.toLowerCase() === expected) {
          return typeof value === 'string' ? value : undefined;
        }
      }
      return undefined;
    }

    if (typeof headers !== 'object' || headers === null) {
      return undefined;
    }

    const headersObject = headers as {
      get?: unknown;
      forEach?: unknown;
    };

    if (typeof headersObject.get === 'function') {
      const value =
        (headersObject.get as (name: string) => unknown)(headerName) ??
        (headersObject.get as (name: string) => unknown)(expected);
      return typeof value === 'string' ? value : undefined;
    }

    if (typeof headersObject.forEach === 'function') {
      let found: string | undefined;
      (headersObject.forEach as (cb: (value: unknown, key: unknown) => void) => void)(
        (value, key) => {
          if (found === undefined && typeof key === 'string' && key.toLowerCase() === expected) {
            found = typeof value === 'string' ? value : undefined;
          }
        }
      );
      return found;
    }

    const record = headers as Record<string, unknown>;
    const direct = record[headerName] ?? record[expected];
    if (typeof direct === 'string') {
      return direct;
    }

    for (const key in record) {
      if (key.toLowerCase() === expected) {
        const value = record[key];
        return typeof value === 'string' ? value : undefined;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
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

interface LazyRequestLifecycle {
  request?: unknown;
  response?: unknown;
  getStatusCode?: () => unknown;
  isFinished?: () => boolean;
  onCleanup?: () => void;
  autoCleanup?: boolean;
  claimCleanup?: () => boolean;
  carryRequest?: unknown;
}

function lifecycleFinished(lifecycle: LazyRequestLifecycle): boolean {
  if (lifecycle.isFinished !== undefined) {
    return lifecycle.isFinished() === true;
  }

  const response = lifecycle.response as { finished?: unknown } | undefined;
  return response?.finished === true;
}

function lifecycleStatusCode(lifecycle: LazyRequestLifecycle): unknown {
  if (lifecycle.getStatusCode !== undefined) {
    return lifecycle.getStatusCode();
  }

  const response = lifecycle.response as { statusCode?: unknown } | undefined;
  return response?.statusCode;
}

export function createLazyRequestContext(
  sdk: SDKInstanceLike,
  input: {
    method: string;
    url: string;
    headers: unknown;
    traceparent?: string;
    tracestate?: string;
    lifecycle?: LazyRequestLifecycle;
  }
): RequestContext | null {
  try {
    const context = sdk.als.createRequestContext({
      method: input.method,
      url: input.url,
      headers: input.headers,
      traceparent: input.traceparent ?? extractHeader(input.headers, 'traceparent'),
      tracestate: input.tracestate ?? extractHeader(input.headers, 'tracestate')
    });

    if (input.lifecycle !== undefined) {
      attachLazyRequestLifecycle(sdk, context, input.lifecycle);
    }

    return context;
  } catch {
    return null;
  }
}

export function attachLazyRequestLifecycle(
  sdk: SDKInstanceLike,
  context: RequestContext,
  lifecycle: LazyRequestLifecycle
): void {
  const attach = sdk.als.attachRequestContextMaterializationHook;
  const autoCleanup = lifecycle.autoCleanup !== false;
  let registered = false;

  const registerOnMaterialize: RequestContextMaterializationHook = () => {
    if (registered) {
      return;
    }
    registered = true;

    if (lifecycle.carryRequest !== undefined) {
      setCarriedRequestContext(sdk, lifecycle.carryRequest, context);
    }

    if (lifecycle.claimCleanup !== undefined && lifecycle.claimCleanup() === false) {
      return;
    }

    if (lifecycleFinished(lifecycle)) {
      return {
        cleanupAfterCapture: () => {
          releaseCompletedRequestIfSuccessful(
            sdk,
            context,
            lifecycleStatusCode(lifecycle)
          );
        }
      };
    }

    sdk.requestTracker.add(context);

    if (autoCleanup) {
      registerRequestCleanup({
        requestTracker: sdk.requestTracker,
        requestId: context.requestId,
        request: lifecycle.request,
        response: lifecycle.response,
        onCleanup: lifecycle.onCleanup,
        onResponseComplete: () => {
          releaseCompletedRequestIfSuccessful(
            sdk,
            context,
            lifecycleStatusCode(lifecycle)
          );
        }
      });
    }
  };

  if (typeof attach === 'function') {
    attach.call(sdk.als, context, registerOnMaterialize);
    return;
  }

  registerOnMaterialize(context);
}

export function completeLazyRequestContext(
  sdk: SDKInstanceLike,
  context: RequestContext,
  statusCode: unknown
): void {
  if (sdk.als.isRequestContextMaterialized?.(context) === false) {
    return;
  }

  releaseCompletedRequestIfSuccessful(sdk, context, statusCode);
  try {
    sdk.requestTracker.remove(context.requestId);
  } catch {
  }
}
