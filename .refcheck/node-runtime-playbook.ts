/**
 * THE NODE/BUN RUNTIME, AND WHAT ACTUALLY GOES WRONG IN IT
 * — grounded in Pottery Market's apps/api (Bun + Elysia + postgres-js).
 *
 * Standalone, type-checked module. It imports nothing from the app, so
 * verify it from the Pottery repo root against the API's own strict config:
 *
 *   cp examples/backend/node-runtime-playbook.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * (`.refcheck/tsconfig.json` just extends `apps/api/tsconfig.json` — the
 * real one, with `strict`, `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and
 * `verbatimModuleSyntax` all on. Every snippet below compiles under those.)
 *
 * The one idea threading through this file: on the frontend, a slow
 * function makes ONE user's screen janky. On the backend, a slow function
 * makes EVERY user wait, because they are all queued behind the same single
 * thread. Almost every rule here is a consequence of that sentence.
 */

/* ============================================================================
 * 1. ONE THREAD — what "blocking" actually means
 * ============================================================================
 * PLAIN ENGLISH FIRST: your server process runs your JavaScript on exactly
 * one thread. Not one thread per request — one thread, total. When 50
 * people hit /products at the same moment, the runtime does not run 50
 * copies of your handler side by side. It runs a little bit of handler #1,
 * and the instant that handler says `await` (waiting on the database, a
 * file, the network), the runtime parks it and picks up handler #2.
 *
 * So `await` is not "pause everything." `await` is "I'm waiting on the
 * outside world — go serve someone else, wake me when my answer lands."
 * That is the entire trick that lets one thread serve hundreds of users.
 *
 * The trick has one failure mode, and it is the whole reason this section
 * exists: **code that takes a long time WITHOUT awaiting anything.** That
 * code is not waiting on the outside world, so there is no park-and-switch
 * point. It just runs, start to finish, and every other request sits frozen
 * behind it. That is "blocking the event loop."
 */

/** Blocking: pure computation. Nobody else is served while this runs. */
function blockingHash(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc * 31 + i) >>> 0;
  return acc;
}

/** Non-blocking: WAITING. Other requests are served meanwhile. */
async function waitingOnDatabase(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 200)); // stand-in for a real query
  return 42;
}

/*
 * Both can "take 200ms" on a stopwatch. They are not remotely the same
 * thing: one costs 200ms of the server's ONLY thread, the other costs ~0ms
 * of it. When you read a profiler, this is the distinction that matters —
 * not total duration, but how much of that duration was *on-thread*.
 *
 * The blocking list, i.e. things with no `await` in them that can still
 * take real time:
 *   - `fs.readFileSync` / `writeFileSync` and every other `*Sync` call
 *   - `JSON.parse` / `JSON.stringify` on a multi-megabyte payload
 *   - `crypto.pbkdf2Sync`, `bcrypt.hashSync` — password hashing is
 *     *designed* to be slow; the sync variant is a self-inflicted outage
 *     (see examples/auth/backend-auth.ts section 2)
 *   - a loop over a big array (sorting 500k rows in JS instead of in SQL)
 *   - catastrophic regex backtracking (section 1.1)
 *   - `child_process.execSync`
 *
 * THE RULE: in a request handler, if a function name ends in `Sync`, it is
 * almost always the wrong function. The async version exists precisely so
 * the thread can go serve someone else while the disk does its thing.
 */

/* ---------------------------------------------------------------------------
 * 1.1 The regex one, because it doesn't look like a performance bug
 * -------------------------------------------------------------------------*/

/*
 * A regex with nested quantifiers over the same characters — `(a+)+`,
 * `(\s*,)*`, `(\w+\s?)*` — can take exponential time on input that ALMOST
 * matches. Thirty characters of hostile input can hang the thread for
 * minutes. It's called ReDoS, and it's a denial-of-service bug wearing a
 * validation costume.
 *
 * Not abstract for this project: `packages/shared/src/schemas/` runs
 * user-supplied strings through regexes on every order request. The two
 * that are live there are safe, and it's worth seeing WHY:
 *
 *   /^\+7\d{10}$/                          (phoneNumberSchema)
 *   /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/       (telegramHandleSchema)
 *
 * Both are linear: anchored at both ends, no quantifier wrapped around
 * another quantifier, and — the property that actually buys the safety —
 * adjacent quantified pieces that can't both match the same character.
 * When two neighbouring groups CAN match the same character, the engine has
 * a choice about which one eats it, and "a choice" is what it backtracks
 * through exponentially.
 *
 * Checklist before shipping a regex that touches user input:
 *   - anchor it (`^...$`) — an unanchored pattern hands the engine N extra
 *     starting positions to retry from
 *   - no quantifier directly inside another (`(x+)+`, `(x*)*`, `(x+)*`)
 *   - bound the repeats (`{3,30}`, not `+`) when the domain has a real max
 *   - cap input length BEFORE the regex runs — `z.string().max(100)` ahead
 *     of `.regex(...)` bounds the worst case no matter what
 * ...and if the pattern is genuinely hairy, don't write a regex. Write a
 * small parser; it will be faster, readable, and impossible to ReDoS.
 */

/* ---------------------------------------------------------------------------
 * 1.2 What to do when the work is genuinely CPU-heavy
 * -------------------------------------------------------------------------*/

/*
 * Sometimes the work really is 200ms of computation — resizing an uploaded
 * product photo, generating a PDF invoice. Four honest options, in the
 * order you should consider them:
 *
 *   1. DON'T DO IT IN THE REQUEST. Accept the upload, return 202, do the
 *      work after. The user gets an instant response and the thread stays
 *      free. This is the right answer far more often than people expect.
 *   2. Make the database do it. Sorting, filtering, aggregating, counting —
 *      Postgres is C with indexes; your JS loop is not. See
 *      examples/backend/drizzle-playbook.ts section 8.
 *   3. Move it off-thread — a `Worker` (`node:worker_threads`; Bun also
 *      implements the browser `Worker` API). Real parallelism, at the cost
 *      of structured-cloning data across the boundary.
 *   4. Use a native module that releases the thread. Sharp (image resizing)
 *      and `crypto.pbkdf2` (async form) do their work in libuv's thread
 *      pool, so `await` genuinely frees the loop.
 *
 * Reach for #4 and #1 first. #3 is a real cost: separate memory, no shared
 * state, serialization on every message.
 */

/* ============================================================================
 * 2. BUN vs NODE — what apps/api actually gets, and what it doesn't
 * ============================================================================
 * This project runs Bun (`bun run --watch src/index.ts`). Bun is a
 * different runtime that deliberately implements Node's APIs, so the large
 * majority of "Node advice" applies unchanged. The gaps that matter here:
 *
 * THINGS BUN GIVES YOU THAT NODE DOESN'T (and that apps/api relies on):
 *   - `.env` is loaded automatically. No `dotenv` dependency. BUT — and
 *     this already bit this project once — `drizzle.config.ts` is run by
 *     the drizzle-kit CLI in its own process, which does NOT inherit that.
 *     That file calls `process.loadEnvFile('.env')` itself for exactly this
 *     reason. Any other CLI-run script needs the same line.
 *   - TypeScript runs directly. No build step, no ts-node, no tsx.
 *   - `Bun.password.hash()` / `.verify()` — argon2id built in, async, with
 *     no native module to compile. See examples/auth/backend-auth.ts.
 *   - `bun:sqlite`, `Bun.serve` (Elysia sits on top of this), `Bun.file`.
 *
 * THINGS THAT ARE STILL TRUE UNDER BUN:
 *   - One thread. Everything in section 1 applies identically.
 *   - The event loop, microtasks, `process.on('SIGTERM')`, `AbortSignal`.
 *   - Postgres is still over a socket, so `await` still parks properly.
 *
 * THE TRAP: `Bun.*` APIs are not portable. The moment `Bun.password`
 * appears in `packages/shared/`, that package can no longer be imported by
 * `apps/web` (a browser bundle) or by a Jest test running under Node.
 * `@pottery/shared` is consumed by BOTH apps — keep it runtime-agnostic:
 * zod schemas and pure functions only, never `Bun.*`, never `node:fs`.
 * That isn't a style rule, it's the thing that keeps the shared package
 * shareable.
 */

/* ============================================================================
 * 3. THE ASYNC MISTAKES THAT SURVIVE CODE REVIEW
 * ============================================================================
 * These four all look fine. Three are bugs and one is an order of magnitude
 * slower than it needs to be.
 */

interface OrderLineLike {
  readonly productId: string;
  readonly quantity: number;
}

declare function fetchProductPrice(id: string): Promise<number>;

/* ---------------------------------------------------------------------------
 * 3.1 Sequential awaits in a loop — correct, and needlessly slow
 * -------------------------------------------------------------------------*/

async function totalSlow(lines: readonly OrderLineLike[]): Promise<number> {
  let total = 0;
  for (const line of lines) {
    const price = await fetchProductPrice(line.productId); // waits for #1 before starting #2
    total += price * line.quantity;
  }
  return total;
}

/*
 * 20 lines x 15ms per query = 300ms, one after another, for work with no
 * ordering requirement at all. The fix is to START all of them, then wait
 * once:
 */

async function totalFast(lines: readonly OrderLineLike[]): Promise<number> {
  const prices = await Promise.all(lines.map((line) => fetchProductPrice(line.productId)));
  return lines.reduce((sum, line, i) => sum + (prices[i] ?? 0) * line.quantity, 0);
}

/*
 * `?? 0` is there because `noUncheckedIndexedAccess` correctly points out
 * that TypeScript can't prove `prices[i]` exists. It always does here —
 * `Promise.all` preserving length and order is guaranteed, not incidental —
 * but the compiler can't know that, and `?? 0` is cheaper than a non-null
 * assertion that would silence a real bug later.
 *
 * WHEN *NOT* TO PARALLELISE:
 *   - When step 2 needs step 1's result. Sequential is then correct.
 *   - When the list is unbounded. `Promise.all` over 5,000 user-supplied
 *     items opens 5,000 concurrent queries and exhausts the connection
 *     pool. Either cap the input (`createOrderRequestSchema` already does:
 *     `.max(50)`) or batch it.
 *   - When one query could replace the whole loop. For this exact case it
 *     can — `where(inArray(products.id, ids))`, one round trip. Drizzle
 *     playbook section 8; it's the actual right answer here.
 */

/* ---------------------------------------------------------------------------
 * 3.2 `.forEach` with an async callback — silently does nothing
 * -------------------------------------------------------------------------*/

function totalBroken(lines: readonly OrderLineLike[]): number {
  let total = 0;
  lines.forEach(async (line) => {
    const price = await fetchProductPrice(line.productId);
    total += price * line.quantity; // runs LATER — after this function already returned
  });
  return total; // always 0
}

/*
 * `forEach` ignores its callback's return value. Every callback returns a
 * Promise; every Promise is dropped on the floor. The function returns 0
 * before a single price has come back and — worse — any rejection inside
 * becomes an unhandled rejection that can kill the process (section 5).
 *
 * There is no async `forEach`. Use `for...of` with `await` (sequential) or
 * `Promise.all(map(...))` (parallel). That's the whole choice.
 *
 * `@typescript-eslint/no-misused-promises` catches this, and it is worth
 * turning on in `apps/api/eslint.config.js` for this bug class alone.
 */

/* ---------------------------------------------------------------------------
 * 3.3 Floating promises — the error you never see
 * -------------------------------------------------------------------------*/

declare function notifyTelegram(orderId: string): Promise<void>;

/** WRONG: not awaited, not caught. If it rejects, nothing here knows. */
function afterOrderWrong(orderId: string): void {
  notifyTelegram(orderId); // eslint: no-floating-promises
}

/**
 * RIGHT when you genuinely don't want to make the user wait for it: say so
 * explicitly, and attach a catch so a failure gets logged rather than
 * escalating to a process-level unhandled rejection.
 */
function afterOrderRight(orderId: string): void {
  void notifyTelegram(orderId).catch((error: unknown) => {
    console.error({ event: 'telegram_notify_failed', orderId, error });
  });
}

/*
 * `void` here is a deliberate, greppable "I know this is async and I am
 * choosing not to await it." Bare `notifyTelegram(orderId)` is
 * indistinguishable from forgetting. Enable
 * `@typescript-eslint/no-floating-promises` and the whole class becomes a
 * lint error instead of a 3am mystery.
 *
 * CAVEAT worth knowing: fire-and-forget work is not durable. If the process
 * is killed between the HTTP response and the Telegram call, that
 * notification is simply gone. For anything that MUST happen, write a row
 * (`status: 'pending'`) in the same transaction as the order and have
 * something drain it. "Await it" and "fire and forget" are both wrong for
 * work that must not be lost.
 */

/* ---------------------------------------------------------------------------
 * 3.4 `Promise.all` vs `allSettled` vs `race` vs `any`
 * -------------------------------------------------------------------------*/

declare function loadProducts(): Promise<readonly string[]>;
declare function loadCategories(): Promise<readonly string[]>;

async function dashboardStrict(): Promise<{
  products: readonly string[];
  categories: readonly string[];
}> {
  // all: rejects the instant ANY input rejects. Correct when you need all
  // of them — a half-built response is worse than an error.
  const [products, categories] = await Promise.all([loadProducts(), loadCategories()]);
  return { products, categories };
}

async function dashboardTolerant(): Promise<{
  products: readonly string[];
  categoriesFailed: boolean;
}> {
  // allSettled: never rejects. Correct when a partial answer is genuinely
  // useful — render the product grid even if the category filter is down.
  const [products, categories] = await Promise.allSettled([loadProducts(), loadCategories()]);
  return {
    products: products.status === 'fulfilled' ? products.value : [],
    categoriesFailed: categories.status === 'rejected',
  };
}

/*
 * `Promise.all` REJECTS fast but does not CANCEL the others — they keep
 * running, holding whatever they hold (a connection, a file handle). If
 * the siblings hold resources, pass them all one `AbortSignal` (section 7)
 * so the rejection actually stops the work.
 *
 * A SECOND rejection after the first is NOT an `unhandledRejection` — a
 * common claim, and wrong: `Promise.all` attaches a handler to every input.
 * Measured on Node 24 and Bun 1.3.14: two inputs rejecting 40ms apart, zero
 * unhandled rejections. The real cost is the opposite one — the second
 * error is silently DISCARDED. If you need to know about every failure,
 * that is `allSettled`, or a log line inside each task.
 *
 * `race` settles on the first to settle either way (used for timeouts);
 * `any` resolves on the first SUCCESS and only rejects if all fail (used
 * for redundant mirrors). The four-way comparison is also in
 * examples/typescript/javascript-essential-toolkit.ts section 8.
 */

/* ============================================================================
 * 4. ERRORS: keep the cause, keep the type, keep the stack
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 4.1 `catch (e: unknown)` — and why `e.message` doesn't compile
 * -------------------------------------------------------------------------*/

function describeFailure(error: unknown): string {
  // Under `strict`, a catch binding is `unknown`. You cannot reach into it
  // until you have proved what it is — because `throw 'a string'` is legal
  // JavaScript, and so is `throw undefined`.
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/* ---------------------------------------------------------------------------
 * 4.2 `Error.cause` — wrap without destroying the evidence
 * -------------------------------------------------------------------------*/

class OrderPersistenceError extends Error {
  override readonly name = 'OrderPersistenceError';
  constructor(
    readonly orderId: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not persist order ${orderId}`, options);
  }
}

declare function insertOrderRow(id: string): Promise<void>;

async function persistOrder(id: string): Promise<void> {
  try {
    await insertOrderRow(id);
  } catch (error) {
    // The original postgres error — its SQLSTATE code, its constraint name,
    // its stack — is preserved under `.cause`. Re-throwing a bare new Error
    // here would throw that away, and the SQLSTATE is exactly what
    // apps/api/src/utils/Errors.util.ts reads to turn a unique violation
    // into a 409.
    throw new OrderPersistenceError(id, { cause: error });
  }
}

/*
 * `cause` is standard (ES2022) and both `console.error` and modern
 * inspectors print the whole chain. Three rules:
 *   - NEVER `catch (e) { throw new Error('failed') }`. That is evidence
 *     destruction. If you have nothing to add, don't catch.
 *   - Only catch where you can DO something: add context, map to a status
 *     code, retry, clean up. Otherwise let it bubble to the one handler at
 *     the top (examples/backend/elysia-playbook.ts section 6).
 *   - `override readonly name = '...'` matters: the default `name` is
 *     `'Error'` for every subclass, and `instanceof` breaks across module
 *     realms and after some bundling. A literal discriminant survives both.
 *     `noImplicitOverride` is on in `tsconfig.base.json`, which is why the
 *     `override` keyword is mandatory there rather than decorative.
 */

/* ---------------------------------------------------------------------------
 * 4.3 The async stack-trace gap
 * -------------------------------------------------------------------------*/

/*
 * A stack trace records where the error was CREATED, not where it was
 * awaited. Async frames are reconstructed, and the reconstruction has a
 * hole in exactly one case: when a promise is created in one tick and
 * awaited in a later one, the frames in between are gone.
 *
 * Academic until you hit it: in section 3.1's `Promise.all` version, a
 * rejection's trace points into the mapping callback with very little above
 * it. Practical defence — put identifying data IN the error (`orderId`,
 * `productId`), as `OrderPersistenceError` does above. A stack trace tells
 * you which line; the fields tell you which row. When something only fails
 * for one customer, the fields are the half that solves it.
 */

/* ============================================================================
 * 5. CRASH SAFETY: unhandledRejection and uncaughtException
 * ============================================================================
 * PLAIN ENGLISH: these two fire when an error escaped EVERYTHING — no
 * try/catch, no `.catch()`, nothing. By the time one fires, some piece of
 * your program is in a state you did not design.
 */

function installCrashHandlers(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    console.error({ event: 'unhandled_rejection', reason });
    process.exit(1);
  });

  process.on('uncaughtException', (error: Error) => {
    console.error({ event: 'uncaught_exception', message: error.message, stack: error.stack });
    process.exit(1);
  });
}

/*
 * THE COUNTERINTUITIVE PART: these handlers exist so you can LOG, then DIE.
 * Not so you can keep going.
 *
 * The temptation is obvious — "it's one bad request, why kill the server?"
 * Because you do not know that it was. An uncaught exception can leave a
 * half-written transaction, a held lock, a mutated module-level cache. A
 * process that survives an unknown error is a process now serving every
 * subsequent request from corrupt state, and those bugs are unfindable.
 * Crash, let the supervisor restart you clean, and fix the actual hole.
 *
 * Note the asymmetry: `unhandledRejection` is very often just a missing
 * `.catch()` in YOUR code (see 3.3). The handler is the alarm; the fix is
 * `no-floating-promises`, not the handler.
 */

/* ============================================================================
 * 6. GRACEFUL SHUTDOWN — the other half of deployment
 * ============================================================================
 * PLAIN ENGLISH: deploying = the old process is told to stop and a new one
 * starts. "Told to stop" is `SIGTERM`. Ignore it and the platform waits
 * ~10-30 seconds, then sends `SIGKILL`, which cannot be caught and kills
 * you mid-request. Every in-flight order request dies with it.
 */

interface ClosableServer {
  stop(): Promise<void> | void;
}

function installGracefulShutdown(server: ClosableServer, closeDb: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // Ctrl-C twice must not run this twice
    shuttingDown = true;
    console.log({ event: 'shutdown_start', signal });

    const forceExit = setTimeout(() => {
      console.error({ event: 'shutdown_timeout' });
      process.exit(1);
    }, 10_000);
    forceExit.unref(); // this timer must not be the reason we stay alive

    void (async () => {
      try {
        await server.stop(); // 1. stop ACCEPTING; finish what's in flight
        await closeDb(); // 2. only then close the pool
        clearTimeout(forceExit);
        console.log({ event: 'shutdown_complete' });
        process.exit(0);
      } catch (error) {
        console.error({ event: 'shutdown_failed', error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM'); // orchestrator / deploy
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT'); // your Ctrl-C
  });
}

/*
 * Order is the whole point: stop accepting FIRST, then drain, then close
 * the database. Closing postgres first means the requests you were trying
 * to be polite about all fail anyway.
 *
 * `.unref()` on the force-exit timer is the subtle bit. An active timer
 * keeps the event loop alive; without `unref()`, a server that drained in
 * 50ms would still sit there for the full 10 seconds waiting on its own
 * safety net.
 *
 * WINDOWS CAVEAT, since this is a Windows dev box: Windows has no real
 * POSIX signals. Node emulates `SIGINT` (Ctrl-C) and `SIGTERM` well enough
 * for development, but `process.kill(pid, 'SIGTERM')` from another process
 * terminates immediately rather than delivering a catchable signal. Don't
 * conclude your shutdown logic is broken from a Windows test — verify it
 * where it will actually run.
 */

/* ============================================================================
 * 7. TIMEOUTS: `fetch` will wait forever, and that is the default
 * ============================================================================
 * PLAIN ENGLISH: `await fetch(url)` against a server that accepts your
 * connection and then says nothing will hang until the OS gives up —
 * minutes. Meanwhile that request holds a connection, and if it's holding a
 * DB connection too, it's holding one of a very small number of those.
 * Slowness propagates; this is how one flaky third party takes down a
 * service that barely depends on it.
 */

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  // AbortSignal.timeout(ms) is the one-liner (Node 17.3+/Bun). It aborts
  // with a TimeoutError rather than a generic AbortError, so you can tell
  // "took too long" apart from "caller gave up".
  return await fetch(url, { signal: AbortSignal.timeout(ms) });
}

async function fetchCancellable(
  url: string,
  ms: number,
  callerSignal: AbortSignal,
): Promise<Response> {
  // AbortSignal.any() — first of several reasons to stop wins. Here: our
  // deadline, or the caller giving up.
  return await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(ms), callerSignal]) });
}

/*
 * RULES:
 *   - Every outbound call gets a timeout. No exceptions. A call without one
 *     is an unbounded liability.
 *   - Pass the signal DOWN. A timeout on a wrapper that doesn't forward its
 *     signal to the actual `fetch` cancels nothing — it just stops you
 *     waiting for work that is still running.
 *   - Distinguish retryable from not. A timeout on a GET is usually worth
 *     one retry with backoff; a timeout on a POST is NOT, unless it is
 *     idempotent — you have no idea whether the other side processed it.
 *   - The database needs this too: `postgres(url, { connect_timeout: 10 })`
 *     plus a statement timeout. Drizzle playbook section 10.
 */

/* ============================================================================
 * 8. STREAMS — when "read the file" is a memory bug
 * ============================================================================
 */

/*
 * `await readFile(path)` puts the ENTIRE file in memory. For a 2KB config,
 * fine. For a 500MB export that's 500MB of RSS for one request — and ten
 * concurrent ones are 5GB and an OOM kill.
 *
 * Streaming processes it in chunks; memory stays flat regardless of size:
 *
 *   const file = Bun.file('./big-export.csv');
 *   const stream = file.stream();                  // ReadableStream
 *   for await (const chunk of stream) { ... }      // constant memory
 *
 * Same on the way out: returning a `ReadableStream` from a handler streams
 * to the client instead of buffering the whole response.
 *
 * When NOT to stream: when the thing is small and bounded, or when you need
 * the whole value at once anyway (parsing JSON). Streaming code is harder
 * to read and harder to get right around errors — reach for it when size is
 * genuinely unbounded or user-controlled, not on principle.
 *
 * The real rule underneath: **never let a user's input decide how much
 * memory you allocate.** `createOrderRequestSchema`'s `.max(50)` on items
 * and `.max(1000)` on the note are that rule applied at the edge; a
 * body-size cap on the server is the same rule one level down.
 */

/* ============================================================================
 * 9. MODULE-LEVEL STATE — the singleton that quietly isn't
 * ============================================================================
 */

/*
 * A module body runs ONCE per process, and its top-level `const` lives for
 * the process's whole life. `apps/api/src/db/client.ts` depends on this on
 * purpose — one connection pool, shared by every request, created once.
 * That is exactly right: pools are expensive and meant to be shared.
 *
 * The trap is using the same mechanism for DATA:
 *
 *   const priceCache = new Map<string, number>();   // (!)
 *
 * Three failures, in increasing order of how long they take to find:
 *   1. It is per-process. Two instances behind a load balancer have two
 *      different caches, and a price edit invalidates one of them. Users
 *      see stale prices depending on which box they land on.
 *   2. It never shrinks. An unbounded Map keyed by anything user-supplied
 *      is a memory leak with a `delete` you forgot to write.
 *   3. It survives between requests. Anything user-specific stored here can
 *      leak from one customer to the next — the worst version of this bug.
 *
 * Per-process caching is fine for immutable, bounded, non-user-specific
 * things (a compiled regex, parsed config). Anything else belongs in
 * Postgres or Redis, where "shared" and "invalidatable" are real.
 *
 * Related: module bodies must stay cheap and side-effect-free. Importing a
 * module should never open a socket or read a file — you cannot catch an
 * error thrown during import, and you cannot test around it. The exception
 * that proves the rule: `env.ts` throws at import time ON PURPOSE (section
 * 10), because misconfiguration should kill startup, not request #4000.
 */

/* ============================================================================
 * 10. CONFIG AND SECRETS — fail at boot, never at 3am
 * ============================================================================
 * apps/api/src/config/env.ts already does this correctly. Here's the why,
 * because it is the highest-leverage 20 lines in a backend.
 */

/*
 *   const envSchema = z.object({
 *     NODE_ENV: z.enum(['development','test','production']).default('development'),
 *     PORT: z.coerce.number().int().positive().default(3000),
 *     CORS_ORIGIN: z.string().default('http://localhost:4200'),
 *     DATABASE_URL: z.url(),                        // no default — required
 *   });
 *   export const env = loadEnv(process.env);        // throws at import time
 *
 * What each decision buys:
 *   - `z.coerce.number()` because EVERY env var is a string. `PORT=3000`
 *     arrives as `'3000'`, and `'3000' + 1` is `'30001'`. Coerce at the
 *     boundary, once, and the rest of the codebase gets a real number.
 *   - `DATABASE_URL: z.url()` with NO default. A default here would be a
 *     disaster: a typo'd variable name would silently connect to localhost
 *     in production. Required-with-no-default makes a missing var a loud
 *     startup crash — the cheapest possible failure.
 *   - `export const env = ...` at module scope: the process refuses to
 *     start misconfigured. Compare with reading `process.env['X']` deep in
 *     a handler, where a typo is a 500 on one endpoint at 3am.
 *   - Everything downstream imports `env`, never `process.env`. That is
 *     what makes the schema the single source of truth. Be clear about
 *     what enforces it: `noPropertyAccessFromIndexSignature` turns
 *     `process.env.PORT` into a compile error, but `process.env['PORT']`
 *     still compiles — the flag makes a raw read VISIBLE, it does not
 *     forbid it. The actual enforcement is a lint rule (`n/no-process-env`,
 *     or `no-restricted-properties` on `process.env`) with an override for
 *     `config/env.ts` and `drizzle.config.ts` only.
 *
 * SECRETS:
 *   - `.env` is gitignored; `.env.example` is committed with the KEYS and
 *     dummy values. Both already true here.
 *   - Never log the env object. `console.log(env)` prints DATABASE_URL —
 *     password included — into whatever aggregates your logs. If you want a
 *     boot banner, print the keys, never the values.
 *   - Never send config in an error response. A stack trace or connection
 *     string in a 500 body is a genuine leak. Elysia playbook section 6 has
 *     the "log the detail, return a generic message" handler.
 */

/* ============================================================================
 * 11. PATHS AND THE FILESYSTEM (on a Windows dev box, no less)
 * ============================================================================
 */

/*
 * ESM has no `__dirname`. The replacement:
 *
 *   import { dirname, join } from 'node:path';
 *   import { fileURLToPath } from 'node:url';
 *   const here = dirname(fileURLToPath(import.meta.url));
 *   const migrations = join(here, '..', 'drizzle');
 *
 * (Bun also exposes `import.meta.dir` directly — shorter, but Bun-only, so
 * not for anything in `packages/shared`.)
 *
 * Windows-specific things that will differ between this dev box and a Linux
 * server:
 *   - `path.join` handles `..` and duplicate separators correctly and stays
 *     right when a segment is user-supplied. String concatenation doesn't.
 *   - The filesystem is case-INSENSITIVE here and case-SENSITIVE on the
 *     server. `import { db } from './DB/client'` runs fine locally and
 *     fails in CI. `forceConsistentCasingInFileNames` is on in
 *     `tsconfig.base.json` precisely to catch this at compile time — that
 *     flag is doing real work, not box-ticking.
 *   - Git's `core.autocrlf` can rewrite line endings, which changes file
 *     HASHES. If you ever checksum a committed file, that's the culprit.
 *     (examples/workflow/git-playbook.md covers the CRLF mess properly.)
 *
 * PATH TRAVERSAL — the security half. If a filename ever comes from a
 * request, `join(uploadDir, userInput)` is not safe: `../../etc/passwd`
 * escapes. `resolve()` the result and verify it still sits inside the
 * directory you intended:
 *
 *   const target = resolve(uploadDir, userInput);
 *   if (!target.startsWith(resolve(uploadDir) + sep)) throw new Error('bad path');
 *
 * Better still: don't use user input as a filename at all. Store a UUID and
 * keep the original name in a column.
 */

/* ============================================================================
 * 12. LOGGING — `console.log` is a debugging tool, not a logging strategy
 * ============================================================================
 */

/*
 * What's wrong with `console.log('order created', id)` in production:
 *   - Not machine-readable. You cannot query "all failures for order X"
 *     across a million lines of prose.
 *   - No level. You cannot turn debug off without editing code.
 *   - No correlation. Ten interleaved requests produce ten interleaved logs
 *     with nothing tying a line to the request that caused it.
 *   - `console.log` can be SYNCHRONOUS, and where it is depends on what
 *     stdout is attached to — which is not something your code controls:
 *         files  synchronous everywhere
 *         pipes  synchronous on Linux and Windows, async on macOS
 *         TTYs   synchronous on POSIX, async on Windows
 *     So the case that matters is the one you did not test: redirected to a
 *     file or piped to a log collector in production, where it is
 *     synchronous, while your terminal on macOS was not. High-volume
 *     logging then blocks the event loop — section 1, arriving from an
 *     unexpected direction. It is also why a real logger (pino) writes
 *     asynchronously and why "just add more logging" can itself be the
 *     performance regression.
 *
 * Log OBJECTS, not sentences — every line in this file already does:
 *
 *   console.error({ event: 'telegram_notify_failed', orderId, error });
 *
 * `event` is a stable key you can group by; the rest are fields you can
 * filter on. That shape ports directly to pino/winston when you outgrow
 * `console`, with no rewriting.
 *
 * NEVER LOG: passwords, tokens, session ids, full card numbers, the whole
 * request body of anything containing them, `env`. For this project that
 * specifically means the admin password and customers' phone numbers /
 * Telegram handles — contact details are personal data, and "it's only in
 * the logs" is exactly how that leaks.
 *
 * DO LOG, on every request: method, path, status, duration, a request id.
 * Four fields, and they answer most production questions on their own.
 * Elysia playbook section 5 wires it as a lifecycle hook.
 */

/* ============================================================================
 * 13. THE DON'T-DO LIST
 * ============================================================================
 *
 * - `*Sync` anything inside a request handler                     -> S1
 * - An unanchored or nested-quantifier regex on user input        -> S1.1
 * - Sorting/filtering a big result set in JS instead of SQL       -> S1.2
 * - `Bun.*` or `node:*` inside `packages/shared`                  -> S2
 * - `await` inside a loop when the calls are independent          -> S3.1
 * - `.forEach(async ...)`                                         -> S3.2
 * - Calling an async function with no `await`, `void` or `.catch` -> S3.3
 * - `catch (e) { throw new Error('failed') }` — evidence gone     -> S4.2
 * - Swallowing an error to "keep the server up"                   -> S5
 * - No SIGTERM handler (every deploy kills live requests)         -> S6
 * - `fetch` with no timeout                                       -> S7
 * - Reading an unbounded file/body fully into memory              -> S8
 * - A module-level `Map` used as a cache of mutable data          -> S9
 * - Reading `process.env` anywhere except `config/env.ts`         -> S10
 * - A default value for a required secret                         -> S10
 * - Logging `env`, tokens, or customer contact details            -> S12
 * - `console.log('thing happened')` as production logging         -> S12
 *
 * And the two that aren't about Node at all but cause the most backend
 * outages anyway:
 * - No index on a column you filter by        -> drizzle-playbook.ts S7
 * - No LIMIT on a list endpoint               -> drizzle-playbook.ts S8
 */

/* Keep every demonstration referenced so `noUnusedLocals` stays honest and
 * this file is a module, not a script. */
export const _referenced = {
  blockingHash,
  waitingOnDatabase,
  totalSlow,
  totalFast,
  totalBroken,
  afterOrderWrong,
  afterOrderRight,
  dashboardStrict,
  dashboardTolerant,
  describeFailure,
  OrderPersistenceError,
  persistOrder,
  installCrashHandlers,
  installGracefulShutdown,
  fetchWithTimeout,
  fetchCancellable,
};
