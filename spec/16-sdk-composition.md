# Module 16: SDK Composition Root

> **Spec status:** LOCKED
> **Source files:** `src/sdk.ts`, `src/index.ts`
> **Dependencies:** ALL prior modules (01-15)
> **Build order position:** 16 (final)

---

## Module Contract Header

```typescript
/**
 * @module 16-sdk-composition
 * @spec spec/16-sdk-composition.md
 * @dependencies ALL modules (01-15)
 */
```

---

## Purpose

Wire all components together via dependency injection, manage the SDK lifecycle (activate, capture, shutdown), and expose the public API. This is the ONLY module that imports all other component classes.

---

## Scope

- `sdk.ts`: `createSDK()` function (composition root), `SDKInstance` class
- `index.ts`: thin public API facade with module-level state
- Shutdown orchestration (ordered teardown, signal handling, emergency flush)

---

## Non-Goals

- Does not implement any business logic. All logic lives in the component classes.
- Does not define types or interfaces (module 01 does that).

---

## Dependencies

All modules 01-15. This is the integration point.

---

## Node.js APIs Used

- `process.on('uncaughtException', handler)`
- `process.on('unhandledRejection', handler)`
- `process.on('beforeExit', handler)`
- `process.on('exit', handler)`
- `process.once('SIGTERM', handler)` / `process.once('SIGINT', handler)` (opt-in)
- `process.removeListener(event, handler)`
- `process.kill(process.pid, signal)` for signal re-raise

---

## Data Structures

### SDKInstance class

```typescript
class SDKInstance {
  private state: 'created' | 'active' | 'shutting_down' | 'shutdown';
  private timers: (NodeJS.Timeout | NodeJS.Timer)[];
  private processListeners: { event: string; handler: Function }[];

  readonly config: ResolvedConfig;
  readonly buffer: IOEventBuffer;
  readonly als: ALSManager;
  readonly requestTracker: RequestTracker;
  readonly inspector: InspectorManager;
  readonly channelSubscriber: ChannelSubscriber;
  readonly patchManager: PatchManager;
  readonly stateTracker: StateTracker;
  readonly errorCapturer: ErrorCapturer;
  readonly transport: TransportDispatcher;
  readonly processMetadata: ProcessMetadata;

  activate(): void;
  captureError(error: Error): void;
  trackState(name: string, container: Map<any, any> | Record<string, any>): typeof container;
  withContext<T>(fn: () => T): T;
  isActive(): boolean;
  shutdown(): Promise<void>;
  enableAutoShutdown(): void;
}
```

### Module-level public API (index.ts)

```typescript
let instance: SDKInstance | null = null;

export function init(config?: Partial<SDKConfig>): SDKInstance;
export function captureError(error: Error): void;
export function trackState(name: string, container: Map<any, any> | Record<string, any>): any;
export function withContext<T>(fn: () => T): T;
export function shutdown(): Promise<void>;
export function createSDK(config?: Partial<SDKConfig>): SDKInstance;
```

---

## Implementation Notes

### createSDK wiring order

```typescript
function createSDK(userConfig: Partial<SDKConfig> = {}): SDKInstance {
  const config = resolveConfig(userConfig);

  // Leaf components
  const buffer = new IOEventBuffer(config);
  const als = new ALSManager();
  const headerFilter = new HeaderFilter(config);
  const scrubber = new Scrubber(config);
  const rateLimiter = new RateLimiter(config);
  const encryption = config.encryptionKey ? new Encryption(config.encryptionKey) : null;
  const processMetadata = new ProcessMetadata(config);
  const inspector = new InspectorManager(config);

  // Mid-level components
  const requestTracker = new RequestTracker(config);
  const bodyCapture = new BodyCapture(config);
  const stateTracker = new StateTracker({ als });

  // Recorders
  const httpServer = new HttpServerRecorder({ buffer, als, requestTracker, bodyCapture, headerFilter, config });
  const httpClient = new HttpClientRecorder({ buffer, als, bodyCapture, headerFilter, config });
  const undiciRecorder = new UndiciRecorder({ buffer, als, headerFilter, config });
  const netDns = new NetDnsRecorder({ buffer, als, config });
  const patchManager = new PatchManager({ buffer, als, config });

  // Channel orchestration
  const channelSubscriber = new ChannelSubscriber({ httpServer, httpClient, undiciRecorder, netDns, config });

  // Capture pipeline
  const packageBuilder = new PackageBuilder({ scrubber, config });
  const transport = new TransportDispatcher({ config, encryption });
  const errorCapturer = new ErrorCapturer({
    buffer, als, inspector, rateLimiter, requestTracker,
    processMetadata, packageBuilder, transport, config
  });

  return new SDKInstance({ config, buffer, als, requestTracker, inspector,
    channelSubscriber, patchManager, stateTracker, errorCapturer, transport, processMetadata });
}
```

### SDKInstance.activate() sequence

```
1. processMetadata.collectStartupMetadata()
2. channelSubscriber.subscribeAll()
3. patchManager.installAll()
4. Register process handlers:
   - process.on('uncaughtException', handler)
   - process.on('unhandledRejection', handler)
   - process.on('beforeExit', handler)  // calls shutdown() idempotently
   - process.on('exit', handler)        // sync emergency flush
   Store all in this.processListeners
5. processMetadata.startEventLoopLagMeasurement()
6. transport.initialize()
7. if (!config.encryptionKey) warn to stderr
8. this.state = 'active'
```

### shutdown() sequence — idempotent

```
async shutdown():
  if state === 'shutting_down' || state === 'shutdown': return (already done)
  state = 'shutting_down'

  1. channelSubscriber.unsubscribeAll()       // stop recording
  2. patchManager.unwrapAll()                  // restore prototypes
  3. inspector.shutdown()                      // disconnect debugger
  4. Clear all timers in this.timers[]
  5. await transport.flush()                   // flush pending payloads
  6. await transport.shutdown({ timeoutMs: 5000 })  // terminate worker
  7. buffer.clear()                            // release body buffers
  8. Remove all process listeners
  9. state = 'shutdown'
```

### enableAutoShutdown() — opt-in signal handling

```
enableAutoShutdown():
  process.once('SIGTERM', async () => { await shutdown(); process.kill(process.pid, 'SIGTERM') })
  process.once('SIGINT', async () => { await shutdown(); process.kill(process.pid, 'SIGINT') })
```

Signal handlers are tracked in `processListeners` for cleanup.

NOT auto-registered because: registering `process.on('SIGTERM')` suppresses Node's default exit behavior. This could cause issues with container orchestrators' grace periods.

### process.on('beforeExit') handler

Calls `shutdown()` idempotently. Ensures cleanup even if user forgets to call `shutdown()`. Because all SDK timers are `.unref()`'d, the SDK does not prevent the process from reaching `beforeExit`.

### process.on('exit') handler — synchronous emergency flush

If `state` is still `'active'` when `exit` fires: best-effort synchronous flush via `transport.sendSync()`. Writes to stderr or file. This is a last-resort path.

### uncaughtException handler

```
1. errorCapturer.capture(error, { isUncaught: true })
2. If user had pre-existing uncaughtException listeners: let them run (Node calls all)
3. If no other listeners: process exits (Node default)
```

### unhandledRejection handler

```
1. errorCapturer.capture(error)
2. Let Node's default behavior proceed
```

### Public methods

- `captureError(error)`: no-op if state !== 'active'. Delegates to errorCapturer.capture.
- `trackState(name, container)`: delegates to stateTracker.track. Throws if not initialized.
- `withContext(fn)`: creates minimal RequestContext, runs fn inside ALS.
- `isActive()`: returns state === 'active'.

### index.ts facade

```typescript
export function init(config?: Partial<SDKConfig>): SDKInstance {
  if (instance) throw new Error('SDK already initialized. Call shutdown() first.');
  instance = createSDK(config ?? {});
  instance.activate();
  return instance;
}

export function captureError(error: Error): void {
  instance?.captureError(error);
}

export async function shutdown(): Promise<void> {
  if (!instance) return;
  await instance.shutdown();
  instance = null;
}
```

`instance` is the ONLY module-level mutable state in the entire SDK.

---

## Security Considerations

- The composition root is the only place where all sensitive components (inspector, encryption, transport) are wired. No external code can access these components except through the public API.
- `captureError` is a no-op during shutdown — prevents late captures from interfering with cleanup.
- Signal handlers re-raise the signal after shutdown to ensure the process exits.

---

## Edge Cases

- `init()` called twice without `shutdown()`: throws
- `captureError()` before `init()`: no-op (instance is null)
- `shutdown()` before `init()`: no-op (returns immediately)
- `shutdown()` called twice: second call resolves immediately (idempotent)
- `shutdown()` during active capture: capture completes, then shutdown proceeds
- Worker thread dies during shutdown: timeout + terminate
- `process.exit()` called directly: `exit` handler fires, sync flush
- `enableAutoShutdown()` + SIGTERM: shutdown runs, signal re-raised
- `enableAutoShutdown()` + user's own SIGTERM handler: both fire (ours first)

---

## Testing Requirements

- `createSDK()` returns SDKInstance with all components wired
- `activate()` subscribes channels, installs patches, registers handlers
- `captureError()` delegates to errorCapturer
- `captureError()` is no-op when not active
- `shutdown()` is idempotent
- After shutdown: channels unsubscribed, patches unwrapped, inspector off, timers cleared, listeners removed
- `init()` twice throws
- `shutdown()` then `init()` again works (re-initialization)
- `enableAutoShutdown()` registers signal handlers
- Process handler registration and removal verified
- Integration: full init -> capture -> shutdown cycle

---

## Completion Criteria

- `createSDK()` function exported, wires all components.
- `SDKInstance` class exported with activate/shutdown lifecycle.
- `index.ts` exports `init`, `captureError`, `trackState`, `withContext`, `shutdown`, `createSDK`.
- Shutdown sequence is ordered and idempotent.
- Signal handling is opt-in.
- Process handlers are registered and cleaned up correctly.
- Module-level state limited to single `instance` variable in `index.ts`.
- All unit and integration tests pass.
