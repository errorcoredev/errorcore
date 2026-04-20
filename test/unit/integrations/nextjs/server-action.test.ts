import { describe, expect, it, vi } from 'vitest';

import { ALSManager } from '../../../../src/context/als-manager';
import { HeaderFilter } from '../../../../src/pii/header-filter';
import { withServerAction } from '../../../../src/integrations/nextjs/server-action';
import { resolveTestConfig } from '../../../helpers/test-config';

function createSdk(options?: { active?: boolean; throwOnCreate?: boolean }) {
  const als = new ALSManager();
  const headerFilter = new HeaderFilter(resolveTestConfig());
  let addedContext:
    | {
        requestId: string;
        method?: string;
        url?: string;
      }
    | undefined;

  return {
    sdk: {
      isActive: () => options?.active ?? true,
      captureError: vi.fn(),
      flush: vi.fn(async () => undefined),
      als: {
        createRequestContext: vi.fn((input: {
          method: string;
          url: string;
          headers: Record<string, string>;
        }) => {
          if (options?.throwOnCreate) {
            throw new Error('sdk failure');
          }
          return als.createRequestContext(input);
        }),
        runWithContext: als.runWithContext.bind(als),
        getContext: als.getContext.bind(als),
        getRequestId: als.getRequestId.bind(als),
      },
      requestTracker: {
        add: vi.fn((ctx: { requestId: string; method?: string; url?: string }) => {
          addedContext = ctx;
        }),
        remove: vi.fn(),
      },
      headerFilter,
    },
    als,
    getAddedContext: () => addedContext,
  };
}

describe('withServerAction', () => {
  it('runs action inside a fresh ALS context and cleans up tracker', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    let observedRequestId: string | undefined;

    const wrapped = withServerAction(
      async () => {
        await Promise.resolve();
        observedRequestId = als.getRequestId();
        return 'done';
      },
      { name: 'saveUser' },
      sdk,
    );

    const result = await wrapped();

    const captured = getAddedContext();
    expect(result).toBe('done');
    expect(observedRequestId).toBe(captured?.requestId);
    expect(captured).toMatchObject({ method: 'ACTION', url: 'action/saveUser' });
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('defaults URL to action/<function-name> when no options.name', async () => {
    const { sdk, getAddedContext } = createSdk();
    async function saveUser() { return 1; }
    await withServerAction(saveUser, undefined, sdk)();
    expect(getAddedContext()).toMatchObject({ url: 'action/saveUser' });
  });

  it('falls back to action/action for anonymous actions with no options', async () => {
    const { sdk, getAddedContext } = createSdk();
    await withServerAction(async () => 1, undefined, sdk)();
    // Anonymous arrow functions have empty .name, so the fallback kicks in.
    expect(getAddedContext()).toMatchObject({ url: 'action/action' });
  });

  it('passes through when SDK is not active', async () => {
    const { sdk } = createSdk({ active: false });
    const result = await withServerAction(async () => 'ok', undefined, sdk)();
    expect(result).toBe('ok');
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
  });

  it('passes through when parent ALS context already exists', async () => {
    const { sdk, als } = createSdk();
    const existing = als.createRequestContext({
      method: 'GET',
      url: '/parent',
      headers: { host: 'service.local' },
    });

    await als.runWithContext(existing, async () => {
      await withServerAction(async () => 'nested', undefined, sdk)();
    });

    expect(sdk.als.createRequestContext).not.toHaveBeenCalled();
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('still runs the action when SDK throws during context setup', async () => {
    const { sdk } = createSdk({ throwOnCreate: true });
    const result = await withServerAction(async () => 'recovered', undefined, sdk)();
    expect(result).toBe('recovered');
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('captures handler errors, re-throws, and cleans up tracker', async () => {
    const { sdk, getAddedContext } = createSdk();
    const captureSpy = sdk.captureError as unknown as ReturnType<typeof vi.fn>;

    await expect(
      withServerAction(async () => {
        throw new Error('action boom');
      }, undefined, sdk)(),
    ).rejects.toThrow('action boom');

    const captured = getAddedContext();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'action boom' }));
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('does NOT call flush on success (regression guard vs wrapServerless)', async () => {
    const { sdk } = createSdk();
    const flushSpy = sdk.flush as unknown as ReturnType<typeof vi.fn>;
    await withServerAction(async () => 0, undefined, sdk)();
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('does NOT call flush on failure path either', async () => {
    const { sdk } = createSdk();
    const flushSpy = sdk.flush as unknown as ReturnType<typeof vi.fn>;
    await expect(
      withServerAction(async () => { throw new Error('x'); }, undefined, sdk)(),
    ).rejects.toThrow('x');
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('forwards arguments to the underlying action', async () => {
    const { sdk } = createSdk();
    const action = vi.fn(async (a: number, b: string) => `${a}-${b}`);
    const wrapped = withServerAction(action, undefined, sdk);
    const result = await wrapped(42, 'hello');
    expect(result).toBe('42-hello');
    expect(action).toHaveBeenCalledWith(42, 'hello');
  });
});
