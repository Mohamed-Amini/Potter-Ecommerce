/**
 * POSTGRES BELOW THE ORM — query plans, window functions, and concurrency.
 *
 * examples/backend/drizzle-playbook.ts covers the ORM layer: how to spell a
 * query and how to shape a schema. This file covers the layer UNDERNEATH
 * it, where the next class of bugs lives — the ones where your Drizzle code
 * is perfectly correct and the database still does something you didn't
 * expect, or sells a pot twice.
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/backend/postgres-beyond-drizzle.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * EVERY PLAN AND EVERY NUMBER IN THIS FILE WAS MEASURED, NOT RECALLED.
 * Against PostgreSQL 17.11 on a scratch database of 50,000 products /
 * 20,000 order requests / 5,000 order lines. Where output is quoted, it is
 * copied from a real `EXPLAIN ANALYZE`. Reproduce it yourself with the
 * script in section 11 — the numbers will differ, the SHAPES will not.
 *
 * THE ONE IDEA: an ORM makes writing a query easy and makes the COST of a
 * query invisible. Everything here is about making the cost visible again.
 */

import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  priceMinor: integer('price_minor').notNull(),
  stockCount: integer('stock_count').notNull().default(0),
});

const orderRequests = pgTable('order_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status').notNull().default('new'),
  agreedTotalMinor: integer('agreed_total_minor'),
  // timestamptz — drizzle-playbook.ts section 2 has the measured reason.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const orderRequestItems = pgTable('order_request_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderRequestId: uuid('order_request_id').notNull(),
  productId: uuid('product_id').notNull(),
  quantity: integer('quantity').notNull().default(1),
});

declare const DATABASE_URL: string;
const db: PostgresJsDatabase<Record<string, never>> = drizzle(postgres(DATABASE_URL));

/* ============================================================================
 * 1. EXPLAIN — the only way to stop guessing
 * ============================================================================
 * PLAIN ENGLISH: `EXPLAIN` asks Postgres "what do you PLAN to do", and
 * `EXPLAIN ANALYZE` actually runs it and reports what happened. Everything
 * else in this file is downstream of being able to read one.
 *
 *   EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
 *
 * WARNING: `ANALYZE` genuinely EXECUTES the statement. On a SELECT that is
 * harmless. On an UPDATE or DELETE it is not — it really updates, really
 * deletes. To inspect a write safely, wrap it:
 *
 *   BEGIN; EXPLAIN (ANALYZE) DELETE FROM ...; ROLLBACK;
 *
 * Drizzle can hand you the SQL to paste into psql without running it — this
 * is the single most useful debugging call in the ORM:
 */

export function showSql(): { sql: string; params: unknown[] } {
  return db.select().from(products).where(eq(products.stockCount, 1)).toSQL();
}

/*
 * READ A PLAN FROM THE INSIDE OUT AND THE BOTTOM UP. The most indented
 * lines run first and feed their parents. Four things to look for, in the
 * order they matter:
 *
 *   1. `Seq Scan` on a large table where you expected an index.
 *   2. A large gap between the ESTIMATED and ACTUAL row counts. If Postgres
 *      guesses 5 rows and gets 50,000, every decision above that node was
 *      made on bad information. Usually means stale statistics — run
 *      `ANALYZE <table>;`.
 *   3. `loops=N` with N large — a node executed once per outer row. That is
 *      the plan-level signature of N+1.
 *   4. `Sort Method: external merge  Disk: NNNkB` — the sort didn't fit in
 *      `work_mem` and spilled to disk. Orders of magnitude slower.
 *
 * SCAN TYPES, cheapest intent first:
 *   Index Scan          walks the index, fetches matching rows. Best for
 *                       few rows.
 *   Index Only Scan     the index CONTAINED every column asked for, so the
 *                       table was never touched. The fastest thing here.
 *   Bitmap Heap Scan    builds a bitmap of matching pages, then reads them
 *                       in physical order. Postgres chooses this for a
 *                       "medium" number of matches — it is not a failure,
 *                       it is often exactly right.
 *   Seq Scan            reads the whole table. Correct and optimal when you
 *                       want most of the rows.
 */

/* ============================================================================
 * 2. WHEN AN INDEX IS USED — measured, with the plans
 * ============================================================================
 */

/*
 * SAME QUERY, filtering 6,139 of 50,000 products by category_id.
 *
 * WITHOUT THE INDEX:
 *
 *   Seq Scan on products (actual rows=6139 loops=1)
 *     Filter: (category_id = ...)
 *     Rows Removed by Filter: 43861          <- 43,861 rows read for nothing
 *
 * WITH `CREATE INDEX products_category_idx ON products(category_id)`:
 *
 *   Bitmap Heap Scan on products (actual rows=6139 loops=1)
 *     Recheck Cond: (category_id = ...)
 *     Heap Blocks: exact=657
 *     ->  Bitmap Index Scan on products_category_idx (actual rows=6139)
 *
 * `Rows Removed by Filter` is the number to watch. It is the work Postgres
 * did to produce nothing. 43,861 discarded rows is the index-shaped hole.
 *
 * AND A UNIQUE LOOKUP, for contrast — `WHERE slug = 'prod-12345'`:
 *
 *   Index Scan using products_slug_key on products (actual rows=1 loops=1)
 *
 * Note the index name: `products_slug_key`. Nobody created it. It came free
 * with the `.unique()` constraint in the schema — which is why adding a
 * separate `index()` on a unique column is pure waste (drizzle-playbook.ts
 * section 8.1).
 */

/* ---------------------------------------------------------------------------
 * 2.1 WHY YOUR INDEX IS IGNORED — three real reasons
 * -------------------------------------------------------------------------*/

/*
 * An index that exists and is not used is one of the most confusing things
 * in a database, because the obvious conclusion ("Postgres is broken") is
 * wrong every time. Measured causes, in order of how often they're it:
 *
 * REASON 1 — THE FILTER MATCHES TOO MANY ROWS. With an index on
 * `stock_count` present:
 *
 *   WHERE stock_count >= 0      (matches all 50,000)
 *     -> Seq Scan on products (actual rows=50000 loops=1)     <- index ignored
 *
 *   WHERE stock_count = 10      (matches 2,404)
 *     -> Bitmap Heap Scan ... Bitmap Index Scan on products_stock_idx
 *
 * Same index, same table, same session. The planner chose correctly BOTH
 * times: using an index to fetch most of a table is SLOWER than reading it
 * straight through, because you pay for the index AND for random-order row
 * fetches. This is the single most common "my index isn't working" — and
 * the index is fine. Rule of thumb: past roughly 5-10% of a table, a
 * sequential scan wins.
 *
 * REASON 2 — THE COLUMN HAS ALMOST NO DISTINCT VALUES. While building the
 * test data for this file I accidentally assigned all 50,000 products to
 * ONE category (an uncorrelated subquery in the INSERT was evaluated once,
 * not per row). With one distinct value, the planner correctly refused to
 * use the index at all — every query was a Seq Scan, even with the index
 * present. An index on a column with two or three distinct values is
 * usually dead weight; `status` columns are the classic case, and they earn
 * their index only as the leading column of a COMPOSITE (section 3).
 *
 * REASON 3 — THE STATISTICS ARE STALE. The planner decides from a sample,
 * refreshed by autovacuum. After a bulk load, that sample can be badly out
 * of date and every decision above it is made on fiction. `ANALYZE
 * products;` costs seconds and is the first thing to try when a plan makes
 * no sense. (This file's measurements run `ANALYZE` after every bulk
 * change, precisely so the plans are honest.)
 *
 * NOT A REASON, but frequently blamed: a type mismatch. `WHERE id = $1`
 * where the column is `uuid` and the parameter binds as `text` can prevent
 * index use in some databases. Drizzle binds the right types, so this is
 * mostly a non-issue here — but it IS why a hand-written `sql.raw` with a
 * stringified id can be slower than the builder.
 */

/* ============================================================================
 * 3. COMPOSITE INDEX COLUMN ORDER — the rule, proved
 * ============================================================================
 * With ONE index: `CREATE INDEX or_status_created_idx
 *                    ON order_requests(status, created_at);`
 * ...three queries, three different outcomes. Measured:
 *
 *   Q1  WHERE status = 'completed'
 *       -> Bitmap Index Scan on or_status_created_idx            USED
 *
 *   Q2  WHERE status = 'completed' ORDER BY created_at DESC LIMIT 20
 *       -> Limit
 *            -> Index Scan Backward using or_status_created_idx  USED, AND
 *                                                                NO SORT NODE
 *
 *   Q3  WHERE created_at > now() - interval '7 days'
 *       -> Seq Scan on order_requests                            NOT USED
 *
 * Q2 is the one worth staring at. There is no `Sort` step anywhere in that
 * plan. The index is ALREADY in (status, created_at) order, so Postgres
 * walks it backwards and stops after 20 rows. It never sorts, and it never
 * looks at the other 19,980 rows. That is what a composite index is FOR —
 * not just filtering, but delivering the rows pre-sorted.
 *
 * Q3 is the proof of the rule: **an index on (A, B) cannot serve a query on
 * B alone.** A phone book sorted by surname then first name is useless for
 * finding every "Dmitri". If you need that query too, it needs its own
 * index on `created_at`.
 *
 * SO THE ORDER IS: equality columns first, then the range/sort column.
 * `(status, created_at)` and never `(created_at, status)`.
 */

/* ============================================================================
 * 4. PAGINATION COST — why page 950 is slow
 * ============================================================================
 * Same query, two depths. Measured:
 *
 *   ... ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0
 *     Limit (actual rows=20 loops=1)
 *       -> Sort (actual rows=20 loops=1)
 *            Sort Method: top-N heapsort  Memory: 27kB
 *
 *   ... ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 19000
 *     Limit (actual rows=20 loops=1)
 *       -> Sort (actual rows=19020 loops=1)           <- 19,020 to return 20
 *            Sort Method: quicksort  Memory: 2175kB   <- 80x the memory
 *
 * Read those two `Sort` lines against each other. At OFFSET 0 Postgres uses
 * a `top-N heapsort` — it only ever keeps 20 rows, so memory is flat. At
 * OFFSET 19000 it cannot do that: to skip 19,000 rows it must first PRODUCE
 * them, so it switches to a full `quicksort` of 19,020 rows and memory goes
 * from 27kB to 2,175kB. The work grows with the offset, forever.
 *
 * KEYSET ("seek") PAGINATION doesn't skip — it starts from where you were:
 */

export async function ordersPageKeyset(cursor?: { createdAt: Date; id: string }) {
  const q = db.select().from(orderRequests);
  if (!cursor) {
    return await q.orderBy(desc(orderRequests.createdAt), desc(orderRequests.id)).limit(20);
  }
  return await q
    .where(
      // "Everything strictly before the cursor row." Spelled with builder
      // helpers rather than a raw template — see the WARNING below, which
      // cost a real debugging cycle while writing this file.
      or(
        lt(orderRequests.createdAt, cursor.createdAt),
        and(eq(orderRequests.createdAt, cursor.createdAt), lt(orderRequests.id, cursor.id)),
      ),
    )
    .orderBy(desc(orderRequests.createdAt), desc(orderRequests.id))
    .limit(20);
}

/*
 * WARNING — A RAW `sql` TEMPLATE SLOT LOSES THE COLUMN'S TYPE MAPPER.
 * Verified the hard way: this function was first written with the tidier
 * SQL row-value comparison,
 *
 *     sql`(${orderRequests.createdAt}, ${orderRequests.id})
 *          < (${cursor.createdAt}, ${cursor.id})`
 *
 * which TYPECHECKS PERFECTLY and then fails at runtime with:
 *
 *     The "string" argument must be of type string or an instance of
 *     Buffer or ArrayBuffer. Received an instance of Date
 *
 * Why: inside the builder, `lt(orderRequests.createdAt, someDate)` knows
 * the target column is a `timestamp` and applies that column's serializer
 * to the Date. A `${}` slot in a raw template carries no column
 * information, so the driver is handed a bare JS `Date` and doesn't know
 * what to do with it. The error names a *string* argument, which points at
 * the driver rather than at your query, and is thoroughly unhelpful.
 *
 * THE GENERAL RULE: in a raw `sql` template, `${}` slots holding COLUMN
 * REFERENCES are fine (that's how section 5's window functions work), but
 * slots holding VALUES of non-primitive types — Date, arrays, json — lose
 * their mapping. Either use builder helpers, or cast explicitly in the SQL:
 *
 *     sql`(${orderRequests.createdAt}, ${orderRequests.id})
 *          < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
 *
 * Both forms were measured returning 20 rows with ZERO overlap against the
 * previous page (first on the original `timestamp` column with a
 * `::timestamp` cast; re-measured 2026-09-23 on `timestamptz` with the
 * `::timestamptz` cast above, with deliberately duplicated timestamps).
 * Prefer the builder version: it needs no casts, and it cannot silently
 * break if a column type changes — the cast has to change WITH the column,
 * which is exactly what happened here.
 *
 * (The row-value form does read better and is what most articles show. If
 * you use it, the `::casts` are not optional decoration.)
 */

/*
 * Constant cost at any depth. The trade is that you lose "jump to page 7" —
 * so: OFFSET for numbered admin pages over a bounded table, KEYSET for
 * feeds and infinite scroll.
 *
 * AND NOTE THE TIE-BREAKER, in both versions. Sorting on `created_at` alone
 * leaves rows with equal timestamps in an undefined order, so a row can
 * appear on two pages or none. Adding `id` makes the ordering total. For
 * keyset it is not merely advisable — without a unique tie-breaker the
 * cursor cannot express "after this exact row" and the query will skip or
 * repeat rows.
 */

/* ============================================================================
 * 5. WINDOW FUNCTIONS — the "top N per group" problem
 * ============================================================================
 * PLAIN ENGLISH: `GROUP BY` collapses rows into one row per group. A window
 * function computes across a set of rows WITHOUT collapsing them — each row
 * keeps its identity and gains a value computed over its "window" of peers.
 * That is what makes "the best seller in EACH category" expressible at all.
 */

/*
 * THE THREE RANKING FUNCTIONS DIFFER ONLY ON TIES, and the difference is
 * the whole reason to pick one. Measured on values 10, 10, 7, 7, 3:
 *
 *    units | row_number | rank | dense_rank
 *   -------+------------+------+-----------
 *       10 |     1      |   1  |     1
 *       10 |     2      |   1  |     1
 *        7 |     3      |   3  |     2      <- rank SKIPS 2, dense does not
 *        7 |     4      |   3  |     2
 *        3 |     5      |   5  |     3
 *
 *   row_number  always 1,2,3... Arbitrary among ties unless ORDER BY is
 *               total. USE THIS for "exactly one row per group".
 *   rank        ties share a number, then it JUMPS (1,1,3). Olympic medals.
 *   dense_rank  ties share, no gaps (1,1,2). "How many distinct levels."
 *
 * The trap: `row_number()` with a non-unique ORDER BY gives a STABLE-LOOKING
 * but arbitrary answer that can change between runs. Add a tie-breaker —
 * the same rule as pagination in section 4.
 */

/** Best-selling product in each category — the `rn = 1` pattern. */
export async function bestSellerPerCategory() {
  const sales = db.$with('sales').as(
    db
      .select({
        categoryId: products.categoryId,
        productName: products.name,
        units: sql<number>`sum(${orderRequestItems.quantity})::int`.as('units'),
      })
      .from(orderRequestItems)
      .innerJoin(products, eq(products.id, orderRequestItems.productId))
      .groupBy(products.categoryId, products.name),
  );

  const ranked = db.$with('ranked').as(
    db
      .with(sales)
      .select({
        categoryId: sales.categoryId,
        productName: sales.productName,
        units: sales.units,
        rn: sql<number>`row_number() over (
          partition by ${sales.categoryId}
          order by ${sales.units} desc, ${sales.productName}
        )`.as('rn'),
      })
      .from(sales),
  );

  return await db
    .with(ranked)
    .select({ productName: ranked.productName, units: ranked.units })
    .from(ranked)
    .where(eq(ranked.rn, 1));
}

/*
 * `db.$with(...)` is Drizzle's CTE builder. The window function itself has
 * no builder API, so it goes through a `sql` template — which is fine and
 * safe: the `${}` slots interpolate COLUMN REFERENCES, not strings, so
 * there is nothing to inject (drizzle-playbook.ts section 9).
 *
 * `.as('units')` / `.as('rn')` on the sql templates is not optional — a CTE
 * column needs a name for the outer query to reference it, and Drizzle
 * cannot invent one for a raw expression.
 *
 * WHY YOU CANNOT DO THIS WITH `GROUP BY` ALONE: the classic wrong attempt
 * is `SELECT category_id, name, MAX(units) ... GROUP BY category_id` —
 * which is either a syntax error (`name` isn't grouped or aggregated) or,
 * in databases that permit it, silently returns the max units next to an
 * ARBITRARY name. Postgres refuses, correctly. The window function is the
 * right tool, not a fancier one.
 */

/** Running total — the other window shape you'll actually want. */
export async function monthlyRevenueRunningTotal() {
  return await db
    .select({
      month: sql<string>`date_trunc('month', ${orderRequests.createdAt})::date`.as('month'),
      revenue: sql<number>`sum(${orderRequests.agreedTotalMinor})::bigint`.as('revenue'),
      cumulative: sql<number>`sum(sum(${orderRequests.agreedTotalMinor}))
        over (order by date_trunc('month', ${orderRequests.createdAt}) rows unbounded preceding)`.as(
        'cumulative',
      ),
    })
    .from(orderRequests)
    .where(eq(orderRequests.status, 'completed'))
    .groupBy(sql`date_trunc('month', ${orderRequests.createdAt})`);
}

/*
 * Real output from the scratch data:
 *
 *      month    |  revenue  | cumulative
 *   ------------+-----------+------------
 *    2025-09-01 |  64276457 |   64276457
 *    2025-10-01 | 243656006 |  307932463
 *    2025-11-01 | 220429456 |  528361919
 *
 * THE DOUBLE `sum(sum(...))` IS NOT A TYPO and it is the thing that makes
 * this confusing. Window functions are evaluated AFTER aggregation, so the
 * inner `sum()` aggregates within the month, and the outer `sum() OVER` runs
 * across the already-aggregated month rows. Once you see the ordering —
 * GROUP BY first, window second — it stops looking like nonsense.
 *
 * `ROWS UNBOUNDED PRECEDING` is the frame: "every row from the start up to
 * this one". The default frame (`RANGE UNBOUNDED PRECEDING`) differs subtly
 * on ties — with duplicate ORDER BY values it includes ALL peers, so a
 * running total can jump. State the frame explicitly whenever the ORDER BY
 * is not unique.
 *
 * NOTE `::bigint` on revenue. Summing `integer` minor units across a year
 * can exceed `integer`'s ~2.1 billion ceiling. And per
 * drizzle-playbook.ts 8.3, the result arrives in JS as a STRING — the
 * `sql<number>` annotation here is an assertion, so treat it as such and
 * convert at the edge.
 */

/* ============================================================================
 * 6. CTEs — and the optimisation fence that used to bite
 * ============================================================================
 * A CTE (`WITH x AS (...)`) names a subquery so the rest of the statement
 * can use it. Use them for readability and for referencing the same
 * intermediate result twice.
 *
 * THE HISTORICAL GOTCHA, worth knowing because half the internet still
 * warns about it: BEFORE PostgreSQL 12, every CTE was an "optimisation
 * fence" — always materialised, never inlined, so a CTE could be
 * dramatically slower than the equivalent subquery because a WHERE clause
 * outside it could not be pushed inside.
 *
 * FROM 12 ONWARDS Postgres inlines a CTE when it is referenced exactly once
 * and is side-effect free. You can still force either behaviour:
 *
 *   WITH x AS MATERIALIZED     (...)   -- force the old fence
 *   WITH x AS NOT MATERIALIZED (...)   -- force inlining
 *
 * `MATERIALIZED` is genuinely useful when an expensive CTE is referenced
 * several times and you want it computed once. On 17 (and anything >= 12)
 * the default is usually right — write CTEs for clarity.
 *
 * RECURSIVE CTEs exist (`WITH RECURSIVE`) for trees — nested categories,
 * org charts. Out of scope here, but that's the tool if a category ever
 * gets a parent_id.
 */

/* ============================================================================
 * 7. CONCURRENCY — the lost update, reproduced
 * ============================================================================
 * This is the section that guards money. drizzle-playbook.ts section 7
 * gives the RULE; this gives the measurement behind it.
 *
 * SETUP: `stock_count = 5`. Two sessions each sell one pot, overlapping in
 * time. The correct final answer is 3 in all three cases.
 */

/*
 * ATTEMPT 1 — THE NAIVE PATTERN. Read the stock, compute `5 - 1 = 4` in
 * JavaScript, write the literal back. MEASURED:
 *
 *     A read=5   B read=5   FINAL=4        <- WRONG. A pot sold for free.
 *
 * Both sessions read 5 before either wrote. Both computed 4. The second
 * write silently overwrote the first. No error, no conflict, no log line —
 * the inventory is simply wrong, and the only evidence is a customer who
 * receives nothing.
 *
 * This is a LOST UPDATE, and note that it needs no exotic timing: a 0.4
 * second overlap reproduced it on the first try.
 *
 * (Worth recording, because it nearly fooled me while writing this file:
 * if you write the decrement as a single statement with a SUBQUERY —
 * `SET stock_count = (SELECT stock_count ...) - 1` — the bug does NOT
 * reproduce. Under READ COMMITTED the blocked statement re-reads after the
 * row lock is released. That makes it a bad demo AND a fragile pattern to
 * rely on; the faithful reproduction needs the value computed in the app,
 * which is what real code does.)
 */

/*
 * ATTEMPT 2 — `SELECT ... FOR UPDATE`. MEASURED:
 *
 *     A read=5   B read=4   FINAL=3        <- correct
 *
 * `FOR UPDATE` takes a row lock at SELECT time. B blocks until A commits,
 * then its SELECT returns the NEW value, 4. The read-modify-write is now
 * serialized.
 *
 * THE COST: B is BLOCKED for the whole of A's transaction, including any
 * round trip A makes in between. That is exactly why "no I/O inside a
 * transaction" matters — a `fetch` between the SELECT and the UPDATE holds
 * the lock for the duration of someone else's network.
 */
export async function reserveStockPessimistic(productId: string, qty: number) {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .for('update'); // <- the row lock

    if (!row || row.stockCount < qty) return { ok: false as const };

    await tx
      .update(products)
      .set({ stockCount: row.stockCount - qty })
      .where(eq(products.id, productId));

    return { ok: true as const };
  });
}

/*
 * ATTEMPT 3 — THE GUARDED SINGLE STATEMENT. MEASURED:
 *
 *     A read=5   B read=5   FINAL=3        <- correct, and no lock held
 *                                             across a round trip
 *
 * Both sessions still READ 5 — that read is only for display. The
 * correctness comes from doing the arithmetic in SQL and putting the
 * business rule in the WHERE clause:
 *
 *     UPDATE products SET stock_count = stock_count - 1
 *      WHERE id = $1 AND stock_count >= 1
 *
 * Postgres locks the row for the duration of one statement, re-reads, and
 * applies the decrement to whatever the current value is. "Sold out" is
 * then simply **zero rows updated**.
 */
export async function reserveStockGuarded(productId: string, qty: number) {
  const updated = await db
    .update(products)
    .set({ stockCount: sql`${products.stockCount} - ${qty}` })
    .where(and(eq(products.id, productId), sql`${products.stockCount} >= ${qty}`))
    .returning({ id: products.id, stockCount: products.stockCount });

  // ZERO ROWS IS THE "OUT OF STOCK" SIGNAL. It is not an error condition to
  // be logged and ignored — it is the answer.
  if (updated.length === 0) return { ok: false as const, reason: 'out_of_stock' as const };
  return { ok: true as const, remaining: updated[0]?.stockCount ?? 0 };
}

/*
 * PREFER ATTEMPT 3. It is shorter, holds no lock across a network round
 * trip, and cannot be got wrong by a future edit that adds an `await`
 * between the read and the write.
 *
 * REACH FOR ATTEMPT 2 when the decision genuinely needs several rows read
 * together before anything is written — reserving five different products
 * atomically, where you must know all five are available before committing
 * to any. Then lock them all, in a defined order (section 9).
 */

/* ============================================================================
 * 8. ISOLATION LEVELS — what READ COMMITTED does and doesn't promise
 * ============================================================================
 * Postgres defaults to READ COMMITTED. What that means precisely:
 *
 *   Each STATEMENT sees a fresh snapshot of everything committed when that
 *   statement began. Not when the transaction began.
 *
 * So inside one transaction, two identical SELECTs can return different
 * data if someone committed in between. That is a "non-repeatable read",
 * and it is allowed at this level, by design.
 *
 * WHAT READ COMMITTED DOES PREVENT: dirty reads. You never see another
 * transaction's uncommitted work. That is a real and sufficient guarantee
 * for most web requests.
 *
 * WHAT IT DOESN'T PREVENT: the lost update in section 7. A transaction is
 * NOT a lock. Wrapping the naive read-modify-write in `db.transaction()`
 * changes nothing about that bug — this is the most common misconception
 * about transactions, and it is worth saying plainly: **atomicity is not
 * isolation.** A transaction guarantees all-or-nothing; it does not
 * guarantee nobody else touched the row in between.
 *
 * THE OTHER TWO LEVELS:
 *
 *   REPEATABLE READ   the snapshot is fixed for the whole transaction. Two
 *                     identical SELECTs always agree. A conflicting write
 *                     fails at COMMIT with a serialization error.
 *   SERIALIZABLE      as if transactions ran one at a time. The strongest
 *                     guarantee, and it also throws serialization errors.
 *
 * THE PRICE OF BOTH is that **your application must be prepared to retry**.
 * They don't block, they ABORT — error code 40001. Code that doesn't catch
 * and retry 40001 is strictly worse under these levels than it was under
 * READ COMMITTED, because now it just fails.
 *
 * PRACTICAL ADVICE: stay on READ COMMITTED and fix specific races with
 * section 7's guarded UPDATE or a row lock. Reach for SERIALIZABLE when a
 * rule spans MULTIPLE rows in a way no single statement can express
 * ("this customer may not have more than 3 open orders"), and when you have
 * actually written the retry loop.
 */

/* ============================================================================
 * 9. DEADLOCKS — and the one rule that prevents them
 * ============================================================================
 * A deadlock is two transactions each holding what the other needs:
 *
 *   A: locks product 1 ... then wants product 2
 *   B: locks product 2 ... then wants product 1
 *
 * Neither can proceed. Postgres DETECTS this (after `deadlock_timeout`,
 * default 1s), kills one with error 40P01, and lets the other finish. So a
 * deadlock is not a hang — it is an error in one transaction, which is
 * better, but still a failed order.
 *
 * THE RULE: **always acquire locks in a consistent order.** If every
 * transaction locks products sorted by id, the cycle above is impossible —
 * both want product 1 first, one waits, nobody deadlocks.
 *
 * Concretely, when reserving several products for one order:
 */
export async function reserveManyInOrder(
  lines: readonly { productId: string; quantity: number }[],
) {
  // Sort by id BEFORE locking. The order the customer added things to the
  // basket is arbitrary; the lock order must not be.
  const ordered = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));

  return await db.transaction(async (tx) => {
    for (const line of ordered) {
      const [row] = await tx
        .select()
        .from(products)
        .where(eq(products.id, line.productId))
        .for('update');
      if (!row || row.stockCount < line.quantity) {
        throw new Error(`Out of stock: ${line.productId}`); // rolls everything back
      }
    }
    return { ok: true as const };
  });
}

/*
 * Two more things that take locks and don't look like locking:
 *   - Foreign keys lock the PARENT row. Inserting an order line takes a
 *     `FOR KEY SHARE` lock on its product. Those do not conflict with EACH
 *     OTHER — two orders inserting lines for the same mug do not wait on
 *     one another — but `FOR KEY SHARE` DOES conflict with `FOR UPDATE`.
 *     So while a transaction holds `.for('update')` on a product (both
 *     functions above), every other order's line insert for that product
 *     waits. `.for('no key update')` is the lock that says "I will change
 *     this row but not its key" — it still serializes stock changes, and
 *     it does not block FK checks. (From the Postgres row-level lock
 *     conflict table, docs §13.3.2 — not measured in this file.)
 *   - `ON CONFLICT` upserts on the same key from two sessions.
 *
 * And the mitigation that costs nothing: KEEP TRANSACTIONS SHORT. A
 * transaction that holds locks for 2ms is very hard to deadlock. One that
 * holds them across a Telegram API call is easy to.
 */

/* ============================================================================
 * 10. THE THINGS THAT BITE IN PRODUCTION
 * ============================================================================
 *
 * `statement_timeout` — set it. Without one, a single runaway query pins a
 *   CPU indefinitely. `postgres(url, { connection: { statement_timeout: 10000 } })`.
 *   Consider a much longer one for migrations, which legitimately take time.
 *
 * `idle_in_transaction_session_timeout` — set it. A connection that opened
 *   a transaction and then went away (a crashed process, a debugger paused
 *   on a breakpoint) holds its locks AND blocks vacuum from cleaning up
 *   dead rows for every table it touched. This is a genuinely nasty
 *   production failure: the table bloats and queries slow down across the
 *   whole database because of one stuck session.
 *
 * LONG-RUNNING TRANSACTIONS BLOCK VACUUM GLOBALLY. Postgres cannot reclaim
 *   a dead row version while any open transaction might still need to see
 *   it. One forgotten `BEGIN` in a psql window can bloat tables it never
 *   touched.
 *
 * `CREATE INDEX` LOCKS THE TABLE against writes for its duration. On a live
 *   table use `CREATE INDEX CONCURRENTLY` — slower, doesn't block writes,
 *   and cannot run inside a transaction. That rules out `drizzle-kit
 *   migrate` entirely: its migrator runs ALL pending migrations inside ONE
 *   transaction with no per-migration opt-out (read from the drizzle-orm
 *   0.45.2 source). Run a concurrent index by hand, in psql, outside a
 *   transaction — and if it fails midway it leaves an INVALID index behind
 *   that must be dropped before retrying.
 *
 * FINDING THE PROBLEM, when it's already happening:
 *
 *   -- what is running right now, oldest first
 *   SELECT pid, state, now() - query_start AS runtime, left(query, 80)
 *     FROM pg_stat_activity
 *    WHERE state <> 'idle' ORDER BY query_start;
 *
 *   -- who is blocking whom
 *   SELECT pid, pg_blocking_pids(pid), left(query, 60)
 *     FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;
 *
 *   SELECT pg_cancel_backend(pid);      -- ask nicely (cancels the query)
 *   SELECT pg_terminate_backend(pid);   -- kill the connection
 *
 * And the one to install before you need it: `pg_stat_statements`, which
 * ranks queries by total time across the whole database. It answers "what
 * is actually slow" rather than "what do I suspect".
 */

/* ============================================================================
 * 11. REPRODUCING EVERY MEASUREMENT IN THIS FILE
 * ============================================================================
 * Nothing here should be taken on trust. Build the same scratch database —
 * note it is a SCRATCH database, never your real one:
 *
 *   createdb pottery_scratch
 *
 *   -- tables mirroring the real schema, then:
 *   INSERT INTO products (category_id, slug, name, price_minor, stock_count)
 *   SELECT (SELECT id FROM categories ORDER BY slug LIMIT 1),
 *          'prod-' || g, 'Product ' || g,
 *          (random()*400000)::int + 50000, (random()*10)::int
 *   FROM generate_series(1, 50000) g;
 *
 *   -- CAUTION, learned the hard way while writing this file: an
 *   -- uncorrelated subquery like `(SELECT id FROM categories ORDER BY
 *   -- random() LIMIT 1)` is evaluated ONCE, not per row — every product
 *   -- lands in the same category and every plan you measure is garbage.
 *   -- Spread rows deterministically instead:
 *   WITH c AS (SELECT id, row_number() OVER (ORDER BY slug) - 1 AS n FROM categories)
 *   UPDATE products p SET category_id = c.id
 *   FROM c WHERE c.n = abs(hashtext(p.slug)) % 8;
 *
 *   ANALYZE;      -- ALWAYS, after any bulk change, or the plans lie
 *
 * Then run the EXPLAINs from sections 2-4. For the concurrency measurements
 * in section 7, run two psql sessions against the same row with a
 * `SELECT pg_sleep(1.5);` between the read and the write to create the
 * overlap window.
 *
 * `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)` is the form used
 * throughout this file: it keeps the plan SHAPE and the actual row counts
 * while dropping the machine-specific numbers, which makes plans
 * comparable between runs and between machines.
 */

/* ============================================================================
 * 12. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Guessing at performance instead of running EXPLAIN            -> S1
 * - `EXPLAIN ANALYZE` on an UPDATE/DELETE outside a ROLLBACK      -> S1
 * - Concluding "the index is broken" when it matches most rows    -> S2.1
 * - Indexing a column with two or three distinct values           -> S2.1
 * - Measuring plans without running `ANALYZE` first               -> S2.1
 * - A composite index ordered range-column-first                  -> S3
 * - Expecting an index on (A,B) to serve a query on B             -> S3
 * - Deep OFFSET pagination on a growing table                     -> S4
 * - Paginating or ranking without a unique tie-breaker            -> S4, S5
 * - `row_number()` with a non-total ORDER BY                      -> S5
 * - Omitting the frame clause on a non-unique ORDER BY            -> S5
 * - Assuming a window `sum()` returns a JS number                 -> S5
 * - Read-modify-write across a round trip                         -> S7
 * - Believing a transaction prevents a lost update                -> S8
 * - REPEATABLE READ / SERIALIZABLE with no retry on 40001         -> S8
 * - Locking rows in basket order rather than a sorted order       -> S9
 * - Any network call inside a transaction                         -> S7, S9
 * - No `statement_timeout`                                        -> S10
 * - No `idle_in_transaction_session_timeout`                      -> S10
 * - `CREATE INDEX` (non-concurrently) on a live table             -> S10
 */

export const _referenced = {
  showSql,
  ordersPageKeyset,
  bestSellerPerCategory,
  monthlyRevenueRunningTotal,
  reserveStockPessimistic,
  reserveStockGuarded,
  reserveManyInOrder,
};
