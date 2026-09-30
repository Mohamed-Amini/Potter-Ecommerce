/**
 * BACKEND AUTH — credentials, sessions, and the things that quietly
 * aren't secure (grounded in Pottery Market's apps/api).
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/auth/backend-auth.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * SCOPE NOTE, because it changes what half this file is for. The 2026-09
 * pivot removed customer accounts entirely: no users table, no sessions,
 * no login screen. The entire auth surface of this project today is
 * **one admin password protecting Alina's order screens** — sections 1-5.
 *
 * Sections 6-10 are the reference for the day accounts come back (or for
 * the next project). They are marked as such and are not describing code
 * that exists in apps/api. Nothing here invents a feature this project
 * decided not to build; it documents the shape it would take.
 *
 * The companion file examples/auth/angular-auth.ts covers the BROWSER half
 * — token storage, interceptors, guards. This one is the server.
 */

import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';

/* ============================================================================
 * 1. WHAT THIS PROJECT ACTUALLY NEEDS, AND WHY IT'S SO SMALL
 * ============================================================================
 * The decision is worth recording because "add a login system" is the
 * default reflex, and here it was the wrong one.
 *
 * SMS OTP was costed against published carrier rates and is structurally
 * wrong at this size. The transferable lesson is the SHAPE of the cost, not
 * the number:
 *
 *   **The per-unit price was never the problem — the FIXED monthly floor
 *   was.** SMS sender-name registration is billed per carrier, per month,
 *   whether or not you send anything. Four carriers, each with its own
 *   standing fee, is a five-figure annual commitment before the first
 *   message. Per-message pricing is what vendors advertise and what you
 *   naturally reason about; standing fees are in the fine print and are
 *   what actually decide viability at low volume.
 *
 * Generalise that: when costing ANY third-party dependency, separate the
 * marginal cost from the fixed floor, and multiply the floor by however
 * many providers/regions/environments you need. A service that is "cheap
 * per call" can be unaffordable at ten calls a day.
 *
 * (The concrete 2026 figures that drove this decision live in the project's
 * own notes, deliberately not here. Rates change, and a number copied into
 * a reference file gets trusted long after it stopped being true — verify
 * against the vendor before any decision rests on it. That caution is
 * itself the lesson: an earlier version of this analysis was wrong by 2-3x
 * because the per-message rate was recalled from memory instead of looked
 * up, and the standing fees were missed entirely.)
 *
 * Email OTP would have been nearly free — at which point the better
 * question was why authenticate customers at all.
 *
 * The answer was: don't. Handmade one-off pots, low volume, high touch,
 * Telegram-first market. The flow is pick pieces -> leave a name and one
 * contact handle -> see a quoted total -> Alina closes the order in
 * conversation. A customer account adds friction to every order and
 * protects nothing.
 *
 * WHAT THAT BUYS, SECURITY-WISE — this is the part worth internalising:
 *   - No password database to breach.
 *   - No password-reset flow, which is historically where account systems
 *     are actually broken into.
 *   - No session fixation, no JWT expiry bugs, no refresh-token rotation.
 *   - No PII beyond a name and one contact handle per order.
 *
 * **The most secure authentication system is the one you didn't build.**
 * Before writing any of sections 6-10, the question is always whether the
 * feature needs an account at all. Basket and favourites live in
 * localStorage here precisely because they don't.
 *
 * WHAT REMAINS: Alina needs to see and update orders; the public must not.
 * That is ONE credential and ONE boundary — sections 2-5.
 */

/* ============================================================================
 * 2. STORING A PASSWORD — hashing, and why "encrypted" is the wrong word
 * ============================================================================
 * PLAIN ENGLISH: you never store a password, and you never store anything
 * you could turn back INTO a password. Encryption is reversible by design —
 * if your app can decrypt it, so can whoever steals the database and the
 * key. Hashing is one-way: you store the hash, and at login you hash what
 * was typed and compare the two hashes.
 */

/*
 * USE: argon2id (first choice), scrypt, or bcrypt.
 * DO NOT USE: MD5, SHA-1, SHA-256, SHA-512 — on their own, for passwords.
 *
 * The reason SHA-256 is wrong here is counterintuitive: it is TOO FAST.
 * Speed is the desirable property of a checksum and a catastrophe for a
 * password hash. Commodity hardware does billions of SHA-256 guesses per
 * second; a real password hash is deliberately engineered to be slow and
 * memory-hungry so an attacker with a stolen database gets thousands of
 * guesses per second instead of billions.
 *
 * (SHA-256 is still the right tool for the non-secret hashing in section
 * 7 — fingerprinting a random 256-bit token. The distinction is whether
 * the input is guessable. A human-chosen password is; a 32-byte random
 * token is not.)
 *
 * Bun ships argon2id built in, so there is no native module to compile:
 *
 *   const hash = await Bun.password.hash(plaintext);              // argon2id
 *   const ok   = await Bun.password.verify(plaintext, hash);
 *
 * Three things that are easy to get wrong:
 *
 *   1. USE THE ASYNC FORM. `Bun.password.hashSync` blocks the one thread
 *      for the entire cost of the hash — which you have deliberately made
 *      expensive. Under concurrent logins that is a self-inflicted outage
 *      (node-runtime-playbook.ts section 1).
 *
 *   2. THE SALT IS ALREADY IN THERE. Modern hash strings are self-
 *      describing: algorithm, parameters, salt and digest in one field
 *      (`$argon2id$v=19$m=65536,t=2,p=1$<salt>$<hash>`). You do not need a
 *      separate salt column, and you must not "help" by hashing the
 *      password before passing it in.
 *
 *   3. COST IS A PARAMETER YOU REVISIT. The stored string records the
 *      parameters used, so raising them later is safe: on a successful
 *      login, if the stored hash used weaker parameters than current
 *      policy, re-hash the (just-verified) plaintext and update the row.
 *      That is the only moment you legitimately hold the plaintext.
 *
 * IF YOU USE bcrypt INSTEAD — two traps that are not obvious and that bite
 * people on other projects constantly:
 *
 *   BCRYPT SILENTLY TRUNCATES AT 72 BYTES. Everything past byte 72 is
 *   ignored, so a 100-character passphrase is no stronger than its first
 *   72 bytes, and two different long passwords sharing a prefix both
 *   verify. Note BYTES, not characters — a Cyrillic or emoji password hits
 *   the limit in far fewer visible characters. The usual mitigation is to
 *   SHA-256 the password first and bcrypt the digest, which is fixed-length
 *   — but then you must base64 the digest, because bcrypt also stops at the
 *   first NUL byte and a raw digest can contain one. This is a good
 *   illustration of why argon2id (no length limit) is the better default:
 *   the workaround has its own footgun.
 *
 *   A NUL BYTE TRUNCATES TOO, for the same reason — the underlying C
 *   implementation is string-based.
 *
 * argon2id has neither limitation. If you are choosing today, choose it.
 */

/* ============================================================================
 * 3. COMPARING SECRETS — why `===` is a real vulnerability
 * ============================================================================
 */

/** WRONG — leaks the answer through how long it takes to say no. */
function compareNaive(a: string, b: string): boolean {
  return a === b;
}

/**
 * RIGHT — constant time with respect to the CONTENT of the inputs.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual THROWS if the lengths differ, so the length check has
  // to happen first — and that check itself leaks the length. Hashing both
  // sides to a fixed 32 bytes removes the leak entirely: every comparison
  // is now over the same number of bytes whatever was typed.
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

/*
 * WHY BOTHER. `===` on strings short-circuits at the first differing
 * character. Comparing against the real secret `"s3cret"`: a guess of
 * `"x..."` returns after 1 character, `"sx..."` after 2. That turns an
 * impossible brute force (guess the whole string) into a tractable one
 * (guess one character at a time, ~95 tries per position) — IF the
 * attacker can measure the difference.
 *
 * Be honest about how hard that is: the difference is nanoseconds, and over
 * the internet network jitter is microseconds to milliseconds, so it takes
 * an enormous number of samples per character. Against THIS gate the rate
 * limiter in section 5 (10 attempts per 15 minutes) makes it hopeless. The
 * attack is realistic on a LAN, from a neighbouring VM, or wherever
 * requests are cheap and unlimited.
 *
 * The rule stands anyway, because the fix costs one function call and
 * removes the question entirely — you never have to argue about whether
 * this particular endpoint is measurable.
 *
 * THE RULE: any comparison where one side is a secret uses a constant-time
 * compare. Passwords (though `Bun.password.verify` already does this
 * internally), session tokens, API keys, webhook signatures, the admin
 * password below.
 *
 * `compareNaive` is kept above only as the thing not to do.
 */

/* ============================================================================
 * 4. THE ADMIN GATE — what this project actually ships
 * ============================================================================
 * One password, in an env var, checked on every admin request. No user
 * table, no session store, no login page.
 */

/* --- Config: the secret is required, with no default --------------------- */

const adminEnvSchema = z.object({
  // NO `.default()`. A default on a credential is a hole: a typo'd variable
  // name would silently fall back to a known value, and every deployment
  // would share it. Required-with-no-default means a missing var is a loud
  // startup crash — node-runtime-playbook.ts section 10.
  ADMIN_PASSWORD: z.string().min(16, 'Admin password must be at least 16 characters'),
});

/*
 * The `.min(16)` is enforcement, not advice. This single password is the
 * only thing between the public internet and every customer's contact
 * details, and — unlike a user password — it is never typed by someone who
 * will forget it, so there is no usability argument for allowing a short
 * one. Generate it (`openssl rand -base64 32`), store it in a password
 * manager, put it in `.env`.
 *
 * `.env` is gitignored; `.env.example` gets the KEY with a dummy value, so
 * the next person knows the variable exists without learning its contents.
 */

declare const env: z.infer<typeof adminEnvSchema>;

/* --- The check ----------------------------------------------------------- */

/**
 * HTTP Basic: the browser sends `Authorization: Basic base64(user:pass)`.
 * Basic auth gets a bad reputation it only half deserves — the credential
 * is base64, NOT encrypted, so it is in the clear to anything that can read
 * the request. Over HTTPS that is fine; over plain HTTP it is equivalent to
 * shouting the password. HTTPS is therefore not optional here.
 *
 * What Basic genuinely buys for this case: the browser's own credential
 * prompt, no login page to build, no session store, no cookie, no CSRF
 * surface (section 8). For one operator on one screen, that is a real and
 * defensible tradeoff — not a shortcut.
 */
export function checkBasicAuth(headerValue: string | undefined): boolean {
  if (headerValue === undefined) return false;

  // The scheme name is case-insensitive (RFC 7617), and clients vary in the
  // whitespace they send.
  const [scheme, encoded] = headerValue.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'basic' || encoded === undefined) return false;

  // No try/catch: `Buffer.from(x, 'base64')` NEVER throws on malformed
  // input — measured, `'!!!notbase64***'` decodes to garbage bytes and
  // `'%%%'` to an empty string. The colon check and the constant-time
  // compare below are what reject it. A `catch` here would be dead code
  // that LOOKS like validation.
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');

  // Split on the FIRST colon only: a password may legitimately contain one.
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const password = decoded.slice(separator + 1);

  // Constant-time — section 3.
  return safeEqual(password, env.ADMIN_PASSWORD);
}

/*
 * Note what this function does NOT do: no logging of the attempt, no
 * `status(401)`, no header parsing beyond what it needs. It answers one
 * question. The HTTP concerns belong in the guard
 * (examples/backend/elysia-playbook.ts section 7), which is what makes this
 * testable without a request object.
 *
 * NEVER LOG THE ATTEMPTED PASSWORD. Not on failure, not "just while
 * debugging." A failed attempt is very often a correct password typed into
 * the wrong field, and it will sit in your log aggregator forever. Log
 * `{ event: 'admin_auth_failed', ip }` and nothing more.
 *
 * THE RESPONSE on failure is `401` with
 * `WWW-Authenticate: Basic realm="admin"` — that header is what makes the
 * browser show its prompt. Without it the browser gets a bare 401 and does
 * nothing useful.
 */

/* ============================================================================
 * 5. BRUTE FORCE — the one thing a single password genuinely needs
 * ============================================================================
 * With no account system there is no account to lock, and with one
 * credential there is exactly one thing to guess. Rate limiting is
 * therefore not a nice-to-have here; it is the other half of the gate.
 */

interface Attempt {
  count: number;
  firstAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

/**
 * Deliberately simple: a per-IP counter over a FIXED window that starts at
 * the first failure (not a sliding one — an attacker gets 10 tries, then
 * waits out whatever remains of that 15 minutes). Returns true when the
 * caller should be refused BEFORE the password is checked.
 */
export function createRateLimiter() {
  const attempts = new Map<string, Attempt>();

  return {
    isBlocked(ip: string, now = Date.now()): boolean {
      const record = attempts.get(ip);
      if (!record) return false;
      if (now - record.firstAt > WINDOW_MS) {
        attempts.delete(ip);
        return false;
      }
      return record.count >= MAX_ATTEMPTS;
    },

    recordFailure(ip: string, now = Date.now()): void {
      const record = attempts.get(ip);
      if (!record || now - record.firstAt > WINDOW_MS) {
        attempts.set(ip, { count: 1, firstAt: now });
        return;
      }
      record.count += 1;
    },

    recordSuccess(ip: string): void {
      attempts.delete(ip);
    },

    /** Without this the Map grows forever — see the caveats below. */
    sweep(now = Date.now()): void {
      for (const [ip, record] of attempts) {
        if (now - record.firstAt > WINDOW_MS) attempts.delete(ip);
      }
    },
  };
}

/*
 * THREE HONEST CAVEATS, because an in-memory limiter is a real tool with
 * real limits and pretending otherwise is how it fails silently:
 *
 *   1. IT IS PER PROCESS. Two instances behind a load balancer give an
 *      attacker 2x the budget. Fine for a single-instance deployment,
 *      which is what this is; the moment there are two, this belongs in
 *      Redis. (Same trap as node-runtime-playbook.ts section 9 — an
 *      unbounded module-level Map — which is why `sweep` exists and must
 *      actually be called on an interval.)
 *
 *   2. IT RESETS ON RESTART. A deploy clears the counters. Acceptable for
 *      a 15-minute window; not acceptable as your only defence if restarts
 *      are frequent.
 *
 *   3. THE IP MUST BE REAL. Behind a proxy, `request.ip` is the PROXY's
 *      address and every visitor shares one bucket — so the limiter either
 *      blocks everybody at once or nobody. You must read
 *      `X-Forwarded-For`, and you must only trust it when the request
 *      genuinely came through a proxy you control, because a client can
 *      simply send that header themselves and rotate it per request.
 *
 * `recordSuccess` clearing the bucket is deliberate: it keeps a legitimate
 * operator who typo'd four times from being locked out by their own
 * eventual success.
 *
 * ALSO WORTH DOING, and cheaper than all of the above: don't put the admin
 * screens at the literal `/admin`. Keep the ONE guarded prefixed instance
 * (elysia-playbook.ts section 7) — just give it a less guessable prefix.
 * Obscurity is not security, but it removes you from the automated scans
 * that make up the overwhelming majority of these attempts.
 */

/* ============================================================================
 * ============================================================================
 * SECTIONS 6-10: REFERENCE ONLY — for accounts, if they ever come back.
 * None of this describes code in apps/api today.
 * ============================================================================
 * ============================================================================
 */

/* ============================================================================
 * 6. SESSIONS vs JWT — the decision, with the real tradeoff
 * ============================================================================
 *
 * SESSION (opaque token in a cookie, state in the database):
 *   - Login creates a row; the client holds only a random id.
 *   - REVOCATION IS INSTANT — delete the row and the session is dead.
 *   - Costs one DB lookup per request (indexed primary key; this is cheap,
 *     and it is the cost people wildly overestimate).
 *
 * JWT (signed claims, no server state):
 *   - No lookup: verify the signature and trust the payload.
 *   - REVOCATION IS THE PROBLEM. A JWT is valid until it expires, full
 *     stop. You cannot log someone out. Ban an abusive user and they keep
 *     their access for the rest of the token's life.
 *   - The usual fix — a denylist of revoked tokens, checked per request —
 *     reintroduces exactly the database lookup that was the reason to pick
 *     JWT. At that point you have a session with extra steps.
 *
 * FOR AN APP LIKE THIS ONE: sessions. The lookup is one indexed read
 * against a table with a few hundred rows. JWTs earn their keep when
 * verification must happen somewhere that CANNOT reach your database —
 * several independent services, or an edge function. A single Elysia
 * process talking to one Postgres is the case where JWT's only advantage
 * does not apply.
 *
 * THE SESSION TABLE:
 *   id          uuid pk
 *   userId      uuid not null references users(id) on delete cascade
 *   tokenHash   varchar(64) not null unique     -- see section 7
 *   expiresAt   timestamp not null
 *   createdAt   timestamp not null default now()
 *   lastSeenAt  timestamp
 * with an index on `tokenHash` (the unique constraint provides it) and a
 * scheduled delete of expired rows.
 */

/* ============================================================================
 * 7. TOKENS: generate, store hashed, compare safely
 * ============================================================================
 */

/** 32 bytes from a CSPRNG. Never `Math.random()` — it is predictable. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What goes in the DATABASE is the hash, never the token itself. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/*
 * WHY HASH A TOKEN THAT IS ALREADY RANDOM — the reasoning differs from
 * passwords and is worth having straight:
 *
 * A session token is a bearer credential: whoever holds it IS the user. If
 * your sessions table is read — a SQL injection elsewhere, a leaked backup,
 * an over-broad admin query — plaintext tokens mean instant impersonation
 * of every logged-in user. Storing SHA-256 of the token makes the table
 * useless to a reader: they cannot reverse it, so they cannot present it.
 *
 * Plain SHA-256 is CORRECT here, where it was wrong in section 2, because
 * the input has 256 bits of entropy. There is nothing to guess, so slowness
 * buys nothing — and speed matters, since this runs on every request.
 *
 * `base64url` and not `hex`: same entropy, shorter string, and URL-safe so
 * it survives being put in a link (a magic-link login, say) without
 * escaping.
 *
 * Lookup is by `tokenHash`, which is indexed — so you never scan and never
 * compare token to token. The constant-time question mostly evaporates: you
 * are looking up an exact hash, not comparing secrets in application code.
 */

/* ============================================================================
 * 8. COOKIES — the four attributes, and why not localStorage
 * ============================================================================
 *
 *   Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/;
 *               Max-Age=1209600
 *
 *   HttpOnly    JavaScript cannot read it. This is the whole game: it means
 *               an XSS bug — a stray `innerHTML`, a compromised npm package
 *               — cannot exfiltrate the session. THIS IS WHY A TOKEN GOES
 *               IN AN HttpOnly COOKIE AND NOT IN localStorage. Anything in
 *               localStorage is readable by every script on the page, so an
 *               XSS is an immediate, total account takeover. There is no
 *               way to defend localStorage against that; the browser simply
 *               does not offer one.
 *
 *   Secure      HTTPS only. Without it the cookie is sent in the clear on
 *               any accidental http:// request.
 *
 *   SameSite    `Lax` — the cookie is NOT sent on cross-site POSTs, which
 *               removes most of CSRF (section 9) for free. `Strict` also
 *               withholds it when following a link from another site, which
 *               means arriving from a Telegram link looks logged out.
 *               `None` requires `Secure` and reopens CSRF; use it only when
 *               a genuine third-party context needs the cookie.
 *
 *   Max-Age     Sessions expire. A cookie with no expiry outlives the
 *               laptop it was created on. Set it, and set `expiresAt` on
 *               the row to match — the server's copy is the one that
 *               counts, since a client can keep sending an expired cookie.
 *
 * THE UNAVOIDABLE COROLLARY: the frontend cannot read the token either. So
 * "am I logged in" is answered by an endpoint (`GET /me` -> 200 or 401),
 * not by looking for a token. examples/auth/angular-auth.ts covers that
 * side; the important bit is that `credentials: 'include'` must be set on
 * requests, and CORS must name the exact origin — `Access-Control-Allow-
 * Origin: *` and credentialed requests are mutually exclusive by spec.
 */

/* ============================================================================
 * 9. CSRF — what it is, and when SameSite is enough
 * ============================================================================
 * PLAIN ENGLISH: cookies are attached by the BROWSER to requests for your
 * domain, whoever caused the request. So evil.com can contain a form that
 * POSTs to your API, and the victim's browser helpfully includes their
 * session cookie. The server sees a perfectly authenticated request the
 * user never intended to make. That is CSRF.
 *
 * It only affects COOKIE auth. A token in an `Authorization` header is
 * immune, because the browser never attaches that automatically — which is
 * the one genuine advantage of header-based tokens, and the reason the
 * Basic-auth admin gate in section 4 has no CSRF surface at all.
 *
 * DEFENCES, in the order to apply them:
 *   1. `SameSite=Lax` on the session cookie. This alone stops the classic
 *      cross-site form POST. Chromium-based browsers apply Lax when the
 *      attribute is missing; Firefox and Safari do not — so SET it
 *      explicitly, never rely on the default. For most applications this
 *      is sufficient.
 *   2. Never use GET for anything that changes state. `SameSite=Lax` still
 *      sends the cookie on top-level GET navigation, so a state-changing
 *      GET remains reachable. (It should be a POST regardless.)
 *   3. A CSRF token for genuinely sensitive actions: a random value in a
 *      non-HttpOnly cookie that the frontend must echo in a header. The
 *      attacker's site cannot read your cookie (different origin), so it
 *      cannot produce the header.
 *
 * Do not build #3 before #1 and #2 are in place — it is the expensive one
 * and it is mostly redundant now.
 */

/* ============================================================================
 * 10. AUTHORIZATION — the half that authentication doesn't cover
 * ============================================================================
 * Authentication: WHO are you. Authorization: may you do THIS, to THIS row.
 * The second is where real applications leak, and it is not a login
 * problem — every user in these examples is correctly logged in.
 */

interface Order {
  id: string;
  userId: string;
}
declare function findOrderById(id: string): Promise<Order | undefined>;
/** `WHERE id = $1 AND user_id = $2` — ownership is part of the query. */
declare function findOrderByIdForUser(id: string, userId: string): Promise<Order | undefined>;

/** WRONG — authenticated, and still a data breach. */
async function getOrderBroken(orderId: string, _currentUserId: string) {
  return await findOrderById(orderId); // any logged-in user can read ANY order
}

/** CORRECT BUT FRAGILE — fetch, then check. Safe only while nobody forgets the `if`. */
async function getOrderCheckedAfter(orderId: string, currentUserId: string) {
  const order = await findOrderById(orderId);
  if (!order || order.userId !== currentUserId) return undefined;
  return order;
}

/** RIGHT — the scope is part of the query, so there is no check to forget. */
async function getOrderSafe(orderId: string, currentUserId: string) {
  return await findOrderByIdForUser(orderId, currentUserId);
}

/*
 * This is IDOR (Insecure Direct Object Reference), and it is consistently
 * among the most common serious web vulnerabilities — because the code
 * looks complete. There IS an auth check; it answers the wrong question.
 *
 * Both correct versions return `undefined` rather than throwing
 * "forbidden", deliberately: telling an attacker "that order exists but
 * isn't yours" confirms the id is real. 404 for both cases leaks nothing.
 *
 * `getOrderCheckedAfter` is correct today and one refactor away from the
 * broken version: the check is a separate line someone can drop, reorder,
 * or forget in the NEXT function that fetches an order. THE STRUCTURAL FIX
 * makes ownership part of the WHERE clause, so the unscoped query is not
 * something you can write by accident:
 *
 *     .where(and(eq(orders.id, orderId), eq(orders.userId, currentUserId)))
 *
 * A repository method that takes `currentUserId` as a required parameter
 * (dto-and-dao.ts section 4) cannot be called without it. That is the
 * difference between a rule people follow and a rule the compiler enforces.
 *
 * CHECK ON THE SERVER, ALWAYS. Hiding a button in Angular is a UX
 * improvement, not a security control — the request is one devtools tab
 * away. Every authorization decision is made server-side, on every request,
 * with no exceptions for "internal" endpoints.
 */

/* ============================================================================
 * 11. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Building accounts before asking whether you need them        -> S1
 * - Storing a password reversibly ("encrypted")                  -> S2
 * - MD5/SHA-* as a password hash                                 -> S2
 * - `hashSync` on the request path                               -> S2
 * - A separate salt column (it's already in the hash string)     -> S2
 * - `===` on a password, token, API key or signature             -> S3
 * - A default value for a credential env var                     -> S4
 * - Logging an attempted password, even while debugging          -> S4
 * - Basic auth over plain HTTP                                   -> S4
 * - No rate limit on the one endpoint that checks the password   -> S5
 * - Trusting `X-Forwarded-For` from an unproxied request         -> S5
 * - An in-memory limiter that never sweeps (unbounded Map)       -> S5
 * - JWTs where you need to be able to log someone out            -> S6
 * - `Math.random()` for a token                                  -> S7
 * - Storing session tokens in plaintext                          -> S7
 * - A token in localStorage (XSS = total takeover)               -> S8
 * - A cookie without HttpOnly / Secure / SameSite / expiry       -> S8
 * - `Access-Control-Allow-Origin: *` with credentials            -> S8
 * - A state-changing GET                                         -> S9
 * - Fetching a row by id without scoping it to the owner         -> S10
 * - "Forbidden" where "not found" leaks less                     -> S10
 * - Relying on a hidden button as an access control              -> S10
 */

export const _referenced = {
  compareNaive,
  safeEqual,
  adminEnvSchema,
  checkBasicAuth,
  createRateLimiter,
  generateSessionToken,
  hashSessionToken,
  getOrderBroken,
  getOrderCheckedAfter,
  getOrderSafe,
};
