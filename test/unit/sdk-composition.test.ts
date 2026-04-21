import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  captureError as captureErrorFacade,
  createSDK as createSDKFacade,
  init,
  shutdown as shutdownFacade,
  trackState as trackStateFacade,
  withContext as withContextFacade
} from '../../src/index';
import { createSDK } from '../../src/sdk';
import { Encryption } from '../../src/security/encryption';
import { DeadLetterStore } from '../../src/transport/dead-letter-store';

function createTestSDK() {
  return createSDK({ transport: { type: 'stdout' }, allowUnencrypted: true });
}

describe('SDK composition', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownFacade();
  });

  it('createSDK returns an SDKInstance with all components wired', async () => {
    const sdk = createTestSDK();

    try {
      expect(sdk.config).toBeDefined();
      expect(sdk.buffer).toBeDefined();
      expect(sdk.als).toBeDefined();
      expect(sdk.requestTracker).toBeDefined();
      expect(sdk.inspector).toBeDefined();
      expect(sdk.channelSubscriber).toBeDefined();
      expect(sdk.patchManager).toBeDefined();
      expect(sdk.stateTracker).toBeDefined();
      expect(sdk.errorCapturer).toBeDefined();
      expect(sdk.transport).toBeDefined();
      expect(sdk.processMetadata).toBeDefined();
    } finally {
      await sdk.shutdown();
    }
  });

  it('does not expose collector authorization on the public config surface', async () => {
    const sdk = createSDK({
      allowUnencrypted: true,
      transport: {
        type: 'http',
        url: 'https://collector.example.com/v1/errors',
        authorization: 'Bearer super-secret'
      }
    });

    try {
      expect(sdk.config.transport).toEqual({
        type: 'http',
        url: 'https://collector.example.com/v1/errors'
      });
      expect(JSON.stringify(sdk.config)).not.toContain('super-secret');
    } finally {
      await sdk.shutdown();
    }
  });

  it('does not call process.exit when the host has its own uncaughtException handler', () => {
    // Regression: the previous behavior was that the SDK always forced
    // process.exit(1) after capturing an uncaught exception, even when
    // the host application had installed its own handler that expected
    // to keep the process alive.
    const existingHostHandler = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // Do not actually exit during the test; we only need to observe
      // whether the SDK tried to call exit.
      return undefined as never;
    }) as (code?: number | string | null | undefined) => never);

    // Install the host handler BEFORE the SDK activates so the SDK's
    // snapshot count sees a pre-existing listener.
    process.on('uncaughtException', existingHostHandler);

    let sdk: ReturnType<typeof createSDK> | undefined;
    try {
      sdk = createSDK({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        // Disable the worker path so capture is synchronous and we do not
        // race with async package assembly.
        useWorkerAssembly: false
      });
      sdk.activate();

      // Find the SDK's uncaughtException handler and invoke it with a
      // synthesized error.
      const listeners = process.listeners('uncaughtException');
      const sdkHandler = listeners[listeners.length - 1] as (err: Error) => void;
      expect(typeof sdkHandler).toBe('function');

      sdkHandler(new Error('injected-uncaught'));

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', existingHostHandler);
      if (sdk !== undefined) {
        // Avoid shutdown side effects that would call exit in production.
        void sdk.shutdown().catch(() => undefined);
      }
      exitSpy.mockRestore();
    }
  });

  it('does not auto-load errorcore.config.js from the current working directory', async () => {
    // Regression test: init() used to call tryLoadConfigFile() which did
    // require(process.cwd() + '/errorcore.config.js'). That was an RCE surface
    // for anything that initialized errorcore from an untrusted directory.
    // After the fix, init() must never require the cwd config file.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-auto-config-'));
    const configPath = path.join(tempDir, 'errorcore.config.js');
    fs.writeFileSync(
      configPath,
      'throw new Error("errorcore.config.js was auto-loaded - this is the RCE we fixed");\n'
    );

    const origCwd = process.cwd();
    process.chdir(tempDir);

    try {
      // With a config file on disk but no config argument, init() must not
      // load it. We pass an explicit stdout config so activation succeeds.
      const instance = init({ transport: { type: 'stdout' }, allowUnencrypted: true });
      expect(instance.isActive()).toBe(true);
    } finally {
      process.chdir(origCwd);
      await shutdownFacade();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not replay forged dead-letter entries on activate', async () => {
    const deadLetterPath = path.join(
      os.tmpdir(),
      `errorcore-forged-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`
    );
    fs.writeFileSync(
      deadLetterPath,
      JSON.stringify({
        version: 1,
        kind: 'payload',
        storedAt: new Date().toISOString(),
        payload: '{"forged":true}',
        mac: 'not-valid'
      }) + '\n'
    );

    const sdk = createSDK({
      encryptionKey: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      transport: {
        type: 'http',
        url: 'https://collector.example.com/v1/errors',
        authorization: 'Bearer super-secret'
      },
      deadLetterPath
    });
    const sendSpy = vi.spyOn(sdk.transport, 'send').mockResolvedValue(undefined);

    try {
      sdk.activate();
      await Promise.resolve();

      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await sdk.shutdown();
      fs.rmSync(deadLetterPath, { force: true });
    }
  });

  it('replays valid signed dead-letter entries on activate and clears processed lines', async () => {
    const deadLetterPath = path.join(
      os.tmpdir(),
      `errorcore-valid-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`
    );
    const encryptionKey =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const payload = JSON.stringify(
      new Encryption(encryptionKey).encrypt('{"ok":true}')
    );
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: encryptionKey,
      requireEncryptedPayload: true
    });

    store.appendPayloadSync(payload);

    const sdk = createSDK({
      encryptionKey,
      transport: {
        type: 'http',
        url: 'https://collector.example.com/v1/errors',
        authorization: 'Bearer super-secret'
      },
      deadLetterPath
    });
    const sendSpy = vi.spyOn(sdk.transport, 'send').mockResolvedValue(undefined);

    try {
      sdk.activate();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(payload);
      expect(fs.existsSync(deadLetterPath)).toBe(false);
    } finally {
      await sdk.shutdown();
      fs.rmSync(deadLetterPath, { force: true });
    }
  });

  it('replays dead-letter entries signed with collector authorization when no encryption key is configured', async () => {
    const deadLetterPath = path.join(
      os.tmpdir(),
      `errorcore-auth-only-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`
    );
    const authorization = 'Bearer replay-secret';
    const payload = '{"ok":true}';
    const store = new DeadLetterStore(deadLetterPath, {
      integrityKey: authorization
    });

    store.appendPayloadSync(payload);

    const sdk = createSDK({
      allowUnencrypted: true,
      transport: {
        type: 'http',
        url: 'https://collector.example.com/v1/errors',
        authorization
      },
      deadLetterPath
    });
    const sendSpy = vi.spyOn(sdk.transport, 'send').mockResolvedValue(undefined);

    try {
      sdk.activate();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(payload);
      expect(fs.existsSync(deadLetterPath)).toBe(false);
    } finally {
      await sdk.shutdown();
      fs.rmSync(deadLetterPath, { force: true });
    }
  });

  it('activate subscribes channels, installs patches, registers handlers, and starts lag measurement', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const sdk = createTestSDK();
    const collectSpy = vi.spyOn(sdk.processMetadata, 'collectStartupMetadata');
    const installSpy = vi.spyOn(sdk['httpServerRecorder'], 'install');
    const lagSpy = vi.spyOn(sdk.processMetadata, 'startEventLoopLagMeasurement');
    const subscribeSpy = vi.spyOn(sdk.channelSubscriber, 'subscribeAll');
    const patchSpy = vi.spyOn(sdk.patchManager, 'installAll');

    try {
      sdk.activate();

      expect(sdk.isActive()).toBe(true);
      // collectStartupMetadata is called in the constructor, not activate()
      expect(collectSpy).toHaveBeenCalledTimes(0);
      expect(installSpy).toHaveBeenCalledTimes(1);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(lagSpy).toHaveBeenCalledTimes(1);
      expect(onSpy.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining([
          'uncaughtException',
          'unhandledRejection',
          'beforeExit'
        ])
      );
    } finally {
      await sdk.shutdown();
    }
  });

  it('does not patch Server.prototype.emit until activate and restores fallback patch on shutdown', async () => {
    const originalEmit = Server.prototype.emit;
    const sdk = createTestSDK();

    try {
      expect(Server.prototype.emit).toBe(originalEmit);

      sdk.activate();
      // Post-fix (G2): emit-patch is always installed on activate, regardless
      // of whether bindStore is available — it is the mechanism that propagates
      // ALS to handlers registered via server.on('request', ...).
      expect(Server.prototype.emit).not.toBe(originalEmit);

      await sdk.shutdown();
      expect(Server.prototype.emit).toBe(originalEmit);
    } finally {
      if (sdk.isActive()) {
        await sdk.shutdown();
      }
    }
  });

  it('captureError delegates only when active', async () => {
    const sdk = createTestSDK();
    const captureSpy = vi.spyOn(sdk.errorCapturer, 'capture').mockReturnValue(null);

    try {
      sdk.captureError(new Error('inactive'));
      expect(captureSpy).not.toHaveBeenCalled();

      sdk.activate();
      sdk.captureError(new Error('active'));

      expect(captureSpy).toHaveBeenCalledTimes(1);
    } finally {
      await sdk.shutdown();
    }
  });

  it('shutdown is idempotent and tears down components in order', async () => {
    const removeListenerSpy = vi.spyOn(process, 'removeListener');
    const sdk = createTestSDK();
    const unsubscribeSpy = vi.spyOn(sdk.channelSubscriber, 'unsubscribeAll');
    const unwrapSpy = vi.spyOn(sdk.patchManager, 'unwrapAll');
    const inspectorSpy = vi.spyOn(sdk.inspector, 'shutdown');
    const flushSpy = vi.spyOn(sdk.transport, 'flush');
    const transportShutdownSpy = vi.spyOn(sdk.transport, 'shutdown');
    const clearSpy = vi.spyOn(sdk.buffer, 'clear');

    sdk.activate();
    unsubscribeSpy.mockClear();
    unwrapSpy.mockClear();
    inspectorSpy.mockClear();
    flushSpy.mockClear();
    transportShutdownSpy.mockClear();
    clearSpy.mockClear();

    await sdk.shutdown();
    await sdk.shutdown();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);
    expect(inspectorSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(transportShutdownSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalled();
    expect(sdk.isActive()).toBe(false);
  });

  it('init twice warns and returns existing instance, shutdown then init again works', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = init({ transport: { type: 'stdout' }, allowUnencrypted: true });

    const duplicate = init();

    expect(duplicate).toBe(first);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('already active');

    await shutdownFacade();

    const second = init({ transport: { type: 'stdout' }, allowUnencrypted: true });

    expect(first).not.toBe(second);
    await shutdownFacade();
  });

  it('keeps uncaughtException listener counts stable across shutdown and re-init', async () => {
    const baseline = process.listenerCount('uncaughtException');
    const first = init({ transport: { type: 'stdout' }, allowUnencrypted: true });
    const firstCount = process.listenerCount('uncaughtException');

    expect(firstCount).toBeGreaterThan(baseline);

    await shutdownFacade();

    const second = init({ transport: { type: 'stdout' }, allowUnencrypted: true });
    const secondCount = process.listenerCount('uncaughtException');

    expect(first).not.toBe(second);
    expect(secondCount).toBe(firstCount);

    await shutdownFacade();

    expect(process.listenerCount('uncaughtException')).toBe(baseline);
  });

  it('enableAutoShutdown registers signal handlers', async () => {
    const onceSpy = vi.spyOn(process, 'once');
    const sdk = createTestSDK();

    try {
      sdk.enableAutoShutdown();

      expect(onceSpy.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining(['SIGTERM', 'SIGINT'])
      );
    } finally {
      await sdk.shutdown();
    }
  });

  it('trackState facade warns and returns container when uninitialized, withContext facade passes through when absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = new Map();
    const result = trackStateFacade('cache', container);

    expect(result).toBe(container);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('before init()');
    warnSpy.mockRestore();

    expect(withContextFacade(() => 'value')).toBe('value');

    const sdk = init({ transport: { type: 'stdout' }, allowUnencrypted: true });

    try {
      const tracked = trackStateFacade('cache', new Map([['a', 1]]));
      const result = withContextFacade(() => tracked.get('a'));

      expect(result).toBe(1);
      expect(sdk.isActive()).toBe(true);
    } finally {
      await shutdownFacade();
    }
  });

  it('keeps overlapping withContext branches isolated across async boundaries', async () => {
    const sdk = createTestSDK();
    const firstObserved: string[] = [];
    const secondObserved: string[] = [];

    try {
      const [firstId, secondId] = await Promise.all([
        sdk.withContext(async () => {
          const observe = () => {
            const requestId = sdk.als.getRequestId();
            expect(requestId).toBeDefined();
            firstObserved.push(requestId as string);
            return requestId as string;
          };

          const requestId = observe();
          await Promise.resolve();
          observe();
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              observe();
              resolve();
            }, 5);
          });
          observe();
          return requestId;
        }),
        sdk.withContext(async () => {
          const observe = () => {
            const requestId = sdk.als.getRequestId();
            expect(requestId).toBeDefined();
            secondObserved.push(requestId as string);
            return requestId as string;
          };

          const requestId = observe();
          await Promise.resolve();
          observe();
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              observe();
              resolve();
            }, 0);
          });
          observe();
          return requestId;
        })
      ]);

      expect(firstId).not.toBe(secondId);
      expect(firstObserved).toEqual([firstId, firstId, firstId, firstId]);
      expect(secondObserved).toEqual([secondId, secondId, secondId, secondId]);
      expect(firstObserved).not.toContain(secondId);
      expect(secondObserved).not.toContain(firstId);
      expect(sdk.als.getRequestId()).toBeUndefined();
    } finally {
      await sdk.shutdown();
    }
  });

  it('supports a full init -> capture -> shutdown cycle through the public API', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    const sdk = init({
      transport: { type: 'stdout' },
      allowUnencrypted: true
    });

    try {
      const captureSpy = vi.spyOn(sdk.errorCapturer, 'capture');

      captureErrorFacade(new Error('integration-boom'));

      expect(captureSpy).toHaveBeenCalledTimes(1);
    } finally {
      await shutdownFacade();
    }

    expect(stdoutWrite).toHaveBeenCalled();
    expect(createSDKFacade).toBeDefined();
  });
});
