# Module 15: Framework Middleware Adapters

> **Spec status:** LOCKED
> **Source files:** `src/middleware/express.ts`, `src/middleware/fastify.ts`, `src/middleware/koa.ts`, `src/middleware/hapi.ts`, `src/middleware/raw-http.ts`
> **Dependencies:** Module 01 (types), Module 06 (ALS, request tracker)
> **Build order position:** 15

---

## Module Contract Header

```typescript
/**
 * @module 15-middleware
 * @spec spec/15-middleware.md
 * @dependencies types.ts, als-manager.ts, request-tracker.ts
 */
```

---

## Purpose

Provide framework-specific middleware/plugin adapters that create the ALS `RequestContext`, enter the ALS context, and register the request in the active request tracker. These are a more reliable ALS entry point than the `diagnostics_channel` approach because frameworks may do async work between the raw HTTP event and the user's handler.

---

## Scope

- Express middleware factory
- Fastify plugin factory
- Koa middleware factory
- Hapi plugin factory
- Raw `http.createServer` handler wrapper

Each adapter accepts an optional `SDKInstance` parameter for dependency injection (tests pass isolated instances; production uses the module-level instance).

---

## Non-Goals

- Does not capture I/O events (recorders do that).
- Does not capture bodies (body capture does that).
- Does not subscribe to diagnostics channels.

---

## Dependencies

- Module 01: `RequestContext`, `ResolvedConfig`
- Module 06: `ALSManager`, `RequestTracker`

---

## Node.js APIs Used

- Framework-specific APIs (Express `(req, res, next)`, Fastify `addHook`, Koa `async (ctx, next)`, Hapi `server.ext`)
- `response.on('finish')` for cleanup

---

## Data Structures

### Express middleware

```typescript
export function expressMiddleware(sdk?: SDKInstance): (req: Request, res: Response, next: NextFunction) => void;
```

### Fastify plugin

```typescript
export function fastifyPlugin(sdk?: SDKInstance): FastifyPluginCallback;
```

### Koa middleware

```typescript
export function koaMiddleware(sdk?: SDKInstance): Koa.Middleware;
```

### Hapi plugin

```typescript
export const hapiPlugin: { name: string; register: (server: Server, options: { sdk?: SDKInstance }) => void };
```

### Raw HTTP wrapper

```typescript
export function wrapHandler(handler: (req: IncomingMessage, res: ServerResponse) => void, sdk?: SDKInstance): typeof handler;
```

---

## Implementation Notes

### Common pattern (all adapters)

```
1. Resolve SDK instance (parameter or module-level)
2. If SDK not active: pass through to next/handler without wrapping
3. Create RequestContext via als.createRequestContext({ method, url, headers })
   - Headers are extracted as plain strings (filtered by HeaderFilter if SDK provides it)
   - URL is the raw request URL string
4. Register context in requestTracker.add(ctx)
5. Listen for response.on('finish'): requestTracker.remove(ctx.requestId)
6. Enter ALS context: als.runWithContext(ctx, () => next/handler)
```

### Express

```typescript
export function expressMiddleware(sdk?: SDKInstance) {
  return (req, res, next) => {
    const s = sdk ?? getModuleInstance();
    if (!s?.isActive()) return next();
    const ctx = s.als.createRequestContext({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([,v]) => typeof v === 'string'))
    });
    s.requestTracker.add(ctx);
    res.on('finish', () => s.requestTracker.remove(ctx.requestId));
    s.als.runWithContext(ctx, () => next());
  };
}
```

### Fastify

Use `fastify.addHook('onRequest', handler)`. The hook receives `(request, reply, done)`. Call `als.runWithContext(ctx, () => done())`.

### Koa

Standard Koa middleware: `async (ctx, next) => { als.runWithContext(reqCtx, () => next()) }`. Note: Koa `ctx` is different from our `RequestContext` — extract `method` and `url` from `ctx.request`.

### Hapi

Use `server.ext('onRequest', (request, h) => { ... h.continue })`.

### Raw HTTP

Wrap the user's handler: return `(req, res) => { als.runWithContext(ctx, () => originalHandler(req, res)) }`.

### getModuleInstance helper

Each middleware file imports a `getModuleInstance()` function that returns the module-level SDKInstance from `index.ts`. This is the ONLY cross-module reference in middleware files, and it's a function call (not a direct import of the mutable variable).

---

## Security Considerations

- Middleware copies header values out of the request object (GC safety). It does NOT store a reference to the request.
- Headers passed to `createRequestContext` should ideally be filtered, but the middleware does not depend on the HeaderFilter directly — it passes raw headers and lets the downstream consumer filter.
- Middleware must not throw into the framework's request pipeline. All SDK operations are wrapped in try/catch.

---

## Edge Cases

- SDK not initialized (null instance): middleware passes through without wrapping
- SDK shutting down (`isActive()` returns false): middleware passes through
- Framework middleware called after response sent: no-op (response already finished)
- Multiple middleware instances with different SDKInstance refs (testing): each operates independently
- Response never finishes (connection dropped): requestTracker TTL sweep handles cleanup

---

## Testing Requirements

- Express: ALS context propagated through async handler
- Express: request registered in tracker, removed on finish
- Express: SDK not active -> pass-through
- Fastify: hook sets up ALS context
- Koa: context propagated through async middleware chain
- Raw HTTP: handler wrapped, ALS context available inside
- All adapters: no reference to req/res stored in RequestContext (GC safety)
- All adapters: exception in SDK does not break request pipeline (try/catch)

---

## Completion Criteria

- All five middleware adapters exported.
- Each accepts optional `SDKInstance` for DI.
- ALS context created and propagated for each request.
- Request tracker add/remove lifecycle correct.
- No host object references in RequestContext.
- All unit tests pass.
