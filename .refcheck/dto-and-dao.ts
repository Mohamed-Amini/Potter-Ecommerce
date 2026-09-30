/**
 * DTO, DAO, ENTITY, ROW — four words for "a product", and why you need
 * all four (grounded in Pottery Market's apps/api + packages/shared).
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/backend/dto-and-dao.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * THE ONE IDEA: the shape a row has IN THE DATABASE, the shape it has IN
 * YOUR BUSINESS LOGIC, the shape a client is allowed to SEND, and the shape
 * a client is allowed to SEE are four different things that merely happen
 * to look alike on day one. Every serious backend bug in this area comes
 * from treating them as one thing and then discovering, months later, that
 * they were never the same.
 */

import { and, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/* ============================================================================
 * 0. THE VOCABULARY, IN ONE PLACE
 * ============================================================================
 * These words get used loosely. Here's what each means in this codebase:
 *
 *   ROW      — what the database hands back. `typeof products.$inferSelect`.
 *              Snake-case columns mapped to camelCase fields, nullable
 *              where the column is nullable, Date objects for timestamps.
 *              Knows nothing about HTTP.
 *
 *   ENTITY   — the domain object your business rules operate on. "An order
 *              request that has been contacted but not confirmed." May span
 *              several tables (an order + its items). May have methods or
 *              invariants. In a small codebase this is often just a typed
 *              object, and that's fine.
 *
 *   DTO      — Data Transfer Object. The shape that crosses the HTTP
 *              boundary. Two of them, and conflating them is the mistake:
 *                - REQUEST DTO: what a client may send. Validated.
 *                - RESPONSE DTO: what a client may see. Filtered.
 *              In this project both are zod schemas in `packages/shared`,
 *              which is what lets apps/web and apps/api share one contract.
 *
 *   DAO /
 *   REPOSITORY — the only code that talks to the database. Takes and
 *              returns rows or entities; never Request objects, never HTTP
 *              status codes. "DAO" and "repository" are used
 *              interchangeably by most people; the pedantic distinction
 *              (DAO = per-table, repository = per-aggregate) is not worth
 *              arguing about — what matters is that ONE layer owns SQL.
 *
 * Why four and not one: each has a different reason to change. The row
 * changes when you add an index or denormalise. The response DTO changes
 * when the UI needs a new field. If they're the same type, a database
 * refactor becomes an API-breaking change, and an API tweak becomes a
 * migration. Keeping them separate is what stops those two things being
 * the same event.
 */

/* ============================================================================
 * 1. THE SAME CONCEPT, FOUR TIMES
 * ============================================================================
 */

/* --- The ROW (apps/api/src/db/schema.ts) --------------------------------- */

const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description').notNull(),
  material: varchar('material', { length: 50 }).notNull(),
  sizeLabel: varchar('size_label', { length: 50 }).notNull(),
  priceMinor: integer('price_minor').notNull(),
  currency: varchar('currency', { length: 6 }).notNull().default('RUB'),
  stockCount: integer('stock_count').notNull().default(0),
  images: text('images').array().notNull(),
  // Columns that exist for the BUSINESS, not for the client:
  costMinor: integer('cost_minor').notNull().default(0), // what the clay cost
  internalNote: text('internal_note'), // "glaze cracks if fired twice"
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

type ProductRow = typeof products.$inferSelect;

/* --- The REQUEST DTO (packages/shared) ----------------------------------- */

const productIdSchema = z.uuid().brand<'ProductId'>();
type ProductId = z.infer<typeof productIdSchema>;

const createProductSchema = z.object({
  categoryId: z.uuid().brand<'CategoryId'>(),
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(50),
  description: z.string().max(5000),
  material: z.string().min(1).max(50),
  sizeLabel: z.string().min(1).max(50),
  priceMinor: z.number().int().nonnegative(),
  currency: z.literal('RUB'),
  stockCount: z.number().int().nonnegative(),
  images: z.array(z.url()).min(1),
});
type CreateProductPayload = z.infer<typeof createProductSchema>;

/* --- The RESPONSE DTO (packages/shared) ---------------------------------- */

const productSchema = z.object({
  id: productIdSchema,
  categoryId: z.uuid().brand<'CategoryId'>(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  material: z.string().min(1),
  sizeLabel: z.string().min(1),
  priceMinor: z.number().int().nonnegative(),
  currency: z.literal('RUB'),
  stockCount: z.number().int().nonnegative(),
  images: z.array(z.url()).min(1),
});
type Product = z.infer<typeof productSchema>;

/*
 * READ THE THREE LISTS AGAINST EACH OTHER — the differences are the point:
 *
 *   `id`            row: yes  request: NO   response: yes
 *                   The server generates it. A client that can choose its
 *                   own id can overwrite an existing row.
 *
 *   `createdAt`     row: yes  request: NO   response: (not here)
 *                   Server-owned. A client sending `createdAt` is either
 *                   confused or malicious.
 *
 *   `costMinor`     row: yes  request: NO   response: NO
 *                   What Alina paid for materials. Business data. Putting
 *                   it in the response leaks her margins to anyone who
 *                   opens devtools.
 *
 *   `internalNote`  row: yes  request: NO   response: NO
 *                   Same category. Staff-only.
 *
 * That is the argument for separate types in four lines: two of these
 * columns must never reach a customer's browser, and the only structural
 * way to guarantee that is for the response type to not contain them.
 */

/* ============================================================================
 * 2. WHY "JUST RETURN THE ROW" IS A BUG WITH A DELAYED FUSE
 * ============================================================================
 */

/** WRONG — compiles, works, passes review, leaks. */
async function getProductBad(db: Db, id: string): Promise<ProductRow | undefined> {
  const [row] = await db.select().from(products).where(eq(products.id, id));
  return row; // costMinor and internalNote are now in the HTTP response
}

/*
 * On the day this is written there may be no `costMinor` column, so it's
 * genuinely harmless. The fuse is that SIX MONTHS LATER somebody adds one,
 * in a migration that touches no route file, reviewed by someone thinking
 * about the database. Nothing in the diff says "this publishes a new field
 * to the internet."
 *
 * That's the real argument, and it's about TIME, not about purity: the
 * mistake is made by a different person, in a different file, in a change
 * that looks unrelated. A response DTO makes adding a column the DEFAULT-
 * SAFE action — a new column is invisible to clients until somebody
 * deliberately adds it to the schema.
 *
 * The same reasoning applies in reverse for requests. `db.insert(products)
 * .values(body)` with an unvalidated `body` is a mass-assignment
 * vulnerability: whatever extra keys the client sent go straight into the
 * row. `createProductSchema` strips them — zod objects drop unknown keys by
 * default, which is exactly the behaviour you want at this boundary.
 */

/** RIGHT — the row is mapped, so only declared fields can escape. */
async function getProductGood(db: Db, id: string): Promise<Product | undefined> {
  const [row] = await db.select().from(products).where(eq(products.id, id));
  return row ? toProductDto(row) : undefined;
}

/* ============================================================================
 * 3. MAPPERS — where the translation lives
 * ============================================================================
 */

function toProductDto(row: ProductRow): Product {
  // Listing every field by hand is the feature, not the tedium. To be
  // exact about why: `productSchema.parse({ ...row })` would ALSO be safe
  // TODAY, because zod strips unknown keys by default. The explicit list is
  // for the day someone switches the schema to `z.looseObject()` (or adds
  // `.passthrough()`) for an unrelated reason: with a spread, that one edit
  // silently starts publishing `costMinor`; with a field list, nothing
  // changes. The safety should not depend on a default nobody is looking at.
  return productSchema.parse({
    id: row.id,
    categoryId: row.categoryId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    material: row.material,
    sizeLabel: row.sizeLabel,
    priceMinor: row.priceMinor,
    currency: row.currency,
    stockCount: row.stockCount,
    images: row.images,
  });
}

/*
 * WHY `.parse()` AND NOT A BARE CAST — this is the subtle half.
 *
 * The DB's `currency` is `varchar(6)`, so its TS type is `string`. The
 * DTO's is `z.literal('RUB')`. TypeScript cannot prove a `string` is
 * `'RUB'`, so something has to bridge that gap. Your two options:
 *
 *   `as Product`         — silences the compiler, verifies nothing. If a
 *                          row somehow holds 'USD', it sails through and
 *                          breaks in the browser.
 *   `productSchema.parse` — actually checks at runtime. A bad row throws
 *                          HERE, with a precise message, at the boundary
 *                          where you can still return a 500 that means
 *                          something.
 *
 * This is the `as`-is-a-smell rule from
 * examples/typescript/typescript-senior-practices.ts in its most practical
 * form: a cast asserts, a parse verifies. At a trust boundary you want
 * verification. `products.route.ts` already does this — every handler ends
 * in `productSchema.parse(row)`.
 *
 * It also earns the branded ids for free. `row.id` is `string`;
 * `Product['id']` is `ProductId` (a branded string). Only a parse can
 * legitimately produce a brand, which is precisely the discipline brands
 * exist to enforce (generics-deep-dive.ts section 6).
 *
 * THE COST, stated honestly: you now maintain a field list in two places,
 * and adding a field means editing the schema AND the mapper. That is a
 * real, recurring tax. It is worth paying at the HTTP boundary, where the
 * failure mode is "leaked business data", and usually NOT worth paying
 * between two internal layers, where it is pure typing.
 */

/* --- The reverse mapper: DTO -> row ------------------------------------- */

function toInsertValues(payload: CreateProductPayload): typeof products.$inferInsert {
  return {
    categoryId: payload.categoryId,
    slug: payload.slug,
    name: payload.name,
    description: payload.description,
    material: payload.material,
    sizeLabel: payload.sizeLabel,
    priceMinor: payload.priceMinor,
    currency: payload.currency,
    stockCount: payload.stockCount,
    images: [...payload.images],
    // id / createdAt: omitted on purpose — the database owns them.
    // costMinor / internalNote: omitted on purpose — a customer-facing
    // create endpoint has no business setting them. An ADMIN endpoint would
    // use a different request schema that includes them, which is the
    // cleanest illustration of why "one type per table" doesn't survive
    // contact with real requirements.
  };
}

/*
 * `[...payload.images]` is not decoration. zod infers `string[]`, but if
 * the DTO type were `readonly string[]` (which is the better default —
 * typescript-power-patterns.ts Part 3), Drizzle's insert type wants a
 * mutable array. Copying is the honest fix; `as string[]` would be a lie
 * that happens to work until someone mutates it.
 */

/* ============================================================================
 * 4. THE DAO / REPOSITORY — one layer owns SQL
 * ============================================================================
 * PLAIN ENGLISH: a repository is an object whose methods are the complete
 * list of things your app can do to one part of the database. Nothing
 * outside it writes SQL.
 */

type Db = PostgresJsDatabase<Record<string, never>>;

export interface ProductRepository {
  findById(id: ProductId): Promise<ProductRow | undefined>;
  findManyByIds(ids: readonly ProductId[]): Promise<ProductRow[]>;
  findBySlug(slug: string): Promise<ProductRow | undefined>;
  list(limit: number, offset: number): Promise<ProductRow[]>;
  insert(values: typeof products.$inferInsert): Promise<ProductRow>;
  /** Decrements stock ONLY if enough is left. `undefined` = not enough. */
  reserveStock(id: ProductId, quantity: number): Promise<ProductRow | undefined>;
}

/**
 * Takes its `db` as an argument rather than importing the singleton. That
 * one decision is what makes the repository (a) testable against a scratch
 * database and (b) usable INSIDE a transaction — because a Drizzle
 * transaction handle `tx` is assignable here, so the same repository
 * composes into a unit of work. See section 5.
 */
export function createProductRepository(db: Db): ProductRepository {
  return {
    async findById(id) {
      const [row] = await db.select().from(products).where(eq(products.id, id));
      return row;
    },

    async findManyByIds(ids) {
      // Not a correctness guard — `inArray(col, [])` is valid SQL on 0.45
      // (drizzle-playbook.ts section 5.4, measured). It just saves a round
      // trip that is guaranteed to return nothing.
      if (ids.length === 0) return [];
      // `[...ids]` and not `ids as string[]`: `inArray` wants a mutable
      // array, and the parameter is `readonly ProductId[]`. The cast is
      // rejected outright here (a readonly branded array does not "overlap"
      // a mutable string[]), which is the compiler making section 3's point
      // for us — copy honestly rather than assert.
      return await db.select().from(products).where(inArray(products.id, [...ids]));
    },

    async findBySlug(slug) {
      const [row] = await db.select().from(products).where(eq(products.slug, slug));
      return row;
    },

    async list(limit, offset) {
      return await db.select().from(products).limit(limit).offset(offset);
    },

    async insert(values) {
      const [row] = await db.insert(products).values(values).returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    },

    async reserveStock(id, quantity) {
      // The arithmetic AND the rule happen in SQL, in ONE statement:
      //   UPDATE products SET stock_count = stock_count - $1
      //    WHERE id = $2 AND stock_count >= $3  RETURNING *
      // Postgres locks the row for that statement and re-reads it, so two
      // concurrent orders for the last pot cannot both succeed — measured
      // in postgres-beyond-drizzle.ts section 7, where the read-in-JS
      // version sold a pot that did not exist. Zero rows back IS the "not
      // enough stock" answer.
      const [row] = await db
        .update(products)
        .set({ stockCount: sqlMinus(products.stockCount, quantity) })
        .where(and(eq(products.id, id), gte(products.stockCount, quantity)))
        .returning();
      return row;
    },
  };
}

/* Small helper so the section above reads cleanly; see drizzle-playbook.ts
 * section 9 for why `sql` templates are parameterised and therefore safe
 * (a plain number in a `${}` slot is fine — it is non-primitive VALUES like
 * a Date that lose their column mapping, postgres-beyond-drizzle.ts §4). */
import { sql } from 'drizzle-orm';
import type { SQL, AnyColumn } from 'drizzle-orm';
function sqlMinus(column: AnyColumn, amount: number): SQL<number> {
  return sql<number>`${column} - ${amount}`;
}

/*
 * WHAT A REPOSITORY MUST NOT DO — the boundary is only worth something if
 * it's actually held:
 *
 *   NO HTTP. No `Request`, no `status(404)`, no `Response`. A repository
 *   that returns a 404 cannot be reused by a CLI script or a cron job, and
 *   "not found" is not always an error — sometimes it's the answer.
 *   Return `undefined` and let the caller decide what that means.
 *
 *   NO BUSINESS RULES. "Which lines make up an order, and what happens when
 *   one is sold out" belongs in the service. The repository offers the
 *   race-free PRIMITIVE (`reserveStock` refuses to go below zero, because
 *   only the database can check that atomically); deciding what a refusal
 *   MEANS for the order is not its question.
 *
 *   NO TRANSACTIONS OF ITS OWN. Section 5.
 *
 *   NO DTO MAPPING. Debatable, and here's the call this project makes: the
 *   repository returns ROWS. Mapping to a DTO is the route layer's job,
 *   because "which fields may a client see" depends on WHICH client — the
 *   admin order screen and the public shop page want different projections
 *   of the same row. A repository that pre-maps has already decided that
 *   for everyone.
 *
 * WHY AN INTERFACE + A FACTORY, rather than a class:
 *   - The interface is the seam. A test can hand the service a plain object
 *     with the same shape and never touch a database
 *     (examples/testing/backend-testing.ts section 4).
 *   - A factory closing over `db` is the whole of the dependency injection
 *     you need on a backend this size. No container, no decorators, no
 *     framework. (This is genuinely different from the frontend, where
 *     Angular's injector earns its keep — see CONVENTIONS.md.)
 *   - It stays honest about what's public. A class tends to accumulate
 *     protected helpers; an interface lists exactly the operations that
 *     exist.
 */

/* ============================================================================
 * 5. THE SERVICE LAYER — business rules, and the transaction boundary
 * ============================================================================
 */

export interface CreateOrderInput {
  readonly customerName: string;
  readonly contact: { readonly method: 'telegram' | 'phone' | 'email'; readonly value: string };
  readonly lines: readonly { readonly productId: ProductId; readonly quantity: number }[];
}

export class OutOfStockError extends Error {
  override readonly name = 'OutOfStockError';
  constructor(
    readonly productId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Only ${String(available)} left of ${productId} (asked for ${String(requested)})`);
  }
}

/** A line names a product that does not exist (a stale basket, usually). */
export class UnknownProductError extends Error {
  override readonly name = 'UnknownProductError';
  constructor(readonly productId: string) {
    super(`Unknown product ${productId}`);
  }
}

/**
 * The service owns the RULES and the UNIT OF WORK. It knows nothing about
 * HTTP either — it throws domain errors and lets the route translate them
 * into status codes (examples/backend/api-architecture.ts section 4).
 */
export function createOrderService(db: Db) {
  return {
    async submit(input: CreateOrderInput): Promise<{ itemsTotalMinor: number }> {
      // Two lines for the same product are ONE demand. Checked line by line,
      // `[{ mug, 1 }, { mug, 1 }]` against a stock of 1 would pass twice.
      const quantities = new Map<ProductId, number>();
      for (const line of input.lines) {
        quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
      }

      // ONE transaction spanning the whole unit of work. The repository is
      // rebuilt around `tx`, so every statement inside — including the ones
      // the repository issues — is part of it.
      return await db.transaction(async (tx) => {
        const repo = createProductRepository(tx);

        const found = await repo.findManyByIds([...quantities.keys()]);
        const byId = new Map(found.map((p) => [p.id, p]));

        let itemsTotalMinor = 0;

        // Reserve in a SORTED order, never basket order: each reservation
        // row-locks its product until commit, and consistent lock ordering
        // is what makes a deadlock between two orders impossible
        // (postgres-beyond-drizzle.ts section 9).
        for (const productId of [...quantities.keys()].sort()) {
          const quantity = quantities.get(productId) ?? 0;
          const product = byId.get(productId);
          // A domain error, not a bare `Error`: a stale basket is the
          // CLIENT's input, and a bare Error would reach the route's bug
          // branch as a 500 (api-architecture.ts section 3).
          if (!product) throw new UnknownProductError(productId);

          // THE BUSINESS RULE, enforced where it cannot race. The
          // `product.stockCount` read above is only for the error message —
          // deciding from it in JS is the lost update that
          // postgres-beyond-drizzle.ts section 7 reproduces (two sessions
          // both read 5, both "sold" one, final stock 4). The guarded UPDATE
          // decides; zero rows back means another order got there first.
          const reserved = await repo.reserveStock(productId, quantity);
          if (!reserved) throw new OutOfStockError(productId, quantity, product.stockCount);

          // PRICE COMES FROM THE DATABASE. Never from the request body.
          // A client that can send its own price can send a price of 1.
          itemsTotalMinor += product.priceMinor * quantity;
        }

        // ...insert the order and its lines here, on the same `tx`
        // (drizzle-playbook.ts section 7 shows that half). Any throw above
        // rolls back every reservation already made.
        return { itemsTotalMinor };
      });
    },
  };
}

/*
 * WHY THE TRANSACTION IS HERE AND NOT IN THE REPOSITORY:
 *
 * If `insert()` opened its own transaction, then inserting an order and its
 * items would be TWO transactions. A crash between them leaves an order
 * with no lines — the exact corruption a transaction exists to prevent.
 * Worse, it's not composable: there is no way for a caller to say "these
 * two repository calls are one atomic operation."
 *
 * THE RULE: the layer that knows what a complete unit of work IS opens the
 * transaction. That is the service. A repository method takes whatever
 * handle it's given and doesn't ask whether it's a transaction.
 *
 * Note that `createProductRepository(tx)` typechecks with no casting
 * because Drizzle's transaction handle satisfies the same interface. That's
 * not luck — it's the reason the repository takes `db` as a parameter
 * instead of importing it.
 */

/* ============================================================================
 * 6. THE FLOW, END TO END
 * ============================================================================
 *
 *   HTTP request
 *     |
 *     v
 *   ROUTE                    parse body with the REQUEST DTO schema
 *   (elysia-playbook.ts)     |  422 on failure, automatically (measured)
 *     |                      |  translate domain errors -> status codes
 *     v
 *   SERVICE                  business rules, the transaction boundary,
 *   (this file, S5)          orchestration across repositories
 *     |                      |  throws domain errors; knows no HTTP
 *     v
 *   REPOSITORY               the only SQL in the codebase
 *   (this file, S4)          |  takes/returns rows; no rules, no HTTP
 *     |
 *     v
 *   DRIZZLE -> POSTGRES
 *     |
 *     v  rows come back up
 *   ROUTE                    map row -> RESPONSE DTO via `.parse()`
 *     |
 *     v
 *   HTTP response
 *
 * Each arrow crosses a boundary where the shape CHANGES on purpose. The
 * dependency direction is strictly downward: a repository must never import
 * a route, a service must never import Elysia. If you ever find yourself
 * adding such an import, the logic is in the wrong layer.
 *
 * THE FOLDER LAYOUT THIS IMPLIES — and what apps/api is growing into:
 *
 *   src/
 *     config/env.ts            validated config, throws at boot
 *     db/schema.ts             tables (the ROW shapes)
 *     db/client.ts             the pool, created once
 *     repositories/            products.repository.ts, orders.repository.ts
 *     services/                orders.service.ts
 *     routes/                  products.route.ts, orders.route.ts
 *     utils/Errors.util.ts     the error taxonomy
 *   packages/shared/src/schemas/   the DTOs — because apps/web needs them too
 *
 * The DTOs live in `packages/shared` specifically so the Angular app
 * imports the SAME schema the API validates against. That's the payoff of
 * the whole arrangement: the frontend cannot drift from the backend's
 * contract, because there is only one contract and both sides import it.
 */

/* ============================================================================
 * 7. WHEN *NOT* TO DO ANY OF THIS
 * ============================================================================
 * The honest counterweight, because layering has a real cost and cargo-cult
 * layering is its own failure mode.
 *
 * `categories.route.ts` in this project queries `db` directly from the
 * handler. No repository, no service. That is CORRECT for what it is: two
 * endpoints, no business rules, no transaction, no second caller. Adding
 * `categories.repository.ts` + `categories.service.ts` would be three files
 * and two indirections to wrap `db.select().from(categories)`.
 *
 * ADD A REPOSITORY WHEN:
 *   - the same query appears in more than one place
 *   - you need to run it inside someone else's transaction
 *   - you want to test the caller without a database
 *
 * ADD A SERVICE WHEN:
 *   - there is a rule that must hold no matter which route is called
 *   - an operation spans more than one table atomically
 *   - the same operation has more than one entry point (HTTP + a script)
 *
 * UNTIL THEN, A ROUTE MAY TALK TO `db` DIRECTLY. Refactoring a 15-line
 * handler into layers later is 20 minutes of mechanical work. Maintaining
 * six files per table from day one is a permanent tax on every change.
 *
 * What is NOT optional, at any size: validating the request and mapping the
 * response. Those two are about correctness and data leakage, not
 * architecture — `categories.route.ts` does both, in a file with no layers
 * at all.
 */

/* ============================================================================
 * 8. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Returning a DB row straight from a handler                   -> S2
 * - `db.insert(t).values(requestBody)` unvalidated               -> S2
 * - `as Product` where `productSchema.parse` belongs             -> S3
 * - Spreading a row into a DTO (`{ ...row }`)                    -> S3
 * - Accepting `id`/`createdAt` in a create payload               -> S1
 * - Trusting a price/total sent by the client                    -> S5
 * - Checking stock in JS, then writing (the lost update)         -> S4, S5
 * - A bare `Error` for a client's bad input (becomes a 500)      -> S5
 * - SQL outside the repository layer (once one exists)           -> S4
 * - A repository that returns 404 / touches `Request`            -> S4
 * - A repository that opens its own transaction                  -> S5
 * - A business rule enforced in a route instead of a service     -> S5
 * - A service that imports Elysia                                -> S6
 * - Six files per table before there is a second caller          -> S7
 */

/* Keep every demonstration referenced. */
declare const DATABASE_URL: string;
export const _db: Db = drizzle(postgres(DATABASE_URL));
export const _referenced = {
  products,
  createProductSchema,
  productSchema,
  getProductBad,
  getProductGood,
  toProductDto,
  toInsertValues,
  createProductRepository,
  createOrderService,
  OutOfStockError,
  UnknownProductError,
};
