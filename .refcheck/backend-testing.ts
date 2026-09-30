/**
 * TESTING THE BACKEND — Jest + @swc/jest against Elysia, Drizzle and
 * Postgres (grounded in Pottery Market's apps/api).
 *
 * This file is a reference, not a suite — it has no `.spec.ts` suffix, so
 * `testMatch` in apps/api/jest.config.js will not pick it up. Copy a
 * pattern into a real `src/**\/*.spec.ts` to run it.
 *
 * It DOES typecheck, but it needs Jest's globals, which the API's own
 * tsconfig excludes (`"types": ["bun"]`). Verify with the spec config:
 *
 *   cp examples/testing/backend-testing.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.spec.json
 *
 * (That config is `.refcheck/tsconfig.json` with `"types": ["bun","jest"]`.
 * The split is not an artifact of this reference — apps/web has exactly the
 * same split for exactly the same reason: `tsconfig.app.json` must not see
 * test globals, or `describe()` typechecks in production code.)
 *
 * THE ONE IDEA: a backend test is worth what it would have caught. Tests
 * that assert your mocks were called catch nothing. The ranking in section
 * 1 follows from that and nothing else.
 */

import { Elysia } from 'elysia';
import { z } from 'zod';

/* ============================================================================
 * 1. WHAT TO TEST, IN ORDER OF VALUE
 * ============================================================================
 * The frontend testing pyramid does not transfer. An API has one narrow,
 * well-defined entry point — an HTTP request — which makes the highest
 * level the CHEAPEST to test, inverting the usual advice.
 *
 *   1. ROUTE TESTS (section 4). One `app.handle(new Request(...))` exercises
 *      routing, validation, the handler, the service, the repository, the
 *      DTO mapping and the error translation. No port, no network, ~ms.
 *      This is where the value is. Start here.
 *
 *   2. SERVICE TESTS (section 5). Business rules with awkward branches —
 *      out of stock, empty basket, a price that changed mid-order. Worth
 *      isolating when the permutations would be tedious over HTTP.
 *
 *   3. SCHEMA TESTS (section 3). Any zod schema with a `.transform()` or
 *      `.refine()`. `telegramHandleSchema` in packages/shared strips
 *      `https://t.me/` and `@` and lowercases — that is real logic with
 *      real edge cases, and it is pure, so tests cost nothing.
 *
 *   4. REPOSITORY TESTS (section 6). Against a REAL Postgres. Only for
 *      queries with actual logic in them — a join, an aggregate, an upsert.
 *      Testing that `select().from(products)` selects from products tests
 *      Drizzle, not you.
 *
 * WHAT NOT TO TEST AT ALL: that Elysia routes, that zod rejects a number
 * where a string was declared, that Postgres stores what you inserted.
 * Those are your dependencies' test suites. Every test you write is a test
 * you maintain forever.
 */

/* ============================================================================
 * 2. THE SETUP THAT'S ALREADY THERE, AND WHY EACH LINE EXISTS
 * ============================================================================
 *
 * apps/api/jest.config.js:
 *
 *   transform: { '^.+\\.ts$': '@swc/jest' }
 *     SWC compiles TS ~20x faster than ts-jest and does NOT typecheck.
 *     That is the right trade: `npm run typecheck` already does that, once,
 *     for the whole project. Paying for it again per test file buys nothing.
 *     THE CONSEQUENCE, worth knowing before it confuses you: a type error
 *     will NOT fail your tests. Typecheck and test are separate commands
 *     and CI must run both.
 *
 *   moduleNameMapper: { '^@pottery/shared$': '<rootDir>/../../packages/shared/src/index.ts' }
 *     Jest does not read tsconfig `paths`. Without this the import resolves
 *     to nothing and every test that touches a shared schema fails with a
 *     module-not-found that looks like a broken install.
 *
 *   testEnvironment: 'node'
 *     Not 'jsdom'. There is no DOM here, and jsdom is slow to construct.
 *
 *   passWithNoTests: true
 *     So `npm test` at the root doesn't fail the whole run before any specs
 *     exist. Worth removing once there are tests — at that point a run that
 *     finds nothing is a signal, not a convenience.
 *
 * WHY JEST AND NOT `bun test`: chosen deliberately, by name. Bun's runner is
 * faster and needs no transform, but Jest's ecosystem (matchers, reporters,
 * IDE integration) is the thing most people actually want. Both work; the
 * project picked one, so use it consistently rather than accumulating two.
 */

/* ============================================================================
 * 3. PURE TESTS: schemas and functions
 * ============================================================================
 */

const telegramHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^(https?:\/\/)?(t\.me\/)?@?/i, '').toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/,
        'A Telegram username is 5-32 characters, starts with a letter, and uses only letters, numbers and underscores',
      ),
  );

export function telegramHandleSpec(): void {
  describe('telegramHandleSchema', () => {
    // The whole point of the transform is that users paste whatever they
    // have. Table-driven, because these are the same assertion N times and
    // a loop keeps the failure message specific.
    it.each([
      ['@alina_ceramics', 'alina_ceramics'],
      ['https://t.me/alina_ceramics', 'alina_ceramics'],
      ['t.me/Alina_Ceramics', 'alina_ceramics'],
      ['  alina_ceramics  ', 'alina_ceramics'],
    ])('normalises %s -> %s', (input, expected) => {
      expect(telegramHandleSchema.parse(input)).toBe(expected);
    });

    it.each([
      ['abc', 'too short'],
      ['1alina', 'starts with a digit'],
      ['alina-ceramics', 'contains a hyphen'],
      ['alina_', 'ends with an underscore'],
    ])('rejects %s (%s)', (input) => {
      expect(telegramHandleSchema.safeParse(input).success).toBe(false);
    });
  });
}

/*
 * `safeParse(...).success` rather than `expect(() => parse()).toThrow()`:
 * it asserts the outcome instead of the mechanism, and it does not pass by
 * accident if the schema throws for an unrelated reason.
 *
 * NOTE WHAT THE FAILURE CASES ARE. Not "a number", not "null" — TypeScript
 * already prevents those at every call site that matters. The cases worth
 * testing are the ones a real person types: a handle that is one character
 * too short, a hyphen instead of an underscore. Those are the boundaries
 * the regex actually decides.
 */

/* ============================================================================
 * 4. ROUTE TESTS — Elysia's best property
 * ============================================================================
 * `app.handle(request)` runs the full pipeline and returns a `Response`.
 * No `listen()`, no port, no supertest, no cleanup, no flake.
 *
 * ---------------------------------------------------------------------------
 * READ THIS FIRST — THE HOSTNAME TRAP, verified against elysia 1.4.30
 * ---------------------------------------------------------------------------
 * The hostname in the URL you construct is not arbitrary. A host that is
 * too SHORT makes every route 404, including routes that plainly exist:
 *
 *     await app.handle(new Request('http://x/plain'))          -> 404
 *     await app.handle(new Request('http://abc/plain'))        -> 404
 *     await app.handle(new Request('http://abcd/plain'))       -> 200
 *     await app.handle(new Request('http://localhost/plain'))  -> 200
 *
 * Measured, not guessed. The cause is an optimisation in Elysia's path
 * extraction: it skips the scheme and host by scanning for the first `/`
 * from a FIXED offset of 11 characters. `http://` is 7, so the host must be
 * at least 4 characters for the path to start at or after index 11. With
 * `https://` (8 chars) 3 is enough — which is why the threshold appears to
 * move depending on the scheme.
 *
 * This is vicious precisely because the failure is a plausible one: a 404
 * on a route you are testing looks like a routing bug, a prefix mistake, or
 * a plugin that didn't register. You will debug your app for an hour.
 *
 * THE RULE: always use `http://localhost` in tests. Every example below
 * does. Building the URL through one tiny helper means you cannot get it
 * wrong in one test out of forty:
 *
 *     const url = (path: string) => `http://localhost${path}`;
 */

const productSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  priceMinor: z.number().int().nonnegative(),
});

declare const productsRoutes: Elysia;

export function routeSpec(): void {
  describe('GET /products/:id', () => {
    const app = new Elysia().use(productsRoutes);

    it('returns 404 for an id that does not exist', async () => {
      const response = await app.handle(
        new Request('http://localhost/products/00000000-0000-4000-8000-000000000000'),
      );

      expect(response.status).toBe(404);
    });

    it('returns 422 for an id that is not a uuid', async () => {
      // This asserts the VALIDATION LAYER, and it is the test people skip.
      // It is also the one that catches a schema someone loosened to
      // z.string() to make an unrelated test pass.
      const response = await app.handle(new Request('http://localhost/products/not-a-uuid'));

      expect(response.status).toBe(422);
    });

    it('returns a body matching the published contract', async () => {
      const response = await app.handle(
        new Request('http://localhost/products/11111111-1111-4111-8111-111111111111'),
      );

      expect(response.status).toBe(200);
      // Assert against the SCHEMA, not a hand-written object literal. This
      // fails if a field is missing, has the wrong type, or if the response
      // drifts from what packages/shared promises — which is the actual
      // contract apps/web depends on.
      //
      // `await` the body FIRST. `response.json()` returns a Promise, and
      // parsing the Promise itself fails every time — measured: the
      // un-awaited form of this line fails against a perfectly correct
      // route. It also typechecks, because `.json()` is `Promise<any>`,
      // which is why only running it catches it.
      const body: unknown = await response.json();
      expect(productSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('POST /products', () => {
    const app = new Elysia().use(productsRoutes);

    it('rejects a payload with a negative price', async () => {
      const response = await app.handle(
        new Request('http://localhost/products', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Mug', priceMinor: -1 }),
        }),
      );

      expect(response.status).toBe(422);
    });
  });
}

/*
 * `content-type: application/json` is required. Without it Elysia does not
 * parse the body, and the failure is misleading rather than obvious —
 * measured against 1.4.30, you get the same 422 as a bad payload, reported
 * against the ROOT of the body:
 *
 *     { "type": "validation", "on": "body", "property": "root", ... }
 *
 * So a forgotten header looks exactly like a schema that rejects your
 * perfectly good object. `property: "root"` with a payload you believe is
 * valid is the tell.
 *
 * THE STATUS CODES BELOW ARE MEASURED, NOT ASSUMED. Elysia 1.4.30 returns
 * **422** for a failed `body`, `params` OR `query` schema — not 400. If you
 * assert 400 because that is what most frameworks do, your tests fail
 * against correct code.
 *
 * THE STATUS CODES ARE THE TEST. A route test asserting only the happy path
 * misses the entire error surface, and the error surface is what breaks
 * when someone refactors. For each route: the success, the not-found, the
 * invalid-input, and — where one exists — the unauthorized.
 *
 * ASSERT THE CONTRACT, NOT A SNAPSHOT. `toMatchSnapshot()` on an API
 * response looks efficient and is a trap: every intentional change produces
 * a diff someone approves without reading, until a snapshot no longer
 * asserts anything. Parsing against the shared schema asserts the thing
 * that actually matters — that the response still satisfies what the
 * frontend imports.
 */

/* ============================================================================
 * 5. SERVICE TESTS — where the fake repository earns its keep
 * ============================================================================
 */

interface ProductRowLike {
  readonly id: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly stockCount: number;
}

interface ProductRepositoryLike {
  findManyByIds(ids: readonly string[]): Promise<ProductRowLike[]>;
}

class OutOfStockError extends Error {
  override readonly name = 'OutOfStockError';
  constructor(readonly productId: string) {
    super(`Out of stock: ${productId}`);
  }
}

function quoteOrder(
  repo: ProductRepositoryLike,
): (lines: readonly { productId: string; quantity: number }[]) => Promise<number> {
  return async (lines) => {
    const rows = await repo.findManyByIds(lines.map((l) => l.productId));
    const byId = new Map(rows.map((r) => [r.id, r]));

    let total = 0;
    for (const line of lines) {
      const product = byId.get(line.productId);
      if (!product) throw new Error(`Unknown product ${line.productId}`);
      if (product.stockCount < line.quantity) throw new OutOfStockError(product.id);
      total += product.priceMinor * line.quantity; // price from the DB, never the request
    }
    return total;
  };
}

export function serviceSpec(): void {
  // A hand-written fake, not `jest.mock()`. It is five lines, it is typed
  // against the real interface (so it breaks when that interface changes),
  // and it has no module-registry magic to debug.
  const fakeRepo = (rows: ProductRowLike[]): ProductRepositoryLike => ({
    findManyByIds: (ids) => Promise.resolve(rows.filter((r) => ids.includes(r.id))),
  });

  describe('quoteOrder', () => {
    it('multiplies price by quantity and sums the lines', async () => {
      const quote = quoteOrder(
        fakeRepo([
          { id: 'a', name: 'Mug', priceMinor: 120_000, stockCount: 10 },
          { id: 'b', name: 'Bowl', priceMinor: 250_000, stockCount: 10 },
        ]),
      );

      await expect(
        quote([
          { productId: 'a', quantity: 2 },
          { productId: 'b', quantity: 1 },
        ]),
      ).resolves.toBe(490_000);
    });

    it('throws OutOfStockError naming the product', async () => {
      const quote = quoteOrder(fakeRepo([{ id: 'a', name: 'Mug', priceMinor: 120_000, stockCount: 1 }]));

      // Assert the TYPE, not the message. Messages are copy and will be
      // reworded; the type is the contract the route layer switches on when
      // it maps errors to status codes.
      await expect(quote([{ productId: 'a', quantity: 5 }])).rejects.toBeInstanceOf(OutOfStockError);
    });
  });
}

/*
 * THE REASON THIS TEST IS POSSIBLE is that the service takes its repository
 * as an argument (dto-and-dao.ts section 4). A service that imported `db`
 * directly could only be tested with a database. Dependency injection on a
 * backend this size is not a framework — it is a function parameter, and
 * this is the payoff.
 *
 * THE CASE WORTH TESTING HERE, above all others: that the price comes from
 * the repository and not from the request. Pass a line with an extra
 * `priceMinor: 1` field and assert the quote ignores it. That is a test
 * that maps directly onto a real attack.
 */

/* ============================================================================
 * 6. REPOSITORY TESTS — against a real Postgres, not a mock
 * ============================================================================
 */

/*
 * DO NOT MOCK THE DATABASE. A mocked `db.select()` asserts that you called
 * Drizzle the way you thought you would — which is the thing you were
 * already sure about. It cannot catch: a typo'd column, a broken join, a
 * constraint violation, a `NOT NULL` you forgot, a migration you didn't
 * apply, or `sum()` returning a string (drizzle-playbook.ts section 8.3).
 * Those are the entire reason to test this layer. Mocking removes all of
 * them and leaves the part that never breaks.
 *
 * USE A REAL POSTGRES. Locally that is a second database on the instance
 * that already exists:
 *
 *   createdb pottery_test
 *   DATABASE_URL=postgres://postgres:...@localhost:5432/pottery_test \
 *     npm run db:migrate --workspace=api
 *
 * Running migrations against it is not incidental — it is how you find out
 * your migrations apply cleanly to an empty database, which is the one
 * property that matters on the day you deploy.
 *
 * ISOLATION — the pattern that makes this fast and flake-free:
 *
 *   beforeEach: BEGIN
 *   afterEach:  ROLLBACK
 *
 * Every test runs inside a transaction that is thrown away, so tests cannot
 * see each other's rows, order does not matter, and there is no truncate
 * between them. With Drizzle, `tx.rollback()` is the discard — it THROWS
 * `TransactionRollbackError` (drizzle-orm 0.45.2), so the helper swallows
 * exactly that error and lets every other one (a failed assertion) through:
 *
 *   import { TransactionRollbackError } from 'drizzle-orm';
 *
 *   async function inRolledBackTx(fn: (tx: Db) => Promise<void>) {
 *     await db
 *       .transaction(async (tx) => {
 *         await fn(tx);        // assertions run here, against tx
 *         tx.rollback();       // discard everything the test wrote
 *       })
 *       .catch((e: unknown) => {
 *         if (!(e instanceof TransactionRollbackError)) throw e;
 *       });
 *   }
 *
 *   it('finds by slug', () => inRolledBackTx(async (tx) => {
 *     const repo = createProductRepository(tx);   // tx, not db
 *     ...
 *   }));
 *
 * THE LIMITATION, stated plainly: code under test must accept the `tx`
 * handle. Anything that grabs the module-level `db` itself writes outside
 * your transaction and will not be rolled back — the same trap as
 * drizzle-playbook.ts section 7, surfacing in tests instead of production.
 * It is another reason repositories take `db` as a parameter.
 *
 * AND THE THING THIS PATTERN CANNOT TEST: your own transaction boundaries.
 * You cannot meaningfully test a nested commit from inside a transaction
 * you intend to roll back. For those few tests, truncate between runs
 * instead.
 *
 * NEVER POINT TESTS AT A DATABASE WITH REAL DATA. A test suite's job is to
 * put the database into known states, and one `delete` with no `where`
 * (drizzle-playbook.ts section 6.4) is all it takes. A separate
 * `DATABASE_URL` for tests is not bureaucracy.
 */

/* ============================================================================
 * 7. TEST DATA — builders, and where it must not end up
 * ============================================================================
 */

interface ProductInput {
  name: string;
  slug: string;
  priceMinor: number;
  stockCount: number;
}

/**
 * A builder with sensible defaults and a partial override. The test then
 * states ONLY the field it cares about, so the reason the test exists is
 * visible in the diff.
 */
export function aProduct(overrides: Partial<ProductInput> = {}): ProductInput {
  return {
    name: 'Test Product',
    slug: `test-product-${String(Math.random()).slice(2, 10)}`,
    priceMinor: 100_000,
    stockCount: 5,
    ...overrides,
  };
}

/*
 *   const soldOut = aProduct({ stockCount: 0 });
 *
 * reads as "a product, except it is sold out" — and when the required
 * fields change, one builder changes rather than forty literals.
 *
 * The randomised slug is deliberate: `slug` is `.unique()` in the schema,
 * so a fixed value makes the second insert in a suite fail on a constraint
 * that has nothing to do with the test.
 *
 * THIS BELONGS IN A TEST FILE OR A TEST HELPER. NOT IN `src/`, NOT IN A
 * SEED SCRIPT, NOT IN A MIGRATION. Invented demo content — "Terracotta
 * Vase", "Clay Mug" — has a way of becoming permanent: it gets committed as
 * a fixture, then someone runs the seed against staging, then it appears in
 * a screenshot. Test data exists inside the test that needs it and is
 * discarded with the transaction that created it (section 6).
 *
 * The database is empty at rest, on purpose. `npm run db:migrate` gives you
 * the schema and nothing else, which is the correct starting state.
 */

/* ============================================================================
 * 8. TIME, RANDOMNESS, AND THE OUTSIDE WORLD
 * ============================================================================
 */

export function timeSpec(): void {
  describe('order timestamps', () => {
    beforeEach(() => {
      // Real clocks make real flakes: a test asserting "createdAt is today"
      // fails once a year at midnight UTC, and a test that waits for a
      // timeout is slow every single run.
      jest.useFakeTimers().setSystemTime(new Date('2026-09-20T12:00:00Z'));
    });

    afterEach(() => {
      // Without this, fake timers leak into every later file in the same
      // worker and the failures appear somewhere unrelated.
      jest.useRealTimers();
    });

    it('records createdAt from the system clock', () => {
      expect(new Date().toISOString()).toBe('2026-09-20T12:00:00.000Z');
    });
  });
}

/*
 * CAVEAT: fake timers control the JS clock, not Postgres's. A column with
 * `defaultNow()` gets the DATABASE's time, and `setSystemTime` has no
 * effect on it. To test time-dependent rows, pass the timestamp in from the
 * application rather than defaulting it in SQL — which is a design decision
 * the test is telling you about, not an obstacle to work around.
 *
 * WHAT TO MOCK, and the list is short:
 *   - time (above)
 *   - randomness, when an assertion depends on it
 *   - THE NETWORK. Always. A test must never call the real Telegram API: it
 *     is slow, it fails when someone's wifi drops, and it sends real
 *     messages to real people.
 *
 * WHAT NOT TO MOCK:
 *   - the database (section 6)
 *   - your own modules, when a parameter would do (section 5)
 *   - anything whose behaviour is the thing under test
 *
 * The general test: mocking something you do not control (the network, the
 * clock) is isolation. Mocking something you DO control is usually a design
 * problem asking to be a function parameter.
 */

/* ============================================================================
 * 9. COVERAGE, AND WHAT IT'S ACTUALLY TELLING YOU
 * ============================================================================
 *
 * Coverage measures which lines RAN, not which behaviours were CHECKED. A
 * test that calls every function and asserts nothing reports 100%.
 *
 * Read it as a map of holes, not a score. The useful question is never "are
 * we at 80%" — it is "is the order-quoting code covered, and are the error
 * branches covered." An uncovered `catch` block is the finding; an
 * uncovered `toString()` helper is not.
 *
 * A coverage THRESHOLD in CI tends to produce assertion-free tests written
 * to satisfy it. If you set one, set it low enough to be a floor rather
 * than a target.
 *
 * `npm test --workspace=api -- --coverage` when you want the map.
 */

/* ============================================================================
 * 10. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Testing that your dependencies work                          -> S1
 * - Expecting `jest` to catch type errors (@swc/jest doesn't)    -> S2
 * - Only testing the happy path of a route                       -> S4
 * - `toMatchSnapshot()` on an API response                       -> S4
 * - Asserting an error's message instead of its type             -> S5
 * - `jest.mock()` where a typed fake object would do             -> S5
 * - Mocking the database                                         -> S6
 * - Tests that depend on each other's rows, or on order          -> S6
 * - Pointing tests at a database with real data                  -> S6
 * - Fixture data left behind in `src/` or a seed script          -> S7
 * - A fixed value in a column with a unique constraint           -> S7
 * - `useFakeTimers()` with no `useRealTimers()` in afterEach     -> S8
 * - Calling a real external API from a test                      -> S8
 * - Treating a coverage percentage as the goal                   -> S9
 */

export const _referenced = {
  telegramHandleSpec,
  routeSpec,
  serviceSpec,
  timeSpec,
  aProduct,
  quoteOrder,
  OutOfStockError,
};
