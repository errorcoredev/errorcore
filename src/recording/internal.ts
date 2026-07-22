export const ERRORCORE_INTERNAL = Symbol('errorcore.internal');

export const SDK_INTERNAL_REQUESTS = new WeakSet<object>();

let internalCallDepth = 0;

export function runAsInternal<T>(fn: () => T): T {
  internalCallDepth += 1;

  try {
    return fn();
  } finally {
    internalCallDepth -= 1;
  }
}

export function isInternalCallActive(): boolean {
  return internalCallDepth > 0;
}

export function markRequestAsInternal<T extends object>(request: T): T {
  SDK_INTERNAL_REQUESTS.add(request);
  (request as T & { [ERRORCORE_INTERNAL]?: true })[ERRORCORE_INTERNAL] = true;
  return request;
}

export function isSdkInternalRequest(request: unknown): boolean {
  if (isInternalCallActive()) {
    return true;
  }

  if (typeof request !== 'object' || request === null) {
    return false;
  }

  return (
    SDK_INTERNAL_REQUESTS.has(request) ||
    (request as { [ERRORCORE_INTERNAL]?: unknown })[ERRORCORE_INTERNAL] === true
  );
}
