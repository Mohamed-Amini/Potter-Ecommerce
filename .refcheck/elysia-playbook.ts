/**
 * ELYSIA — the HTTP layer of Pottery Market's apps/api.
 *
 * Self-contained and type-checked against the real dependency. Verify from
 * the Pottery repo root:
 *
 *   cp examples/backend/elysia-playbook.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * Verified against elysia 1.4.30 + zod 4.6.4. Elysia's types are unusually
 * aggressive — much of what this file teaches is about keeping them working
 * FOR you, because the moment you break the chain (section 1) you lose the
 * safety that was the reason to pick it.
 *
 * WHY ELYSIA IS HERE AT ALL: it validates routes directly against zod
 * schemas via Standard Schema. So `packages/shared` schemas are literally
 * the API's validators — there is no separate "API layer" DTO, and the
 * Angular app imports the same objects. That single property is the reason
 * it was chosen over Hono.
 */

import { Elysia } from 'elysia';
import { z } from 'zod';

/* ============================================================================
 * 1. THE CHAIN IS THE TYPE SYSTEM — the one rule you cannot break
 * ============================================================================
 * PLAIN ENGLISH: in Express you mutate an app object. In Elysia, every
 * `.get()`, `.use()`, `.decorate()` returns a NEW instance whose TYPE
 * carries everything registered so far. The chain isn't style — it's how
 * the type information accumulates.
 */

/* WRONG — the types are thrown away at the semicolon: */
//   const app = new Elysia();
//   app.decorate('version', '1.0');
//   app.get('/v', ({ version }) => version);   // `version` does not exist
//
// `decorate` returned a new, richer instance, and that return value was
// discarded. The original `app` never learned about `version`, so the
// handler's context is the empty one. This is the single most common
// Elysia mistake, and the error message ("Property 'version' does not
// exist") points at the handler rather than at the real cause two lines up.

/* RIGHT — one unbroken chain: */
const versioned = new Elysia().decorate('version', '1.0.0').get('/v', ({ version }) => version);

/*
 * The corollary for organising code: you do not "add routes to an app" from
 * several files. You BUILD an instance per file and compose them with
 * `.use()` — which is exactly what `productsRoutes` and `categoriesRoutes`
 * already do. Each is a complete little Elysia instance; `index.ts` chains
 * them together. That's not a convention, it's the only shape that keeps
 * the types.
 */

/* ============================================================================
 * 2. VALIDATION — zod schemas ARE the route contract
 * ============================================================================
 */

const productIdSchema = z.uuid().brand<'ProductId'>();

const productSchema = z.object({
  id: productIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  priceMinor: z.number().int().nonnegative(),
  currency: z.literal('RUB'),
  stockCount: z.number().int().nonnegative(),
});
type Product = z.infer<typeof productSchema>;

const createProductSchema = productSchema.omit({ id: true });

/* Every non-2xx body has ONE shape — the contract from api-architecture.ts
 * section 4 (which lists the full `code` enum; kept open here for brevity). */
const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

declare function loadProduct(id: string): Promise<Product | undefined>;
declare function saveProduct(input: z.infer<typeof createProductSchema>): Promise<Product>;

const productRoutes = new Elysia({ prefix: '/products' })
  .get(
    '/:id',
    async ({ params, status }) => {
      const product = await loadProduct(params.id);
      if (!product) return status(404, { code: 'NOT_FOUND', message: `Product ${params.id} not found` });
      return product;
    },
    {
      // `params` is validated AND typed. `params.id` below is a branded
      // ProductId, not a string — the brand survives the boundary.
      params: z.object({ id: productIdSchema }),
      response: {
        200: productSchema,
        404: errorBodySchema,
      },
    },
  )
  .post(
    '/',
    async ({ body, status }) => {
      // `body` is already parsed and typed. There is no `safeParse` here
      // and no 400-handling: a malformed body never reaches this function.
      const created = await saveProduct(body);
      return status(201, created);
    },
    {
      body: createProductSchema,
      response: { 201: productSchema },
    },
  );

/*
 * WHAT EACH KEY ACTUALLY DOES:
 *
 *   body / params / query / headers
 *     Validated BEFORE the handler runs. A failure short-circuits with a
 *     422 (Elysia's default for a validation error) and the handler is
 *     never entered. This is why handlers in this codebase have no
 *     defensive checks at the top — the schema already made those states
 *     unreachable. (Elysia's DEFAULT 422 body is not the contract shape —
 *     section 6 replaces it.)
 *
 *   response
 *     Validates what you RETURN, per status code. This is the one people
 *     skip, and it's the most valuable of the lot:
 *       - it catches a handler that forgot a field, in a test, rather than
 *         in the Angular app
 *       - it catches a DB row leaking extra columns into the response
 *         (dto-and-dao.ts section 2) — zod strips unknown keys, so the
 *         leak is closed even if the mapper is sloppy
 *       - it makes the status codes a route can return an explicit,
 *         readable list. `status(403, ...)` from a handler whose `response`
 *         map has no 403 is a TYPE ERROR, which is a genuinely excellent
 *         property: the set of possible responses is checked, not hoped.
 *
 * `status(code, body)` is how you return a non-200. It is destructured from
 * the handler context, NOT thrown, and NOT `set.status = 404` (that older
 * style still exists but loses the response-type checking above).
 *
 * WATCH OUT — the brand is real at runtime only where a parse happens. In
 * `params: z.object({ id: productIdSchema })` the parse DOES happen, so the
 * brand is earned honestly. Writing `params: z.object({ id: z.string() })`
 * and then passing it to something expecting `ProductId` would not compile,
 * which is the whole point of branding ids in `packages/shared`.
 */

/* ============================================================================
 * 3. PLUGINS: composition, prefixes, and the dedupe rule
 * ============================================================================
 */

const healthPlugin = new Elysia({ name: 'health' }).get('/health', () => ({ status: 'ok' as const }));

/*
 * `name` is not cosmetic. Elysia DEDUPLICATES plugins by name: a named
 * plugin `.use()`d from five different route files is instantiated ONCE.
 * Without a name it is re-instantiated every time, which for a plugin that
 * opens a connection or registers a lifecycle hook means five connections
 * and five hooks firing per request.
 *
 * RULE: any plugin that will be used more than once gets a `name`. Route
 * groups that are used exactly once (`productsRoutes`) don't need one.
 *
 * `prefix` applies to every route in the instance, which is why
 * `products.route.ts` says `/:id` rather than `/products/:id`. Keep the
 * prefix in ONE place — the instance — so a URL is never assembled from
 * two files.
 */

/* ============================================================================
 * 4. CONTEXT: decorate vs state vs derive vs resolve
 * ============================================================================
 * Four ways to put something in the handler's context. Choosing wrongly is
 * how request-scoped data becomes accidentally shared between users — the
 * single worst bug class on a backend.
 */

declare const realDb: { query: string };

const contextDemo = new Elysia()
  // decorate: ONE value, created at STARTUP, shared by every request.
  // Correct for: the db pool, a config object, a logger. Anything
  // stateless and expensive to build.
  .decorate('db', realDb)

  // state: mutable, app-wide. Correct for: a metrics counter. NOT correct
  // for anything user-specific — it is shared across every request in the
  // process, which is exactly the module-level-state trap from
  // node-runtime-playbook.ts section 9, wearing a framework's clothes.
  .state('requestCount', 0)

  // derive: runs PER REQUEST, before the handler. Correct for: anything
  // computed from THIS request. Runs before validation.
  .derive(({ headers }) => ({
    requestId: headers['x-request-id'] ?? crypto.randomUUID(),
  }))

  .get('/demo', ({ db, store, requestId }) => {
    store.requestCount += 1;
    return { db: db.query, requestId, count: store.requestCount };
  });

/*
 * `resolve` is `derive`'s sibling and the difference matters: `derive` runs
 * BEFORE validation, `resolve` runs AFTER it. So anything that depends on a
 * validated `body`/`params` must be a `resolve` — in a `derive` those
 * values have not been checked yet.
 *
 * THE RULE THAT PREVENTS THE WORST BUG: per-request data lives in `derive`
 * or `resolve`, NEVER in `state` or a module-level variable. "The currently
 * authenticated admin" stored in `state` is not a bug you find in testing —
 * it's a bug you find when two people use the site at the same time.
 */

/* ============================================================================
 * 5. LIFECYCLE HOOKS — and the request log that pays for itself
 * ============================================================================
 *
 * Order, per request:
 *   onRequest        raw Request; nothing parsed yet. Cheapest rejection
 *                    point — rate limiting, IP blocks.
 *   onParse          body -> object
 *   onTransform      mutate the context before validation
 *   derive           add request-scoped context (pre-validation)
 *   onBeforeHandle   guards. RETURNING A VALUE HERE SKIPS THE HANDLER —
 *                    that is how auth rejection works (section 7).
 *   resolve          add request-scoped context (post-validation)
 *   [ HANDLER ]
 *   onAfterHandle    transform the response
 *   mapResponse      final serialization control
 *   onError          anything above threw (section 6)
 *   onAfterResponse  after the bytes are sent — logging, metrics
 */

const requestLog = new Elysia({ name: 'request-log' })
  .derive(() => ({ startedAt: performance.now() }))
  .onAfterResponse(({ request, startedAt, set }) => {
    // Structured, one object, greppable keys — node-runtime-playbook.ts
    // section 12. Four fields answer most production questions.
    console.log({
      event: 'http_request',
      method: request.method,
      path: new URL(request.url).pathname,
      status: set.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  })
  .as('scoped');

/*
 * `.as('scoped')` IS NOT OPTIONAL HERE. Every hook and `derive` in a plugin
 * is LOCAL by default — it applies only to routes registered on that same
 * instance, and this plugin has none. Measured (elysia 1.4.30): without
 * `.as('scoped')`, this logger composed into `app` before the route plugins
 * never fired once. It is the same silent no-op as the guard in section 7,
 * and it applies to EVERY cross-cutting plugin, not just auth.
 *
 * `onAfterResponse` and not `onAfterHandle`: the former runs after the
 * response has been sent, so the logging cost is not on the user's latency
 * path. It also fires for error responses, which `onAfterHandle` does not.
 *
 * DO NOT log the request body here. It contains customer names, phone
 * numbers and Telegram handles — personal data that should not sit in a log
 * aggregator. Log the path and the status; if you need to correlate, log
 * the `requestId` from section 4.
 */

/* ============================================================================
 * 6. ERROR HANDLING — one place, and it must not leak
 * ============================================================================
 */

/* The taxonomy: domain errors that the HTTP layer knows how to translate.
 * These live near the services that throw them, not in the route file. */
class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(what: string) {
    super(`${what} not found`);
  }
}
class ConflictError extends Error {
  override readonly name = 'ConflictError';
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}
class OutOfStockError extends Error {
  override readonly name = 'OutOfStockError';
  constructor(readonly productId: string) {
    super(`Out of stock: ${productId}`);
  }
}

const errorHandling = new Elysia({ name: 'error-handling' })
  .onError(({ code, error, status }) => {
    // `code` is Elysia's own: 'VALIDATION' | 'NOT_FOUND' | 'PARSE' |
    // 'INTERNAL_SERVER_ERROR' | 'UNKNOWN' | ...
    if (code === 'VALIDATION') {
      // Elysia's DEFAULT 422 body is `{ type, on, property, message, found,
      // errors }` — measured, 1.4.30. Three problems with sending it as-is:
      // it has no `code`; `property` is only the TOP-level key ("items", not
      // "items.1.quantity"); and `found` echoes the ENTIRE request body back,
      // contact details included. `error.all` carries every failure with a
      // full dotted path ("items.1.quantity" — measured), which is exactly
      // what the form layer maps onto inputs
      // (frontend/forms-and-validation.ts section 6).
      return status(422, {
        code: 'VALIDATION_FAILED',
        message: 'Invalid request',
        issues: error.all.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    // Elysia's own "no such route" and "body is not valid JSON". Without
    // these two lines both fall through to the bug branch below and a
    // mistyped URL becomes a logged 500.
    if (code === 'NOT_FOUND') return status(404, { code: 'NOT_FOUND', message: 'Not found' });
    if (code === 'PARSE') return status(400, { code: 'VALIDATION_FAILED', message: 'Malformed request body' });

    // Our domain errors -> status codes. This mapping is the ONLY place the
    // translation happens, which is what lets services stay HTTP-free
    // (dto-and-dao.ts section 5). Every body carries a `code` — the client
    // branches on that, never on `message`.
    if (error instanceof NotFoundError) return status(404, { code: 'NOT_FOUND', message: error.message });
    if (error instanceof ConflictError) {
      return status(409, { code: 'CONFLICT', message: error.message, field: error.field });
    }
    if (error instanceof OutOfStockError) {
      return status(409, { code: 'OUT_OF_STOCK', message: error.message });
    }

    // Anything else is a bug. Log EVERYTHING, return NOTHING.
    console.error({
      event: 'unhandled_route_error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error ? error.cause : undefined,
    });

    return status(500, { code: 'INTERNAL', message: 'Something went wrong' });
  })
  .as('scoped');

/*
 * `.as('scoped')`, AGAIN — and here the failure is a security hole, not a
 * missing log line. MEASURED (elysia 1.4.30): the same plugin WITHOUT it,
 * `.use()`d first, never ran for the routes composed after it. An unknown
 * error then got ELYSIA'S DEFAULT treatment — a 500 whose body is the raw
 * `error.message`, even with NODE_ENV=production. For a postgres error that
 * is the failing SQL and the offending values. `.as('scoped')` made it
 * cover both direct child and grandchild route plugins; `.as('global')`
 * works too.
 *
 * THE TWO HALVES OF THAT LAST BLOCK ARE BOTH REQUIRED:
 *
 *   LOG EVERYTHING — including `error.cause`, which is where the original
 *   postgres error lives after a wrap (node-runtime-playbook.ts section
 *   4.2). Without the cause you get "Could not persist order" and no
 *   SQLSTATE, which is the difference between a two-minute fix and an
 *   afternoon.
 *
 *   RETURN NOTHING — a generic message and nothing else. A stack trace in a
 *   500 body reveals file paths, library versions and sometimes connection
 *   strings. `error.message` from a postgres driver can contain the failing
 *   SQL, which can contain data from another row. Never reflect an unknown
 *   error's text to a client.
 *
 * NOTE the asymmetry with the errors ABOVE it: `NotFoundError` and
 * `ConflictError` messages ARE safe to return, because you wrote them and
 * they say only what the user already knows. The rule is not "never return
 * messages", it's "never return messages you didn't author."
 *
 * WHERE IT GOES: a named plugin with `.as('scoped')`, `.use()`d on the root
 * instance BEFORE the route plugins (section 8). Both parts matter — hooks
 * apply to routes registered after them, and without the `.as()` they do
 * not leave the plugin at all.
 */

/* ============================================================================
 * 7. GUARDS — the admin gate, which is all the auth this project needs
 * ============================================================================
 * Since the 2026-09 pivot there are no customer accounts. The entire auth
 * surface is: Alina's admin endpoints are behind one password.
 * examples/auth/backend-auth.ts covers the credential handling properly
 * (timing-safe comparison, why not to use `===`); this section is only
 * about WHERE the check is wired in.
 */

declare function isValidAdminAuth(header: string | undefined): Promise<boolean>;

const adminOnly = new Elysia({ name: 'admin-only' })
  .onBeforeHandle(async ({ headers, set, status }) => {
    // Returning a value from onBeforeHandle SKIPS THE HANDLER. That is the
    // mechanism: no `next()`, no forgotten `return`.
    // `headers['authorization']`, not `headers.authorization`: Elysia types
    // headers as an index signature, and this repo has
    // `noPropertyAccessFromIndexSignature` on — so dot access is a compile
    // error here. Verified, not stylistic. The flag is doing its job:
    // bracket syntax marks "this key might not be there", and for a header
    // it genuinely might not.
    if (!(await isValidAdminAuth(headers['authorization']))) {
      // This header is what makes the browser show its Basic-auth prompt
      // (auth/backend-auth.ts section 4). Without it, a bare 401.
      set.headers['www-authenticate'] = 'Basic realm="admin"';
      return status(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    // Returning undefined means "carry on".
    return;
  })
  .as('scoped');

/*
 * `.as('scoped')` is the critical, easily-missed part. By default a
 * lifecycle hook applies only to routes in the SAME instance — so a plugin
 * whose whole job is guarding other routes does nothing at all without it.
 * `'scoped'` propagates the hook to the instance that `.use()`s this one;
 * `'global'` propagates it everywhere. A silent no-op auth guard is the
 * worst possible failure mode, so this is worth testing explicitly:
 * a test that asserts 401 without credentials, on a real route, through
 * `app.handle()` (examples/testing/backend-testing.ts section 5).
 *
 * The alternative shape, for guarding a group inline:
 *
 *   new Elysia()
 *     .guard({ beforeHandle: checkAdmin }, (app) =>
 *       app.get('/admin/orders', ...).patch('/admin/orders/:id', ...))
 *
 * Use the plugin form when the same guard protects routes in several files;
 * use `guard` when it's a block within one file.
 *
 * SECURITY RULE THAT OUTRANKS BOTH: default to closed. A new admin route
 * added to a file that isn't under the guard is unprotected, and nothing
 * will tell you. Prefer one `/admin`-prefixed instance that the guard wraps
 * as a whole, so a new route inherits protection by DEFAULT rather than by
 * remembering.
 */

/* ============================================================================
 * 8. COMPOSING THE APP — order matters
 * ============================================================================
 */

declare const corsOrigin: string;
declare function cors(options: { origin: string }): Elysia;

export const app = new Elysia()
  .use(errorHandling) // 1. first — so it catches everything after it (and `.as('scoped')` inside, or it catches nothing)
  .use(requestLog) // 2. logging wraps the routes (same `.as('scoped')` requirement)
  .use(cors({ origin: corsOrigin })) // 3. before routes
  .use(healthPlugin)
  .use(productRoutes)
  .use(adminOnly.use(new Elysia({ prefix: '/admin' }).get('/orders', () => [])));

/*
 * Cross-cutting plugins go FIRST. `onError` registered after the routes it
 * should cover simply won't cover them — this is a source of "my error
 * handler isn't running" that looks like a framework bug and isn't.
 *
 * CORS: `origin` comes from validated config, never `'*'`. A wildcard on an
 * API that will later carry an admin credential is a real hole, and it's
 * much easier to set correctly now than to remember later.
 *
 * `app` is EXPORTED, and `.listen()` is called separately (as
 * apps/api/src/index.ts does). That separation is what makes the app
 * testable: a test imports `app` and calls `app.handle(new Request(...))`
 * with no port, no network, no cleanup. If `listen()` were part of the
 * same expression, importing the module would bind a port.
 */

/* ============================================================================
 * 9. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Breaking the chain (`app.get(...)` on its own line)          -> S1
 * - A route with no `response` schema                            -> S2
 * - Hand-validating inside a handler that has a `body` schema    -> S2
 * - An unnamed plugin used more than once                        -> S3
 * - Request-scoped data in `state` or a module variable          -> S4
 * - Logging request bodies containing contact details            -> S5
 * - Returning `error.message` for an unknown error               -> S6
 * - Returning a stack trace in any response                      -> S6
 * - Sending Elysia's default 422 body (no `code`, echoes input)   -> S6
 * - `onError` registered after the routes                        -> S8
 * - ANY cross-cutting plugin hook without `.as('scoped')`
 *   (guard, onError, logger — all silent no-ops)                  -> S5, S6, S7
 * - Auth applied per-route instead of to a prefixed group        -> S7
 * - `cors({ origin: '*' })`                                      -> S8
 * - `.listen()` in the same expression as the app definition     -> S8
 */

export const _referenced = {
  versioned,
  contextDemo,
  productRoutes,
  adminOnly,
  NotFoundError,
  ConflictError,
  OutOfStockError,
};
