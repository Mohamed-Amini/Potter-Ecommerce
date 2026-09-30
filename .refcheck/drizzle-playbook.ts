/**
 * DRIZZLE ORM + POSTGRES, END TO END
 * — the query layer under Pottery Market's apps/api.
 *
 * Self-contained: this file declares its own copy of the project's tables
 * so it compiles on its own, then queries them for real. Verify it from the
 * Pottery repo root, where drizzle-orm actually lives:
 *
 *   cp examples/backend/drizzle-playbook.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * Verified against drizzle-orm 0.45.2 / drizzle-kit 0.31.10 / Postgres 17.
 * Drizzle's builder API moves; where a signature changed recently this file
 * says so rather than quietly using the new one.
 *
 * THE ONE IDEA: Drizzle is not an abstraction over SQL, it's a typed
 * spelling of SQL. `db.select().from(products).where(eq(...))` is
 * `SELECT * FROM products WHERE ...` with the column names checked by the
 * compiler. That's the whole value proposition, and it's also the warning:
 * if you don't know what SQL a line produces, you don't know what it costs.
 */

import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  relations,
  sql,
  sum,
} from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/* ============================================================================
 * 1. THE THREE PIECES, AND WHICH ONE YOU'RE EDITING
 * ============================================================================
 * 1. `schema.ts`   — plain TS objects describing tables. The single source
 *                    of truth: code, reviewable, diffable. Not a GUI, not a
 *                    hand-edited .sql file.
 * 2. Drizzle Kit   — the CLI. Two DISTINCT workflows, not variants of one:
 *                    `generate` + `migrate` writes a numbered .sql file and
 *                    applies it (reviewable, has history — the default);
 *                    `push` diffs straight against the live DB and applies
 *                    immediately (no file, no history — prototyping only).
 * 3. The client    — `db.select()...`. Dialect-agnostic at the CALL SITE:
 *                    this project's SQLite -> Postgres move changed
 *                    `schema.ts`, `client.ts` and `drizzle.config.ts`, and
 *                    exactly zero route handlers.
 *
 * Which file a change belongs in is almost always obvious from that list —
 * the mistake to avoid is editing a generated `.sql` in `drizzle/` by hand.
 * Those files are a log of what was applied. Edit one and the snapshot in
 * `drizzle/meta/` no longer matches it, and the NEXT `generate` produces
 * nonsense. Fix schema.ts and generate a new migration instead. Always.
 */

/* ============================================================================
 * 2. THE SCHEMA — every column type decision, with the reason
 * ============================================================================
 */

/*
 * Small helpers first. Column definitions repeat across every table, and a
 * helper makes the repetition a single decision instead of ten copies that
 * can drift. This is exactly what apps/api/src/db/schema.ts does:
 */
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/** Every timestamp is `timestamptz` — see the measured reason below. */
const tstz = (name: string) => timestamp(name, { withTimezone: true });

/*
 * `uuid(...).defaultRandom()` compiles to `gen_random_uuid()`, built into
 * Postgres core since v13 — no pgcrypto, no uuid-ossp. (Under SQLite this
 * had to be plain `text`, which is one of the concrete reasons the move was
 * worth it.)
 *
 * WHY UUID AND NOT `serial`: ids appear in URLs. A sequential integer tells
 * a stranger how many products you have and lets them walk /products/1,
 * /products/2. A UUID doesn't. The cost is 16 bytes vs 4 and slightly worse
 * index locality — irrelevant at this scale, and worth it for the property
 * that ids can be generated client-side before the insert.
 *
 * THE EXCEPTION, and it's a good one: `orderRequests.referenceNumber` below
 * is a sequential integer ON PURPOSE. It's the number Alina says out loud
 * in a Telegram chat — "заказ №14". Nobody reads a UUID over a messenger.
 * Two ids on one row with two different jobs: the UUID is the system's
 * identity, the integer is the human's.
 */

export const categories = pgTable('categories', {
  id: id(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  name: text('name').notNull(),
});

export const products = pgTable(
  'products',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    slug: varchar('slug', { length: 200 }).notNull().unique(),
    name: varchar('name', { length: 50 }).notNull(),
    description: text('description').notNull(),
    material: varchar('material', { length: 50 }).notNull(),
    sizeLabel: varchar('size_label', { length: 50 }).notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: varchar('currency', { length: 6 }).notNull().default('RUB'),
    stockCount: integer('stock_count').notNull().default(0),
    images: text('images').array().notNull(),
    createdAt: createdAt(),
  },
  // NOTE (API CHANGE): the third argument is a callback returning an ARRAY.
  // Many tutorials still show it returning an OBJECT
  // (`(t) => ({ idx: index(...) })`); that form is deprecated and does not
  // typecheck on a current version. Verified against 0.45.2 — if you are on
  // an older release and the array form is rejected, check your version
  // rather than assuming the docs are wrong.
  (t) => [index('products_category_idx').on(t.categoryId)],
);

/*
 * COLUMN-BY-COLUMN, the decisions worth being able to defend:
 *
 * - `priceMinor: integer` — MONEY IS AN INTEGER OF MINOR UNITS. Never
 *   `float`/`real`/`double`. 0.1 + 0.2 !== 0.3 in binary floating point,
 *   and that error compounds across a basket until a total is off by a
 *   kopeck and nobody can explain why. 450000 means 4500.00 RUB. Format
 *   for display at the very edge (Intl.NumberFormat), never in the DB.
 *   Postgres also has `numeric`, which is exact — but it comes back as a
 *   STRING in JS (because it can exceed Number's precision), so every
 *   arithmetic site needs conversion. Integer minor units keep arithmetic
 *   in `number` where it belongs. The tradeoff is a hard ceiling around
 *   2.1 billion minor units on `integer` — use `bigint` if you might
 *   exceed that; ~21 million RUB per row is not a constraint here.
 *
 * - `varchar(50)` vs `text` — in Postgres these have IDENTICAL performance
 *   (unlike MySQL). `varchar(n)` is a CHECK constraint with nicer syntax.
 *   So the length is a business statement: "a product name over 50 chars is
 *   a mistake, reject it at the DB." Use `text` where there's no real
 *   maximum (`description`) and `varchar(n)` where there is. `varchar(254)`
 *   on email columns is the RFC 5321 limit, not a guess.
 *
 * - `images: text('images').array()` — a native Postgres `text[]`. SQLite
 *   had no array type and had to fake it as JSON-in-text. The judgement
 *   call: an array column is right when the values are a simple ordered
 *   list you always read whole. The moment you want to query "products
 *   whose second image is missing" or attach metadata (alt text, width),
 *   it should have been a `product_images` TABLE. Arrays are a convenience,
 *   not a way to dodge a join.
 *
 * - `currency` defaulted to `'RUB'` in the DB *and* pinned to
 *   `z.literal('RUB')` in the shared schema. Belt and braces on purpose:
 *   the DB default protects direct SQL inserts, the zod literal protects
 *   the API boundary.
 *
 * - `timestamp(..., { withTimezone: true })` — `timestamptz` — on EVERY
 *   timestamp, never the bare `timestamp(...)` default. MEASURED against
 *   drizzle-orm 0.45.2 on this machine's Postgres, whose `TimeZone` is
 *   `Asia/Krasnoyarsk` (UTC+7): with a bare `timestamp` column, a row
 *   filled by `defaultNow()` read back 420 MINUTES IN THE FUTURE, while a
 *   row written from a JS `Date` was correct. Two causes that compound:
 *   Postgres fills `now()` into a zone-less column as the SESSION's local
 *   wall clock, and Drizzle reads a zone-less value back by appending
 *   `+0000`, i.e. assumes it was UTC. So the SAME column mixes two
 *   meanings depending on who wrote the row, and "orders created today" is
 *   off by seven hours. `timestamptz` stores an instant; both paths agree.
 *   Cost: none — same 8 bytes. (Changing an existing column is an
 *   `ALTER COLUMN ... TYPE timestamptz USING col AT TIME ZONE '<the zone
 *   the old values were written in>'` migration — and that zone is exactly
 *   the thing to decide carefully, because the old rows are ambiguous.)
 */

export const contactMethod = pgEnum('contact_method', ['telegram', 'phone', 'email']);
export const orderStatus = pgEnum('order_status', [
  'new',
  'contacted',
  'confirmed',
  'shipped',
  'completed',
  'cancelled',
]);

/*
 * `pgEnum` is a REAL database type. An invalid value is rejected by
 * Postgres itself, not just by your app — which matters because your app is
 * not the only thing that will ever write to this database (a migration, a
 * psql session, a future admin script).
 *
 * THE COST, and it's the reason some teams avoid enums: adding a value is a
 * migration (`ALTER TYPE ... ADD VALUE`, which is cheap and non-blocking in
 * modern Postgres), but REMOVING or REORDERING one is genuinely awkward —
 * there is no `DROP VALUE`. So: use `pgEnum` for a closed set that changes
 * about never (order status, contact method). Use a lookup TABLE with a FK
 * when the set is editable by a human (product categories — which is
 * exactly why `categories` is a table here and not an enum).
 */

export const orderRequests = pgTable(
  'order_requests',
  {
    id: id(),
    referenceNumber: integer('reference_number').generatedAlwaysAsIdentity(),
    customerName: varchar('customer_name', { length: 100 }).notNull(),
    contactMethod: contactMethod('contact_method').notNull(),
    contactValue: varchar('contact_value', { length: 254 }).notNull(),
    note: text('note'),
    itemsTotalMinor: integer('items_total_minor').notNull(),
    agreedTotalMinor: integer('agreed_total_minor'),
    status: orderStatus('status').notNull().default('new'),
    contactedAt: tstz('contacted_at'),
    confirmedAt: tstz('confirmed_at'),
    completedAt: tstz('completed_at'),
    cancelledAt: tstz('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('order_requests_status_created_idx').on(t.status, t.createdAt),
    uniqueIndex('order_requests_reference_idx').on(t.referenceNumber),
  ],
);

/*
 * TWO TOTALS, ON PURPOSE. `itemsTotalMinor` is what the site quoted;
 * `agreedTotalMinor` is what Alina actually settled on in the chat, and it
 * is NULLABLE because it doesn't exist until that conversation happens.
 * Revenue sums the agreed one. Collapsing these into a single "total"
 * column would make "what did we quote vs what did we get" unanswerable
 * forever — and that's a question you only discover you need later, once
 * the data you'd need is already gone.
 *
 * FOUR TIMESTAMPS RATHER THAN JUST A STATUS. `status` tells you where an
 * order is NOW. It cannot tell you "how much did we complete in August" or
 * "how long between contact and confirmation", because a status column is
 * overwritten on every transition and keeps no history. Four nullable
 * timestamps make those plain SQL. The general principle: a status column
 * is a projection of history, not a substitute for it.
 *
 * `generatedAlwaysAsIdentity()` is the modern replacement for `serial`.
 * `GENERATED ALWAYS` means the app cannot supply the value at all — which
 * is what you want for a human-facing counter. (Identity values are still
 * not gap-free: a rolled-back transaction burns a number, because sequences
 * live outside transactions on purpose. Reference numbers may skip; that's
 * correct behaviour, not a bug to work around.)
 */

export const orderRequestItems = pgTable(
  'order_request_items',
  {
    id: id(),
    orderRequestId: uuid('order_request_id')
      .notNull()
      .references(() => orderRequests.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    nameSnapshot: varchar('name_snapshot', { length: 50 }).notNull(),
    priceMinorSnapshot: integer('price_minor_snapshot').notNull(),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [index('order_request_items_order_idx').on(t.orderRequestId)],
);

/*
 * THE SNAPSHOT COLUMNS ARE THE MOST IMPORTANT DESIGN DECISION IN THIS
 * SCHEMA, and they look like duplication until you see the failure they
 * prevent.
 *
 * Without them, an order line stores only `productId`, and the order's
 * history is rendered by joining to `products` — so when Alina raises the
 * price of a mug from 1200 to 1500, every PAST order silently re-prices
 * itself. An invoice you already sent now disagrees with the database.
 *
 * `nameSnapshot` and `priceMinorSnapshot` record what the customer actually
 * saw and agreed to, frozen at that instant. The FK to `products` stays for
 * analytics ("which product sells best" is a GROUP BY on productId), but
 * the money never moves again.
 *
 * The general rule: **a transactional record must not depend on mutable
 * master data for its meaning.** Copy the values that were agreed.
 *
 * TWO DIFFERENT `onDelete` BEHAVIOURS HERE, also deliberate:
 *   - items -> orderRequests is `cascade`: an order's lines have no meaning
 *     without the order, so deleting the order should take them.
 *   - items -> products has NO cascade (the default, `NO ACTION`): deleting
 *     a product that appears in a past order is REFUSED by Postgres. That
 *     refusal is a feature — it stops you shredding order history by
 *     tidying the catalogue. When Alina stops selling something, the answer
 *     is a `discontinued` flag, not a DELETE.
 */

/* ============================================================================
 * 3. RELATIONS — the second, optional declaration
 * ============================================================================
 * `references()` above creates the actual FOREIGN KEY in the database.
 * `relations()` below creates nothing in the database at all — it is purely
 * a hint to the `db.query` API (section 5) so it knows how to join for you.
 * You need both, and they are genuinely different things: forgetting
 * `references()` means no integrity; forgetting `relations()` just means
 * `db.query` can't use `with`.
 */

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const productsRelations = relations(products, ({ one }) => ({
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
}));

export const orderRequestsRelations = relations(orderRequests, ({ many }) => ({
  items: many(orderRequestItems),
}));

export const orderRequestItemsRelations = relations(orderRequestItems, ({ one }) => ({
  order: one(orderRequests, {
    fields: [orderRequestItems.orderRequestId],
    references: [orderRequests.id],
  }),
  product: one(products, {
    fields: [orderRequestItems.productId],
    references: [products.id],
  }),
}));

const schema = {
  categories,
  products,
  orderRequests,
  orderRequestItems,
  categoriesRelations,
  productsRelations,
  orderRequestsRelations,
  orderRequestItemsRelations,
};

/* ============================================================================
 * 4. THE CLIENT — and the pool settings that aren't optional
 * ============================================================================
 */

declare const DATABASE_URL: string;

const sql_ = postgres(DATABASE_URL, {
  max: 10, // pool size. See the note below — this is not "bigger is better".
  idle_timeout: 20, // seconds before an idle connection is returned
  connect_timeout: 10, // seconds to wait for a connection before failing
});

export const db = drizzle(sql_, { schema });

/*
 * `max` is the setting people get wrong. It is PER PROCESS. Four instances
 * with `max: 50` can open 200 connections against a default
 * `max_connections` of 100 (a few of which are reserved for superusers) —
 * so under load the THIRD instance is already refused, and because
 * postgres-js connects lazily it shows up at peak traffic, looking like a
 * networking problem. Postgres connections are expensive (a whole backend
 * process each); the right number is small. Start at 10.
 *
 * `connect_timeout` is the one that saves you at 3am: without it, a
 * database that has stopped accepting connections leaves every request
 * hanging instead of failing fast. Same principle as section 7 of the node
 * playbook — an unbounded wait is an unbounded liability.
 *
 * Worth adding for any query that could run away:
 *   postgres(url, { connection: { statement_timeout: 10_000 } })
 * A statement timeout turns "one bad query pins a CPU forever" into "one
 * request gets an error."
 *
 * The `db` object is created ONCE at module scope and shared. That's the
 * legitimate use of module-level state from node-playbook section 9 — a
 * pool is meant to be shared. Creating a client per request is a classic
 * and very effective way to exhaust the server.
 */

/* ============================================================================
 * 5. READING: the four shapes, and when each is right
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 5.1 `db.select()` — explicit SQL, no relation magic
 * -------------------------------------------------------------------------*/

export async function listProducts(): Promise<(typeof products.$inferSelect)[]> {
  return await db.select().from(products);
}

/*
 * `typeof products.$inferSelect` is the row type as it comes OUT (with
 * defaults applied, nullable columns as `T | null`). `$inferInsert` is the
 * shape going IN (columns with defaults become optional). These are derived
 * from the table definition, so they cannot drift — the same
 * "schema-generates-the-type" idea as `z.infer` in
 * examples/validation/zod-patterns.ts section 2, one layer down.
 */

/* ---------------------------------------------------------------------------
 * 5.2 SELECT ONLY THE COLUMNS YOU USE
 * -------------------------------------------------------------------------*/

export async function listProductCards(): Promise<
  { id: string; name: string; priceMinor: number; images: string[] }[]
> {
  return await db
    .select({
      id: products.id,
      name: products.name,
      priceMinor: products.priceMinor,
      images: products.images,
    })
    .from(products);
}

/*
 * The return type is narrowed automatically to exactly the keys you asked
 * for. Two wins, one of which is not about performance: a shop grid doesn't
 * need `description`, so you stop shipping kilobytes per row — and, more
 * importantly, a partial select is a hard guarantee that a column you
 * didn't ask for cannot leak into a response by accident. That's the same
 * safety the DTO layer buys (examples/backend/dto-and-dao.ts section 3),
 * enforced one level deeper.
 */

/* ---------------------------------------------------------------------------
 * 5.3 `db.query` with `with` — the relational API
 * -------------------------------------------------------------------------*/

export async function getOrderWithItems(orderId: string) {
  return await db.query.orderRequests.findFirst({
    where: eq(orderRequests.id, orderId),
    with: {
      items: {
        columns: { nameSnapshot: true, priceMinorSnapshot: true, quantity: true },
      },
    },
  });
}

/*
 * This returns a NESTED object (`{ ...order, items: [...] }`), which is
 * what an API response actually wants, and it does it in ONE round trip —
 * Drizzle builds a lateral join with json aggregation, not N+1 queries.
 *
 * `findFirst` returns `T | undefined`, not an array. Check it explicitly;
 * `noUncheckedIndexedAccess` won't save you here because it isn't an index
 * access.
 *
 * `db.select()` vs `db.query`: use `db.query` when you want a nested tree
 * and the shape maps cleanly onto your relations. Use `db.select()` the
 * moment you need an aggregate, a window function, a self-join, or precise
 * control over the emitted SQL. They compose — there is no "pick one for
 * the whole project" decision to make here.
 */

/* ---------------------------------------------------------------------------
 * 5.4 THE N+1 PROBLEM — the single most common ORM performance bug
 * -------------------------------------------------------------------------*/

/** WRONG: 1 query for the list, then 1 per row. 50 products = 51 queries. */
export async function listWithCategoryNamesBad(): Promise<{ name: string; category: string }[]> {
  const rows = await db.select().from(products);
  const out: { name: string; category: string }[] = [];
  for (const row of rows) {
    const [category] = await db.select().from(categories).where(eq(categories.id, row.categoryId));
    out.push({ name: row.name, category: category?.name ?? '' });
  }
  return out;
}

/** RIGHT: one join, one round trip, regardless of row count. */
export async function listWithCategoryNamesGood(): Promise<{ name: string; category: string }[]> {
  return await db
    .select({ name: products.name, category: categories.name })
    .from(products)
    .innerJoin(categories, eq(products.categoryId, categories.id));
}

/*
 * Why this survives review: the bad version is *correct*, reads naturally,
 * and is fast with 5 rows in development. It falls over at 500 rows in
 * production. Each query is only ~1ms, but 1ms of NETWORK LATENCY x 500,
 * strictly sequentially, is half a second of one request.
 *
 * How to spot it: an `await` on a database call inside a loop. That's the
 * whole tell. If the loop body queries, you have N+1.
 *
 * Three fixes, in order of preference:
 *   1. A join (above) — best when you want flat rows.
 *   2. `db.query` with `with` (5.3) — best when you want a nested tree.
 *   3. One `inArray` query, then group in memory — best when the shape
 *      doesn't suit either:
 *
 *        const ids = rows.map(r => r.categoryId);
 *        const cats = await db.select().from(categories)
 *          .where(inArray(categories.id, ids));
 *        const byId = new Map(cats.map(c => [c.id, c]));
 *
 *      Two queries total, no matter how many rows.
 *
 * THE EMPTY-ARRAY CASE, measured against 0.45.2 rather than assumed:
 *      inArray(t.id, [])     ->  ... where false      (matches nothing)
 *      notInArray(t.id, [])  ->  ... where true       (matches everything)
 * Both are CORRECT SQL and neither throws, so this is not the landmine
 * older write-ups describe. Guard anyway —
 *      if (ids.length === 0) return [];
 * — not for safety but because the query is a guaranteed-empty round trip
 * to the database, and `notInArray`'s `where true` is a full table scan you
 * definitely did not mean to issue.
 *
 * (Contrast `.insert().values([])`, which genuinely DOES throw —
 * "values() must be called with at least one value". Verified. Section 6.2.)
 */

/* ---------------------------------------------------------------------------
 * 5.5 Composing WHERE clauses conditionally
 * -------------------------------------------------------------------------*/

export async function searchProducts(filter: {
  categoryId?: string;
  inStockOnly?: boolean;
}): Promise<(typeof products.$inferSelect)[]> {
  // Build a list of conditions, drop the undefined ones, and hand the lot
  // to `and()`. This is the readable alternative to reassigning a query
  // builder in a chain of ifs.
  const conditions = [
    filter.categoryId !== undefined ? eq(products.categoryId, filter.categoryId) : undefined,
    filter.inStockOnly === true ? gt(products.stockCount, 0) : undefined,
  ].filter((c) => c !== undefined);

  return await db
    .select()
    .from(products)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
}

/*
 * `and()` / `or()` tolerate `undefined` entries by design, so the filter
 * step is belt-and-braces. Passing `undefined` to `.where()` means "no
 * WHERE clause" — which is why the explicit `conditions.length > 0` check
 * reads better than relying on that.
 *
 * Note this composes CONDITIONS, not SQL strings. There is no string
 * concatenation anywhere, so there is no injection surface. See section 9
 * for the one place raw SQL shows up and how to keep it safe.
 */

/* ============================================================================
 * 6. WRITING: insert, upsert, and the two catastrophes
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 6.1 `.returning()` — don't re-SELECT what you just wrote
 * -------------------------------------------------------------------------*/

export async function createCategory(input: typeof categories.$inferInsert) {
  const [row] = await db.insert(categories).values(input).returning();
  if (!row) throw new Error('Insert returned no row'); // cannot happen; the compiler doesn't know that
  return row;
}

/*
 * `RETURNING` is a Postgres feature Drizzle exposes directly, and it's the
 * only way to get server-generated values (the uuid, `createdAt`,
 * `referenceNumber`) without a second round trip. A follow-up SELECT isn't
 * just slower — it can race with a concurrent update and return something
 * that was never the state you inserted.
 *
 * The destructure needs the guard because `.returning()` is typed as an
 * array. Throwing on a genuinely impossible case beats `!`: if the
 * impossible happens, you get a clear error instead of `undefined` leaking
 * onward. (Same reasoning as examples/typescript/typescript-senior-practices.ts
 * on why `as` is a smell.)
 */

/* ---------------------------------------------------------------------------
 * 6.2 Bulk insert — one statement, not a loop
 * -------------------------------------------------------------------------*/

export async function addOrderItems(rows: (typeof orderRequestItems.$inferInsert)[]) {
  if (rows.length === 0) return []; // `.values([])` is a runtime error, not a no-op
  return await db.insert(orderRequestItems).values(rows).returning();
}

/*
 * `.values(array)` emits ONE multi-row INSERT. A `for` loop of single
 * inserts is N round trips and — unless wrapped in a transaction — N
 * independent chances to half-succeed.
 *
 * The empty-array guard is not defensive padding: Drizzle throws on an
 * empty `values()` because there is no valid SQL for it.
 */

/* ---------------------------------------------------------------------------
 * 6.3 Upsert with `onConflictDoUpdate`
 * -------------------------------------------------------------------------*/

export async function upsertCategory(slug: string, name: string) {
  const [row] = await db
    .insert(categories)
    .values({ slug, name })
    .onConflictDoUpdate({
      target: categories.slug, // must be a UNIQUE column or index
      set: { name },
    })
    .returning();
  return row;
}

/*
 * This is ATOMIC. The hand-rolled version — SELECT, then INSERT or UPDATE —
 * has a race between the two statements where a concurrent request can
 * insert the same slug, and you get a unique-violation you "already
 * checked for". `ON CONFLICT` pushes the check into the same statement,
 * where Postgres can hold the right lock.
 *
 * `target` must match an actual unique constraint — `categories.slug` is
 * `.unique()` in the schema above. Without one, Postgres has nothing to
 * detect a conflict ON and errors at runtime. Also: `onConflictDoNothing()`
 * exists for "insert if absent, don't care otherwise", and it returns ZERO
 * rows when it does nothing, which is a common surprise with `.returning()`.
 */

/* ---------------------------------------------------------------------------
 * 6.4 THE TWO CATASTROPHES
 * -------------------------------------------------------------------------*/

/*
 *   await db.update(products).set({ stockCount: 0 });   // every product
 *   await db.delete(orderRequests);                     // every order
 *
 * Both compile. Both are valid Drizzle. Both are a very bad afternoon.
 *
 * A missing `.where()` is not a syntax error in SQL or in Drizzle, and no
 * type system is going to save you — "update all rows" is a legitimate
 * operation that somebody needs. Defences, in order of how much they
 * actually help:
 *   1. Write `.where()` FIRST, before `.set()`, as a habit. Sounds trivial;
 *      it's the one that works.
 *   2. Code review flags any `update`/`delete` with no `.where()`.
 *   3. Prefer soft delete for anything a human created — a `deletedAt`
 *      timestamp is recoverable, a DELETE is not.
 *   4. The application's database user does not need to be a superuser.
 *      Least privilege is a real mitigation and costs nothing to set up.
 *
 * And the honest one: know where your backups are and whether you have ever
 * restored one. An untested backup is a rumour.
 */

/* ============================================================================
 * 7. TRANSACTIONS — where the boundary belongs
 * ============================================================================
 * PLAIN ENGLISH: a transaction makes several statements atomic — all of
 * them land, or none do. Without one, a crash between two writes leaves the
 * database in a state your code has no name for.
 */

interface OrderDraft {
  readonly customerName: string;
  readonly contactMethod: 'telegram' | 'phone' | 'email';
  readonly contactValue: string;
  readonly note: string | null;
  readonly lines: readonly { productId: string; quantity: number }[];
}

/** A domain error the route maps to a 4xx — a stale basket is the client's input. */
class UnknownProductError extends Error {
  override readonly name = 'UnknownProductError';
  constructor(readonly productId: string) {
    super(`Unknown product ${productId}`);
  }
}

export async function createOrderRequest(draft: OrderDraft) {
  // The shared schema already says `.min(1)` on lines, but this function
  // must not depend on every caller having parsed: with zero lines the
  // items insert below would be `.values([])`, which THROWS (section 6.2).
  if (draft.lines.length === 0) throw new Error('An order needs at least one line');

  return await db.transaction(async (tx) => {
    // Every statement inside uses `tx`, NOT `db`. A stray `db` call here
    // runs on a DIFFERENT connection, outside the transaction, and will not
    // be rolled back with it. That is the single most common transaction
    // bug and it is completely invisible until the day something fails.

    const ids = draft.lines.map((l) => l.productId);
    const found = await tx.select().from(products).where(inArray(products.id, ids));
    const byId = new Map(found.map((p) => [p.id, p]));

    const priced = draft.lines.map((line) => {
      const product = byId.get(line.productId);
      // A domain error, not a bare `Error` — a bare Error reaches the
      // route's bug branch and a stale basket becomes a 500.
      if (!product) throw new UnknownProductError(line.productId);
      return { product, quantity: line.quantity };
    });

    // Prices are read from the DATABASE, never from the request body.
    // A client that can send its own price can send its own price of 1.
    // (Stock is not reserved here, to keep this about transactions and
    // snapshots — dto-and-dao.ts section 5 adds the race-free reservation.)
    const itemsTotalMinor = priced.reduce((sum, l) => sum + l.product.priceMinor * l.quantity, 0);

    const [order] = await tx
      .insert(orderRequests)
      .values({
        customerName: draft.customerName,
        contactMethod: draft.contactMethod,
        contactValue: draft.contactValue,
        note: draft.note,
        itemsTotalMinor,
      })
      .returning();

    if (!order) throw new Error('Order insert returned no row');

    // Built AFTER the order row exists, so there is no placeholder id.
    await tx.insert(orderRequestItems).values(
      priced.map(({ product, quantity }) => ({
        orderRequestId: order.id,
        productId: product.id,
        nameSnapshot: product.name,
        priceMinorSnapshot: product.priceMinor,
        quantity,
      })),
    );

    return order;
  });
}

/*
 * ROLLBACK IS A THROW. Any error thrown inside the callback rolls the whole
 * thing back — nothing to remember to call on the error path. An order row
 * without its items simply cannot exist. (For a DELIBERATE rollback with no
 * error of your own — a dry run, a test — `tx.rollback()` exists: it throws
 * `TransactionRollbackError`, so the `db.transaction()` call rejects with
 * that. Verified in drizzle-orm 0.45.2.)
 *
 * WHERE THE BOUNDARY GOES: in the SERVICE layer, never the repository. A
 * repository method that opens its own transaction cannot be composed with
 * another one — you get two independent transactions where you needed one.
 * The service knows the unit of work; the repository knows one table. See
 * examples/backend/dto-and-dao.ts section 5.
 *
 * DO NOT DO I/O INSIDE A TRANSACTION. No `fetch`, no Telegram call, no
 * email. A transaction holds locks for its whole lifetime, and a 30-second
 * HTTP timeout inside one is 30 seconds of a row nobody else can touch.
 * Commit first, then do the outside-world work (node playbook section 3.3
 * covers doing that safely).
 *
 * ISOLATION, briefly: Postgres defaults to READ COMMITTED, where each
 * statement sees a fresh snapshot — so two concurrent transactions CAN
 * interleave in ways that surprise you (the classic: both read stock = 1,
 * both decrement, you sell two of one pot). If you need stock to be
 * genuinely safe under concurrency, either take a row lock
 * (`.for('update')`) or push the check into the statement itself:
 *   UPDATE products SET stock_count = stock_count - 1
 *   WHERE id = $1 AND stock_count >= 1
 * ...and treat "0 rows updated" as "out of stock". The second is cheaper
 * and doesn't hold a lock across a round trip.
 */

/* ============================================================================
 * 8. INDEXES, PAGINATION AND COUNTING
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 8.1 What to index
 * -------------------------------------------------------------------------*/

/*
 * An index is a sorted lookup structure. Without one, "find products in
 * category X" reads EVERY row (a sequential scan). With 200 products that's
 * free; the reason to index anyway is that the query that's fine today is
 * the one that pages the site at 50,000 rows, and by then it's a production
 * problem rather than a schema decision.
 *
 * INDEX: foreign keys you filter or join on (`products.categoryId`,
 * `orderRequestItems.orderRequestId` — both above), columns in a WHERE,
 * columns in an ORDER BY, and anything unique.
 *
 * DON'T INDEX: everything. Each index is storage plus a write cost on every
 * INSERT/UPDATE/DELETE, and a table with twelve indexes is slow to write to
 * for no reading benefit.
 *
 * NOTE: a PRIMARY KEY and a UNIQUE constraint each create an index
 * automatically. `categories.slug` is `.unique()`, so it is already indexed
 * — a separate `index()` on it would be pure waste.
 *
 * COMPOSITE INDEX ORDER MATTERS, and it's the part people get wrong. The
 * index above is `(status, createdAt)`. It serves:
 *     WHERE status = 'new'                          yes
 *     WHERE status = 'new' ORDER BY created_at      yes — the good case
 *     WHERE created_at > '...'                      NO
 * The rule: equality columns first, then the range/sort column. An index on
 * (A, B) can serve a query on A alone, but not on B alone — like a phone
 * book sorted by surname then first name, which is useless for finding
 * every "Dmitri".
 *
 * HOW TO ACTUALLY CHECK, rather than guess:
 *     EXPLAIN ANALYZE SELECT ... ;
 * `Seq Scan` on a big table where you expected `Index Scan` is the finding.
 * Run it against realistic data volumes — Postgres will correctly choose a
 * seq scan on a 200-row table no matter how many indexes you add.
 */

/* ---------------------------------------------------------------------------
 * 8.2 Pagination: never return an unbounded list
 * -------------------------------------------------------------------------*/

export async function listOrdersPage(page: number, perPage = 20) {
  const safePerPage = Math.min(Math.max(Math.trunc(perPage) || 20, 1), 100); // cap what a client can ask for
  // Clamp the page too: page 0 would be OFFSET -20, which Postgres rejects
  // with an error — a client's typo turned into a 500.
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  return await db
    .select()
    .from(orderRequests)
    .orderBy(desc(orderRequests.createdAt), desc(orderRequests.id))
    .limit(safePerPage)
    .offset((safePage - 1) * safePerPage);
}

/** Keyset: "the 20 rows strictly after the last one you saw". */
export async function listOrdersAfter(cursor: { createdAt: Date; id: string }) {
  return await db
    .select()
    .from(orderRequests)
    .where(
      or(
        lt(orderRequests.createdAt, cursor.createdAt),
        and(eq(orderRequests.createdAt, cursor.createdAt), lt(orderRequests.id, cursor.id)),
      ),
    )
    .orderBy(desc(orderRequests.createdAt), desc(orderRequests.id))
    .limit(20);
}

/*
 * `GET /orders` with no LIMIT is a time bomb: fine at 50 rows, a
 * multi-megabyte response and an OOM at 500,000. Every list endpoint gets a
 * limit, and the limit is CAPPED server-side — otherwise `?perPage=999999`
 * hands the client the same time bomb.
 *
 * NOTE THE TIE-BREAKER in `orderBy`. Sorting only by `createdAt` when two
 * rows share a timestamp leaves their relative order undefined, so a row
 * can appear on both page 1 and page 2, or on neither. Adding `id` makes
 * the ordering total. This is a real, rare, extremely confusing bug.
 *
 * OFFSET vs KEYSET: `OFFSET 100000` makes Postgres generate and discard
 * 100,000 rows to give you 20. Fine for an admin screen with a few hundred
 * orders; bad for an infinite scroll over a large table. The alternative is
 * keyset ("seek") pagination — pass the last row you saw, as
 * `listOrdersAfter` above does.
 *
 * The cursor is BOTH columns, and the tie-breaker is not optional here
 * either: a cursor of only `createdAt` (`where created_at < $cursor`)
 * silently SKIPS every other row that shares the last row's timestamp.
 * MEASURED (60 rows over 7 distinct timestamps, page boundary inside a tie
 * group): the createdAt-only cursor LOST 5 of the 20 rows of page 2; this
 * two-column version returned exactly page 2, zero overlap. The
 * `or(lt, and(eq, lt))` shape is "strictly before this exact row" in the
 * same total order the ORDER BY uses. postgres-beyond-drizzle.ts section 4
 * has the measured version, and why the tidier raw-SQL row comparison
 * `(a, b) < ($1, $2)` needs explicit casts.
 *
 * Constant time at any depth, at the cost of losing "jump to page 7". Use
 * offset for numbered admin pages, keyset for feeds.
 */

/* ---------------------------------------------------------------------------
 * 8.3 Counting and aggregating — in SQL, not in JS
 * -------------------------------------------------------------------------*/

export async function countOrdersByStatus() {
  return await db
    .select({ status: orderRequests.status, total: count() })
    .from(orderRequests)
    .groupBy(orderRequests.status);
}

export async function revenueMinor(): Promise<number> {
  const [row] = await db
    .select({ total: sum(orderRequests.agreedTotalMinor) })
    .from(orderRequests)
    .where(eq(orderRequests.status, 'completed'));
  // CAREFUL: SUM() returns Postgres `numeric`, which postgres-js gives you
  // as a STRING (it can exceed Number's safe range), and as NULL when zero
  // rows matched. Both have to be handled — this is exactly the sort of
  // thing that silently becomes "NaN" in a dashboard.
  return row?.total != null ? Number(row.total) : 0;
}

/*
 * The anti-pattern this replaces:
 *     const all = await db.select().from(orderRequests);
 *     const total = all.filter(o => o.status === 'completed')
 *                      .reduce((s, o) => s + (o.agreedTotalMinor ?? 0), 0);
 * That pulls every order over the wire into your one thread to compute a
 * single number. Aggregate where the data is. `sum`, `count`, `avg`, `min`,
 * `max` are all exported from `drizzle-orm`.
 *
 * `count()` returns a `number` in Drizzle (it casts for you). `sum()` does
 * not — the string/null handling above is required, not paranoia.
 */

/* ============================================================================
 * 9. THE `sql` ESCAPE HATCH — and using it without opening a hole
 * ============================================================================
 */

export async function topSellingProducts(limit: number) {
  return await db
    .select({
      productId: orderRequestItems.productId,
      name: orderRequestItems.nameSnapshot,
      unitsSold: sql<number>`sum(${orderRequestItems.quantity})::int`,
    })
    .from(orderRequestItems)
    .groupBy(orderRequestItems.productId, orderRequestItems.nameSnapshot)
    .orderBy(desc(sql`sum(${orderRequestItems.quantity})`))
    .limit(limit);
}

/*
 * When the builder doesn't cover something (a cast, a window function, a
 * Postgres-specific operator), `sql` is the documented way down. Two things
 * to understand about it:
 *
 * 1. IT IS PARAMETERISED, NOT CONCATENATED. `sql` is a tagged template:
 *    every `${}` becomes a bound parameter ($1, $2), not spliced text. So
 *    `sql`... where name = ${userInput}`` is SAFE.
 *    What is NOT safe is building the template string itself:
 *        sql.raw(`select * from products where name = '${userInput}'`)
 *    `sql.raw` does exactly what it says. Use it only for fragments YOU
 *    wrote, never for anything that touched a request. A column name that
 *    comes from a query param (`?sortBy=`) must be validated against an
 *    allowlist first — `z.enum(['name','priceMinor'])` — because an
 *    identifier can't be a bound parameter.
 *
 * 2. `sql<number>` IS AN ASSERTION, NOT A CHECK. You are telling the
 *    compiler what comes back; nothing verifies it. Here the `::int` cast
 *    is what makes the claim true — without it, `sum()` returns numeric,
 *    which arrives as a string, and `sql<number>` would be a lie that
 *    typechecks. When you write `sql<T>`, make the SQL actually produce T.
 */

/* ============================================================================
 * 10. MIGRATIONS — the workflow, and the two that can lose data
 * ============================================================================
 */

/*
 * THE LOOP:
 *   1. Edit `schema.ts`.
 *   2. `npm run db:generate`  -> writes drizzle/NNNN_name.sql + a snapshot.
 *   3. **READ THE SQL.** `cat drizzle/0007_whatever.sql`. This step is the
 *      entire reason for choosing generate+migrate over push. Skipping it
 *      throws away the benefit you paid for.
 *   4. `npm run db:migrate`   -> applies it, records it in `__drizzle_migrations`.
 *   5. Commit schema.ts, the .sql AND drizzle/meta/ together. The snapshot
 *      is how the next `generate` knows what's already applied; committing
 *      the .sql without it produces duplicate migrations for the next
 *      person who runs it.
 *
 * `db:push` skips 2-4 entirely. It's genuinely useful while you're still
 * reshaping tables hourly and the database holds nothing you care about.
 * The moment real data exists, stop using it — it has no history and no
 * rollback.
 *
 * WHAT `migrate` ACTUALLY DOES — read from the drizzle-orm 0.45.2 migrator
 * source rather than assumed, because two common beliefs are wrong:
 *   - It takes NO LOCK. It reads the last applied migration OUTSIDE any
 *     transaction, then applies what is newer. Two processes migrating at
 *     once both see the same "last applied" and both try the same
 *     statements. Run it exactly once per deploy, as its own step — never
 *     on API boot with more than one instance.
 *   - ALL pending migrations run in ONE transaction, with no per-migration
 *     opt-out. Good news for atomicity (a failure rolls back the whole
 *     batch). Bad news for anything that cannot run inside a transaction:
 *     `CREATE INDEX CONCURRENTLY` cannot go through `migrate` at all — run
 *     that one by hand (psql) outside a transaction.
 *
 * THE TWO GENERATED STATEMENTS TO STOP AND THINK ABOUT:
 *
 *   DROP COLUMN — the data in it is gone the moment this runs. If the
 *   column is genuinely dead, fine. If you're RENAMING, note that Drizzle
 *   may see a rename as drop+add (it prompts when it's unsure, and the
 *   prompt is easy to click through). That is silent data loss dressed up
 *   as a rename.
 *
 *   ALTER COLUMN ... SET NOT NULL on a table with existing rows — fails
 *   outright if any row is NULL. Better to find that in review than in
 *   production.
 *
 * THE SAFE PATTERN for both, when the table has data worth keeping — three
 * deploys, not one:
 *   1. Add the new column as NULLABLE. Deploy. Write to BOTH columns.
 *   2. Backfill (`UPDATE ... SET new = old WHERE new IS NULL`), then read
 *      from the new one. Deploy.
 *   3. Once nothing reads the old column, drop it. Deploy.
 * Tedious, and it is the difference between a rename and an outage. The
 * general principle: **a migration and the code that depends on it are
 * never deployed in the same instant** — for a moment, old code runs
 * against the new schema, so every migration step must be compatible with
 * the code currently running.
 *
 * TESTING MIGRATIONS: apply them to a scratch database (`db:migrate`
 * against a throwaway DATABASE_URL) before they go near anything real. See
 * examples/testing/backend-testing.ts section 3.
 *
 * THE GOTCHA THIS PROJECT ALREADY HIT: `drizzle.config.ts` runs in the
 * drizzle-kit CLI's own process, which does NOT inherit Bun's automatic
 * `.env` loading. That's why the file calls `process.loadEnvFile('.env')`
 * itself. Remove that line and every db: script fails with an empty
 * connection string.
 */

/* ============================================================================
 * 11. THE DON'T-DO LIST
 * ============================================================================
 *
 * - `float`/`real` for money                                     -> S2
 * - `timestamp` without `withTimezone` (drifts by the server's
 *   UTC offset when `defaultNow()` fills it — measured +7h)       -> S2
 * - Trusting a price sent by the client                          -> S7
 * - An order line with no price snapshot                         -> S2
 * - `ON DELETE CASCADE` towards master data (products)           -> S2
 * - A query inside a loop (N+1)                                  -> S5.4
 * - `SELECT *` when you need four columns                        -> S5.2
 * - `update`/`delete` with no `.where()`                         -> S6.4
 * - Using `db` instead of `tx` inside a transaction              -> S7
 * - `fetch`/email/Telegram inside a transaction                  -> S7
 * - Opening a transaction in a repository method                 -> S7
 * - Read-modify-write on stock without a lock or a guarded UPDATE-> S7
 * - A list endpoint with no LIMIT, or an uncapped `perPage`      -> S8.2
 * - `ORDER BY` a non-unique column while paginating              -> S8.2
 * - A keyset cursor without the tie-breaker column               -> S8.2
 * - Running `migrate` from more than one process at once         -> S10
 * - Aggregating in JS what SQL can aggregate                     -> S8.3
 * - Assuming `sum()` gives you a number                          -> S8.3
 * - `sql.raw` with anything from a request                       -> S9
 * - Hand-editing a file in `drizzle/`                            -> S1
 * - Committing a migration without `drizzle/meta/`               -> S10
 * - `db:push` against a database with real data                  -> S10
 * - Creating a `postgres()` client per request                   -> S4
 */
