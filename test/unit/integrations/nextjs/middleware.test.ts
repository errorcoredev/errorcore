import { describe, it, expect, vi, afterEach } from 'vitest';
import { withNextMiddleware } from '../../../../src/integrations/nextjs/middleware';
import { resetMiddlewareWarning } from '../../../../src/middleware/common';

function makeFakeRequest(opts: { method: string; url: string; headers?: Record<string, string> }) {
  const headers = opts.headers ?? {};
  return {
    method: opts.method,
    url: opts.url,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      }
    }
  };
}

interface FakeSDK {
  isActive: () => boolean;
  captureError: ReturnType<typeof vi.fn>;
  als: {
    getContext: () => { requestId: string } | undefined;
    createRequestContext: ReturnType<typeof vi.fn>;
    runWithContext: <T>(ctx: unknown, fn: () => T | Promise<T>) => T | Promise<T>;
  };
  requestTracker: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  headerFilter: {
    filterAndNormalizeHeaders: (h: unknown) => Record<string, string>;
  };
  config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' };
}

function makeFakeActiveSDK(opts?: {
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';
  existingContext?: boolean;
}): FakeSDK {
  const contextHolder: { current: { requestId: string } | undefined } = {
    current: opts?.existingContext ? { requestId: 'pre-existing' } : undefined
  };
  return {
    isActive: () => true,
    captureError: vi.fn(),
    als: {
      getContext: () => contextHolder.current,
      createRequestContext: vi.fn((req) => {
        const ctx = { requestId: 'new-context-id', ...req };
        return ctx;
      }),
      runWithContext: async (ctx: any, fn: any) => {
        const prev = contextHolder.current;
        contextHolder.current = ctx;
        try {
          return await fn();
        } finally {
          contextHolder.current = prev;
        }
      }
    },
    requestTracker: {
      add: vi.fn(),
      remove: vi.fn()
    },
    headerFilter: {
      filterAndNormalizeHeaders: (h) => h as Record<string, string>
    },
    config: { captureMiddlewareStatusCodes: opts?.captureMiddlewareStatusCodes ?? 'none' }
  };
}

describe('C1 — withNextMiddleware', () => {
  afterEach(() => {
    resetMiddlewareWarning();
    vi.restoreAllMocks();
  });

  it('passes through when sdk is null (SDK not initialized)', async () => {
    const inner = vi.fn(async () => ({ status: 200 }));
    const wrapped = withNextMiddleware(inner as never, null as never);
    const req = makeFakeRequest({ method: 'GET', url: '/' });
    const res = await wrapped(req);
    expect(inner).toHaveBeenCalled();
    expect(res).toEqual({ status: 200 });
  });

  it('passes through when SDK exists but isActive() returns false', async () => {
    const inactive: Partial<FakeSDK> = {
      isActive: () => false
    };
    const inner = vi.fn(async () => ({ status: 200 }));
    const wrapped = withNextMiddleware(inner as never, inactive as never);
    await wrapped(makeFakeRequest({ method: 'GET', url: '/' }));
    expect(inner).toHaveBeenCalled();
  });

  it('starts ALS context and registers in requestTracker when active', async () => {
    const sdk = makeFakeActiveSDK();
    let observedCtx: unknown;
    const inner = vi.fn(async () => {
      observedCtx = sdk.als.getContext();
      return undefined;
    });
    const wrapped = withNextMiddleware(inner as never, sdk as never);
    await wrapped(makeFakeRequest({ method: 'GET', url: '/x' }));
    expect(observedCtx).toBeDefined();
    expect(sdk.requestTracker.add).toHaveBeenCalled();
    expect(sdk.requestTracker.remove).toHaveBeenCalled();
  });

  it('reuses existing ALS context (nested) — skips creating a new one', async () => {
    const sdk = makeFakeActiveSDK({ existingContext: true });
    const inner = vi.fn(async () => undefined);
    const wrapped = withNextMiddleware(inner as never, sdk as never);
    await wrapped(makeFakeRequest({ method: 'GET', url: '/' }));
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it('undefined middleware return is pass-through regardless of captureMiddlewareStatusCodes', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'all' });
    const wrapped = withNextMiddleware(async () => undefined, sdk as never);
    const res = await wrapped(makeFakeRequest({ method: 'GET', url: '/' }));
    expect(res).toBeUndefined();
    expect(sdk.captureError).not.toHaveBeenCalled();
  });

  it('captures MiddlewareRejection when returned status matches array config', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: [401, 500] });
    const wrapped = withNextMiddleware(
      async () => ({ status: 401 }),
      sdk as never
    );
    await wrapped(makeFakeRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).toHaveBeenCalledTimes(1);
    const arg = sdk.captureError.mock.calls[0][0];
    expect(arg.name).toBe('MiddlewareRejection');
    expect(arg.message).toContain('HTTP 401');
  });

  it('captures all non-2xx when captureMiddlewareStatusCodes is "all"', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'all' });
    const wrapped = withNextMiddleware(
      async () => ({ status: 503 }),
      sdk as never
    );
    await wrapped(makeFakeRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).toHaveBeenCalled();
  });

  it('does not capture 2xx returns when captureMiddlewareStatusCodes is "all"', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'all' });
    const wrapped = withNextMiddleware(
      async () => ({ status: 200 }),
      sdk as never
    );
    await wrapped(makeFakeRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).not.toHaveBeenCalled();
  });

  it('does not capture any response when config is "none"', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'none' });
    const wrapped = withNextMiddleware(
      async () => ({ status: 500 }),
      sdk as never
    );
    await wrapped(makeFakeRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).not.toHaveBeenCalled();
  });

  it('captures thrown errors and rethrows', async () => {
    const sdk = makeFakeActiveSDK();
    const boom = new Error('boom');
    const wrapped = withNextMiddleware(async () => { throw boom; }, sdk as never);
    await expect(wrapped(makeFakeRequest({ method: 'GET', url: '/' }))).rejects.toBe(boom);
    expect(sdk.captureError).toHaveBeenCalledWith(boom);
  });
});
