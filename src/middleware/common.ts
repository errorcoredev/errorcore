
export interface SDKInstanceLike {
  isActive(): boolean;
  captureError?(error: Error): void;
  als: {
    createRequestContext(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
    }): { requestId: string };
    getContext?(): { requestId: string } | undefined;
    runWithContext<T>(ctx: { requestId: string }, fn: () => T): T;
  };
  requestTracker: {
    add(ctx: { requestId: string }): void;
    remove(requestId: string): void;
  };
  headerFilter: {
    filterAndNormalizeHeaders(headers: unknown): Record<string, string>;
  };
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
