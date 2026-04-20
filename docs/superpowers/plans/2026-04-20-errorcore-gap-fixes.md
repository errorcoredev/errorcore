# errorcore 0.2.0 Gap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship errorcore 0.2.0 fixing the P0–P2 gaps identified in `D:\blue\errorcore-gap-report.md`: inspector locals correlation (G1), I/O timeline + driver injection (G2), source-map cold-cache race (G3), config resolver accepting legacy `allowInsecureTransport: false` (G4), Next.js middleware wrapper (C1), and Edge-runtime docs (C2).

**Architecture:** Three-layer exception correlation via Symbol-tagging at V8 inspector pause (Layer 1) with identity-tuple fallback (Layer 2) and best-effort frame-index alignment (Layer 3). Recorder shape audit fixing the critical `message.socket` early-return bug. Sync-on-miss source maps with 2MB size gate. New `drivers`, `silent`, `sourceMapSyncThresholdBytes`, `captureMiddlewareStatusCodes` config fields. Three-state startup diagnostic. New `withNextMiddleware` export.

**Tech Stack:** TypeScript 5.9, Node 20+, Vitest 4, `node:inspector` (V8 Debugger), `node:diagnostics_channel`, `source-map-js`, CommonJS build with ESM-emit override for the Edge stub.

**Design spec:** [docs/superpowers/specs/2026-04-20-errorcore-gap-fixes-design.md](../specs/2026-04-20-errorcore-gap-fixes-design.md)

**Working directory for all commands:** `C:/Users/harin/Downloads/errorcore/ec-master`

---

## Phase 0 — Preflight

### Task 0: Baseline verification

**Files:** none

- [ ] **Step 1: Build and test current main to establish baseline**

Run: `npm run build && npm run test`
Expected: Build succeeds. Tests pass.

- [ ] **Step 2: Capture baseline file and line counts for files we'll touch**

Run: `wc -l src/config.ts src/types.ts src/capture/inspector-manager.ts src/capture/source-map-resolver.ts src/capture/error-capturer.ts src/sdk.ts src/recording/http-server.ts src/recording/http-client.ts src/recording/undici.ts src/recording/channel-subscriber.ts src/recording/patches/patch-manager.ts src/recording/patches/pg.ts src/recording/patches/mongodb.ts src/recording/patches/mysql2.ts src/recording/patches/ioredis.ts`
Expected: Numbers recorded in a local scratchpad for reference.

- [ ] **Step 3: Confirm working tree is clean and create a release branch**

```bash
git status
git checkout -b release/0.2.0-gap-fixes
```

Expected: `nothing to commit, working tree clean` before branching; branch created.

---

## Phase 1 — Types and config foundation

### Task 1: Extend `SDKConfig` and `ResolvedConfig` with new fields

**Files:**
- Modify: `src/types.ts`
- Test: `test/unit/types-and-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/types-and-config.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/types-and-config.test.ts -t "0.2.0 config surface"`
Expected: FAIL — TypeScript errors on unknown properties `drivers`, `silent`, `sourceMapSyncThresholdBytes`, `captureMiddlewareStatusCodes`.

- [ ] **Step 3: Extend the types**

In `src/types.ts`, in the `SDKConfig` interface (after `onInternalWarning`), add:

```typescript
  drivers?: {
    pg?: unknown;
    mongodb?: unknown;
    mysql2?: unknown;
    ioredis?: unknown;
  };
  silent?: boolean;
  sourceMapSyncThresholdBytes?: number;
  captureMiddlewareStatusCodes?: number[] | 'none' | 'all';
```

In the `ResolvedConfig` interface (after `onInternalWarning`), add:

```typescript
  drivers: {
    pg?: unknown;
    mongodb?: unknown;
    mysql2?: unknown;
    ioredis?: unknown;
  };
  silent: boolean;
  sourceMapSyncThresholdBytes: number;
  captureMiddlewareStatusCodes: number[] | 'none' | 'all';
```

- [ ] **Step 4: Implement resolution in `resolveConfig`**

In `src/config.ts`, within `resolveConfig` (after the `onInternalWarning` validation block, before the final `return` object):

```typescript
  const drivers = userConfig.drivers ?? {};
  if (typeof drivers !== 'object' || drivers === null || Array.isArray(drivers)) {
    throw new Error('drivers must be an object with pg/mongodb/mysql2/ioredis references');
  }

  const silent = userConfig.silent ?? false;
  if (typeof silent !== 'boolean') {
    throw new Error('silent must be a boolean');
  }

  const sourceMapSyncThresholdBytes =
    userConfig.sourceMapSyncThresholdBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isInteger(sourceMapSyncThresholdBytes) ||
    sourceMapSyncThresholdBytes < 0
  ) {
    throw new Error('sourceMapSyncThresholdBytes must be a non-negative integer');
  }

  const captureMiddlewareStatusCodes = userConfig.captureMiddlewareStatusCodes ?? 'none';
  if (
    captureMiddlewareStatusCodes !== 'none' &&
    captureMiddlewareStatusCodes !== 'all' &&
    !Array.isArray(captureMiddlewareStatusCodes)
  ) {
    throw new Error(
      `captureMiddlewareStatusCodes must be 'none', 'all', or integer[]`
    );
  }
  if (Array.isArray(captureMiddlewareStatusCodes)) {
    for (const code of captureMiddlewareStatusCodes) {
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        throw new Error(
          `captureMiddlewareStatusCodes entries must be integers 100-599; got ${String(code)}`
        );
      }
    }
  }
```

Add to the returned object (after `onInternalWarning`):

```typescript
    drivers,
    silent,
    sourceMapSyncThresholdBytes,
    captureMiddlewareStatusCodes,
```

- [ ] **Step 5: Run test to verify it passes, then commit**

```bash
npx vitest run test/unit/types-and-config.test.ts -t "0.2.0 config surface"
git add src/types.ts src/config.ts test/unit/types-and-config.test.ts
git commit -m "feat(config): add drivers, silent, sourceMapSyncThresholdBytes, captureMiddlewareStatusCodes"
```

Expected: PASS; commit lands.

---

### Task 2: Extend `Completeness` with new telemetry fields

**Files:**
- Modify: `src/types.ts`
- Test: `test/unit/types-and-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/types-and-config.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/types-and-config.test.ts -t "Completeness schema"`
Expected: FAIL with TypeScript errors on `localVariablesCaptureLayer`, `localVariablesDegradation`, `localVariablesFrameAlignment`, `sourceMapResolution`.

- [ ] **Step 3: Extend `Completeness` in `src/types.ts`**

Add to the `Completeness` interface (after `rateLimiterDrops`):

```typescript
  localVariablesCaptureLayer?: 'tag' | 'identity';
  localVariablesDegradation?: 'exact' | 'dropped_hash' | 'dropped_count' | 'background';
  localVariablesFrameAlignment?: 'full' | 'prefix_only';
  sourceMapResolution?: {
    framesResolved: number;
    framesUnresolved: number;
    cacheHits: number;
    cacheMisses: number;
    missing: number;
    corrupt: number;
    evictions: number;
  };
```

- [ ] **Step 4: Run test and build to confirm no regressions**

```bash
npx vitest run test/unit/types-and-config.test.ts
npm run build
```

Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/unit/types-and-config.test.ts
git commit -m "feat(types): extend Completeness with L1/L2 correlation + source-map telemetry"
```

---

### Task 3: G4 — Accept `allowInsecureTransport: false` as silent no-op; reject `true`

**Files:**
- Modify: `src/config.ts`
- Test: `test/unit/types-and-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/types-and-config.test.ts`:

```typescript
describe('G4 — allowInsecureTransport semantics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Reset the module-scoped one-shot warn flag between tests
    const cfg = require('../../src/config') as { __resetLegacyInsecureTransportWarning?: () => void };
    cfg.__resetLegacyInsecureTransportWarning?.();
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

    // Second call within the same process should not re-warn
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/types-and-config.test.ts -t "G4"`
Expected: FAIL — current code throws on `false`.

- [ ] **Step 3: Replace the G4 handler in `src/config.ts`**

Locate the current block at ~line 193:

```typescript
  if ((userConfig as { allowInsecureTransport?: unknown }).allowInsecureTransport !== undefined) {
    throw new Error(
      'allowInsecureTransport was removed. Use allowPlainHttpTransport to enable plain-http collector URLs.'
    );
  }
```

Replace with:

```typescript
  const legacyInsecureTransport = (userConfig as { allowInsecureTransport?: unknown })
    .allowInsecureTransport;
  if (legacyInsecureTransport === true) {
    if (userConfig.allowPlainHttpTransport === false) {
      throw new Error(
        'Config contradiction: allowInsecureTransport: true and allowPlainHttpTransport: false cannot both be set. ' +
        'Remove allowInsecureTransport (deprecated) and set allowPlainHttpTransport: true if you intend to allow plain HTTP.'
      );
    }
    throw new Error(
      'allowInsecureTransport: true was renamed to allowPlainHttpTransport: true in 0.2.0. ' +
      'Update your config. (Deprecated in 0.2.0, will be removed in 1.0.0.)'
    );
  }
  if (legacyInsecureTransport === false) {
    warnLegacyInsecureTransportOnce();
  }
```

At the top of the file (after imports), add the one-shot warn helper:

```typescript
let legacyInsecureTransportWarned = false;
function warnLegacyInsecureTransportOnce(): void {
  if (legacyInsecureTransportWarned) return;
  legacyInsecureTransportWarned = true;
  console.warn(
    '[ErrorCore] allowInsecureTransport is deprecated and ignored. ' +
    'Remove it from your config. (Deprecated in 0.2.0, will be removed in 1.0.0.) ' +
    'Use allowPlainHttpTransport to enable plain-http collector URLs.'
  );
}
// Test-only reset for the one-shot flag.
export function __resetLegacyInsecureTransportWarning(): void {
  legacyInsecureTransportWarned = false;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/unit/types-and-config.test.ts`
Expected: PASS — all G4 tests plus previous tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/types-and-config.test.ts
git commit -m "fix(config): accept allowInsecureTransport: false as no-op; reject true [G4]"
```

---

## Phase 2 — G2 Critical shape fix

### Task 4: Fix `http.server.request.start` — remove socket early-return

**Files:**
- Modify: `src/recording/http-server.ts`
- Test: `test/unit/io-recording.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/io-recording.test.ts`:

```typescript
describe('G2 — http-server shape: message.socket is optional', () => {
  it('records request when diagnostic-channel payload omits socket', () => {
    const { buffer, als, requestTracker, bodyCapture, headerFilter, scrubber, config } = setupHttpServerDeps();
    const recorder = new HttpServerRecorder({
      buffer, als, requestTracker, bodyCapture, headerFilter, scrubber, config
    });

    const request = makeFakeRequest({ method: 'GET', url: '/api/test' });
    const response = makeFakeResponse();
    // Key test fixture: NO top-level socket. request.socket is the real source.
    const payload = {
      request,
      response,
      server: makeFakeServer()
    } as unknown as Parameters<typeof recorder.handleRequestStart>[0];

    recorder.handleRequestStart(payload);

    expect(buffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http-server',
        direction: 'inbound',
        method: 'GET',
        url: '/api/test'
      })
    );
    expect(requestTracker.add).toHaveBeenCalled();
  });

  it('still records when socket is present (backward compat)', () => {
    const { buffer, als, requestTracker, bodyCapture, headerFilter, scrubber, config } = setupHttpServerDeps();
    const recorder = new HttpServerRecorder({
      buffer, als, requestTracker, bodyCapture, headerFilter, scrubber, config
    });

    const request = makeFakeRequest({ method: 'POST', url: '/x' });
    const response = makeFakeResponse();
    recorder.handleRequestStart({
      request,
      response,
      socket: request.socket,
      server: makeFakeServer()
    } as never);

    expect(buffer.push).toHaveBeenCalled();
  });
});
```

(Use existing test fixtures if present; otherwise add minimal `setupHttpServerDeps`, `makeFakeRequest`, `makeFakeResponse`, `makeFakeServer` helpers at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/io-recording.test.ts -t "G2 — http-server shape"`
Expected: FAIL — current code returns early because `message.socket === undefined`.

- [ ] **Step 3: Fix `handleRequestStart`**

In `src/recording/http-server.ts:250`, replace:

```typescript
      if (
        message.request === undefined ||
        message.response === undefined ||
        message.socket === undefined
      ) {
        return;
      }

      const request = message.request;
      const response = message.response;
      const socket = message.socket ?? request.socket;
```

With:

```typescript
      if (
        message.request === undefined ||
        message.response === undefined
      ) {
        return;
      }

      const request = message.request;
      const response = message.response;
      const socket = message.socket ?? request.socket;
      if (socket === undefined) {
        // No FD available; proceed with fd=null. This is valid on some
        // transports (e.g. unix sockets bridged to mock servers in tests).
      }
```

Then update the later `event.fd = extractFd(socket);` to handle `undefined`:

```typescript
      event.fd = socket === undefined ? null : extractFd(socket);
```

Also widen the TypeScript type of the `handleRequestStart` parameter: `socket?: Socket` instead of `socket: Socket`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/io-recording.test.ts`
Expected: PASS — both new tests plus existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/recording/http-server.ts test/unit/io-recording.test.ts
git commit -m "fix(http-server): accept diag-channel payloads without top-level socket [G2 critical]"
```

---

### Task 5: Audit `http-client` recorder for the same shape pattern

**Files:**
- Modify: `src/recording/http-client.ts`
- Test: `test/unit/io-recording.test.ts`

- [ ] **Step 1: Read the current recorder to find strict checks**

Run: `grep -n "socket\|=== undefined" src/recording/http-client.ts`

Identify any early-return that requires `message.socket` or similar fields not guaranteed by Node's `http.client.request.start` channel payload (which is `{ request }` only).

- [ ] **Step 2: Write the failing test**

Append to `test/unit/io-recording.test.ts`:

```typescript
describe('G2 — http-client shape: { request } only', () => {
  it('records outbound request when payload contains only request', () => {
    const deps = setupHttpClientDeps();
    const recorder = new HttpClientRecorder(deps);
    const request = makeFakeClientRequest({ method: 'POST', host: 'api.example.com', path: '/v1/x' });

    recorder.handleRequestStart({ request } as never);

    expect(deps.buffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'http-client',
        direction: 'outbound',
        method: 'POST'
      })
    );
  });
});
```

- [ ] **Step 3: Run test to confirm failure mode**

Run: `npx vitest run test/unit/io-recording.test.ts -t "G2 — http-client shape"`
Expected: FAIL if http-client requires fields beyond `request`.

- [ ] **Step 4: Fix the recorder**

In `src/recording/http-client.ts`, remove any early-return that rejects payloads for missing `socket`, `response`, or other fields not part of the documented `{ request }` shape. Derive anything needed (FD, host) from `request.socket` / `request.getHeader('host')` / request options. Where the socket isn't yet available at `request.start` time (it attaches later), set `fd = null` and update during subsequent events if we subscribe to them.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/io-recording.test.ts
git add src/recording/http-client.ts test/unit/io-recording.test.ts
git commit -m "fix(http-client): accept { request } only payload shape [G2]"
```

Expected: PASS; commit lands.

---

### Task 6: Audit `undici` recorder against `RequestImpl` shape

**Files:**
- Modify: `src/recording/undici.ts`
- Test: `test/unit/io-recording.test.ts`

- [ ] **Step 1: Read the undici recorder and identify `ClientRequest`-assumptions**

Run: `grep -nE "request\.(method|path|origin|headers|url)" src/recording/undici.ts`

undici's `RequestImpl` exposes fields like `origin`, `path`, `method`, `headers` — check each field access against the real undici type (see `node_modules/undici/types/dispatcher.d.ts`). Identify any that use Node `http.ClientRequest` API surface (e.g., `request.getHeader()`, `request.socket`).

- [ ] **Step 2: Write the failing test**

Append to `test/unit/io-recording.test.ts`:

```typescript
describe('G2 — undici shape: RequestImpl, not ClientRequest', () => {
  it('records outbound fetch when payload matches undici:request:create shape', () => {
    const deps = setupUndiciDeps();
    const recorder = new UndiciRecorder(deps);
    const request = {
      origin: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      headers: ['host', 'api.example.com', 'user-agent', 'test'],
      body: null
    };
    recorder.handleRequestCreate({ request } as never);

    expect(deps.buffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'undici',
        direction: 'outbound',
        method: 'GET',
        url: 'https://api.example.com/v1/x'
      })
    );
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `npx vitest run test/unit/io-recording.test.ts -t "G2 — undici shape"`
Expected: FAIL if the recorder reads from ClientRequest-only fields.

- [ ] **Step 4: Fix the recorder**

In `src/recording/undici.ts`, replace any `request.method` / `request.path` / `request.getHeader` access with the undici shape:
- `method`: `request.method` (same)
- `url`: construct from `request.origin + request.path`
- `headers`: undici gives them as a flat array `[name, value, name, value, ...]`, convert to an object
- No `request.socket` available at `request:create` time; FD captured later via `undici:request:headers` if needed

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/io-recording.test.ts
git add src/recording/undici.ts test/unit/io-recording.test.ts
git commit -m "fix(undici): record against RequestImpl shape, not http.ClientRequest [G2]"
```

---

### Task 7: Channel-subscriber — subscribe to both `http.server.response.finish` and `http.server.response.created`

**Files:**
- Modify: `src/recording/channel-subscriber.ts`
- Test: `test/unit/channel-subscriber.test.ts`

- [ ] **Step 1: Identify current response-channel subscription**

Run: `grep -n "response" src/recording/channel-subscriber.ts`
Confirm the current subscription handles only one of the two channel names.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/channel-subscriber.test.ts`:

```typescript
describe('G2 — response finish/created dual subscription', () => {
  it('subscribes to both http.server.response.finish and http.server.response.created when available', () => {
    const subscribed: string[] = [];
    vi.mock('node:diagnostics_channel', () => ({
      subscribe: (name: string) => { subscribed.push(name); },
      unsubscribe: () => undefined
    }));
    const sub = new ChannelSubscriber({
      httpServer: { handleRequestStart: vi.fn(), handleResponseFinish: vi.fn() } as never,
      httpClient: { handleRequestStart: vi.fn() } as never,
      undiciRecorder: {} as never,
      netDns: {} as never
    });
    sub.subscribeAll();

    expect(subscribed).toContain('http.server.response.finish');
    expect(subscribed).toContain('http.server.response.created');
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `npx vitest run test/unit/channel-subscriber.test.ts -t "dual subscription"`
Expected: FAIL.

- [ ] **Step 4: Add both channels to the registry**

In `src/recording/channel-subscriber.ts`'s `subscribeAll`, add both entries. Both route to `httpServer.handleResponseFinish(message)` (or equivalent), and the handler dedups by request identity (use a `WeakSet<IncomingMessage>`).

In `HttpServerRecorder`, add a `handleResponseFinish(message)` method that performs the finalization work that currently lives on `response.on('close')`. Keep the `close` listener as a safety net.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/channel-subscriber.test.ts test/unit/io-recording.test.ts
git add src/recording/channel-subscriber.ts src/recording/http-server.ts test/unit/channel-subscriber.test.ts
git commit -m "feat(channel-subscriber): subscribe to both response.finish and response.created [G2]"
```

---

## Phase 3 — G2 Driver injection

### Task 8: `PatchManager` — accept `drivers` option and pass to each installer

**Files:**
- Modify: `src/recording/patches/patch-manager.ts`
- Test: `test/unit/database-patches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/database-patches.test.ts`:

```typescript
describe('G2 — PatchManager accepts explicit drivers', () => {
  it('passes user-provided pg reference into the pg installer', () => {
    const userPg = { Client: { prototype: { query: function original() {} } } };
    const config = resolveTestConfig({ drivers: { pg: userPg } });
    const buffer = { push: vi.fn(() => ({ slot: {}, seq: 0 })), updatePayloadBytes: vi.fn() };
    const als = { getContext: () => undefined, getStore: () => ({} as never) };
    const pm = new PatchManager({ buffer: buffer as never, als: als as never, config });
    pm.installAll();

    // After installAll, the user-provided pg.Client.prototype.query should be wrapped
    expect(userPg.Client.prototype.query).not.toBe(
      // marker that it's been replaced by our owned wrapper
      (function original() {})
    );
    expect((userPg.Client.prototype.query as { [k: symbol]: unknown })).toBeDefined();
  });

  it('falls back to nodeRequire when drivers.pg is not provided', () => {
    const config = resolveTestConfig();
    const buffer = { push: vi.fn(() => ({ slot: {}, seq: 0 })), updatePayloadBytes: vi.fn() };
    const als = { getContext: () => undefined, getStore: () => ({} as never) };
    const pm = new PatchManager({ buffer: buffer as never, als: als as never, config });
    expect(() => pm.installAll()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/database-patches.test.ts -t "PatchManager accepts explicit drivers"`
Expected: FAIL.

- [ ] **Step 3: Update `PatchInstallDeps` and installers**

In `src/recording/patches/patch-manager.ts`, extend `PatchInstallDeps`:

```typescript
export interface PatchInstallDeps {
  buffer: IOEventBufferLike;
  als: ALSManagerLike;
  config: ResolvedConfig;
  explicitDriver?: unknown;   // when set, installer uses this instead of nodeRequire
}
```

Update `installAll`:

```typescript
  public installAll(): void {
    this.uninstallers = [
      installPgPatch({ ...this.deps, explicitDriver: this.deps.config.drivers.pg }),
      installMysql2Patch({ ...this.deps, explicitDriver: this.deps.config.drivers.mysql2 }),
      installIoredisPatch({ ...this.deps, explicitDriver: this.deps.config.drivers.ioredis }),
      installMongodbPatch({ ...this.deps, explicitDriver: this.deps.config.drivers.mongodb })
    ];
  }
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/database-patches.test.ts
git add src/recording/patches/patch-manager.ts test/unit/database-patches.test.ts
git commit -m "feat(patch-manager): thread drivers config through to installers [G2]"
```

---

### Task 9: `pg` patch — use explicit driver ref when provided

**Files:**
- Modify: `src/recording/patches/pg.ts`
- Test: `test/unit/database-patches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/database-patches.test.ts`:

```typescript
describe('G2 — pg installer with explicit driver', () => {
  it('patches only the provided instance, not nodeRequire', async () => {
    const userPg = { Client: { prototype: { query: function original() { return 'user'; } } }, Pool: { prototype: {} } };
    const deps = makePatchDeps({ explicitDriver: userPg });
    const uninstall = installPgPatch(deps);

    // The user's pg has been wrapped:
    const userWrapped = userPg.Client.prototype.query;
    expect(userWrapped).not.toBe(Object.getPrototypeOf(Function));  // wrapped, not original

    uninstall();
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = makePatchDeps({ explicitDriver: undefined });
    // Should not throw regardless of whether pg is actually installed
    expect(() => installPgPatch(deps)()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run test/unit/database-patches.test.ts -t "pg installer with explicit driver"`
Expected: FAIL.

- [ ] **Step 3: Update `src/recording/patches/pg.ts` `install()`**

Replace the top of `install`:

```typescript
export function install(deps: PatchInstallDeps): () => void {
  try {
    const pg = (deps.explicitDriver ?? nodeRequire('pg')) as {
      Client?: { prototype?: object };
      Pool?: { prototype?: object };
    };
    // ... rest unchanged
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/database-patches.test.ts
git add src/recording/patches/pg.ts test/unit/database-patches.test.ts
git commit -m "feat(pg): use drivers.pg when provided; fallback to nodeRequire [G2]"
```

---

### Task 10: `mongodb` patch — accept explicit driver ref

**Files:**
- Modify: `src/recording/patches/mongodb.ts`
- Test: `test/unit/database-patches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/database-patches.test.ts`:

```typescript
describe('G2 — mongodb installer with explicit driver', () => {
  it('uses explicitDriver when provided', () => {
    const originalConnect = function connect() { return 'orig'; };
    const userMongo = { MongoClient: { prototype: { connect: originalConnect } } };
    const deps = makePatchDeps({ explicitDriver: userMongo });
    const uninstall = installMongodbPatch(deps);
    expect(userMongo.MongoClient.prototype.connect).not.toBe(originalConnect);
    uninstall();
    expect(userMongo.MongoClient.prototype.connect).toBe(originalConnect);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = makePatchDeps({ explicitDriver: undefined });
    expect(() => installMongodbPatch(deps)()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/database-patches.test.ts -t "mongodb installer with explicit driver"`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/recording/patches/mongodb.ts`**

At the top of `install()`, replace the `nodeRequire('mongodb')` call with:

```typescript
export function install(deps: PatchInstallDeps): () => void {
  try {
    const mongodb = (deps.explicitDriver ?? nodeRequire('mongodb')) as {
      MongoClient?: { prototype?: object };
    };
    // ... rest unchanged
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/database-patches.test.ts
git add src/recording/patches/mongodb.ts test/unit/database-patches.test.ts
git commit -m "feat(mongodb): use drivers.mongodb when provided [G2]"
```

---

### Task 11: `mysql2` patch — accept explicit driver ref

**Files:**
- Modify: `src/recording/patches/mysql2.ts`
- Test: `test/unit/database-patches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/database-patches.test.ts`:

```typescript
describe('G2 — mysql2 installer with explicit driver', () => {
  it('uses explicitDriver when provided', () => {
    const originalQuery = function query() { return 'orig'; };
    const userMysql2 = { Connection: { prototype: { query: originalQuery } } };
    const deps = makePatchDeps({ explicitDriver: userMysql2 });
    const uninstall = installMysql2Patch(deps);
    expect(userMysql2.Connection.prototype.query).not.toBe(originalQuery);
    uninstall();
    expect(userMysql2.Connection.prototype.query).toBe(originalQuery);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = makePatchDeps({ explicitDriver: undefined });
    expect(() => installMysql2Patch(deps)()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/database-patches.test.ts -t "mysql2 installer with explicit driver"`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/recording/patches/mysql2.ts`**

At the top of `install()`:

```typescript
export function install(deps: PatchInstallDeps): () => void {
  try {
    const mysql2 = (deps.explicitDriver ?? nodeRequire('mysql2')) as {
      Connection?: { prototype?: object };
    };
    // ... rest unchanged
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/database-patches.test.ts
git add src/recording/patches/mysql2.ts test/unit/database-patches.test.ts
git commit -m "feat(mysql2): use drivers.mysql2 when provided [G2]"
```

---

### Task 12: `ioredis` patch — accept explicit driver ref

**Files:**
- Modify: `src/recording/patches/ioredis.ts`
- Test: `test/unit/database-patches.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/database-patches.test.ts`:

```typescript
describe('G2 — ioredis installer with explicit driver', () => {
  it('uses explicitDriver when provided', () => {
    const originalSendCommand = function sendCommand() { return 'orig'; };
    const userIoredis = function Redis() {} as unknown as { prototype: { sendCommand: Function } };
    userIoredis.prototype = { sendCommand: originalSendCommand };
    const deps = makePatchDeps({ explicitDriver: userIoredis });
    const uninstall = installIoredisPatch(deps);
    expect(userIoredis.prototype.sendCommand).not.toBe(originalSendCommand);
    uninstall();
    expect(userIoredis.prototype.sendCommand).toBe(originalSendCommand);
  });

  it('falls back to nodeRequire when explicitDriver is undefined', () => {
    const deps = makePatchDeps({ explicitDriver: undefined });
    expect(() => installIoredisPatch(deps)()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/database-patches.test.ts -t "ioredis installer with explicit driver"`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/recording/patches/ioredis.ts`**

At the top of `install()`:

```typescript
export function install(deps: PatchInstallDeps): () => void {
  try {
    const Redis = (deps.explicitDriver ?? nodeRequire('ioredis')) as {
      prototype?: { sendCommand?: Function };
    };
    // ... rest unchanged
```

(ioredis's default export IS the Redis class constructor; `prototype.sendCommand` is the wrap target. Verify shape against current `ioredis.ts` before finalizing.)

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/database-patches.test.ts
git add src/recording/patches/ioredis.ts test/unit/database-patches.test.ts
git commit -m "feat(ioredis): use drivers.ioredis when provided [G2]"
```

---

## Phase 4 — G2 Startup diagnostic

### Task 13: Bundler detection + recorder status types

**Files:**
- Create: `src/sdk-diagnostics.ts`
- Test: `test/unit/sdk-composition.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/sdk-composition.test.ts`:

```typescript
describe('G2 — bundler detection', () => {
  it('detectBundler returns webpack when __webpack_require__ is defined', () => {
    (globalThis as Record<string, unknown>).__webpack_require__ = () => undefined;
    try {
      expect(detectBundler()).toBe('webpack');
    } finally {
      delete (globalThis as Record<string, unknown>).__webpack_require__;
    }
  });

  it('detectBundler returns unknown otherwise', () => {
    expect(detectBundler()).toBe('unknown');
  });

  it('isNextJsNodeRuntime reads NEXT_RUNTIME === nodejs', () => {
    const saved = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    try {
      expect(isNextJsNodeRuntime()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = saved;
    }
  });
});

describe('G2 — recorder status assembly', () => {
  it('classifyRecorderStatus emits ok / skip / warn correctly', () => {
    expect(classifyRecorderStatus({ installed: true })).toEqual({ state: 'ok' });
    expect(classifyRecorderStatus({ installed: false, reason: 'not-installed' })).toEqual({
      state: 'skip',
      reason: 'not-installed'
    });
    expect(classifyRecorderStatus({ installed: false, reason: 'bundled-unpatched' })).toEqual({
      state: 'warn',
      reason: 'bundled-unpatched'
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/sdk-composition.test.ts -t "bundler detection|recorder status"`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Create `src/sdk-diagnostics.ts`**

```typescript
export type BundlerKind = 'webpack' | 'unknown';

export function detectBundler(): BundlerKind {
  if (typeof (globalThis as Record<string, unknown>).__webpack_require__ !== 'undefined') {
    return 'webpack';
  }
  return 'unknown';
}

export function isNextJsNodeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === 'nodejs';
}

export type RecorderState =
  | { state: 'ok' }
  | { state: 'skip'; reason: string }
  | { state: 'warn'; reason: string };

export function classifyRecorderStatus(input: {
  installed: boolean;
  reason?: string;
}): RecorderState {
  if (input.installed) return { state: 'ok' };
  const reason = input.reason ?? 'unknown';
  if (reason === 'bundled-unpatched') return { state: 'warn', reason };
  return { state: 'skip', reason };
}

export function formatStartupLine(input: {
  version: string;
  nodeVersion: string;
  recorders: Record<string, RecorderState>;
}): string {
  const parts = Object.entries(input.recorders)
    .map(([name, s]) => {
      if (s.state === 'ok') return `${name}=ok`;
      return `${name}=${s.state}(${s.reason})`;
    })
    .join(' ');
  return `[errorcore] ${input.version} node=${input.nodeVersion} recorders: ${parts}`;
}

export function formatWarnGuidance(
  name: string,
  state: RecorderState,
  context: { isNextJs: boolean }
): string | null {
  if (state.state !== 'warn') return null;
  if (state.reason === 'bundled-unpatched') {
    if (context.isNextJs) {
      return `[errorcore]   → ${name}: driver present but bundled. Add '${name}' to serverExternalPackages in next.config.js.`;
    }
    return `[errorcore]   → ${name}: driver present but bundled. Pass drivers: { ${name}: require('${name}') } to errorcore.init().`;
  }
  return `[errorcore]   → ${name}: ${state.reason}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/sdk-composition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdk-diagnostics.ts test/unit/sdk-composition.test.ts
git commit -m "feat(sdk): bundler detection + recorder status classification [G2]"
```

---

### Task 14: Emit startup diagnostic in `SDKInstance.activate`

**Files:**
- Modify: `src/sdk.ts`
- Modify: `src/recording/patches/patch-manager.ts` (expose per-recorder install state)
- Test: `test/unit/sdk-composition.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/sdk-composition.test.ts`:

```typescript
describe('G2 — startup diagnostic emission', () => {
  it('emits a single summary line when all recorders are ok or skip and silent is false', () => {
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { logs.push(msg); };
    console.log = (msg: string) => { logs.push(msg); };
    try {
      const sdk = createSDK({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        silent: false
      });
      sdk.activate();
      const line = logs.find((l) => l.startsWith('[errorcore]'));
      expect(line).toMatch(/\[errorcore\] .* node=.* recorders: /);
      expect(line).toContain('http-server=ok');
      void sdk.shutdown();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
  });

  it('emits nothing when silent is true', () => {
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { logs.push(msg); };
    console.log = (msg: string) => { logs.push(msg); };
    try {
      const sdk = createSDK({
        transport: { type: 'stdout' },
        allowUnencrypted: true,
        silent: true
      });
      sdk.activate();
      expect(logs.filter((l) => l.startsWith('[errorcore] 0.'))).toEqual([]);
      void sdk.shutdown();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/sdk-composition.test.ts -t "startup diagnostic"`
Expected: FAIL — no line currently emitted.

- [ ] **Step 3: Track per-recorder install status in `PatchManager`**

In `src/recording/patches/patch-manager.ts`, change each `install*Patch` signature to return `{ uninstall: () => void; state: RecorderState }`. Update the four patch installer files to return:
- `{ installed: false, reason: 'not-installed' }` when `MODULE_NOT_FOUND`
- `{ installed: false, reason: 'bundled-unpatched' }` when `detectBundler() === 'webpack'` and no explicitDriver
- `{ installed: true }` otherwise

Expose `PatchManager.getRecorderStates(): Record<string, RecorderState>`.

Similarly, have each of the four recorder classes (`HttpServerRecorder`, `HttpClientRecorder`, `UndiciRecorder`, `NetDnsRecorder`) expose a `getState(): RecorderState` method. For HTTP + undici + net/dns, current state is `{ state: 'ok' }` after successful install.

- [ ] **Step 4: Emit in `activate()`**

In `src/sdk.ts`, at the end of `activate()` (after `this.state = 'active'`), add:

```typescript
    if (!this.config.silent) {
      this.emitStartupDiagnostic();
    }
```

And add the method:

```typescript
  private emitStartupDiagnostic(): void {
    const recorders: Record<string, import('./sdk-diagnostics').RecorderState> = {
      'http-server': this.httpServerRecorder.getState(),
      'http-client': this.httpClientRecorder.getState(),
      'undici': this.undiciRecorder.getState(),
      'net': this.netDnsRecorder.getState(),  // combined
      'dns': this.netDnsRecorder.getState(),
      ...this.patchManager.getRecorderStates(),
    };
    const version = require('../package.json').version as string;
    const line = require('./sdk-diagnostics').formatStartupLine({
      version,
      nodeVersion: process.versions.node,
      recorders,
    });
    console.log(line);
    const isNextJs = require('./sdk-diagnostics').isNextJsNodeRuntime();
    for (const [name, state] of Object.entries(recorders)) {
      const guidance = require('./sdk-diagnostics').formatWarnGuidance(name, state, { isNextJs });
      if (guidance !== null) console.log(guidance);
    }
    if (require('./sdk-diagnostics').detectBundler() === 'unknown') {
      const dbRecorderNames = ['pg', 'mongodb', 'mysql2', 'ioredis'];
      const hasAnyDriverCandidate = dbRecorderNames.some(
        (name) => recorders[name]?.state === 'ok'
      );
      if (hasAnyDriverCandidate) {
        console.log(
          '[errorcore]   info: Bundler auto-detection covers webpack only. If DB events don\'t appear, pass drivers: { pg: require(\'pg\'), ... } to init().'
        );
      }
    }
  }
```

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/sdk-composition.test.ts test/unit/database-patches.test.ts
git add src/sdk.ts src/recording/patches/patch-manager.ts src/recording/patches/pg.ts src/recording/patches/mongodb.ts src/recording/patches/mysql2.ts src/recording/patches/ioredis.ts src/recording/http-server.ts src/recording/http-client.ts src/recording/undici.ts src/recording/net-dns.ts test/unit/sdk-composition.test.ts
git commit -m "feat(sdk): emit three-state recorder startup diagnostic at activate [G2]"
```

---

## Phase 5 — G3 Source maps

### Task 15: Three-state `CacheEntry` shape

**Files:**
- Modify: `src/capture/source-map-resolver.ts`
- Test: `test/unit/source-map-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/source-map-resolver.test.ts`:

```typescript
describe('G3 — three-state cache', () => {
  it('caches a missing result and does not re-hit disk on subsequent calls', () => {
    const readSyncSpy = vi.spyOn(fs, 'readFileSync');
    const resolver = new SourceMapResolver();
    const stack = 'Error: x\n    at foo (/nonexistent/file.js:1:1)';
    resolver.resolveStack(stack);
    const initialCalls = readSyncSpy.mock.calls.length;
    resolver.resolveStack(stack);
    // Second call should not trigger additional disk reads for the missing file.
    expect(readSyncSpy.mock.calls.length).toBe(initialCalls);
    readSyncSpy.mockRestore();
  });

  it('caches a corrupt result with reason', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('.map'));
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not valid json{{{');
    const resolver = new SourceMapResolver();
    const stack = 'Error: x\n    at foo (/fake/file.js:1:1)';
    resolver.resolveStack(stack);
    const telemetry = resolver.consumeTelemetry();
    expect(telemetry.corrupt).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/source-map-resolver.test.ts -t "three-state cache"`
Expected: FAIL — no `consumeTelemetry`, no three-state semantics yet.

- [ ] **Step 3: Replace the `cache` declaration and `getConsumer`**

At the top of `SourceMapResolver`:

```typescript
type CacheEntry =
  | { type: 'consumer'; consumer: SourceMapConsumer; usedAt: number }
  | { type: 'missing'; cachedAt: number }
  | { type: 'corrupt'; reason: string; cachedAt: number };

const NEGATIVE_ENTRY_TTL_MS = 60 * 60 * 1000;  // 1 hour

const MAX_CACHE_SIZE = 128;

export class SourceMapResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly telemetry = {
    framesResolved: 0,
    framesUnresolved: 0,
    cacheHits: 0,
    cacheMisses: 0,
    missing: 0,
    corrupt: 0,
    evictions: 0
  };
  // ... rest
}
```

Rewrite `getConsumer` to return a `CacheEntry`, never `SourceMapConsumer | null`. Wire the positive / missing / corrupt paths. Expire negative entries older than 1h via the existing `_sweepCache` (or equivalent). Add `consumeTelemetry()` that returns a snapshot and resets counters.

- [ ] **Step 4: Update `resolveStack` callers to work with `CacheEntry`**

Rewrite the cache-lookup logic inside `resolveStack` and `resolveStackCacheOnly` to branch on `entry.type`. Count telemetry at each branch.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/source-map-resolver.test.ts
git add src/capture/source-map-resolver.ts test/unit/source-map-resolver.test.ts
git commit -m "feat(source-map): three-state cache with negative entries + telemetry [G3]"
```

---

### Task 16: Sync-on-miss with 2MB size gate

**Files:**
- Modify: `src/capture/source-map-resolver.ts`
- Test: `test/unit/source-map-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G3 — sync-on-miss with size gate', () => {
  it('resolves on the first call for maps under the threshold', () => {
    // Fixture: a small valid source map on disk
    const { filePath, mapPath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const resolved = resolver.resolveStack(stack);
    expect(resolved).toContain('webpack://');  // or original source form
    expect(resolver.consumeTelemetry().cacheMisses).toBe(1);
    fs.unlinkSync(filePath);
    fs.unlinkSync(mapPath);
  });

  it('falls back to async for maps larger than threshold', () => {
    const { filePath, mapPath } = writeLargeSourceMap(3 * 1024 * 1024);  // 3MB
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 2 * 1024 * 1024 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const resolved = resolver.resolveStack(stack);
    // First call returns unresolved, large map scheduled async
    expect(resolved).toContain(filePath);
    fs.unlinkSync(filePath);
    fs.unlinkSync(mapPath);
  });

  it('sourceMapSyncThresholdBytes: 0 forces all-async behavior', () => {
    const { filePath, mapPath } = writeSmallValidSourceMap();
    const resolver = new SourceMapResolver({ sourceMapSyncThresholdBytes: 0 });
    const stack = `Error: x\n    at foo (${filePath}:1:1)`;
    const resolved = resolver.resolveStack(stack);
    expect(resolved).toContain(filePath);  // not yet resolved
    fs.unlinkSync(filePath);
    fs.unlinkSync(mapPath);
  });
});
```

(Add `writeSmallValidSourceMap` / `writeLargeSourceMap` helpers; they create temp files with real content.)

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/source-map-resolver.test.ts -t "sync-on-miss with size gate"`
Expected: FAIL.

- [ ] **Step 3: Implement sync-on-miss with size check**

Modify the `SourceMapResolver` constructor to accept options:

```typescript
  public constructor(options?: { sourceMapSyncThresholdBytes?: number }) {
    this.syncThresholdBytes = options?.sourceMapSyncThresholdBytes ?? 2 * 1024 * 1024;
  }
  private readonly syncThresholdBytes: number;
```

In `resolveStack`, replace `scheduleWarm(missedPath)` with:

```typescript
      if (this.syncThresholdBytes > 0 && this.fileSizeUnderThreshold(missedPath)) {
        this.getConsumer(missedPath);  // sync load
      } else {
        this.scheduleWarm(missedPath);
      }
```

Where `fileSizeUnderThreshold` stats the adjacent `.map` file (or falls back to stat-ing the `.js` source if map location is unknown):

```typescript
  private fileSizeUnderThreshold(filePath: string): boolean {
    const adjacentMap = filePath + '.map';
    try {
      const s = fs.statSync(adjacentMap);
      return s.size <= this.syncThresholdBytes;
    } catch {
      // No adjacent map; size unknown — prefer async to stay safe.
      return false;
    }
  }
```

- [ ] **Step 4: Wire threshold from config through `createSDK`**

In `src/sdk.ts`, the `new SourceMapResolver()` call becomes `new SourceMapResolver({ sourceMapSyncThresholdBytes: config.sourceMapSyncThresholdBytes })`.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run test/unit/source-map-resolver.test.ts
git add src/capture/source-map-resolver.ts src/sdk.ts test/unit/source-map-resolver.test.ts
git commit -m "feat(source-map): sync-on-miss with 2MB size gate [G3]"
```

---

### Task 17: Plumb `sourceMapResolution` telemetry into `Completeness`

**Files:**
- Modify: `src/capture/error-capturer.ts`
- Modify: `src/capture/package-builder.ts` (if needed)
- Test: `test/unit/error-capture-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/error-capture-pipeline.test.ts`:

```typescript
describe('G3 — sourceMapResolution telemetry in capture output', () => {
  it('captures cacheHits/cacheMisses/corrupt/missing counts in completeness', async () => {
    // Arrange: throw an error whose stack references a file with a known source map
    // Capture via ErrorCapturer, assert on the resulting package's completeness.sourceMapResolution
    const pkg = await captureErrorThroughPipeline({
      errorFactory: () => { const e = new Error('x'); e.stack = 'Error: x\n    at foo (/nonexistent/a.js:1:1)'; return e; }
    });
    expect(pkg.completeness.sourceMapResolution).toBeDefined();
    expect(pkg.completeness.sourceMapResolution?.cacheMisses).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/error-capture-pipeline.test.ts -t "sourceMapResolution telemetry"`
Expected: FAIL.

- [ ] **Step 3: Thread telemetry through the pipeline**

In `src/capture/error-capturer.ts`, in `capture()`:

```typescript
      const serializedError = serializeError(error, this.sourceMapResolver);
      const sourceMapTelemetry = this.sourceMapResolver?.consumeTelemetry();
      // ... existing code ...
      const parts: ErrorPackageParts = {
        // ... existing fields ...
        sourceMapResolution: sourceMapTelemetry,
      };
```

Extend `ErrorPackageParts` in `src/types.ts` with `sourceMapResolution?: { framesResolved: number; ... }`.

In `src/capture/package-builder.ts`, propagate the field into `completeness.sourceMapResolution`.

- [ ] **Step 4: Run test and commit**

```bash
npx vitest run test/unit/error-capture-pipeline.test.ts
git add src/capture/error-capturer.ts src/capture/package-builder.ts src/types.ts test/unit/error-capture-pipeline.test.ts
git commit -m "feat(capture): thread sourceMapResolution telemetry into completeness [G3]"
```

---

## Phase 6 — G1 Inspector locals correlation

### Task 18: Ring buffer data structure + Symbol tag constant

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/v8-inspector.test.ts`:

```typescript
describe('G1 — ring buffer structure', () => {
  it('ERRORCORE_CAPTURE_ID_SYMBOL is Symbol.for-keyed', () => {
    expect(ERRORCORE_CAPTURE_ID_SYMBOL).toBe(Symbol.for('errorcore.v1.captureId'));
  });

  it('LocalsRingBuffer evicts oldest entry when capacity is reached', () => {
    const rb = new LocalsRingBuffer(3);
    rb.push({ id: 'a', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [] });
    rb.push({ id: 'b', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [] });
    rb.push({ id: 'c', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [] });
    rb.push({ id: 'd', requestId: 'r', errorName: 'E', errorMessage: 'm', frameCount: 1, structuralHash: 'h', frames: [] });
    expect(rb.getById('a')).toBeUndefined();
    expect(rb.getById('d')).toBeDefined();
  });

  it('LocalsRingBuffer.findByIdentity returns LIFO oldest-matching-wins', () => {
    const rb = new LocalsRingBuffer(4);
    rb.push({ id: '1', requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h', frames: [] });
    rb.push({ id: '2', requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h', frames: [] });
    const match = rb.findByIdentity({ requestId: 'r1', errorName: 'E', errorMessage: 'm', frameCount: 2, structuralHash: 'h' });
    expect(match?.id).toBe('2');  // LIFO most recent on full match
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/v8-inspector.test.ts -t "ring buffer structure"`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Add the data structure**

At the top of `src/capture/inspector-manager.ts`:

```typescript
export const ERRORCORE_CAPTURE_ID_SYMBOL = Symbol.for('errorcore.v1.captureId');

export interface LocalsRingBufferEntry {
  id: string;
  requestId: string | null;
  errorName: string;
  errorMessage: string;
  frameCount: number;
  structuralHash: string;
  frames: CapturedFrame[];
  createdAt: number;
}

export class LocalsRingBuffer {
  private readonly capacity: number;
  private readonly entries: LocalsRingBufferEntry[] = [];
  private nextId = 0;

  public constructor(capacity: number) {
    this.capacity = capacity;
  }

  public allocateId(): string {
    return String(++this.nextId);
  }

  public push(entry: LocalsRingBufferEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  public getById(id: string): LocalsRingBufferEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].id === id) return this.entries[i];
    }
    return undefined;
  }

  public findByIdentity(key: {
    requestId: string | null;
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): LocalsRingBufferEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount &&
        e.structuralHash === key.structuralHash
      ) {
        return e;
      }
    }
    return undefined;
  }

  public findByDegradedKey(
    key: Omit<Parameters<LocalsRingBuffer['findByIdentity']>[0], 'structuralHash'>
  ): LocalsRingBufferEntry[] {
    const out: LocalsRingBufferEntry[] = [];
    for (const e of this.entries) {
      if (
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount
      ) out.push(e);
    }
    return out;
  }

  public findByLooseKey(
    key: { requestId: string | null; errorName: string; errorMessage: string }
  ): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.requestId === key.requestId &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage
    );
  }

  public findBackgroundMatches(key: {
    errorName: string;
    errorMessage: string;
    frameCount: number;
    structuralHash: string;
  }): LocalsRingBufferEntry[] {
    return this.entries.filter(
      (e) =>
        e.requestId === null &&
        e.errorName === key.errorName &&
        e.errorMessage === key.errorMessage &&
        e.frameCount === key.frameCount &&
        e.structuralHash === key.structuralHash
    );
  }
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts -t "ring buffer structure"
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): LocalsRingBuffer + ERRORCORE_CAPTURE_ID_SYMBOL [G1]"
```

---

### Task 19: Structural hash and frame-count computation from V8 call frames

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/v8-inspector.test.ts`:

```typescript
describe('G1 — structural hash', () => {
  it('hashes function names only, not paths', () => {
    const h1 = computeStructuralHash([
      { functionName: 'GET', url: '/a/b.js' },
      { functionName: 'handler', url: '/c/d.js' }
    ]);
    const h2 = computeStructuralHash([
      { functionName: 'GET', url: '/x/y.js' },
      { functionName: 'handler', url: '/z/w.js' }
    ]);
    expect(h1).toBe(h2);
  });

  it('different function names → different hashes', () => {
    const h1 = computeStructuralHash([{ functionName: 'GET', url: '/a.js' }]);
    const h2 = computeStructuralHash([{ functionName: 'POST', url: '/a.js' }]);
    expect(h1).not.toBe(h2);
  });

  it('empty function names collapse to a common hash (minification fingerprint)', () => {
    const h = computeStructuralHash([
      { functionName: '', url: '/a.js' },
      { functionName: '', url: '/b.js' }
    ]);
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('G1 — frame count from callFrames', () => {
  it('returns callFrames.length', () => {
    expect(countCallFrames([
      { functionName: 'a' }, { functionName: 'b' }, { functionName: 'c' }
    ] as never)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/v8-inspector.test.ts -t "structural hash|frame count"`
Expected: FAIL.

- [ ] **Step 3: Implement the two helpers**

Add to `src/capture/inspector-manager.ts`:

```typescript
import { createHash } from 'node:crypto';

export function computeStructuralHash(frames: Array<{ functionName: string }>): string {
  const joined = frames.map((f) => f.functionName || '<anonymous>').join('\u241F');
  return createHash('sha1').update(joined).digest('hex');
}

export function countCallFrames(frames: Array<{ functionName: string }>): number {
  return frames.length;
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): structural hash + frame-count helpers [G1]"
```

---

### Task 20: Layer 1 — Symbol tag installation via `Runtime.callFunctionOn`

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G1 — Layer 1: tag via Runtime.callFunctionOn', () => {
  it('installs Symbol.for(errorcore.v1.captureId) on the exception object', () => {
    // Use real node:inspector session via helper; throw + catch, assert the tag
    const { runInPausedHandler, injectedId } = runCaptureScenarioWithRealInspector(
      () => { throw new Error('tagging-test'); }
    );
    const tagged = (runInPausedHandler.caughtError as unknown as Record<symbol, unknown>)[
      Symbol.for('errorcore.v1.captureId')
    ];
    expect(tagged).toBe(injectedId);
  });

  it('returns the existing id on re-throw (idempotent)', () => {
    // Tag error once, throw it again — second pause should not overwrite
    const { firstId, secondId } = runDoubleThrowScenario();
    expect(firstId).toBe(secondId);
  });

  it('skips tagging for primitive throws (gracefully returns undefined)', () => {
    const result = runPrimitiveThrowScenario();
    expect(result.returnedId).toBeUndefined();
  });
});
```

(`runCaptureScenarioWithRealInspector`, `runDoubleThrowScenario`, `runPrimitiveThrowScenario` are new helpers that exercise the inspector against actual V8 pauses — see existing `test/unit/v8-inspector.test.ts` for its mock inspector pattern; extend that pattern.)

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/v8-inspector.test.ts -t "Layer 1: tag"`
Expected: FAIL.

- [ ] **Step 3: Implement tagging in `_onPaused`**

Add a new method to `InspectorManager`:

```typescript
  private installCaptureTag(
    exceptionObjectId: string,
    captureId: string
  ): void {
    if (this.session === null) return;
    const functionDeclaration = `
      function(symbolKey, captureId) {
        if (this == null) return undefined;
        const existing = this[symbolKey];
        if (typeof existing === 'string') return existing;
        if (Object.isFrozen(this)) return undefined;
        try {
          Object.defineProperty(this, symbolKey, {
            value: captureId,
            enumerable: false,
            configurable: false,
            writable: false
          });
          return captureId;
        } catch {
          return undefined;
        }
      }
    `;
    this.session.post(
      'Runtime.callFunctionOn' as never,
      {
        functionDeclaration,
        objectId: exceptionObjectId,
        arguments: [
          { value: 'errorcore.v1.captureId' },  // Symbol.for key (string form; the function body calls Symbol.for implicitly via this)
          { value: captureId }
        ],
        returnByValue: true,
        silent: true
      } as never,
      () => undefined
    );
  }
```

Note: the function body's `Symbol.for(symbolKey)` — update the function declaration to call `Symbol.for` on the string arg:

```js
function(symbolKeyName, captureId) {
  const sym = Symbol.for(symbolKeyName);
  if (this == null) return undefined;
  const existing = this[sym];
  if (typeof existing === 'string') return existing;
  if (Object.isFrozen(this)) return undefined;
  try {
    Object.defineProperty(this, sym, {
      value: captureId,
      enumerable: false,
      configurable: false,
      writable: false
    });
    return captureId;
  } catch {
    return undefined;
  }
}
```

In `_onPaused`, after gathering frames and computing key fields, allocate `const captureId = this.ringBuffer.allocateId();`, push the entry, then call `this.installCaptureTag(params.data?.objectId, captureId)` when `params.data?.objectId` is defined.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts -t "Layer 1"
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): Layer 1 — tag exception with Symbol.for capture id [G1]"
```

---

### Task 21: Layer 1 lookup — read Symbol tag off the error object

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G1 — Layer 1 lookup', () => {
  it('getLocalsWithDiagnostics returns frames when error has the captureId Symbol', () => {
    const rb = new LocalsRingBuffer(10);
    const id = rb.allocateId();
    rb.push({
      id, requestId: 'r', errorName: 'E', errorMessage: 'm',
      frameCount: 1, structuralHash: 'h',
      frames: [{ functionName: 'f', filePath: '/x.js', lineNumber: 1, columnNumber: 1, locals: { a: 1 } }],
      createdAt: Date.now()
    });
    const err = new Error('m');
    (err as unknown as Record<symbol, unknown>)[Symbol.for('errorcore.v1.captureId')] = id;

    const mgr = buildInspectorWithRingBuffer(rb);
    const { frames, missReason } = mgr.getLocalsWithDiagnostics(err);
    expect(frames).toHaveLength(1);
    expect(frames![0].locals).toEqual({ a: 1 });
    expect(missReason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/v8-inspector.test.ts -t "Layer 1 lookup"`
Expected: FAIL.

- [ ] **Step 3: Implement Layer 1 read in `getLocalsWithDiagnostics`**

At the top of `getLocalsWithDiagnostics`, before any path-based lookup:

```typescript
    // Layer 1 — tag read
    const taggedId = (error as unknown as Record<symbol, unknown>)[
      ERRORCORE_CAPTURE_ID_SYMBOL
    ];
    if (typeof taggedId === 'string') {
      const entry = this.ringBuffer.getById(taggedId);
      if (entry !== undefined) {
        return {
          frames: entry.frames,
          missReason: null,
          captureLayer: 'tag',
          degradation: 'exact',
        };
      }
    }
```

Adjust the return type to carry `captureLayer` and `degradation`.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): Layer 1 lookup by Symbol tag [G1]"
```

---

### Task 22: Layer 2 lookup — identity tuple with degradation

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G1 — Layer 2 identity lookup', () => {
  it('exact match returns frames with captureLayer=identity, degradation=exact', () => {
    const rb = new LocalsRingBuffer(10);
    const id = rb.allocateId();
    rb.push({
      id, requestId: 'r1', errorName: 'TypeError', errorMessage: 'oops',
      frameCount: 2, structuralHash: computeStructuralHash([{ functionName: 'h' }, { functionName: 'x' }]),
      frames: [], createdAt: Date.now()
    });
    const err = new TypeError('oops');
    err.stack = 'TypeError: oops\n    at h (/a.js:1:1)\n    at x (/b.js:1:1)';
    const mgr = buildInspectorWithRingBuffer(rb, { currentRequestId: 'r1' });
    const { captureLayer, degradation } = mgr.getLocalsWithDiagnostics(err);
    expect(captureLayer).toBe('identity');
    expect(degradation).toBe('exact');
  });

  it('degrades to dropped_hash when structuralHash mismatches but count + name + message agree', () => {
    // ... similar setup ...
  });

  it('degrades to background when requestId is null', () => {
    // ... similar setup ...
  });

  it('refuses ambiguous background matches, returns null with captureFailures entry', () => {
    // ... ring buffer has two different-frame entries with same (name, message, count, hash), no requestId ...
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/v8-inspector.test.ts -t "Layer 2 identity"`
Expected: FAIL.

- [ ] **Step 3: Implement the degradation cascade**

Replace the existing path-based lookup in `getLocalsWithDiagnostics` with:

```typescript
    const requestId = this.getRequestId() ?? null;
    const errorName = error.name || 'Error';
    const errorMessage = error.message || '';
    const stackFrames = parseStackForFunctionNames(error.stack);
    const frameCount = stackFrames.length;
    const structuralHash = computeStructuralHash(stackFrames);

    if (requestId !== null) {
      // Step 1: full key
      const exact = this.ringBuffer.findByIdentity({
        requestId, errorName, errorMessage, frameCount, structuralHash
      });
      if (exact !== undefined) {
        return { frames: exact.frames, missReason: null, captureLayer: 'identity', degradation: 'exact' };
      }
      // Step 2: drop hash
      const droppedHash = this.ringBuffer.findByDegradedKey({
        requestId, errorName, errorMessage, frameCount
      });
      if (droppedHash.length === 1) {
        return {
          frames: droppedHash[0].frames, missReason: null,
          captureLayer: 'identity', degradation: 'dropped_hash'
        };
      }
      // Step 3: drop frameCount (name + message within request)
      const looseRequest = this.ringBuffer.findByLooseKey({ requestId, errorName, errorMessage });
      if (looseRequest.length === 1) {
        return {
          frames: looseRequest[0].frames, missReason: null,
          captureLayer: 'identity', degradation: 'dropped_count'
        };
      }
    } else {
      // Step 4: background match
      const candidates = this.ringBuffer.findBackgroundMatches({
        errorName, errorMessage, frameCount, structuralHash
      });
      if (candidates.length === 1) {
        return {
          frames: candidates[0].frames, missReason: null,
          captureLayer: 'identity', degradation: 'background'
        };
      }
      if (candidates.length > 1) {
        return {
          frames: null, missReason: 'ambiguous_context_less_match',
          captureLayer: 'identity', degradation: 'background'
        };
      }
    }

    return {
      frames: null,
      missReason: `no_correlation (pauses=${this.pauseEventsReceived})`,
      captureLayer: undefined,
      degradation: undefined,
    };
```

Add `parseStackForFunctionNames(error.stack)` that splits the stack into `{ functionName }[]`.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts -t "Layer 2"
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): Layer 2 identity-tuple lookup with degradation [G1]"
```

---

### Task 23: Layer 3 — Frame-index alignment at serialization

**Files:**
- Modify: `src/capture/error-capturer.ts`
- Modify: `src/capture/package-builder.ts`
- Test: `test/unit/error-capture-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G1 — Layer 3 frame-index alignment', () => {
  it('attaches locals to rendered frames by index when counts match', () => {
    // fixture: 3 V8 frames captured, 3 rendered frames after resolve
    const pkg = buildPackageWithLocalsAndRenderedStack({
      locals: [{ frameIdx: 0, locals: { a: 1 } }, { frameIdx: 1, locals: { b: 2 } }, { frameIdx: 2, locals: { c: 3 } }],
      renderedFrameCount: 3
    });
    expect(pkg.localVariables).toHaveLength(3);
    expect(pkg.completeness.localVariablesFrameAlignment).toBe('full');
  });

  it('attaches locals to common prefix only when rendered count is smaller', () => {
    const pkg = buildPackageWithLocalsAndRenderedStack({
      locals: [{ frameIdx: 0 }, { frameIdx: 1 }, { frameIdx: 2 }],
      renderedFrameCount: 2
    });
    expect(pkg.localVariables).toHaveLength(2);
    expect(pkg.completeness.localVariablesFrameAlignment).toBe('prefix_only');
  });
});
```

- [ ] **Step 2: Run, implement in `package-builder.ts`**

When building the package, iterate rendered frames by index; attach captured locals whose frame index ≤ rendered count. Set `localVariablesFrameAlignment` accordingly.

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run test/unit/error-capture-pipeline.test.ts
git add src/capture/error-capturer.ts src/capture/package-builder.ts test/unit/error-capture-pipeline.test.ts
git commit -m "feat(capture): Layer 3 frame-index alignment with prefix_only fallback [G1]"
```

---

### Task 24: Graceful-absence flags (worker thread, primitive throw, frozen error, cross-realm)

**Files:**
- Modify: `src/capture/inspector-manager.ts`
- Test: `test/unit/v8-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe('G1 — graceful absence flags', () => {
  it('sets missReason=not_available_in_worker when isMainThread is false', () => {
    // Mock worker_threads.isMainThread = false; construct InspectorManager; verify available=false + reason
  });

  it('primitive throw records missReason=primitive_throw on Layer 2 fingerprint path', () => {
    const mgr = buildInspectorWithRingBuffer(new LocalsRingBuffer(4));
    const { missReason } = mgr.getLocalsWithDiagnostics(42 as unknown as Error);
    expect(missReason).toContain('primitive_throw');
  });

  it('frozen error goes through Layer 2 identity lookup; flags frozen_exception if tag install skipped', () => {
    // ... setup ...
  });
});
```

- [ ] **Step 2: Implement the guards**

At the top of `getLocalsWithDiagnostics`:

```typescript
    if (!this.isMainThread()) {
      return { frames: null, missReason: 'not_available_in_worker' };
    }
    if (error == null || typeof error !== 'object') {
      return {
        frames: null,
        missReason: `primitive_throw (value=${typeof error})`
      };
    }
```

And in `installCaptureTag`, pass a `wasFrozen` flag back to `_onPaused`; store as `frozen` in the ring-buffer entry. At lookup time if the entry match reports `frozen`, include `frozen_exception` in the `captureFailures`.

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run test/unit/v8-inspector.test.ts
git add src/capture/inspector-manager.ts test/unit/v8-inspector.test.ts
git commit -m "feat(inspector): graceful-absence flags for worker/primitive/frozen [G1]"
```

---

### Task 25: Plumb `localVariablesCaptureLayer` / `Degradation` / `FrameAlignment` into completeness

**Files:**
- Modify: `src/capture/error-capturer.ts`
- Modify: `src/capture/package-builder.ts`
- Modify: `src/types.ts` (`ErrorPackageParts` if not yet)
- Test: `test/unit/error-capture-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('completeness includes localVariablesCaptureLayer=tag when Layer 1 fires', async () => {
  // Tag an error; capture; check completeness
});
it('completeness includes localVariablesCaptureLayer=identity + degradation when Layer 2 fires', async () => {
  // ...
});
```

- [ ] **Step 2: Thread fields through**

`ErrorCapturer.safeGetLocals` returns `{ frames, missReason, captureLayer?, degradation? }`. Update `ErrorPackageParts` to include `localVariablesCaptureLayer`, `localVariablesDegradation`. `PackageBuilder` passes through to `Completeness`.

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run test/unit/error-capture-pipeline.test.ts
git add src/capture/error-capturer.ts src/capture/package-builder.ts src/types.ts test/unit/error-capture-pipeline.test.ts
git commit -m "feat(capture): surface L1/L2/L3 telemetry in completeness [G1]"
```

---

## Phase 7 — C1 Next.js middleware

### Task 26: Structural types for `NextRequest` / `NextResponse`

**Files:**
- Modify: `src/integrations/nextjs/types.ts`

- [ ] **Step 1: Add types**

Append to `src/integrations/nextjs/types.ts`:

```typescript
export interface NextRequestLike {
  method: string;
  url: string;
  headers: {
    forEach(cb: (value: string, key: string) => void): void;
    entries?(): IterableIterator<[string, string]>;
  };
}

export interface ResponseLike {
  status: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/integrations/nextjs/types.ts
git commit -m "feat(nextjs): structural NextRequestLike + ResponseLike types [C1]"
```

---

### Task 27: `withNextMiddleware` Node implementation

**Files:**
- Create: `src/integrations/nextjs/middleware.ts`
- Test: `test/unit/integrations/nextjs/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/integrations/nextjs/middleware.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { withNextMiddleware } from '../../../../src/integrations/nextjs/middleware';

describe('C1 — withNextMiddleware', () => {
  it('passes through when SDK is not active', async () => {
    const inner = vi.fn(async () => new Response(null, { status: 200 }));
    const wrapped = withNextMiddleware(inner, null as never);
    const req = makeFakeNextRequest({ method: 'GET', url: '/' });
    const res = await wrapped(req);
    expect(inner).toHaveBeenCalledWith(req);
    expect((res as Response).status).toBe(200);
  });

  it('starts ALS context when SDK is active and propagates into inner', async () => {
    const sdk = makeFakeActiveSDK();
    let seenRequestId: string | null = null;
    const inner = vi.fn(async () => {
      seenRequestId = sdk.als.getContext()?.requestId ?? null;
      return undefined;
    });
    const wrapped = withNextMiddleware(inner, sdk);
    await wrapped(makeFakeNextRequest({ method: 'GET', url: '/x' }));
    expect(seenRequestId).not.toBeNull();
    expect(sdk.requestTracker.add).toHaveBeenCalled();
    expect(sdk.requestTracker.remove).toHaveBeenCalled();
  });

  it('undefined return is always pass-through regardless of captureMiddlewareStatusCodes', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'all' });
    const wrapped = withNextMiddleware(async () => undefined, sdk);
    const res = await wrapped(makeFakeNextRequest({ method: 'GET', url: '/' }));
    expect(res).toBeUndefined();
    expect(sdk.captureError).not.toHaveBeenCalled();
  });

  it('captures a MiddlewareRejection when returned status matches captureMiddlewareStatusCodes array', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: [401, 500] });
    const wrapped = withNextMiddleware(
      async () => new Response('denied', { status: 401 }),
      sdk
    );
    await wrapped(makeFakeNextRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MiddlewareRejection' })
    );
  });

  it('captures all non-2xx when captureMiddlewareStatusCodes is all', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'all' });
    const wrapped = withNextMiddleware(
      async () => new Response(null, { status: 503 }),
      sdk
    );
    await wrapped(makeFakeNextRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).toHaveBeenCalled();
  });

  it('does not capture any response when captureMiddlewareStatusCodes is none (default)', async () => {
    const sdk = makeFakeActiveSDK({ captureMiddlewareStatusCodes: 'none' });
    const wrapped = withNextMiddleware(
      async () => new Response(null, { status: 500 }),
      sdk
    );
    await wrapped(makeFakeNextRequest({ method: 'GET', url: '/x' }));
    expect(sdk.captureError).not.toHaveBeenCalled();
  });

  it('captures thrown errors and rethrows', async () => {
    const sdk = makeFakeActiveSDK();
    const boom = new Error('boom');
    const wrapped = withNextMiddleware(async () => { throw boom; }, sdk);
    await expect(wrapped(makeFakeNextRequest({ method: 'GET', url: '/' }))).rejects.toBe(boom);
    expect(sdk.captureError).toHaveBeenCalledWith(boom);
  });

  it('nested context — skips creating a new one when als.getContext is already set', async () => {
    const sdk = makeFakeActiveSDK({ existingContext: true });
    const inner = vi.fn(async () => undefined);
    const wrapped = withNextMiddleware(inner, sdk);
    await wrapped(makeFakeNextRequest({ method: 'GET', url: '/' }));
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/integrations/nextjs/middleware.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `src/integrations/nextjs/middleware.ts`**

```typescript
import {
  filterHeaders,
  getModuleInstance,
  warnIfUninitialized,
  type SDKInstanceLike,
} from '../../middleware/common';
import type { NextRequestLike, ResponseLike } from './types';

type MiddlewareHandler = (req: NextRequestLike) => Promise<ResponseLike | undefined>;

function shouldCaptureStatus(
  status: number,
  config: number[] | 'none' | 'all'
): boolean {
  if (config === 'none') return false;
  if (config === 'all') return status < 200 || status >= 300;
  return config.includes(status);
}

export function withNextMiddleware(
  middleware: MiddlewareHandler,
  sdk?: SDKInstanceLike
): MiddlewareHandler {
  return async (req) => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive()) {
      warnIfUninitialized('withNextMiddleware()');
      return middleware(req);
    }

    if (instance.als.getContext?.() !== undefined) {
      return middleware(req);
    }

    let context: import('../../types').RequestContext;
    try {
      const headers: Record<string, string> = {};
      let traceparent: string | undefined;
      req.headers.forEach((value, key) => {
        headers[key] = value;
        if (key === 'traceparent') traceparent = value;
      });
      context = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: filterHeaders(instance, headers),
        traceparent,
      });
    } catch {
      return middleware(req);
    }

    instance.requestTracker.add(context);

    try {
      return await instance.als.runWithContext(context, async () => {
        const result = await middleware(req);

        if (result === undefined) return undefined;

        const cfg = (instance as unknown as {
          config: { captureMiddlewareStatusCodes: number[] | 'none' | 'all' };
        }).config.captureMiddlewareStatusCodes ?? 'none';

        if (
          instance.captureError !== undefined &&
          typeof (result as { status?: unknown }).status === 'number' &&
          shouldCaptureStatus((result as { status: number }).status, cfg)
        ) {
          try {
            const err = new Error(`Middleware returned HTTP ${(result as { status: number }).status}`);
            err.name = 'MiddlewareRejection';
            instance.captureError(err);
          } catch {}
        }

        return result;
      });
    } catch (err) {
      if (instance.captureError !== undefined && err instanceof Error) {
        try { instance.captureError(err); } catch {}
      }
      throw err;
    } finally {
      instance.requestTracker.remove(context.requestId);
    }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/integrations/nextjs/middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/nextjs/middleware.ts test/unit/integrations/nextjs/middleware.test.ts
git commit -m "feat(nextjs): withNextMiddleware wrapper with captureMiddlewareStatusCodes [C1]"
```

---

### Task 28: Re-export `withNextMiddleware` from `errorcore/nextjs` Node entry

**Files:**
- Modify: `src/integrations/nextjs/index.ts`
- Test: `test/unit/integrations/nextjs/exports-shape.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/integrations/nextjs/exports-shape.test.ts`:

```typescript
it('Node entry exports withNextMiddleware', () => {
  const mod = require('../../../../src/integrations/nextjs/index');
  expect(typeof mod.withNextMiddleware).toBe('function');
});
```

- [ ] **Step 2: Add the re-export**

In `src/integrations/nextjs/index.ts`:

```typescript
export { withNextMiddleware } from './middleware';
```

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run test/unit/integrations/nextjs/
git add src/integrations/nextjs/index.ts test/unit/integrations/nextjs/exports-shape.test.ts
git commit -m "feat(nextjs): export withNextMiddleware from subpath [C1]"
```

---

### Task 29: Edge stub passthrough for `withNextMiddleware`

**Files:**
- Modify: `src/integrations/nextjs/edge.mts`
- Test: `test/unit/integrations/nextjs/edge-stub.test.ts`, `test/unit/integrations/nextjs/exports-shape.test.ts`

- [ ] **Step 1: Add the Edge stub passthrough**

Append to `edge.mts`:

```typescript
export function withNextMiddleware<TReq, TResult>(
  middleware: (req: TReq) => Promise<TResult>,
  _sdk?: unknown,
): (req: TReq) => Promise<TResult> {
  return middleware;
}
```

- [ ] **Step 2: Add an edge-stub test**

Append:

```typescript
it('withNextMiddleware is passthrough in Edge stub', async () => {
  const inner = async (req: { ok: boolean }) => req.ok;
  const wrapped = withNextMiddleware(inner);
  await expect(wrapped({ ok: true })).resolves.toBe(true);
});
```

- [ ] **Step 3: Run tests, build, verify edge stub**

```bash
npx vitest run test/unit/integrations/nextjs/
npm run build
npm run verify:edge-stub
```

Expected: PASS on all three.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/nextjs/edge.mts test/unit/integrations/nextjs/edge-stub.test.ts test/unit/integrations/nextjs/exports-shape.test.ts
git commit -m "feat(nextjs): Edge stub passthrough for withNextMiddleware [C1]"
```

---

## Phase 8 — Config templates, docs, release

### Task 30: Update config templates for G4 migration

**Files:**
- Modify: `config-template/errorcore.config.js`
- Modify: `config-template/errorcore.config.minimal.js`

- [ ] **Step 1: Update `errorcore.config.js`**

Replace the `allowInsecureTransport: false,` line (if present) or ensure the template has the migration comment:

```js
  // allowInsecureTransport: removed in 0.2.0, see CHANGELOG — use allowPlainHttpTransport
  // allowPlainHttpTransport: false,
```

Confirm `allowPlainHttpTransport: false,` is still present as before.

- [ ] **Step 2: Update `errorcore.config.minimal.js`**

No action needed if it doesn't mention `allowInsecureTransport`, but verify:

```bash
grep -n allowInsecureTransport config-template/errorcore.config.minimal.js
```

- [ ] **Step 3: Commit**

```bash
git add config-template/
git commit -m "docs(config-template): document allowInsecureTransport removal [G4]"
```

---

### Task 31: CHANGELOG 0.2.0 entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read current top of CHANGELOG**

Run: `head -40 CHANGELOG.md`

- [ ] **Step 2: Prepend the 0.2.0 block**

Prepend the 0.2.0 section exactly as written in spec §10.2 of `docs/superpowers/specs/2026-04-20-errorcore-gap-fixes-design.md`. Set date to today or leave as `(2026-MM-DD)` for release-time substitution.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 0.2.0 entry with breaking-change migration notice"
```

---

### Task 32: README three-tier driver block

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate an appropriate insertion point**

Run: `grep -n "^##" README.md | head -20`

Identify the "Installation" or "Usage" section; insert after.

- [ ] **Step 2: Add the three-tier block**

Insert the three-tier section from spec §4.4 (verbatim the block starting `> **Tier 1 — Plain Node.js** ...`). Include a link to `spec/08-io-recording.md` and `spec/17-nextjs-integration.md`.

- [ ] **Step 3: Add a short note about the startup diagnostic verbosity**

Below the three-tier block, add:

```md
### Startup output

errorcore prints one diagnostic line at `init()`. When any recorder reports `warn(...)`, additional guidance lines appear (3–6 lines total is normal). Suppress entirely with `silent: true`.
```

- [ ] **Step 4: Add a short "Next.js middleware" note**

```md
### Next.js middleware

If you use Next.js middleware (for auth, routing, etc.), wrap it with `withNextMiddleware` to get ALS-correlated error capture. See [spec/17-nextjs-integration.md](./spec/17-nextjs-integration.md).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): three-tier driver guidance, startup diagnostic, middleware [G2, C1]"
```

---

### Task 33: Update `spec/08-io-recording.md` with tier doc and channel shape contract

**Files:**
- Modify: `spec/08-io-recording.md`

- [ ] **Step 1: Add a new section "Tiered driver support"**

Mirror spec §4.4 verbatim.

- [ ] **Step 2: Add a "Channel payload shapes" table**

Mirror spec §4.2 table verbatim.

- [ ] **Step 3: Commit**

```bash
git add spec/08-io-recording.md
git commit -m "docs(spec/08): tier doc + channel payload shape contracts [G2]"
```

---

### Task 34: Update `spec/09-database-patches.md` with `drivers` option

**Files:**
- Modify: `spec/09-database-patches.md`

- [ ] **Step 1: Add a "drivers config option" section**

Describe:
- Purpose
- Signature (from Task 1 types)
- Per-recorder tier mapping (Tier 1/2/3)
- `explicitDriver` semantics in `PatchInstallDeps`

- [ ] **Step 2: Commit**

```bash
git add spec/09-database-patches.md
git commit -m "docs(spec/09): drivers config option and explicitDriver contract [G2]"
```

---

### Task 35: Update `spec/10-channel-subscriber.md` with dual response subscription

**Files:**
- Modify: `spec/10-channel-subscriber.md`

- [ ] **Step 1: Document the dual-subscribe pattern**

Explain: both `http.server.response.finish` and `http.server.response.created` are subscribed when available; dedup by request identity via a `WeakSet<IncomingMessage>`.

- [ ] **Step 2: Commit**

```bash
git add spec/10-channel-subscriber.md
git commit -m "docs(spec/10): dual subscribe for response.finish and response.created [G2]"
```

---

### Task 36: Update `spec/12-v8-inspector.md` with the three-layer design

**Files:**
- Modify: `spec/12-v8-inspector.md`

- [ ] **Step 1: Replace the "Internal cache" section with a Ring Buffer section**

Copy the three-layer design section from `docs/superpowers/specs/2026-04-20-errorcore-gap-fixes-design.md` §3 verbatim into an "Identity-based correlation" section.

Retain the existing Debugger protocol subsection; update the "cache key" prose.

- [ ] **Step 2: Commit**

```bash
git add spec/12-v8-inspector.md
git commit -m "docs(spec/12): three-layer inspector correlation design [G1]"
```

---

### Task 37: Update `spec/13-error-capture-pipeline.md` with resolve-path contract

**Files:**
- Modify: `spec/13-error-capture-pipeline.md`

- [ ] **Step 1: Describe sync-on-miss, size gate, three-state cache, negative entry TTL**

Mirror spec §5.

- [ ] **Step 2: Commit**

```bash
git add spec/13-error-capture-pipeline.md
git commit -m "docs(spec/13): source-map resolve-path sync-on-miss contract [G3]"
```

---

### Task 38: Update `spec/17-nextjs-integration.md` with middleware + edge sections

**Files:**
- Modify: `spec/17-nextjs-integration.md`

- [ ] **Step 1: Add a "Middleware capture (C1)" section**

Reference the new `withNextMiddleware` export. Include:
- Signature
- `captureMiddlewareStatusCodes` semantics
- ALS propagation contract
- Undefined return pass-through

- [ ] **Step 2: Add an "Edge runtime capture (C2)" section**

Mirror spec §8 verbatim including the `encryptForIngest` example and unencrypted caveat.

- [ ] **Step 3: Commit**

```bash
git add spec/17-nextjs-integration.md
git commit -m "docs(spec/17): middleware capture section + Edge guidance [C1, C2]"
```

---

### Task 39: Add `followups.md` entries

**Files:**
- Modify: `followups.md`

- [ ] **Step 1: Append**

```md
## 0.2.0 deferrals

- **Byte-size cache budget for SourceMapResolver** — secondary eviction criterion beyond count-of-128. Add when we observe cache memory footprint in production.
- **Lifetime sync-parse budget** — e.g., 2s cumulative per activate(), then fall back to async-with-flag. Add if we observe cold-cascade blocking beyond the 2MB size gate's mitigation.
- **parseTimeoutMs** — clock-check inside consumer builder loop. Only when `source_map_async_pending` rate justifies the complexity.
- **Public advanced API subpath** (`errorcore/advanced`, `getSDK(): AdvancedSDKHandle`) — materialize when concrete user demand emerges for bespoke middleware wrapping beyond `withNextMiddleware`.
- **1.0.0 release** — concurrent with ingestion-backend commercial availability.
```

- [ ] **Step 2: Commit**

```bash
git add followups.md
git commit -m "docs(followups): 0.2.0 deferrals — byte budget, parseTimeoutMs, advanced API, 1.0.0"
```

---

## Phase 9 — Integration smoke

### Task 40: Upgrade `tmp-nextjs-smoke/` into a real `next build && next start` fixture

**Files:**
- Create: `tmp-nextjs-smoke/app/api/test-error/route.ts`
- Create: `tmp-nextjs-smoke/app/layout.tsx`
- Create: `tmp-nextjs-smoke/app/page.tsx`
- Create: `tmp-nextjs-smoke/instrumentation.ts`
- Create: `tmp-nextjs-smoke/next.config.js`
- Modify: `tmp-nextjs-smoke/package.json`
- Create: `tmp-nextjs-smoke/run-smoke.mjs`

- [ ] **Step 1: Add Next.js as a dev dependency**

In `tmp-nextjs-smoke/package.json`, add:

```json
{
  "dependencies": {
    "next": "14.2.33",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "errorcore": "file:.."
  }
}
```

Run: `cd tmp-nextjs-smoke && npm install`

- [ ] **Step 2: Create `next.config.js`**

```js
module.exports = {
  webpack: (config, { isServer }) => {
    if (isServer) config.devtool = 'source-map';
    return config;
  },
};
```

- [ ] **Step 3: Create `instrumentation.ts`**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const errorcore = await import('errorcore');
    errorcore.init({
      transport: { type: 'file', path: './smoke-errors.ndjson' },
      captureLocalVariables: true,
      allowUnencrypted: true,
    });
  }
}
```

- [ ] **Step 4: Create `app/api/test-error/route.ts`**

```ts
import { withErrorcore } from 'errorcore/nextjs';

interface User { id: string; tier: 'gold' | 'silver'; }
interface Cart { items: Array<{ price: number; qty: number }>; promoCode?: string; }

function lookupPromo(code: string): number {
  return code === 'WELCOME10' ? 0.1 : 0;
}

function computeUserDiscount(user: User, cart: Cart): number {
  const base = cart.items.reduce((s, it) => s + it.price * it.qty, 0);
  const tierMultiplier = user.tier === 'gold' ? 0.8 : 1.0;
  const promoDiscount = cart.promoCode ? lookupPromo(cart.promoCode) : 0;
  throw new Error(`discount computation boom — base=${base} mult=${tierMultiplier} promo=${promoDiscount}`);
}

async function handler() {
  const user: User = { id: 'u1', tier: 'gold' };
  const cart: Cart = { items: [{ price: 100, qty: 2 }, { price: 50, qty: 1 }], promoCode: 'WELCOME10' };
  computeUserDiscount(user, cart);
  return Response.json({ ok: true });
}

export const GET = withErrorcore(handler);
```

- [ ] **Step 5: Create `app/layout.tsx` and `app/page.tsx`**

```tsx
// layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}

// page.tsx
export default function Page() { return <h1>smoke</h1>; }
```

- [ ] **Step 6: Create `run-smoke.mjs`**

```mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
process.chdir(here);

fs.rmSync('./smoke-errors.ndjson', { force: true });
const build = spawnSync('npx', ['next', 'build'], { stdio: 'inherit', shell: true });
if (build.status !== 0) process.exit(1);

const server = spawn('npx', ['next', 'start', '-p', '3099'], { stdio: 'inherit', shell: true });
await new Promise((r) => setTimeout(r, 5000));

try {
  const res = await fetch('http://localhost:3099/api/test-error');
  if (res.status !== 500) { console.error('expected 500, got', res.status); process.exit(1); }
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
}

const raw = fs.readFileSync('./smoke-errors.ndjson', 'utf8').trim();
const entries = raw.split('\n').map((l) => JSON.parse(l));
if (entries.length === 0) { console.error('no entries'); process.exit(1); }

const first = entries[0];

function fail(msg) { console.error('SMOKE FAIL:', msg); process.exit(1); }
if (first.completeness.ioTimelineCaptured !== true) fail('ioTimelineCaptured false');
if (!first.ioTimeline.some((e) => e.type === 'http-server')) fail('no http-server inbound');
if (first.completeness.localVariablesCaptured !== true) fail('localVariablesCaptured false');
const frame = (first.localVariables ?? []).find((f) => f.locals && (f.locals.user || f.locals.cart));
if (frame === undefined) fail('no frame with user/cart locals');
const hasIntermediate = ['base', 'tierMultiplier', 'promoDiscount'].some((k) => k in (frame.locals ?? {}));
if (!hasIntermediate) fail('no intermediate locals');

const firstFrame = first.error.stack.split('\n')[1] ?? '';
if (/\.next[\\/]server[\\/].*route\.js/.test(firstFrame)) fail('first frame not source-mapped');
if (!/webpack:|route\.ts/.test(firstFrame)) fail(`first frame not mapped: ${firstFrame}`);

const sm = first.completeness.sourceMapResolution;
if (!sm || sm.framesResolved <= 0) fail('sourceMapResolution.framesResolved <= 0');

console.log('SMOKE OK —', entries.length, 'entries');
```

- [ ] **Step 7: Add run scripts to root `package.json`**

Top-level `package.json`, in `scripts`:

```json
"smoke:nextjs": "cd tmp-nextjs-smoke && node run-smoke.mjs",
"smoke:nextjs:sourcemaps": "cd tmp-nextjs-smoke && cross-env NODE_OPTIONS=--enable-source-maps node run-smoke.mjs"
```

(Add `cross-env` as a devDependency.)

- [ ] **Step 8: Run the smoke**

```bash
npm run build
npm run smoke:nextjs
```

Expected: `SMOKE OK — N entries`.

- [ ] **Step 9: Commit**

```bash
git add tmp-nextjs-smoke/ package.json package-lock.json
git commit -m "test(smoke): real next build && next start fixture for G1/G2/G3 [CI]"
```

---

### Task 41: `--enable-source-maps` smoke variant

**Files:**
- (no new file; ensure the npm script works)

- [ ] **Step 1: Run the variant**

```bash
npm run smoke:nextjs:sourcemaps
```

Expected: `SMOKE OK — N entries`. Any failure surfaces G1 regressions under the native source-maps hook.

- [ ] **Step 2: If CI config exists, add both variants to CI**

If `.github/workflows/ci.yml` or similar exists, add jobs running the two smoke scripts on Node 18, 20, 22, 24. If no CI exists, add a TODO in `followups.md` noting the smoke scripts should be wired.

- [ ] **Step 3: Commit any CI changes**

```bash
git add .github/
git commit -m "ci: run nextjs smoke and --enable-source-maps variant across Node 18-24"
```

(Skip if no CI files were modified.)

---

## Phase 10 — Release

### Task 42: Version bump + final build + verify

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.1.1"` to `"version": "0.2.0"`.

- [ ] **Step 2: Build, test, verify edge stub, smoke**

```bash
npm run build
npm run test
npm run verify:edge-stub
npm run smoke:nextjs
```

Expected: All PASS.

- [ ] **Step 3: Commit and tag**

```bash
git add package.json package-lock.json
git commit -m "chore(release): 0.2.0"
git tag -a v0.2.0 -m "errorcore 0.2.0 — G1/G2/G3/G4/C1/C2 gap fixes"
```

- [ ] **Step 4: Merge to main**

Confirm with the maintainer before pushing. Suggested:

```bash
git checkout main
git merge --no-ff release/0.2.0-gap-fixes
git push origin main --tags
```

(Only run with explicit user approval.)

---

## Self-Review Checklist

After implementing, verify against the spec §12 Success Criteria:

- [ ] `completeness.captureFailures` is empty on entries with ALS context (blubeez-style fixture)
- [ ] `localVariablesCaptured: true` on Layer-1 entries; Layer-2 entries carry correct degradation flag
- [ ] `ioTimeline.length > 0` for every HTTP-triggered capture
- [ ] DB events populate iff the user set `serverExternalPackages` OR passed `drivers`; startup diagnostic says so explicitly
- [ ] First-hit stack from any new route is source-map-resolved (not `.next/server/…/route.js:1:column`)
- [ ] `next start` succeeds with `allowInsecureTransport: false` in config
- [ ] Clerk middleware rejections captured iff `captureMiddlewareStatusCodes` is set to include the status
- [ ] Startup line clearly communicates recorder states

---

## Notes

- Keep commits small and atomic — each task is one commit. The pre-existing `followups.md` pattern is used for deferrals.
- Every TDD cycle: red → green → commit. Do not batch.
- The G1 `callFunctionOn` path depends on `Debugger.setPauseOnExceptions: 'all'` — already set at [inspector-manager.ts:258](../../src/capture/inspector-manager.ts). Do not change to `'uncaught'`.
- The G3 sync-on-miss path must have **no async yield** between file read, JSON.parse, and cache set — verify by reading the final `getConsumer` top-to-bottom before committing Task 16.
- When touching any recorder, add a shape-assertion test; do not rely on documentation alone.
