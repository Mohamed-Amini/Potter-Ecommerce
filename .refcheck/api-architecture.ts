/**
 * API ARCHITECTURE — the contract decisions, the error taxonomy, and the
 * cross-cutting concerns (grounded in Pottery Market's apps/api).
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/backend/api-architecture.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * This file is about the SHAPE OF THE CONTRACT — URLs, status codes, error
 * bodies, idempotency, versioning. Its two neighbours cover the other
 * halves and are not repeated here:
 *   - examples/backend/dto-and-dao.ts    layering, DTOs, repositories,
 *                                        services, transaction boundaries
 *   - examples/backend/elysia-playbook.ts how the framework wires it up
 *
 * THE ONE IDEA: an HTTP API is a published contract with a consumer you
 * cannot deploy at the same time as yourself. Every decision here is about
 * making tomorrow's change possible without breaking today's client — even
 * when that client is your own Angular app.
 */

import { z } from 'zod';

/* ============================================================================
 * 1. THE DEPENDENCY RULE, IN ONE LINE
 * ============================================================================
 * routes -> services -> repositories -> drizzle -> postgres
 *
 * Dependencies point DOWN, only. A repository never imports a route; a
 * service never imports Elysia. If you need an import that goes up, the
 * logic is in the wrong layer — that is the whole test, and it is
 * mechanical enough to check in review without arguing about taste.
 *
 * Why it matters concretely: it is what lets the same service be called by
 * an HTTP route today and a CLI script or a scheduled job tomorrow, without
 * dragging a web framework into a cron process. See dto-and-dao.ts section
 * 6 for the full flow and section 7 for when NOT to build layers at all —
 * `categories.route.ts` correctly has none.
 */

/* ============================================================================
 * 2. RESOURCE DESIGN — URLs are nouns, methods are verbs
 * ============================================================================
 *
 *   GET    /products              list
 *   POST   /products              create
 *   GET    /products/:id          read one
 *   PATCH  /products/:id          partial update
 *   DELETE /products/:id          delete
 *
 * The method carries the verb, so the path must not:
 *   BAD   POST /createProduct, POST /products/:id/delete, GET /getProducts
 *   GOOD  POST /products,      DELETE /products/:id,      GET /products
 *
 * This is not aesthetics. `GET` is safe and cacheable, `PUT`/`DELETE` are
 * idempotent, `POST` is neither — proxies, browsers and HTTP caches all act
 * on those guarantees. `GET /deleteProduct/5` is a URL a crawler will
 * happily follow, and then the product is gone.
 *
 * PATCH vs PUT — pick one and be consistent. PUT REPLACES the whole
 * resource (omit a field and it is cleared); PATCH merges the fields you
 * sent. This project uses PATCH with `editProductSchema` — a `.partial()`
 * of the full schema — which is almost always the right choice for an admin
 * form that edits one field at a time. A PUT here would mean a form that
 * forgets to send `images` silently deletes the photos.
 *
 * NESTING: one level, when the child genuinely cannot exist alone.
 *   GOOD  GET /orders/:id/items
 *   BAD   GET /categories/:cid/products/:pid/reviews/:rid
 * Beyond one level, URLs become brittle and you cannot fetch a thing you
 * already have the id for. Prefer a filter: `GET /products?categoryId=...`.
 *
 * WHEN TO BREAK REST — and it is worth breaking, deliberately, for actions
 * that are not CRUD on a noun:
 *   POST /orders/:id/confirm
 *   POST /orders/:id/cancel
 * Modelling those as `PATCH /orders/:id { status: 'confirmed' }` looks
 * purer and is worse: status transitions have RULES (you cannot confirm a
 * cancelled order), they set timestamps, they may notify someone. A generic
 * PATCH invites a client to set any status from any other. An explicit
 * action endpoint is a place to put the rule. Name the action, keep it a
 * POST, do not pretend everything is CRUD.
 */

/* ============================================================================
 * 3. STATUS CODES — the ones that carry information
 * ============================================================================
 *
 *   200 OK           read, or an update that returns the new state
 *   201 Created      a POST that made something. Return the created
 *                    resource, so the client needs no follow-up GET.
 *   204 No Content   success with nothing to say (DELETE). No body at all —
 *                    a 204 with a body is malformed and some clients choke.
 *
 *   400 Bad Request  malformed in a way schema validation cannot express —
 *                    e.g. "send at least one field to change" on an empty
 *                    PATCH body, which products.route.ts returns today.
 *   401 Unauthorized WHO ARE YOU — no credential, or a bad one. (The name
 *                    is a historical mistake; it means unauthenticated.)
 *   403 Forbidden    I KNOW WHO YOU ARE AND NO — a valid credential without
 *                    the right. Never use 401 for this; a client is
 *                    supposed to re-prompt for credentials on 401, and
 *                    re-prompting achieves nothing on a 403.
 *   404 Not Found    no such resource — and, deliberately, also "exists but
 *                    is not yours" (backend-auth.ts section 10: a 403 there
 *                    confirms the id is real).
 *   409 Conflict     the request is valid but collides with current state:
 *                    a duplicate slug, ordering more than is in stock.
 *   422 Unprocessable well-formed but failed validation. Elysia's default
 *                    for a schema failure, and what this project returns.
 *   429 Too Many     rate limited. Include `Retry-After`.
 *
 *   500 Internal     YOUR bug. Never use it for a client mistake.
 *   503 Unavailable  a dependency is down. Distinguishing 503 from 500 is
 *                    what tells an on-call human whether to look at your
 *                    code or at Postgres.
 *
 * THE TWO ERRORS THAT ACTUALLY MATTER:
 *   - Returning 200 with `{ error: ... }` in the body. Now every client
 *     must parse a body to learn whether it worked, retries are wrong,
 *     monitoring reports 100% success during an outage, and `response.ok`
 *     lies. The status code IS the outcome.
 *   - Returning 500 for a validation failure. It pages someone at 3am for
 *     a typo in a form.
 *
 * 422 vs 400: both are defensible, and consistency beats correctness here.
 * This project uses 422 because that is what Elysia emits for a schema
 * failure — so match it rather than translating half of them.
 */

/* ============================================================================
 * 4. THE ERROR TAXONOMY — one hierarchy, one response shape
 * ============================================================================
 * The problem this solves: without it, every route invents its own error
 * body, and the Angular app ends up with a different special case per
 * endpoint. One shape, decided once.
 */

/* --- The wire format, in packages/shared so both apps import it --------- */

/** Every code the SERVER may emit. The server's side of the contract. */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'OUT_OF_STOCK',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const apiErrorSchema = z.object({
  /** A stable, machine-readable key. The client switches on THIS. */
  code: z.enum(API_ERROR_CODES),
  /** Human-readable. For developers and logs — NOT for display as-is. */
  message: z.string(),
  /** Which field, when the error is about exactly one (a 409 on a slug). */
  field: z.string().optional(),
  /**
   * Every failed field, for a 422. `path` is zod's issue path joined with
   * '.', e.g. "items.0.quantity" — which is exactly Angular's `form.get()`
   * syntax (frontend/forms-and-validation.ts section 6).
   */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/*
 * WHY `code` AND `message` ARE BOTH THERE, and why the split is the whole
 * value of this section:
 *
 *   `message` is prose. It gets reworded, translated, made friendlier. A
 *   client that branches on message text breaks the day someone fixes a
 *   typo — and this project's users read Russian, so the displayed string
 *   is not even the one the API would send.
 *
 *   `code` is an identifier. It never changes. `if (error.code ===
 *   'OUT_OF_STOCK')` is a contract; `if (error.message.includes('stock'))`
 *   is a time bomb.
 *
 * So: the CLIENT owns the user-facing copy, keyed by `code`. The API owns
 * the code. That also means a new error code is a soft breaking change —
 * a client that does not know it should fall back to a generic message, so
 * `switch` on codes with a `default`, never an exhaustive match that throws.
 *
 * THE ENUM ABOVE IS THE SERVER'S SCHEMA, NOT THE CLIENT'S. If the client
 * parses error bodies with this same closed `z.enum`, a code added by a
 * newer server FAILS THE PARSE — measured: the body is rejected and lands in
 * the client's "malformed response" branch, so the carefully written
 * "unknown code -> generic message" fallback never even runs. The client
 * parses `code` as an open `z.string()` (frontend/api-client-and-errors.ts
 * section 1). Same contract, deliberately looser on the reading side.
 *
 * `field` exists so a 409 on a duplicate slug can highlight the slug input.
 * `Errors.util.ts` already produces this — `conflictingField()` maps a
 * Postgres constraint name (`products_slug_unique`) to `'slug'`. That
 * mapping table is the translation between a database concept and a form
 * concept, and it belongs exactly where it is.
 */

/* --- The thrown types, near the services that throw them ---------------- */

/**
 * One base class so the route layer can ask "is this a known domain error
 * or a genuine bug?" with a single `instanceof`.
 */
export abstract class AppError extends Error {
  abstract readonly code: ApiError['code'];
  abstract readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429;
  readonly field?: string;
}

export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
  readonly code = 'CONFLICT' as const;
  readonly status = 409 as const;
  override readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

export class OutOfStockError extends AppError {
  override readonly name = 'OutOfStockError';
  readonly code = 'OUT_OF_STOCK' as const;
  readonly status = 409 as const;
  constructor(
    readonly productId: string,
    readonly available: number,
  ) {
    super(`Only ${String(available)} left in stock`);
  }
}

/**
 * The single translation point. Everything that is not an `AppError` is,
 * by definition, a bug — and bugs return a generic 500 with nothing in it.
 */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.field !== undefined ? { field: error.field } : {}),
      },
    };
  }

  // Unknown = a bug. Log everything (including `cause`, where the original
  // postgres error lives), return nothing. See elysia-playbook.ts section 6
  // for why reflecting an unknown error's text is a real leak.
  console.error({
    event: 'unhandled_error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? error.cause : undefined,
  });

  return { status: 500, body: { code: 'INTERNAL', message: 'Something went wrong' } };
}

/*
 * NOTE THE CONDITIONAL SPREAD on `field`. This repo has
 * `exactOptionalPropertyTypes` on, which distinguishes "absent" from
 * "present and undefined" — so `field: error.field` would NOT compile when
 * `field` is `string | undefined` and the target says `field?: string`.
 * The spread adds the key only when there is a value.
 *
 * Be precise about what that buys, because the obvious story is wrong: it
 * is NOT about the wire. `JSON.stringify` already drops keys whose value is
 * `undefined` — measured: `{ code: 'X', field: undefined }` serializes as
 * `{"code":"X"}`, never `"field": null`. What the flag protects is the
 * object while it is still IN the process: `'field' in body`,
 * `Object.keys(body)` and `{ ...defaults, ...body }` (which overwrites a real
 * default with `undefined`) all see a key that "is there but empty". The
 * type then says exactly what the object is.
 *
 * WHY `abstract class` AND NOT A UNION: `instanceof AppError` is one check
 * that stays correct as errors are added, and it puts the status code next
 * to the error that means it rather than in a lookup table someone forgets
 * to update. The cost is that `instanceof` is unreliable across module
 * realms (two copies of the module after a bad bundle) — `override readonly
 * name` on each is the literal discriminant to fall back on if that ever
 * bites (node-runtime-playbook.ts section 4.2).
 */

/* ============================================================================
 * 5. IDEMPOTENCY — because the network lies
 * ============================================================================
 * PLAIN ENGLISH: a client sends `POST /orders`, the order is created, and
 * the response is lost to a dropped connection. The client has no way to
 * know whether it worked. If it retries, there are two orders. If it does
 * not, the customer thinks their order failed when it did not.
 *
 * This is not an edge case — it is mobile networks, every day.
 *
 * GET, PUT and DELETE are naturally idempotent: doing them twice has the
 * same effect as once. POST is not, which is why it needs help.
 *
 * THE MECHANISM: the client generates a key (a UUID) per logical attempt
 * and sends it as a header. The server stores it with the result.
 *
 *   POST /orders
 *   Idempotency-Key: 6f1c...  ->  201 { id, referenceNumber }
 *   (retry, same key)         ->  201 { id, referenceNumber }   same body
 *
 * A table with a unique constraint on the key, written in the SAME
 * transaction as the order (drizzle-playbook.ts section 7). The uniqueness
 * is what makes it safe: two simultaneous retries race, one wins, the other
 * gets a unique violation. Two details that decide whether this works:
 *   - The loser's transaction is ABORTED by that violation — Postgres
 *     refuses every further statement in it. Read back the winner's result
 *     in a NEW statement, after the rollback, not inside the failed tx.
 *   - Store a fingerprint of the request body next to the key. The same key
 *     arriving with a DIFFERENT body is a client bug; answer it with a 422,
 *     never with the first request's result.
 *
 * WORTH IT FOR: order submission, payments, anything that costs money or
 * sends a message.
 * NOT WORTH IT FOR: creating a category from an admin screen.
 *
 * WHERE A NATURAL UNIQUE CONSTRAINT IS ENOUGH: when the data itself is
 * unique. `products.slug` being `.unique()` already means a double-submitted
 * create form is a 409 rather than two products. What a unique index CANNOT
 * express is "the same order within two minutes" — an index has no time
 * window, and a unique index on customer + contact + items would block a
 * legitimate repeat order forever. For orders, the idempotency key above IS
 * the cheap version: one uuid column with a unique constraint.
 */

/* ============================================================================
 * 6. LIST ENDPOINTS: the envelope decision
 * ============================================================================
 */

export const productListSchema = z.object({
  data: z.array(z.object({ id: z.uuid(), name: z.string() })),
  meta: z.object({
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    perPage: z.number().int().positive(),
  }),
});

/*
 * BARE ARRAY (`[...]`) vs ENVELOPE (`{ data, meta }`).
 *
 * `products.route.ts` currently returns a bare array, and for a catalogue
 * of a few hundred pots that is correct and simpler.
 *
 * The moment you need pagination, you need somewhere to put `total` — and
 * adding `{ data, meta }` LATER is a breaking change for every client.
 * Since the frontend is yours and deploys alongside, that is survivable
 * here; on a public API it would not be.
 *
 * THE RULE OF THUMB: bare array when the list is bounded and small by
 * nature (categories — there will never be 10,000). Envelope the moment a
 * list can grow without limit (orders — one per sale, forever).
 * `/orders` should be an envelope from day one.
 *
 * The `page`/`perPage`/`total` meta above is the OFFSET shape — right for a
 * numbered admin table. For a list that grows forever and is read as a feed,
 * prefer `meta: { nextCursor }` (keyset pagination): `total` costs a
 * `count(*)` on every request, and deep OFFSETs sort everything they skip
 * (measured in postgres-beyond-drizzle.ts section 4).
 *
 * WHATEVER YOU CHOOSE, BE CONSISTENT. Half your endpoints returning arrays
 * and half returning envelopes means every client call site has to remember
 * which. That inconsistency costs more than either choice.
 *
 * And regardless: every list endpoint has a LIMIT, capped server-side
 * (drizzle-playbook.ts section 8.2). An unbounded list is the most common
 * way a fine API becomes an outage.
 */

/* ============================================================================
 * 7. VERSIONING — mostly, don't
 * ============================================================================
 *
 * `/v1/products` is the standard answer and is usually premature. Versioning
 * is for when you cannot deploy your clients — a public API, a mobile app
 * on users' phones. Here, `apps/web` and `apps/api` deploy together from
 * one monorepo, and `packages/shared` means a contract change is a
 * COMPILE ERROR in the frontend rather than a runtime surprise. That is
 * stronger than versioning, and it is the payoff for the shared package.
 *
 * WHEN A BREAKING CHANGE IS UNAVOIDABLE, prefer expand-then-contract over a
 * version bump — the same three-step shape as a column rename
 * (drizzle-playbook.ts section 10):
 *   1. Add the new field alongside the old. Both populated. Nothing breaks.
 *   2. Move clients to the new field.
 *   3. Remove the old one.
 *
 * WHAT COUNTS AS BREAKING (the asymmetry is the useful part):
 *   BREAKING      removing a field, renaming one, narrowing a type,
 *                 making an optional request field required, adding a new
 *                 enum value the client must handle
 *   NOT BREAKING  adding an optional request field, adding a response
 *                 field, adding a new endpoint
 *
 * Adding a response field is safe ONLY IF clients ignore unknown keys —
 * which zod does by default. Worth knowing that `.strict()` on a client-side
 * response schema would turn every future API addition into a breakage.
 * Don't use `.strict()` on response schemas.
 */

/* ============================================================================
 * 8. CROSS-CUTTING: request ids and health checks
 * ============================================================================
 */

/*
 * REQUEST ID. One id, generated at the edge (or taken from an inbound
 * `X-Request-Id`), attached to every log line for that request and returned
 * in the response header. It turns "a customer says their order failed at
 * about 3pm" into one grep. Wired as a `derive` —
 * elysia-playbook.ts section 4.
 *
 * HEALTH CHECKS — two different questions that get conflated:
 *
 *   LIVENESS   `GET /health` -> `{ status: 'ok' }`. "Is the process alive?"
 *              It must NOT touch the database. A liveness check that fails
 *              because Postgres is down causes the orchestrator to KILL
 *              AND RESTART a perfectly healthy process — repeatedly, while
 *              the database is already struggling. This is a real and
 *              well-documented way to turn a database blip into a
 *              crash-loop outage. apps/api's current `/health` is correct
 *              precisely because it does nothing.
 *
 *   READINESS  `GET /ready` -> checks the DB with a `SELECT 1`. "Should I
 *              receive traffic?" A failure here removes the instance from
 *              the load balancer WITHOUT killing it, so it recovers on its
 *              own when the dependency comes back.
 *
 * The distinction is: liveness failure = restart me. Readiness failure =
 * leave me alone for a moment. Using one endpoint for both picks the wrong
 * remedy half the time.
 */

/* ============================================================================
 * 9. HEADERS AND CORS
 * ============================================================================
 *
 * CORS is configured from validated config (`env.CORS_ORIGIN`), never `'*'`.
 * Be exact about what CORS does: it does not stop requests being SENT, it
 * decides which other sites may READ the responses in a visitor's browser.
 * For a purely public, anonymous read API, `*` is legitimate. It is wrong
 * HERE for two reasons, and the second is the one people miss:
 *   - this API has an admin surface; a wildcard lets any site read whatever
 *     a request from that browser is allowed to see
 *   - `Access-Control-Allow-Origin: *` is INCOMPATIBLE with credentialed
 *     requests by spec, so it silently breaks the day you add a cookie
 *
 * Worth setting on an API that serves JSON:
 *   X-Content-Type-Options: nosniff        stop MIME sniffing
 *   Cache-Control: no-store                on anything authenticated
 *
 * `Cache-Control` is the one with teeth. An admin order list cached by a
 * proxy is a data leak with no bug in your code at all.
 *
 * The HTML security headers — CSP, X-Frame-Options, HSTS — belong on
 * whatever serves `apps/web`, not on the JSON API. Setting CSP on a JSON
 * response does nothing.
 */

/* ============================================================================
 * 10. THE DON'T-DO LIST
 * ============================================================================
 *
 * - A verb in a URL (`POST /createProduct`)                      -> S2
 * - `GET` for anything that changes state                        -> S2
 * - PUT where PATCH is meant (silently clears omitted fields)    -> S2
 * - Nesting resources more than one level deep                   -> S2
 * - A generic PATCH that lets a client set any status            -> S2
 * - 200 with an error in the body                                -> S3
 * - 500 for a client's invalid input                             -> S3
 * - 401 where 403 is meant, or vice versa                        -> S3
 * - A different error body shape per endpoint                    -> S4
 * - A client branching on `message` text instead of `code`       -> S4
 * - A client parsing `code` with the server's closed enum        -> S4
 * - Returning an unknown error's message or stack                -> S4
 * - No idempotency on order submission                           -> S5
 * - Adding `{data, meta}` to a shipped bare-array endpoint       -> S6
 * - Mixing bare arrays and envelopes across endpoints            -> S6
 * - `/v1/` on an API that deploys with its only client           -> S7
 * - `.strict()` on a response schema (future additions break)    -> S7
 * - A liveness check that queries the database                   -> S8
 * - `cors({ origin: '*' })`                                      -> S9
 * - No `Cache-Control: no-store` on authenticated responses      -> S9
 */

export const _referenced = { API_ERROR_CODES, apiErrorSchema, toApiError, productListSchema };
