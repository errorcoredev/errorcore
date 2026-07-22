import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveConfig,
  detectServerlessEnvironment,
  resolveModeState,
  __resetLegacyInsecureTransportWarning
} from '../../src/config';
import { defaultPolicy } from '../../src/scrubber/policy';
import type {
  CaptureErrorOptions,
  CaptureMode,
  ModeState,
  ModeSwitchResult,
  AdaptiveCaptureConfig,
  ErrorInfo,
  ErrorPackage,
  IOEventSerialized,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  SerializationLimits,
  StateReadSerialized,
  TransportConfig
} from '../../src/types';
import { resolveTestConfig } from '../helpers/test-config';

describe('resolveConfig', () => {
  it('resolves hot-swappable ModeState for the full mode chain', () => {
    const base = resolveTestConfig({
      captureMode: 'safe',
      captureLocalVariables: false,
      captureDbBindParams: true,
      captureBody: true,
      captureBodyDigest: true,
      payloadSpool: { enabled: true },
      useWorkerAssembly: true,
      flushIntervalMs: 2000,
      resolveSourceMaps: false
    });

    const safe = resolveModeState(base.userConfig, base, 'safe');
    const forensic = resolveModeState(base.userConfig, base, 'forensic');
    const fast = resolveModeState(base.userConfig, base, 'fast');
    const balanced = resolveModeState(base.userConfig, base, 'balanced');
    const safeAgain = resolveModeState(base.userConfig, base, 'safe');

    expect(safe.captureMode).toBe('safe');
    expect(safe.captureLocalVariables).toBe(false);
    expect(safe.captureDbBindParams).toBe(true);
    expect(safe.captureRequestBodies).toBe(true);
    expect(safe.captureResponseBodies).toBe(true);
    expect(safe.captureBodyDigest).toBe(true);
    expect(safe.payloadSpool.enabled).toBe(true);
    expect(safe.useWorkerAssembly).toBe(true);
    expect(safe.flushIntervalMs).toBe(2000);
    expect(safe.resolveSourceMaps).toBe(false);
    expect(safe.capabilities.deferredDelivery).toBe(false);

    expect(forensic.captureMode).toBe('forensic');
    expect(forensic.localVariablesMode).toBe('none');
    expect(forensic.maxLocalsFrames).toBe(10);
    expect(forensic.recorders.database).toBe(true);
    expect(forensic.capabilities.materializeBodies).toBe(true);

    expect(fast.captureMode).toBe('fast');
    expect(fast.captureLocalVariables).toBe(false);
    expect(fast.captureDbBindParams).toBe(false);
    expect(fast.captureRequestBodies).toBe(false);
    expect(fast.captureResponseBodies).toBe(false);
    expect(fast.captureBodyDigest).toBe(false);
    expect(fast.payloadSpool.enabled).toBe(false);
    expect(fast.useWorkerAssembly).toBe(false);
    expect(fast.flushIntervalMs).toBe(0);
    expect(fast.resolveSourceMaps).toBe(false);

    expect(balanced.captureDbBindParams).toBe(true);
    expect(balanced.captureRequestBodies).toBe(true);
    expect(balanced.payloadSpool.enabled).toBe(true);
    expect(safeAgain).toEqual(safe);
  });

  it('uses fast hard-forced fields only while the active ModeState is fast', () => {
    const base = resolveTestConfig({
      captureMode: 'safe',
      captureLocalVariables: true,
      captureDbBindParams: true,
      captureRequestBodies: true,
      captureResponseBodies: true,
      captureBodyDigest: true,
      payloadSpool: { enabled: true },
      useWorkerAssembly: true,
      flushIntervalMs: 3000,
      resolveSourceMaps: true
    });

    const fast = resolveModeState(base.userConfig, base, 'fast');
    const forensic = resolveModeState(base.userConfig, base, 'forensic');

    expect(fast).toMatchObject({
      captureLocalVariables: false,
      captureDbBindParams: false,
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureBodyDigest: false,
      useWorkerAssembly: false,
      flushIntervalMs: 0,
      resolveSourceMaps: false
    });
    expect(fast.payloadSpool.enabled).toBe(false);

    expect(forensic).toMatchObject({
      captureLocalVariables: true,
      captureDbBindParams: true,
      captureRequestBodies: true,
      captureResponseBodies: true,
      captureBodyDigest: true,
      useWorkerAssembly: true,
      flushIntervalMs: 3000,
      resolveSourceMaps: true
    });
    expect(forensic.payloadSpool.enabled).toBe(true);
  });

  it('resolves adaptive capture defaults and warns when captureMode is also provided', () => {
    const warnings: string[] = [];
    const resolved = resolveTestConfig({
      captureMode: 'balanced',
      adaptiveCapture: { enabled: true },
      onInternalWarning: (warning) => warnings.push(warning.code)
    });

    expect(resolved.captureMode).toBe('safe');
    expect(resolved.modeState.captureMode).toBe('safe');
    expect(resolved.adaptiveCapture).toEqual({
      enabled: true,
      base: 'safe',
      escalated: 'forensic',
      deescalateAfterMs: 120000,
      minDwellMs: 10000,
      maxSwitchesPerHour: 60
    });
    expect(warnings).toEqual(['EC_ADAPTIVE_CAPTURE_OVERRIDES_MODE']);
  });

  it('validates adaptive capture modes and timing knobs', () => {
    expect(() =>
      resolveTestConfig({ adaptiveCapture: { enabled: true, base: 'fast', escalated: 'fast' } })
    ).toThrow(/adaptiveCapture.escalated/);
    expect(() =>
      resolveTestConfig({ adaptiveCapture: { enabled: true, deescalateAfterMs: 0 } })
    ).toThrow(/adaptiveCapture.deescalateAfterMs/);
    expect(() =>
      resolveTestConfig({ adaptiveCapture: { enabled: true, maxSwitchesPerHour: -1 } })
    ).toThrow(/adaptiveCapture.maxSwitchesPerHour/);
  });

  it('resolves fast mode for explicit-context low-overhead capture', () => {
    const resolved = resolveTestConfig({ captureMode: 'fast' });

    expect(resolved.captureMode).toBe('fast');
    expect(resolved.captureLocalVariables).toBe(false);
    expect(resolved.captureDbBindParams).toBe(false);
    expect(resolved.captureRequestBodies).toBe(false);
    expect(resolved.captureResponseBodies).toBe(false);
    expect(resolved.captureBodyDigest).toBe(false);
    expect(resolved.resolveSourceMaps).toBe(false);
    expect(resolved.useWorkerAssembly).toBe(false);
    expect(resolved.flushIntervalMs).toBe(0);
    expect(resolved.payloadSpool.enabled).toBe(false);
    expect(resolved.recorders).toEqual({
      httpServer: false,
      httpClient: false,
      undici: false,
      fetch: false,
      netDns: false,
      database: false,
      processHandlers: false,
      transport: true
    });
  });

  it('re-axes mode defaults: safe is the low-overhead default with locals on', () => {
    const safe = resolveTestConfig({ captureMode: 'safe' });
    const balanced = resolveTestConfig({ captureMode: 'balanced' });
    const forensic = resolveTestConfig({ captureMode: 'forensic' });

    // safe: fast chassis + inbound recorder + process handlers + shallow locals
    expect(safe.captureLocalVariables).toBe(true);
    expect(safe.localVariablesMode).toBe('shallow');
    expect(safe.captureDbBindParams).toBe(false);
    expect(safe.captureRequestBodies).toBe(false);
    expect(safe.captureResponseBodies).toBe(false);
    expect(safe.captureBodyDigest).toBe(false);
    expect(safe.resolveSourceMaps).toBe(true);
    expect(safe.useWorkerAssembly).toBe(false);
    expect(safe.payloadSpool.enabled).toBe(false);
    expect(safe.flushIntervalMs).toBe(5000);
    // The July 2026 capture-mode bench decomposition measured the standing
    // http-server recorder at ~20 points of throughput overhead — the
    // single dominant cost — while middleware, locals, and the remaining
    // recorders were within noise. Safe therefore runs NO standing
    // recorders; the inbound event is synthesized from the ALS request
    // context at capture time.
    expect(safe.recorders).toEqual({
      httpServer: false,
      httpClient: false,
      undici: false,
      fetch: false,
      netDns: false,
      database: false,
      processHandlers: true,
      transport: true
    });

    // balanced/forensic keep the full standing pipeline
    for (const resolved of [balanced, forensic]) {
      expect(resolved.captureLocalVariables).toBe(true);
      expect(resolved.useWorkerAssembly).toBe(true);
      expect(resolved.payloadSpool.enabled).toBe(true);
      expect(resolved.recorders.httpClient).toBe(true);
      expect(resolved.recorders.database).toBe(true);
    }
    expect(balanced.localVariablesMode).toBe('shallow');
    expect(forensic.localVariablesMode).toBe('deep');
    expect(forensic.captureRequestBodies).toBe(true);
  });

  it('user overrides still beat safe mode defaults', () => {
    const resolved = resolveTestConfig({
      captureMode: 'safe',
      captureLocalVariables: false,
      useWorkerAssembly: true
    });

    expect(resolved.captureLocalVariables).toBe(false);
    expect(resolved.localVariablesMode).toBe('none');
    expect(resolved.useWorkerAssembly).toBe(true);
  });

  it('rejects invalid capture modes', () => {
    expect(() =>
      resolveTestConfig({ captureMode: 'paranoid' as never })
    ).toThrow('captureMode');
  });

  describe('capture capabilities', () => {
    it('derives the low-overhead chassis for fast and safe', () => {
      const fast = resolveTestConfig({ captureMode: 'fast' });
      const safe = resolveTestConfig({ captureMode: 'safe' });

      for (const resolved of [fast, safe]) {
        expect(resolved.capabilities.deferredDelivery).toBe(true);
        expect(resolved.capabilities.materializeBodies).toBe(false);
        expect(resolved.capabilities.syntheticInboundFallback).toBe(true);
      }
      expect(fast.capabilities.eventLoopLagMonitor).toBe(false);
      expect(safe.capabilities.eventLoopLagMonitor).toBe(true);
    });

    it('derives in-window delivery for the standing-pipeline modes', () => {
      const balanced = resolveTestConfig({ captureMode: 'balanced' });
      const forensic = resolveTestConfig({ captureMode: 'forensic' });

      for (const resolved of [balanced, forensic]) {
        expect(resolved.capabilities.deferredDelivery).toBe(false);
        expect(resolved.capabilities.syntheticInboundFallback).toBe(false);
        expect(resolved.capabilities.eventLoopLagMonitor).toBe(true);
      }
      // Body materialization follows the body-capture flags, not the mode:
      // balanced captures no bodies by default, forensic captures everything.
      expect(balanced.capabilities.materializeBodies).toBe(false);
      expect(forensic.capabilities.materializeBodies).toBe(true);
    });

    it('explicit useWorkerAssembly opts safe back into in-window delivery', () => {
      const resolved = resolveTestConfig({ captureMode: 'safe', useWorkerAssembly: true });
      expect(resolved.capabilities.deferredDelivery).toBe(false);
    });

    it('enabling body capture on balanced turns materialization on', () => {
      const resolved = resolveTestConfig({ captureMode: 'balanced', captureBody: true });
      expect(resolved.capabilities.materializeBodies).toBe(true);
    });
  });

  describe('localsGuard resolution', () => {
    it('defaults to enabled with 50 pauses/sec and 250ms/min when locals are on', () => {
      const resolved = resolveTestConfig({ captureMode: 'safe' });
      expect(resolved.localsGuard).toEqual({
        enabled: true,
        maxPausesPerSecond: 50,
        maxPauseMsPerMinute: 250
      });
    });

    it('is disabled when locals are off', () => {
      const resolved = resolveTestConfig({ captureMode: 'fast' });
      expect(resolved.localsGuard.enabled).toBe(false);
    });

    it("'off' keeps locals armed regardless of pause load", () => {
      const resolved = resolveTestConfig({ captureMode: 'safe', localsGuard: 'off' });
      expect(resolved.localsGuard.enabled).toBe(false);
      expect(resolved.captureLocalVariables).toBe(true);
    });

    it('accepts custom thresholds and validates them', () => {
      const resolved = resolveTestConfig({
        captureMode: 'safe',
        localsGuard: { maxPausesPerSecond: 10, maxPauseMsPerMinute: 100 }
      });
      expect(resolved.localsGuard).toEqual({
        enabled: true,
        maxPausesPerSecond: 10,
        maxPauseMsPerMinute: 100
      });

      expect(() =>
        resolveTestConfig({ localsGuard: { maxPausesPerSecond: 0 } })
      ).toThrow(/localsGuard.maxPausesPerSecond/);
      expect(() =>
        resolveTestConfig({ localsGuard: { maxPauseMsPerMinute: -5 } })
      ).toThrow(/localsGuard.maxPauseMsPerMinute/);
    });
  });

  it('returns the full default configuration when transport is explicit', () => {
    const resolved = resolveTestConfig();

    expect(resolved).toEqual({
      captureMode: 'safe',
      localVariablesMode: 'shallow',
      capabilities: {
        deferredDelivery: true,
        materializeBodies: false,
        syntheticInboundFallback: true,
        eventLoopLagMonitor: true
      },
      recorders: {
        httpServer: false,
        httpClient: false,
        undici: false,
        fetch: false,
        netDns: false,
        database: false,
        processHandlers: true,
        transport: true
      },
      modeState: {
        captureMode: 'safe',
        localVariablesMode: 'shallow',
        capabilities: {
          deferredDelivery: true,
          materializeBodies: false,
          syntheticInboundFallback: true,
          eventLoopLagMonitor: true
        },
        recorders: {
          httpServer: false,
          httpClient: false,
          undici: false,
          fetch: false,
          netDns: false,
          database: false,
          processHandlers: true,
          transport: true
        },
        captureLocalVariables: true,
        localsGuard: {
          enabled: true,
          maxPausesPerSecond: 50,
          maxPauseMsPerMinute: 250
        },
        captureDbBindParams: false,
        captureRequestBodies: false,
        captureResponseBodies: false,
        captureBody: false,
        captureBodyDigest: false,
        payloadSpool: {
          enabled: false,
          globalMaxBytes: 64 * 1024 * 1024,
          perRequestMaxBytes: 2 * 1024 * 1024,
          perBlobMaxBytes: 512 * 1024,
          previewBytes: 8 * 1024,
          completedTtlMs: 60000
        },
        useWorkerAssembly: false,
        flushIntervalMs: 5000,
        resolveSourceMaps: true,
        maxLocalsCollectionsPerSecond: 20,
        maxCachedLocals: 50,
        maxLocalsFrames: 5,
        maxLocalsObjectProperties: 8
      },
      adaptiveCapture: {
        enabled: false,
        base: 'safe',
        escalated: 'forensic',
        deescalateAfterMs: 120000,
        minDwellMs: 10000,
        maxSwitchesPerHour: 60
      },
      userConfig: {},
      bufferSize: 200,
      bufferMaxBytes: 52428800,
      maxPayloadSize: 32768,
      maxConcurrentRequests: 50,
      rateLimitPerMinute: 60,
      rateLimitWindowMs: 60000,
      headerAllowlist: [
        'content-type',
        'content-length',
        'accept',
        'accept-encoding',
        'user-agent',
        'x-request-id',
        'x-correlation-id',
        'host',
        'traceparent',
        'tracestate',
        'idempotency-key',
        'x-idempotency-key',
        'etag',
        'if-match',
        'if-none-match',
        'if-modified-since',
        'if-unmodified-since',
        'range',
        'content-range',
        'vary',
        'retry-after',
        'cache-control'
      ],
      headerBlocklist: [
        /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-refresh-token|x-csrf-token|x-secret-token)$/i,
        /\b(api|auth|access|secret|session|bearer|private|client|refresh)[-_]?(key|token|secret|password)\b/i,
        /\b(passwords?|passwd|credentials?)\b/i
      ],
      envAllowlist: [
        'NODE_ENV',
        'NODE_VERSION',
        'PORT',
        'HOST',
        'TZ',
        'LANG',
        'npm_package_version',
        'HOSTNAME',
        'POD_NAME',
        'POD_NAMESPACE',
        'POD_IP',
        'NODE_NAME',
        'KUBERNETES_SERVICE_HOST',
        'ECS_CONTAINER_METADATA_URI',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
        'CLOUD_RUN_JOB',
        'K_SERVICE',
        'K_REVISION',
        'RENDER_SERVICE_NAME',
        'FLY_APP_NAME',
        'FLY_REGION',
        'DEPLOYMENT_ID',
        'IMAGE_TAG',
        'REPLICA_SET'
      ],
      envBlocklist: [/key|secret|token|password|passcode|passphrase|passwd|credential|auth|private/i],
      encryptionKey: undefined,
      macKey: undefined,
      encryptionKeyCallback: undefined,
      previousEncryptionKeys: [],
      previousTransportAuthorizations: [],
      allowUnencrypted: true, // set explicitly by resolveTestConfig
      allowProductionPlaintext: false,
      hardCapBytes: 1_048_576,
      transport: { type: 'stdout' },
      captureLocalVariables: true,
      localsGuard: {
        enabled: true,
        maxPausesPerSecond: 50,
        maxPauseMsPerMinute: 250
      },
      captureDbBindParams: false,
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureBody: false,
      captureBodyDigest: false,
      bodyCaptureContentTypes: [
        'application/json',
        'application/x-www-form-urlencoded',
        'text/plain',
        'application/xml'
      ],
      piiScrubber: undefined,
      replaceDefaultScrubber: false,
      scrubberPolicy: defaultPolicy,
      serialization: {
        maxDepth: 8,
        maxArrayItems: 20,
        maxObjectKeys: 50,
        maxStringLength: 2048,
        maxPayloadSize: 32768,
        maxTotalPackageSize: 5242880
      },
      maxLocalsCollectionsPerSecond: 20,
      maxCachedLocals: 50,
      maxLocalsFrames: 5,
      uncaughtExceptionExitDelayMs: 1500,
      allowPlainHttpTransport: false,
      allowInvalidCollectorCertificates: false,
      deadLetterPath: undefined,
      deadLetterMaxBytes: 50 * 1024 * 1024,
      deadLetterMaxBackups: 5,
      maxDrainOnStartup: 100,
      useWorkerAssembly: false,
      flushIntervalMs: 5000,
      resolveSourceMaps: true,
      serverless: false,
      payloadSpool: {
        enabled: false,
        globalMaxBytes: 64 * 1024 * 1024,
        perRequestMaxBytes: 2 * 1024 * 1024,
        perBlobMaxBytes: 512 * 1024,
        previewBytes: 8 * 1024,
        completedTtlMs: 60000
      },
      onInternalWarning: undefined,
      drivers: {},
      silent: false,
      logLevel: 'warn',
      sourceMapSyncThresholdBytes: 2 * 1024 * 1024,
      captureMiddlewareStatusCodes: 'none',
      traceContext: { vendorKey: 'ec' },
      stateTracking: { captureWrites: true, maxWritesPerContext: 50 },
      service: 'errorcore',
      deploymentEnv: undefined
    });
  });

  it('accepts user overrides for traceContext.vendorKey and stateTracking', () => {
    const resolved = resolveTestConfig({
      traceContext: { vendorKey: 'errorcore' },
      stateTracking: { captureWrites: false, maxWritesPerContext: 100 }
    });
    expect(resolved.traceContext).toEqual({ vendorKey: 'errorcore' });
    expect(resolved.stateTracking).toEqual({
      captureWrites: false,
      maxWritesPerContext: 100
    });
  });

  it('accepts scrubberPolicy overrides', () => {
    const detector = (value: unknown) => value === 'pii';
    const credentialNames = /private/i;
    const resolved = resolveTestConfig({
      scrubberPolicy: {
        credentialNames,
        piiDetectors: [detector],
        maxKeys: 4,
        spoolBytes: 16,
        maxField: 128
      }
    });

    expect(resolved.scrubberPolicy).toEqual({
      credentialNames,
      piiDetectors: [detector],
      maxKeys: 4,
      spoolBytes: 16,
      maxField: 128
    });
  });

  it('rejects invalid scrubberPolicy values', () => {
    expect(() =>
      resolveTestConfig({ scrubberPolicy: { credentialNames: 'private' as never } })
    ).toThrow('scrubberPolicy.credentialNames must be a RegExp');
    expect(() =>
      resolveTestConfig({ scrubberPolicy: { piiDetectors: [true as never] } })
    ).toThrow('scrubberPolicy.piiDetectors must be an array of functions');
    expect(() =>
      resolveTestConfig({ scrubberPolicy: { maxKeys: 0 } })
    ).toThrow('scrubberPolicy.maxKeys must be a positive integer');
  });

  it('rejects invalid traceContext.vendorKey', () => {
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: 'EC' } })
    ).toThrow('traceContext.vendorKey must match');
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: '' } })
    ).toThrow('traceContext.vendorKey must match');
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: 'has space' } })
    ).toThrow('traceContext.vendorKey must match');
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: 'a'.repeat(257) } })
    ).toThrow('traceContext.vendorKey must match');
    // Valid: lowercase, digits, hyphen, underscore, asterisk, slash
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: 'errorcore' } })
    ).not.toThrow();
    expect(() =>
      resolveTestConfig({ traceContext: { vendorKey: 'a-b_c*d/e' } })
    ).not.toThrow();
  });

  it('rejects invalid stateTracking config', () => {
    expect(() =>
      // @ts-expect-error runtime validation
      resolveTestConfig({ stateTracking: { captureWrites: 'yes' } })
    ).toThrow('stateTracking.captureWrites must be a boolean');
    expect(() =>
      resolveTestConfig({ stateTracking: { maxWritesPerContext: -1 } })
    ).toThrow('stateTracking.maxWritesPerContext');
    expect(() =>
      resolveTestConfig({ stateTracking: { maxWritesPerContext: 1.5 } })
    ).toThrow('stateTracking.maxWritesPerContext');
    // 0 is valid (caps writes off entirely while keeping captureWrites=true)
    expect(() =>
      resolveTestConfig({ stateTracking: { maxWritesPerContext: 0 } })
    ).not.toThrow();
  });

  it('merges user config over defaults', () => {
    const resolved = resolveTestConfig({
      bufferSize: 500,
      captureBody: false,
      captureBodyDigest: true,
      bodyCaptureContentTypes: ['application/json'],
      serialization: { maxDepth: 4 },
      transport: { type: 'file', path: '/tmp/errorcore.log' }
    });

    expect(resolved.bufferSize).toBe(500);
    expect(resolved.captureBody).toBe(false);
    expect(resolved.captureRequestBodies).toBe(false);
    expect(resolved.captureResponseBodies).toBe(false);
    expect(resolved.captureBodyDigest).toBe(true);
    expect(resolved.bodyCaptureContentTypes).toEqual(['application/json']);
    expect(resolved.serialization).toEqual({
      maxDepth: 4,
      maxArrayItems: 20,
      maxObjectKeys: 50,
      maxStringLength: 2048,
      maxPayloadSize: 32768,
      maxTotalPackageSize: 5242880
    });
    expect(resolved.transport).toEqual({ type: 'file', path: '/tmp/errorcore.log' });
  });

  it('rejects invalid numeric values with descriptive errors', () => {
    expect(() => resolveTestConfig({ bufferSize: 0 })).toThrow(
      'bufferSize must be a positive integer'
    );
    expect(() => resolveTestConfig({ bufferSize: 9 })).toThrow(
      'bufferSize must be between 10 and 100000'
    );
    expect(() => resolveTestConfig({ bufferMaxBytes: 1048575 })).toThrow(
      'bufferMaxBytes must be at least 1048576'
    );
    expect(() => resolveTestConfig({ maxPayloadSize: 1023 })).toThrow(
      'maxPayloadSize must be at least 1024'
    );
    expect(() =>
      resolveTestConfig({ bufferMaxBytes: 1048576, maxPayloadSize: 1048577 })
    ).toThrow('maxPayloadSize must be less than or equal to bufferMaxBytes');
    expect(() =>
      resolveTestConfig({ serialization: { maxArrayItems: 0 } })
    ).toThrow('serialization.maxArrayItems must be a positive integer');
  });

  it('rejects invalid encryptionKey', () => {
    expect(() => resolveTestConfig({ encryptionKey: 'tooshort' })).toThrow(
      'encryptionKey must be a 64-character hex string'
    );
    expect(() => resolveTestConfig({ encryptionKey: 'zz' + 'a'.repeat(62) })).toThrow(
      'encryptionKey must be a 64-character hex string'
    );
    const validKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    expect(() =>
      resolveTestConfig({ encryptionKey: validKey })
    ).not.toThrow();
  });

  it('rejects low-diversity encryptionKey', () => {
    expect(() => resolveTestConfig({ encryptionKey: '0'.repeat(64) })).toThrow(
      'insufficient character diversity'
    );
    expect(() => resolveTestConfig({ encryptionKey: 'a'.repeat(64) })).toThrow(
      'insufficient character diversity'
    );
    expect(() => resolveTestConfig({ encryptionKey: 'ab'.repeat(32) })).toThrow(
      'insufficient character diversity'
    );
    const randomKey = require('node:crypto').randomBytes(32).toString('hex');
    expect(() => resolveTestConfig({ encryptionKey: randomKey })).not.toThrow();
  });

  it('rejects non-function piiScrubber', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ piiScrubber: 'not-a-function' })
    ).toThrow('piiScrubber must be a function or undefined');
    expect(() =>
      resolveTestConfig({ piiScrubber: (_k: string, v: unknown) => v })
    ).not.toThrow();
  });

  it('rejects non-string-array headerAllowlist and envAllowlist', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ headerAllowlist: [123] })
    ).toThrow('headerAllowlist must be an array of strings');
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ envAllowlist: [/regex/] })
    ).toThrow('envAllowlist must be an array of strings');
    expect(() =>
      resolveTestConfig({ headerAllowlist: ['x-custom'] })
    ).not.toThrow();
  });

  it('rejects non-RegExp-array headerBlocklist and envBlocklist', () => {
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ headerBlocklist: ['not-a-regexp'] })
    ).toThrow('headerBlocklist must be an array of RegExp');
    expect(() =>
      // @ts-expect-error testing runtime validation
      resolveTestConfig({ envBlocklist: [42] })
    ).toThrow('envBlocklist must be an array of RegExp');
    expect(() =>
      resolveTestConfig({ headerBlocklist: [/secret/i] })
    ).not.toThrow();
  });

  it('keeps the default header blocklist effective even when allowlisted', () => {
    const resolved = resolveTestConfig({
      headerAllowlist: ['authorization', 'content-type']
    });

    expect(resolved.headerAllowlist).toContain('authorization');
    expect(
      resolved.headerBlocklist.some((pattern) => pattern.test('authorization'))
    ).toBe(true);
  });

  it('blocks PASS-style environment names by default', () => {
    const resolved = resolveTestConfig();

    for (const name of ['PASSWORD', 'PASSCODE', 'PASSPHRASE', 'PASSWD']) {
      expect(
        resolved.envBlocklist.some((pattern) => pattern.test(name))
      ).toBe(true);
    }
  });

  it('ignores unknown keys', () => {
    const resolved = resolveTestConfig({
      bufferSize: 250,
      // @ts-expect-error verifying unknown keys are ignored at runtime
      unknownKey: 'ignored'
    });

    expect(resolved.bufferSize).toBe(250);
    expect('unknownKey' in resolved).toBe(false);
  });

  it('accepts HTTP transport with a valid https:// URL', () => {
    const resolved = resolveTestConfig({
      transport: {
        type: 'http',
        url: 'https://example.com/collect',
        authorization: 'Bearer secret-token'
      }
    });
    expect(resolved.transport).toEqual({
      type: 'http',
      url: 'https://example.com/collect',
      protocol: 'auto'
    });
    expect(JSON.stringify(resolved)).not.toContain('secret-token');
  });

  it('accepts webhook transport and resolves batching defaults', () => {
    const resolved = resolveTestConfig({
      transport: {
        type: 'webhook',
        url: 'https://example.com/errorcore',
        secret: 'webhook-secret'
      }
    });

    expect(resolved.transport).toEqual({
      type: 'webhook',
      url: 'https://example.com/errorcore',
      batchSize: 100,
      maxDelayMs: 10_000,
      retries: 5,
      timeoutMs: 5_000,
      maxBufferEvents: 1_000,
      storePath: path.join(process.cwd(), '.errorcore', 'events.ndjson'),
      retainOnAck: true
    });
    expect(JSON.stringify(resolved)).not.toContain('webhook-secret');
  });

  it('validates webhook URL and numeric knobs', () => {
    expect(() =>
      resolveTestConfig({
        transport: { type: 'webhook', url: 'http://example.com/hook' }
      })
    ).toThrow('Webhook transport requires an https:// URL');

    expect(() =>
      resolveTestConfig({
        transport: {
          type: 'webhook',
          url: 'https://example.com/hook',
          batchSize: 0
        }
      })
    ).toThrow('transport.batchSize must be a positive integer');
  });

  it('requires transport to be configured explicitly in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => resolveConfig({})).toThrow('transport must be configured explicitly');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('defaults to stdout transport in non-production', () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const resolved = resolveConfig({});
      expect(resolved.transport).toEqual({ type: 'stdout' });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('uses the split HTTP transport flags', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'http', url: 'http://example.com/collect' }
      })
    ).toThrow('allowPlainHttpTransport');

    expect(
      resolveConfig({
        transport: { type: 'http', url: 'http://example.com/collect' },
        allowPlainHttpTransport: true,
        allowInvalidCollectorCertificates: true
      })
    ).toMatchObject({
      allowPlainHttpTransport: true,
      allowInvalidCollectorCertificates: true
    });
  });

  it('defaults allowUnencrypted to !isProduction() so zero-config dev works', () => {
    // Mirrors the transport default on the same code path: NODE_ENV !==
    // 'production' gets stdout + plaintext, NODE_ENV === 'production'
    // requires an explicit encryptionKey. Any divergence from the transport
    // default breaks the README's documented zero-config dev contract.
    const cases: Array<[string | undefined, boolean]> = [
      ['production', false],
      ['prod', true],
      ['PRODUCTION', true],
      ['development', true],
      [undefined, true],
    ];
    for (const [value, expected] of cases) {
      const prev = process.env.NODE_ENV;
      if (value === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = value;
      }
      try {
        const resolved = resolveConfig({ transport: { type: 'stdout' } });
        expect(resolved.allowUnencrypted).toBe(expected);
      } finally {
        process.env.NODE_ENV = prev;
      }
    }
  });

  it('rejects low-diversity encryption keys that previously scraped by with entropy >= 2', () => {
    // Four distinct hex chars equally distributed scores entropy 2.0, which
    // passed the old threshold but is clearly not a random key.
    const weakFourChar = '0123'.repeat(16);
    expect(() => resolveTestConfig({ encryptionKey: weakFourChar })).toThrow(
      'insufficient character diversity'
    );
  });

  it('ships a production-oriented config template', () => {
    const template = fs.readFileSync(
      path.join(process.cwd(), 'config-template', 'errorcore.config.js'),
      'utf8'
    );

    expect(template).toContain('allowUnencrypted: true');
    expect(template).toContain('allowPlainHttpTransport: false');
    expect(template).toContain('allowInvalidCollectorCertificates: false');
    expect(template).not.toContain("'multipart/form-data'");
    expect(template).not.toMatch(/^\s*transport:\s*\{\s*type:\s*'stdout'/m);
    expect(template).toContain('captureRequestBodies: false');
    expect(template).toContain('captureResponseBodies: false');
    expect(template).not.toMatch(/^\s*headerAllowlist:\s*\[/m);
    expect(template).not.toMatch(/^\s*headerBlocklist:\s*\[/m);
    expect(template).toContain('deadLetterMaxBytes: 50 * 1024 * 1024');
    expect(template).toContain('previousTransportAuthorizations: []');
  });

  it('maps legacy captureBody to both request and response capture for compatibility', () => {
    const resolved = resolveTestConfig({
      captureBody: true
    });

    expect(resolved.captureBody).toBe(true);
    expect(resolved.captureRequestBodies).toBe(true);
    expect(resolved.captureResponseBodies).toBe(true);
  });

  it('prefers explicit request and response capture controls over the legacy alias', () => {
    const resolved = resolveTestConfig({
      captureBody: true,
      captureRequestBodies: true,
      captureResponseBodies: false
    });

    expect(resolved.captureBody).toBe(false);
    expect(resolved.captureRequestBodies).toBe(true);
    expect(resolved.captureResponseBodies).toBe(false);
  });

  it('does not treat generic AWS execution environments as Lambda serverless', () => {
    const previousAwsExecutionEnv = process.env.AWS_EXECUTION_ENV;
    const previousAwsLambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    try {
      process.env.AWS_EXECUTION_ENV = 'AWS_ECS_FARGATE';
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;

      expect(detectServerlessEnvironment()).toBe(false);
    } finally {
      if (previousAwsExecutionEnv === undefined) {
        delete process.env.AWS_EXECUTION_ENV;
      } else {
        process.env.AWS_EXECUTION_ENV = previousAwsExecutionEnv;
      }
      if (previousAwsLambdaFunctionName === undefined) {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      } else {
        process.env.AWS_LAMBDA_FUNCTION_NAME = previousAwsLambdaFunctionName;
      }
    }
  });

  it('treats Lambda-shaped AWS execution environments as serverless', () => {
    const previousAwsExecutionEnv = process.env.AWS_EXECUTION_ENV;
    const previousAwsLambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    try {
      process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;

      expect(detectServerlessEnvironment()).toBe(true);
    } finally {
      if (previousAwsExecutionEnv === undefined) {
        delete process.env.AWS_EXECUTION_ENV;
      } else {
        process.env.AWS_EXECUTION_ENV = previousAwsExecutionEnv;
      }
      if (previousAwsLambdaFunctionName === undefined) {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      } else {
        process.env.AWS_LAMBDA_FUNCTION_NAME = previousAwsLambdaFunctionName;
      }
    }
  });
});

describe('type exports', () => {
  it('exports the shared interfaces successfully', () => {
    const captureMode: CaptureMode = 'fast';
    const captureOptions: CaptureErrorOptions = {
      request: {
        method: 'GET',
        url: '/health',
        headers: { host: 'localhost' },
        statusCode: 200,
        bodyLength: 0,
        bodyHash: null
      }
    };
    const transportConfig: TransportConfig = { type: 'stdout' };
    const requestSummary: RequestSummary = {
      requestId: 'req-1',
      method: 'GET',
      url: '/health',
      startTime: '1'
    };
    const processMetadata: ProcessMetadata = {
      nodeVersion: 'v20.0.0',
      v8Version: '11.0',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      hostname: 'test-host',
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 1,
      activeRequests: 0,
      eventLoopLagMs: 0
    };
    const errorInfo: ErrorInfo = {
      type: 'Error',
      message: 'boom',
      stack: 'stack',
      properties: {}
    };
    const ioEvent: IOEventSerialized = {
      seq: 1,
      type: 'http-server',
      direction: 'inbound',
      target: 'service',
      method: 'GET',
      url: '/health',
      statusCode: 200,
      fd: null,
      requestId: 'req-1',
      contextLost: false,
      startTime: '1',
      endTime: '2',
      durationMs: 1,
      requestHeaders: { host: 'localhost' },
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyTruncated: false,
      responseBodyTruncated: false,
      requestBodyOriginalSize: null,
      responseBodyOriginalSize: null,
      error: null,
      aborted: false
    };
    const stateRead: StateReadSerialized = {
      container: 'cache',
      operation: 'get',
      key: 'user:1',
      value: { id: 1 },
      timestamp: '1'
    };
    const limits: SerializationLimits = {
      maxDepth: 1,
      maxArrayItems: 1,
      maxObjectKeys: 1,
      maxStringLength: 1,
      maxPayloadSize: 1024,
      maxTotalPackageSize: 1024
    };
    const resolved: ResolvedConfig = resolveTestConfig();
    const errorPackage: ErrorPackage = {
      schemaVersion: '1.1.0',
      capturedAt: '2026-01-01T00:00:00.000Z',
      error: {
        type: errorInfo.type,
        message: errorInfo.message,
        stack: errorInfo.stack,
        properties: errorInfo.properties
      },
      ioTimeline: [ioEvent],
      stateReads: [stateRead],
      concurrentRequests: [requestSummary],
      processMetadata,
      codeVersion: {},
      environment: {},
      completeness: {
        modeAtCapture: 'safe',
        requestCaptured: false,
        requestBodyTruncated: false,
        ioTimelineCaptured: true,
        ioEventsDropped: 0,
        ioPayloadsTruncated: 0,
        alsContextAvailable: false,
        localVariablesCaptured: false,
        localVariablesTruncated: false,
        stateTrackingEnabled: false,
        stateReadsCaptured: false,
        concurrentRequestsCaptured: false,
        piiScrubbed: true,
        encrypted: false,
        captureFailures: []
      }
    };

    expect(captureMode).toBe('fast');
    const modeState: ModeState = resolved.modeState;
    const modeSwitchResult: ModeSwitchResult = {
      from: 'safe',
      to: 'forensic',
      appliedInMs: 1,
      changed: ['captureDbBindParams']
    };
    const adaptive: AdaptiveCaptureConfig = {
      enabled: true,
      base: 'safe',
      escalated: 'forensic'
    };
    expect(modeState.captureMode).toBe('safe');
    expect(modeSwitchResult.changed).toEqual(['captureDbBindParams']);
    expect(adaptive.base).toBe('safe');
    expect(captureOptions.request?.url).toBe('/health');
    expect(transportConfig.type).toBe('stdout');
    expect(requestSummary.requestId).toBe('req-1');
    expect(processMetadata.pid).toBe(1);
    expect(errorPackage.schemaVersion).toBe('1.1.0');
    expect(limits.maxPayloadSize).toBe(1024);
    expect(resolved.transport.type).toBe('stdout');
  });
});

describe('0.2.0 config surface', () => {
  it('accepts drivers with per-driver references', () => {
    const fakePg = { Client: { prototype: {} } };
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      drivers: { pg: fakePg }
    });
    expect(resolved.drivers.pg).toBe(fakePg);
    expect(resolved.drivers.mongodb).toBeUndefined();
  });

  it('defaults drivers to empty object when omitted', () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true
    });
    expect(resolved.drivers).toEqual({});
  });

  it('defaults silent=false, sourceMapSyncThresholdBytes=2MB, captureMiddlewareStatusCodes=none', () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true
    });
    expect(resolved.silent).toBe(false);
    expect(resolved.sourceMapSyncThresholdBytes).toBe(2 * 1024 * 1024);
    expect(resolved.captureMiddlewareStatusCodes).toBe('none');
  });

  it('accepts captureMiddlewareStatusCodes as all, none, or integer array', () => {
    const all = resolveConfig({ transport: { type: 'stdout' }, allowUnencrypted: true, captureMiddlewareStatusCodes: 'all' });
    const none = resolveConfig({ transport: { type: 'stdout' }, allowUnencrypted: true, captureMiddlewareStatusCodes: 'none' });
    const arr = resolveConfig({ transport: { type: 'stdout' }, allowUnencrypted: true, captureMiddlewareStatusCodes: [401, 500] });
    expect(all.captureMiddlewareStatusCodes).toBe('all');
    expect(none.captureMiddlewareStatusCodes).toBe('none');
    expect(arr.captureMiddlewareStatusCodes).toEqual([401, 500]);
  });

  it('rejects non-integer or out-of-range captureMiddlewareStatusCodes entries', () => {
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      captureMiddlewareStatusCodes: [401, 99]
    })).toThrow(/captureMiddlewareStatusCodes/);
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      captureMiddlewareStatusCodes: [401, 600]
    })).toThrow(/captureMiddlewareStatusCodes/);
  });

  it('rejects captureMiddlewareStatusCodes when not string-union or array', () => {
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      captureMiddlewareStatusCodes: 401 as never
    })).toThrow(/captureMiddlewareStatusCodes/);
  });

  it('accepts DLQ size/backups and previous transport authorization config', () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      deadLetterMaxBytes: 12 * 1024 * 1024,
      deadLetterMaxBackups: 7,
      previousTransportAuthorizations: ['Bearer old-token', 'Bearer older-token']
    });

    expect(resolved.deadLetterMaxBytes).toBe(12 * 1024 * 1024);
    expect(resolved.deadLetterMaxBackups).toBe(7);
    expect(resolved.previousTransportAuthorizations).toEqual([
      'Bearer old-token',
      'Bearer older-token'
    ]);
  });

  it('rejects invalid DLQ and previous transport authorization config', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        deadLetterMaxBytes: 0
      })
    ).toThrow(/deadLetterMaxBytes/);

    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        deadLetterMaxBackups: -1
      })
    ).toThrow(/deadLetterMaxBackups/);

    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        previousTransportAuthorizations: [42]
      } as never)
    ).toThrow(/previousTransportAuthorizations/);
  });
});

describe('G4 — allowInsecureTransport semantics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    __resetLegacyInsecureTransportWarning();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts allowInsecureTransport: false as a no-op with a one-shot warn', () => {
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      allowInsecureTransport: false
    } as never)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/allowInsecureTransport.*deprecated/i);

    resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      allowInsecureTransport: false
    } as never);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects allowInsecureTransport: true with actionable error', () => {
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      allowInsecureTransport: true
    } as never)).toThrow(/allowPlainHttpTransport/);
  });

  it('rejects allowInsecureTransport: true + allowPlainHttpTransport: false as contradiction', () => {
    expect(() => resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
      allowInsecureTransport: true,
      allowPlainHttpTransport: false
    } as never)).toThrow(/contradiction/i);
  });

  it('absence of allowInsecureTransport does not warn', () => {
    resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('Completeness schema — 0.2.0 additions', () => {
  it('Completeness accepts new optional fields without breaking existing consumers', () => {
    const c: import('../../src/types').Completeness = {
      requestCaptured: true,
      requestBodyTruncated: false,
      ioTimelineCaptured: true,
      usedAmbientEvents: false,
      ioEventsDropped: 0,
      ioPayloadsTruncated: 0,
      alsContextAvailable: true,
      localVariablesCaptured: true,
      localVariablesTruncated: false,
      stateTrackingEnabled: false,
      stateReadsCaptured: false,
      concurrentRequestsCaptured: true,
      piiScrubbed: true,
      encrypted: false,
      captureFailures: [],
      modeAtCapture: 'safe',
      localVariablesCaptureLayer: 'tag',
      localVariablesDegradation: 'exact',
      localVariablesFrameAlignment: 'full',
      sourceMapResolution: {
        framesResolved: 3,
        framesUnresolved: 0,
        cacheHits: 3,
        cacheMisses: 0,
        missing: 0,
        corrupt: 0,
        evictions: 0
      }
    };
    expect(c.localVariablesCaptureLayer).toBe('tag');
    expect(c.sourceMapResolution?.framesResolved).toBe(3);
  });
});

describe('logLevel resolution', () => {
  it("defaults to 'warn'", () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
    });
    expect(resolved.logLevel).toBe('warn');
  });

  it('accepts every documented value', () => {
    for (const level of ['silent', 'error', 'warn', 'info', 'debug'] as const) {
      const resolved = resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        logLevel: level,
      });
      expect(resolved.logLevel).toBe(level);
    }
  });

  it('rejects unknown values', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        // @ts-expect-error testing runtime validation
        logLevel: 'verbose',
      })
    ).toThrow(/logLevel/);
  });
});

describe('previousEncryptionKeys resolution', () => {
  const PRIMARY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const PREV1   = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const PREV2   = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

  it('defaults to empty array when not provided', () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      allowUnencrypted: true,
    });
    expect(resolved.previousEncryptionKeys).toEqual([]);
  });

  it('accepts a list of hex keys and preserves order', () => {
    const resolved = resolveConfig({
      transport: { type: 'stdout' },
      encryptionKey: PRIMARY,
      previousEncryptionKeys: [PREV1, PREV2],
    });
    expect(resolved.previousEncryptionKeys).toEqual([PREV1, PREV2]);
  });

  it('rejects entries that are not 64-hex', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        encryptionKey: PRIMARY,
        previousEncryptionKeys: ['not-hex'],
      })
    ).toThrow(/previousEncryptionKeys/);
  });

  it('rejects low-entropy entries', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        encryptionKey: PRIMARY,
        previousEncryptionKeys: ['0'.repeat(64)],
      })
    ).toThrow(/insufficient character diversity/);
  });

  it('rejects an entry equal to the primary key', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        encryptionKey: PRIMARY,
        previousEncryptionKeys: [PRIMARY],
      })
    ).toThrow(/must not include the primary key/);
  });

  it('rejects more than 5 entries', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'stdout' },
        encryptionKey: PRIMARY,
        previousEncryptionKeys: [PREV1, PREV2, PREV1.replace('f', 'e'), PREV2.replace('0', '1'), PRIMARY.replace('0', '2'), PRIMARY.replace('0', '3')],
      })
    ).toThrow(/at most 5/);
  });
});
