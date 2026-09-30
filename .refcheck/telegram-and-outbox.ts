/**
 * TELEGRAM DELIVERY AND THE OUTBOX PATTERN — making sure the message
 * actually gets sent.
 *
 * Pottery Market's entire order flow ends in a Telegram conversation
 * (auth/backend-auth.ts section 1). So "Alina is notified that an order
 * exists" is not a nice-to-have bolted onto the side — it IS the checkout.
 * A notification that silently fails is a lost sale.
 *
 * node-runtime-playbook.ts section 3.3 raised this and deferred it:
 * fire-and-forget work is not durable, and "write a row and have something
 * drain it" was the one-line answer. This file is that answer, built.
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/backend/telegram-and-outbox.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * The concurrency measurements in section 4 were produced by running two
 * real psql sessions against PostgreSQL 17.11. The Telegram API calls are
 * NOT exercised here (no bot token, and sending real messages from a
 * reference file would be wrong) — those sections describe the contract.
 *
 * THE ONE IDEA: you cannot write to your database and to Telegram
 * atomically. Anything that assumes you can will, on some percentage of
 * orders, do exactly one of the two.
 */

import { and, eq, lte, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';

/* ============================================================================
 * 1. THE PROBLEM — two systems, no shared transaction
 * ============================================================================
 * The obvious implementation:
 *
 *   await db.transaction(async (tx) => { ...insert the order... });
 *   await sendTelegram(order);              // <- right here
 *
 * Four things that can go wrong, and only the first is handled by a
 * try/catch:
 *
 *   1. Telegram returns an error      -> you know; you can react.
 *   2. The process is killed between the commit and the send (a deploy,
 *      an OOM, a crash)               -> the order exists, nobody is told.
 *      NOTHING in your code runs. There is no catch block for this.
 *   3. Telegram is slow               -> the customer's HTTP request waits
 *      on a third party. Every outbound call needs a timeout
 *      (node-runtime-playbook.ts section 7), and a timeout here means the
 *      checkout feels broken even though the order was saved.
 *   4. Telegram is DOWN for ten minutes -> every order in that window is
 *      lost, permanently, with no record that a notification was owed.
 *
 * AND THE INVERSE, if you send BEFORE committing: Telegram succeeds, the
 * commit fails, and Alina is now chasing an order that does not exist.
 *
 * THE FIX: make the notification part of the transaction — not by calling
 * Telegram inside it (never do I/O in a transaction —
 * drizzle-playbook.ts section 7), but by writing a ROW that says a message
 * is owed. That row commits atomically with the order. A separate worker
 * drains it.
 *
 * This is the OUTBOX PATTERN, and the whole of it is: turn an
 * un-transactional side effect into a transactional row plus a retry loop.
 */

/* ============================================================================
 * 2. THE TABLE
 * ============================================================================
 */

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Discriminator — which handler processes this. */
    kind: text('kind').notNull(),
    /** Everything the handler needs. See the warning below. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** When this becomes eligible again. Drives the backoff. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A PARTIAL index — only over pending rows. The worker polls this
    // constantly, and once the table holds a million delivered messages a
    // full index would be mostly dead weight. `WHERE status = 'pending'`
    // keeps the index the size of the actual backlog.
    index('outbox_claim_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/*
 * `timestamptz`, NOT `timestamp`. `nextAttemptAt` is compared against the
 * clock across processes, and a naive `timestamp` column stores no offset,
 * so "is this due yet" becomes ambiguous the moment anything moves.
 *
 * An earlier version of this note called plain `timestamp` "defensible for
 * values only ever written and read by one server". MEASURED, it is not:
 * on this machine's Postgres (`TimeZone = Asia/Krasnoyarsk`), a plain
 * `timestamp` filled by `defaultNow()` read back through Drizzle 420
 * minutes in the future, while one written from a JS `Date` was correct —
 * one server, one column, two meanings (drizzle-playbook.ts section 2).
 * Every timestamp in the schema should be `timestamptz`, not just this one.
 *
 * STORE THE PAYLOAD, DON'T JUST REFERENCE THE ORDER. The tempting design
 * is `{ orderId }` and have the worker re-read the order. That is a
 * coupling you will regret: the worker then renders a message from CURRENT
 * data, so a retry three hours later sends a message describing a state
 * that has since changed. Store what the message should SAY. It is the
 * same argument as the snapshot columns on order lines
 * (drizzle-playbook.ts section 2) — a record of an event must not depend
 * on mutable data for its meaning.
 *
 * DO NOT PUT SECRETS IN THE PAYLOAD. It is a durable row that will be in
 * every backup and readable by anyone with database access. The bot token
 * lives in `env`, not here.
 */

/* Handlers are keyed by `kind`; each declares the payload it accepts. */
const orderCreatedPayload = z.object({
  orderReference: z.number().int().positive(),
  customerName: z.string().min(1),
  contactMethod: z.enum(['telegram', 'phone', 'email']),
  contactValue: z.string().min(1),
  itemsTotalMinor: z.number().int().nonnegative(),
  lines: z.array(z.object({ name: z.string(), quantity: z.number().int().positive() })).min(1),
});
export type OrderCreatedPayload = z.infer<typeof orderCreatedPayload>;

/* ============================================================================
 * 3. ENQUEUE — in the SAME transaction as the order
 * ============================================================================
 */

type Db = PostgresJsDatabase<Record<string, never>>;
declare const DATABASE_URL: string;
const db: Db = drizzle(postgres(DATABASE_URL));

/**
 * Takes `tx`, not `db`. That is the entire point — this row must commit or
 * roll back WITH the order (backend/dto-and-dao.ts section 5). Calling it
 * with the module-level `db` would put the write on a different connection,
 * outside the transaction, and silently defeat the pattern.
 */
export async function enqueue(tx: Db, kind: string, payload: unknown): Promise<void> {
  await tx.insert(outbox).values({ kind, payload });
}

export async function createOrderWithNotification(draft: OrderCreatedPayload): Promise<void> {
  await db.transaction(async (tx) => {
    // ... insert the order and its lines here ...

    // Same transaction. If the order insert fails, no notification row.
    // If the process dies immediately after COMMIT, the row is already
    // durable and the worker will pick it up on restart.
    await enqueue(tx, 'order_created', draft);
  });

  // Nothing else. The HTTP response returns now — the customer does not
  // wait on Telegram, and Telegram being down does not fail their order.
}

/* ============================================================================
 * 4. CLAIMING WORK — `FOR UPDATE SKIP LOCKED`
 * ============================================================================
 * The worker must take a batch of pending rows without another worker (or
 * another instance, or the same worker's previous tick that hasn't
 * finished) taking the same ones.
 */

export async function claimBatch(tx: Db, limit = 10) {
  return await tx
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, new Date())))
    .orderBy(outbox.createdAt)
    .limit(limit)
    .for('update', { skipLocked: true });
}

/*
 * MEASURED, two concurrent workers against six pending rows, each holding
 * its transaction open for a fixed delay:
 *
 *   WITH `FOR UPDATE SKIP LOCKED`
 *     worker 1 claimed n = 1 2 3
 *     worker 2 claimed n = 4 5 6        <- disjoint
 *     wall time 1547ms                  <- ran in PARALLEL (each slept 1000ms)
 *
 *   WITH plain `FOR UPDATE` (no SKIP LOCKED)
 *     worker 1 got n = 1 2 3
 *     worker 2 got n = 1 2 3            <- THE SAME ROWS
 *     wall time 3266ms                  <- SERIALIZED (each slept 1500ms)
 *
 * Both failures in one experiment. Without `SKIP LOCKED`, worker 2 BLOCKS
 * until worker 1 commits — so you get no parallelism at all — and then it
 * re-reads and sees the same rows, so unless the status was already
 * updated it processes them a second time. Two workers, double delivery,
 * and no throughput gain for the trouble.
 *
 * `SKIP LOCKED` says "ignore rows someone else has locked and give me the
 * next free ones". It is the single feature that makes a database usable
 * as a work queue, and it is why you usually do not need Redis or RabbitMQ
 * for this. One fewer system to run, back up and reason about.
 *
 * `ORDER BY created_at` gives rough FIFO. It is not a strict guarantee
 * under concurrency and does not need to be — order notifications are
 * independent. If ordering ever matters, you need a partition key and one
 * worker per key, which is a much bigger design.
 */

/* ============================================================================
 * 5. THE WORKER LOOP
 * ============================================================================
 */

const MAX_ATTEMPTS = 8;

type Handler = (payload: unknown) => Promise<void>;

const handlers: Record<string, Handler> = {
  order_created: async (raw) => {
    const payload = orderCreatedPayload.parse(raw); // parse: the row is old data
    await sendOrderNotification(payload);
  },
};

export async function processBatch(): Promise<number> {
  return await db.transaction(async (tx) => {
    const rows = await claimBatch(tx, 10);
    let done = 0;

    for (const row of rows) {
      const handler = handlers[row.kind];

      if (!handler) {
        // An unknown kind — usually a rollback to an older deploy. Park it
        // rather than retrying forever against code that cannot handle it.
        await tx
          .update(outbox)
          .set({ status: 'failed', lastError: `No handler for kind "${row.kind}"` })
          .where(eq(outbox.id, row.id));
        continue;
      }

      try {
        await handler(row.payload);
        await tx.update(outbox).set({ status: 'delivered' }).where(eq(outbox.id, row.id));
        done += 1;
      } catch (error: unknown) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);

        await tx
          .update(outbox)
          .set(
            attempts >= MAX_ATTEMPTS
              ? { status: 'failed', attempts, lastError: message }
              : { attempts, lastError: message, nextAttemptAt: backoffFrom(attempts) },
          )
          .where(eq(outbox.id, row.id));
      }
    }

    return done;
  });
}

/** Exponential backoff with jitter, capped. */
function backoffFrom(attempts: number): Date {
  const base = Math.min(2 ** attempts * 1000, 60 * 60 * 1000); // cap at 1h
  const jitter = Math.random() * base * 0.3;
  return new Date(Date.now() + base + jitter);
}

/*
 * JITTER IS NOT DECORATION. Without it, every message that failed during a
 * Telegram outage retries at the same instant when it ends — a thundering
 * herd that can re-break the thing that just recovered. Spreading retries
 * randomly across the window is what makes recovery gradual.
 *
 * THE DEAD LETTER (`status: 'failed'`) is the part people omit, and then a
 * permanently-bad message retries forever, filling the logs and never
 * succeeding. With `MAX_ATTEMPTS = 8` the 8th failure dead-letters the row
 * instead of scheduling another try, so there are SEVEN waits: 2s, 4s, 8s,
 * 16s, 32s, 64s, 128s — 254s, about 4 to 5.5 minutes once jitter is added.
 * That is short: a Telegram outage longer than five minutes dead-letters
 * every order in it. Tune MAX_ATTEMPTS (and the 1h cap) to how long an
 * outage you want to survive unattended — 12 attempts is eleven waits,
 * 4,094s, a little over an hour before jitter.
 *
 * AND THEN ALERT ON IT. A row sitting in `failed`, or a `pending` row older
 * than an hour, means a customer is waiting and nobody knows:
 *
 *   SELECT count(*) FROM outbox WHERE status = 'failed';
 *   SELECT count(*) FROM outbox
 *    WHERE status = 'pending' AND created_at < now() - interval '1 hour';
 *
 * An outbox with no monitoring is a queue that loses things quietly, which
 * is the exact failure it was built to prevent.
 *
 * NOTE THE WHOLE BATCH IS ONE TRANSACTION, which keeps the claim and the
 * status updates consistent — but it also means the transaction is open for
 * as long as the slowest handler. With a timeout on the Telegram call
 * (section 6) that is bounded. Without one it is not, and you are back to
 * holding locks across a third party's outage. If batches grow, claim in
 * one transaction and process each row in its own — but then the claim
 * must also LEASE the rows (`SET next_attempt_at = now() + interval '2
 * minutes'` in the same statement as the `SKIP LOCKED` select), because the
 * row locks vanish the moment the claiming transaction commits, and without
 * a lease the next tick claims the same rows again.
 */

/* ============================================================================
 * 6. AT-LEAST-ONCE, WHICH MEANS DUPLICATES
 * ============================================================================
 * If the handler succeeds and the process dies BEFORE the status update
 * commits, the row is still `pending` and will be delivered again.
 *
 * That is not a flaw to engineer away — it is the standard guarantee. You
 * can have at-least-once or at-most-once; exactly-once across two systems
 * with no shared transaction is not available. Choose at-least-once,
 * because a duplicate notification is recoverable and a missing order is
 * not.
 *
 * SO THE CONSUMER MUST TOLERATE DUPLICATES. For a Telegram message to a
 * human, a rare repeat is harmless — and including the order reference
 * makes it obviously the same order rather than a second one:
 *
 *     Заказ №14                     <- not "a new order"
 *
 * If the side effect were a payment, you would need an idempotency key on
 * the third party's side (backend/api-architecture.ts section 5). The
 * pattern is the same: make repeating the call safe, rather than trying to
 * guarantee it happens once.
 */

/* ============================================================================
 * 7. THE TELEGRAM SIDE
 * ============================================================================
 * NOT EXERCISED HERE — no bot token, and a reference file should not send
 * real messages. This describes the contract.
 */

declare const env: { TELEGRAM_BOT_TOKEN: string; TELEGRAM_ADMIN_CHAT_ID: string };

const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });

async function sendOrderNotification(payload: OrderCreatedPayload): Promise<void> {
  const text = [
    `Заказ №${String(payload.orderReference)}`,
    `${payload.customerName} · ${payload.contactMethod}: ${payload.contactValue}`,
    '',
    ...payload.lines.map((l) => `• ${l.name} × ${String(l.quantity)}`),
    '',
    // Intl, not `Math.round(minor / 100) + ' ₽'` — frontend/i18n-and-formatting.ts
    // section 2: symbol after, NBSP thousands separator, no silent rounding.
    `Итого: ${rub.format(payload.itemsTotalMinor / 100)}`,
  ].join('\n');

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text }),
      // A timeout, always. Without it a hanging request holds this
      // transaction open indefinitely (section 5).
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    // THROW, so the worker records the attempt and schedules a retry.
    // Swallowing here would mark the row delivered when it was not.
    throw new Error(`Telegram sendMessage failed: ${String(response.status)}`);
  }
}

/*
 * THE GOTCHA THAT SHAPED THIS PROJECT'S CHECKOUT: **a phone number does not
 * make someone reachable on Telegram**, and usernames are optional and
 * changeable. A bot CANNOT message a user who has not first started a
 * conversation with it. There is no "send to +7…" endpoint.
 *
 * So the flow cannot be "we'll message you". It has to be the customer
 * opening the chat, which is what the deep link is for:
 *
 *     https://t.me/<bot_or_shop_username>?text=Заказ%20№14
 *
 * The customer taps it, Telegram opens with the message pre-filled, they
 * send it, and only THEN can the conversation continue. Build that link
 * with `encodeURIComponent` on the text.
 *
 * WEBHOOK vs POLLING, if you later want to RECEIVE messages:
 *   - `getUpdates` (long polling) needs no public URL and is right for
 *     development and for a low-volume shop. It is a loop you run.
 *   - `setWebhook` needs a public HTTPS endpoint, and you must verify the
 *     request really came from Telegram — set a secret token and check the
 *     `X-Telegram-Bot-Api-Secret-Token` header, or anyone who finds the URL
 *     can post fake orders.
 * Start with polling. A webhook is an inbound attack surface you do not
 * need until volume justifies it.
 *
 * MESSAGE FORMATTING: the default is plain text and that is the safe
 * choice. If you enable `parse_mode: 'MarkdownV2'` or `'HTML'`, a product
 * name containing `_`, `*` or `<` will break the message or, worse, be
 * interpreted. Customer names and notes are user input; escape them or
 * stay on plain text.
 */

/* ============================================================================
 * 8. RUNNING THE WORKER
 * ============================================================================
 *
 * IN-PROCESS (right for this project): a `setInterval` in the API process
 * that calls `processBatch()` every few seconds. One process, nothing to
 * deploy separately.
 *
 *   const timer = setInterval(() => { void processBatch().catch(log); }, 5000);
 *   timer.unref?.();   // don't keep the process alive just for this
 *
 * Note the `void ... .catch()` — a floating promise in an interval is the
 * unhandled-rejection bug from node-runtime-playbook.ts section 3.3, in the
 * one place where it will fire repeatedly.
 *
 * AND STOP IT ON SHUTDOWN. `clearInterval` in the SIGTERM handler
 * (node-runtime-playbook.ts section 6), before closing the pool — otherwise
 * a tick fires mid-shutdown against a closing connection.
 *
 * A SEPARATE PROCESS becomes worth it when the work is heavy enough to
 * compete with request handling for the single thread, or when you want to
 * scale workers independently. `SKIP LOCKED` already makes multiple workers
 * safe, so this is a deployment decision rather than a code change — which
 * is the nice property of building it this way.
 *
 * DON'T POLL TOO FAST. Every tick is a query. Five seconds is fine for
 * order notifications; a human is not watching the millisecond. If you ever
 * need instant, `LISTEN`/`NOTIFY` lets Postgres wake the worker — but that
 * is an optimisation, and the poll is the thing that makes it reliable.
 */

/* ============================================================================
 * 9. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Calling Telegram after the commit and hoping                 -> S1
 * - Calling Telegram INSIDE the transaction                      -> S1
 * - Sending before committing                                    -> S1
 * - Making the customer's request wait on a third party          -> S1
 * - Enqueueing with `db` instead of `tx`                         -> S3
 * - Storing only an id and re-reading current state on retry     -> S2
 * - Secrets in the payload (it is in every backup)               -> S2
 * - `FOR UPDATE` without `SKIP LOCKED` (blocks AND duplicates)   -> S4
 * - A full index where a partial one fits the backlog            -> S2
 * - No `MAX_ATTEMPTS` — retrying a poison message forever        -> S5
 * - Backoff with no jitter (thundering herd on recovery)         -> S5
 * - No alert on `failed` or on old `pending` rows                -> S5
 * - Assuming exactly-once delivery                               -> S6
 * - A notification with no reference number (looks like a 2nd)   -> S6
 * - `fetch` to Telegram with no timeout                          -> S7
 * - Assuming a phone number means you can message them           -> S7
 * - An unescaped product name with `parse_mode` enabled          -> S7
 * - A webhook with no secret-token check                         -> S7
 * - A floating promise inside the worker's interval              -> S8
 * - Not clearing the interval on SIGTERM                         -> S8
 */

export const _referenced = {
  outbox,
  enqueue,
  createOrderWithNotification,
  claimBatch,
  processBatch,
  sendOrderNotification,
};
