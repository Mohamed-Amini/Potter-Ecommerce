/**
 * ZOD (v4), END TO END — the validation library shared by both halves of
 * the stack (packages/shared/src/schemas/*.schema.ts, imported by apps/api
 * AND apps/web through @pottery/shared).
 *
 * Standalone, type-checked module — verify with:
 *   npx tsc --strict --noEmit --target ES2022 --module ESNext \
 *       --moduleResolution bundler --skipLibCheck examples/validation/zod-patterns.ts
 *
 * ...or, to check it against the version a real project pins, copy it into
 * that repo and use its own config (this file is verified against the
 * Pottery monorepo's zod 4.6.4 that way).
 *
 * API NOTE — READ THIS IF YOU LEARNED ZOD FROM AN OLDER TUTORIAL. Sections
 * 1-11 were originally written against zod 3's string-format API and have
 * been migrated. The formats moved to TOP-LEVEL functions in v4:
 *
 *     v3 (deprecated)          v4 (use this)
 *     z.string().uuid()        z.uuid()
 *     z.string().email()       z.email()
 *     z.string().url()         z.url()
 *     z.string().datetime()    z.iso.datetime()
 *
 * The old forms still run in 4.6 but are deprecated and warn. They are not
 * merely renamed — `z.email()` is a distinct schema type, which is why it
 * composes with `.pipe()` differently (section 5). Every example below uses
 * the v4 spelling, as does packages/shared.
 *
 * The one idea threading through this whole file: a zod schema is not
 * "just validation" — it's the SINGLE SOURCE OF TRUTH for a shape. You
 * write the schema once; the TypeScript type (`z.infer`), the runtime
 * check, and the user-facing error messages all come FROM that one
 * definition. The moment you find yourself writing a TypeScript
 * `interface` next to a schema that describes the same shape, one of them
 * is redundant — let the schema generate the type, never hand-maintain both.
 */

import { z } from 'zod';

/* ============================================================================
 * 1. .parse() vs .safeParse() — pick based on WHERE you are, not habit
 * ============================================================================
 * PLAIN ENGLISH FIRST: a zod schema is a shape-checker you can actually run.
 * `.parse(data)` checks `data` against the schema and either hands back the
 * validated value or THROWS if it doesn't match. `.safeParse(data)` checks
 * the same thing but NEVER throws — it hands back an envelope (`{ success:
 * true, data }` or `{ success: false, error }`), exactly the `Result<T, E>`
 * shape from generics-deep-dive.ts section 4, just built into the library:
 */

const tinySchema = z.object({ age: z.number() });
try {
  tinySchema.parse({ age: 'not a number' }); // throws a ZodError immediately
} catch (e) {
  console.log('parse() threw:', e instanceof Error ? e.message : e);
}
const safeResult = tinySchema.safeParse({ age: 'not a number' });
if (!safeResult.success) {
  console.log('safeParse() instead just told us:', safeResult.error.issues[0]?.message); // no throw, no try/catch needed
}

/* .parse() THROWS a ZodError on invalid input. .safeParse() never throws —
 * it returns a discriminated union you narrow explicitly (the exact
 * Result<T, E> shape from generics-deep-dive.ts section 4, which is not a
 * coincidence: this is that pattern, built into the library).
 *
 * Use .parse() where invalid data means something is genuinely broken
 * upstream and a thrown exception is the right reaction (an HTTP response
 * body that already passed the API's own validation, so a mismatch here
 * means the two sides of the contract have drifted). Use .safeParse()
 * anywhere invalid input is an EXPECTED possibility you need to handle
 * gracefully — a form submission, a query param, anything a user typed.
 */

const bookingSchema = z.object({
  id: z.string(),
  slotStart: z.string(),
  status: z.enum(['pending', 'confirmed', 'cancelled']),
});

function parseTrustedApiResponse(raw: unknown) {
  return bookingSchema.parse(raw); // throws — a malformed response here is a contract violation, not a user mistake
}

function parseUserSubmittedForm(raw: unknown) {
  const result = bookingSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false as const, errors: result.error };
  }
  return { ok: true as const, booking: result.data };
}

/* ============================================================================
 * 2. z.infer — the type IS the schema, never hand-duplicated
 * ============================================================================
 */

type Booking = z.infer<typeof bookingSchema>; // { id: string; slotStart: string; status: 'pending' | 'confirmed' | 'cancelled' }
// Change a field in bookingSchema and Booking updates everywhere it's used,
// automatically, at compile time — there is no second definition that can
// silently drift out of sync with the first.

/* ============================================================================
 * 3. SCHEMA COMPOSITION — building new schemas FROM existing ones
 * ============================================================================
 * These four operations are how you avoid re-declaring overlapping shapes
 * by hand every time a related-but-different DTO shows up (a create
 * payload that's missing server-generated fields, a patch payload where
 * everything is optional, and so on).
 */

// .omit() — the "create" DTO doesn't include a server-generated id:
const createBookingSchema = bookingSchema.omit({ id: true });
type CreateBookingPayload = z.infer<typeof createBookingSchema>; // { slotStart: string; status: '...' } — no id

// .partial() — a PATCH payload where every field becomes optional, derived
// from the SAME base schema rather than redefined with `?` on every field:
const patchBookingSchema = bookingSchema.partial();
type BookingPatch = z.infer<typeof patchBookingSchema>; // every field now `T | undefined`

// .extend() — add fields on top of a base shape (a server-side "with
// metadata" variant, say):
const bookingWithAuditSchema = bookingSchema.extend({
  createdAt: z.string(),
  createdBy: z.string(),
});

// .pick() — the inverse of omit, when you want an EXPLICIT allowlist
// instead of an exclude-list (safer when a schema might grow new fields
// later — pick doesn't silently expose them, omit does):
const bookingSummarySchema = bookingSchema.pick({ id: true, status: true });

/* ============================================================================
 * 4. REFINEMENTS — validation that can't be expressed by a type alone
 * ============================================================================
 * `.refine()` adds a predicate zod can't derive from the shape itself —
 * cross-field rules, business logic, anything that needs the ACTUAL VALUE,
 * not just its shape. This is exactly the kind of check TypeScript's type
 * system alone cannot express (a type can say "two strings," never "these
 * two strings, compared, must satisfy X").
 */

const dateRangeSchema = z
  .object({
    start: z.string(),
    end: z.string(),
  })
  .refine((data) => new Date(data.start) < new Date(data.end), {
    message: 'End date must be after start date',
    path: ['end'], // attaches the error to the `end` field specifically, so a form can show it under the right input
  });

// .superRefine() — the escape hatch for MULTIPLE independent checks that
// each need their own message/path, which a single .refine() can't express
// (a single .refine() has exactly one message for its one boolean result):
const registrationSchema = z
  .object({ email: z.email(), password: z.string(), confirmPassword: z.string() })
  .superRefine((data, ctx) => {
    if (data.password.length < 8) {
      ctx.addIssue({ code: 'custom', message: 'Password must be at least 8 characters', path: ['password'] });
    }
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({ code: 'custom', message: 'Passwords do not match', path: ['confirmPassword'] });
    }
  });

/* ============================================================================
 * 5. TRANSFORMS — validate AND reshape in one step
 * ============================================================================
 * PLAIN ENGLISH FIRST: `.transform()` is a `.map()` for a schema — it runs
 * AFTER the input already passed validation, and whatever it returns
 * becomes the new OUTPUT type. Smallest version — a schema that accepts a
 * string but hands back its length:
 */

const stringToLength = z.string().transform((value) => value.length);
const lengthResult = stringToLength.parse('hello'); // 5 — a number, even though the INPUT was a string
type LengthOutput = z.infer<typeof stringToLength>; // number — z.infer always reflects the OUTPUT type, not the input

/* The real version below needs to be able to say "actually, this input
 * failed validation" from INSIDE the transform itself (a string that looks
 * like a date but doesn't actually parse into one) — that's what the
 * second `ctx` argument and `z.NEVER` are for. `.transform()` runs after
 * validation succeeds and changes the OUTPUT type — this is how a schema
 * can accept a wire-format string and hand back a real, richer domain
 * value, collapsing what would otherwise be a separate "parse, then map"
 * step into one.
 */

const isoDateStringToDate = z.string().transform((value, ctx) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'Invalid ISO date string' });
    return z.NEVER; // signals "validation actually failed" from inside a transform — required so a bad date doesn't silently become an Invalid Date downstream
  }
  return date;
});
type ParsedFromDateString = z.infer<typeof isoDateStringToDate>; // Date — the OUTPUT type, not string

// z.coerce — a narrower, purpose-built transform for the extremely common
// "this came from a query string / form field as text, but it's really a
// number/boolean/date" case:
const paginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().default(1), // "2" (string, from a URL) -> 2 (number), with validation still applied AFTER coercion
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/* ============================================================================
 * 6. DISCRIMINATED UNIONS — the SAME pattern as
 *    typescript-power-patterns.ts section 13, enforced at the data boundary
 * ============================================================================
 * A TypeScript discriminated union describes the SHAPE at compile time; a
 * zod discriminated union VALIDATES that the runtime data actually matches
 * one of the variants — and `z.infer` on it produces exactly the TS union
 * you'd have hand-written, so the two never drift apart.
 */

const bookingStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('confirmed'), confirmedAt: z.string() }),
  z.object({ status: z.literal('cancelled'), reason: z.string() }),
]);
type BookingState = z.infer<typeof bookingStateSchema>; // identical shape to typescript-power-patterns.ts section 13's hand-written BookingState

/* ============================================================================
 * 7. BRANDED TYPES — zod's native version of generics-deep-dive.ts section 10
 * ============================================================================
 * PLAIN ENGLISH FIRST: same idea as the hand-rolled `Brand<T, B>` from
 * generics-deep-dive.ts section 10 — stamp an invisible compile-time
 * sticker on a base type so two things that are identical at runtime (both
 * just strings) become distinct types to the compiler — except here zod
 * validates the SHAPE and stamps the brand in the exact same `.parse()`
 * call, instead of a separate manual cast afterward.
 *
 * `.brand<'X'>()` produces the SAME nominal-typing effect as the hand-rolled
 * `Brand<T, B>` generic from file 1 — a UserId and a BookingId are both
 * strings at runtime but distinct, non-interchangeable types at compile
 * time — except here it's validated at the boundary in the same breath as
 * the shape check, not bolted on afterward with a manual cast.
 */

const userIdSchema = z.uuid().brand<'UserId'>();
const bookingIdSchema = z.uuid().brand<'BookingId'>();
type UserId = z.infer<typeof userIdSchema>;
type BookingId = z.infer<typeof bookingIdSchema>;

declare function cancelBooking(id: BookingId): void;
declare const parsedUserId: UserId;
// cancelBooking(parsedUserId); // compile error — same protection as file 1's Brand<T,B>, now enforced right where the ID is first parsed off the wire

/* ============================================================================
 * 8. .optional() vs .nullable() vs .default() — a genuinely common confusion
 * ============================================================================
 * These three solve THREE DIFFERENT problems and are not interchangeable:
 *   .optional()  -> the KEY may be absent entirely from the object (`T | undefined`)
 *   .nullable()  -> the key is present, but its VALUE may explicitly be `null` (`T | null`)
 *   .default(v)  -> if the key is absent/undefined, SUBSTITUTE v — the
 *                   parsed OUTPUT type drops the `| undefined` entirely
 * A field coming from a SQL column that allows NULL is `.nullable()`, not
 * `.optional()` — the key is always present in the JSON, its value is
 * sometimes `null`. A field a client is allowed to omit is `.optional()`.
 * A field you want to always have a concrete value for downstream, even
 * when the caller didn't provide one, is `.default()`.
 */

const profileSchema = z.object({
  displayName: z.string(),
  bio: z.string().nullable(), // always present in the DB row; NULL when the user hasn't written one
  avatarUrl: z.string().optional(), // the API may simply not include this key yet for older records
  locale: z.string().default('en'), // callers can omit it; the PARSED value is always a string, never undefined
});
type Profile = z.infer<typeof profileSchema>;
// Profile['bio'] -> string | null
// Profile['avatarUrl'] -> string | undefined
// Profile['locale'] -> string (NOT string | undefined — .default() removes the undefined branch from the OUTPUT type)

/* ============================================================================
 * 9. FORMATTING ERRORS FOR A UI — z.flattenError / z.treeifyError
 * ============================================================================
 * A failed .safeParse() gives you a ZodError full of low-level issue
 * objects — exactly what a REST error response wants, but too much detail
 * to hand a form directly. Flatten it down to "one message per field" for
 * binding straight into your reactive form's error state.
 */

function toFieldErrors(fieldErrors: Record<string, string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    // Read the element ONCE into a local and narrow that. `if
    // (messages?.length) result[field] = messages[0]` looks equivalent and
    // does not compile under `noUncheckedIndexedAccess` — checking
    // `.length` tells the compiler nothing about `[0]`, which is still
    // `string | undefined`. Verified: this is the shape that passes under
    // the flag, and the flag is on in this stack's tsconfig.base.json.
    const first = messages?.[0];
    if (first !== undefined) result[field] = first; // first message per field is usually enough for inline form UI
  }
  return result;
}

function handleSubmit(raw: unknown) {
  const result = registrationSchema.safeParse(raw);
  if (!result.success) {
    // `z.flattenError(err)`, not `err.flatten()` — the method form is
    // @deprecated in zod 4.6 (same v3 -> v4 move as the string formats in
    // the header), and it would be the only deprecated call in this file.
    return { fieldErrors: toFieldErrors(z.flattenError(result.error).fieldErrors) }; // e.g. { password: 'Password must be at least 8 characters' }
  }
  return { data: result.data };
}

/* ============================================================================
 * 10. VALIDATING ENVIRONMENT/CONFIG AT STARTUP
 * ============================================================================
 * The single highest-value zod usage that has nothing to do with HTTP:
 * parse `process.env` ONCE, at boot, through a schema — a missing or
 * malformed environment variable then fails LOUDLY at startup with a clear
 * message, instead of surfacing as a mysterious `undefined` deep inside
 * request-handling code three weeks later. This is the exact shape of
 * what apps/api/src/config/env.ts is for.
 */

const envSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

function loadEnv(raw: Record<string, string | undefined>) {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Fail fast, with every missing/invalid var listed at once — not one
    // cryptic "Cannot read property of undefined" per var, discovered one
    // deploy at a time.
    throw new Error(`Invalid environment configuration:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return result.data; // fully typed, every consumer downstream gets real types instead of `process.env.PORT` being `string | undefined`
}

/* ============================================================================
 * 11. ASYNC REFINEMENT — validation that needs to await something
 * ============================================================================
 * PLAIN ENGLISH FIRST: every check so far ran synchronously and instantly.
 * Some checks genuinely can't — "is this email already registered" needs a
 * database round-trip, which takes time. `.refine()` can accept an ASYNC
 * predicate for exactly this, but the schema itself is still just a
 * description — you now MUST call `.parseAsync()`/`.safeParseAsync()` and
 * `await` it, or zod has no chance to wait for that database check to finish.
 *
 * A predicate that needs to hit the database (checking an email isn't
 * already taken, say) can't be a plain `.refine()` — it needs
 * `.parseAsync()`/`.safeParseAsync()` to actually await it. Using the sync
 * `.parse()` — or even `.safeParse()` — against a schema with an async
 * refinement THROWS: "Encountered Promise during synchronous parse. Use
 * .parseAsync() instead." (measured, zod 4.6.4). Loud, at least — but only
 * at RUNTIME, only on the code path that reaches that schema, and
 * `safeParse` throwing surprises everyone who reads "safe" as "never
 * throws". Nothing at compile time tells you a schema went async.
 */

declare function emailExists(email: string): Promise<boolean>;

const uniqueEmailSchema = z.email().refine(async (email) => !(await emailExists(email)), {
  message: 'Email is already registered',
});

async function validateNewEmail(raw: unknown) {
  return uniqueEmailSchema.safeParseAsync(raw); // MUST be the async variant — see the warning above
}

/* ============================================================================
 * ============================================================================
 * PART TWO — ZOD ON THE BACKEND
 * ============================================================================
 * Sections 1-11 are library mechanics and apply anywhere. The rest of this
 * file is about the thing that makes zod worth its weight in a monorepo:
 * ONE schema, imported by the server that enforces it and the client that
 * obeys it. See examples/backend/ for how these land in routes and
 * repositories.
 * ============================================================================
 */

/* ============================================================================
 * 12. THE SHARED-PACKAGE CONTRACT — why the schema lives in neither app
 * ============================================================================
 * `packages/shared/src/schemas/` is imported by BOTH `apps/api` and
 * `apps/web`. That single fact is what removes an entire category of bug:
 * the frontend cannot disagree with the backend about a shape, because
 * there is only one shape and both sides import the same object.
 *
 * Concretely, the payoff is that a contract change is a COMPILE ERROR in
 * the frontend rather than a runtime surprise in a customer's browser.
 * Rename `priceCents` to `priceMinor` in the shared schema and every
 * Angular template that read the old field stops building. That is
 * stronger than API versioning (api-architecture.ts section 7), and it is
 * the reason that package exists.
 *
 * THE RULE THAT KEEPS IT WORKING — and it is easy to break by accident:
 * `packages/shared` must stay RUNTIME-AGNOSTIC. zod schemas and pure
 * functions only. No `Bun.*`, no `node:crypto`, no `fs`, no
 * `process.env`, no Angular imports. The moment one of those appears, the
 * package stops being importable by a browser bundle or by a Jest test
 * running under Node, and the contract quietly splits back into two.
 *
 * WHAT BELONGS THERE:   shapes, formats, branded ids, transforms that are
 *                       pure (normalising a Telegram handle), enums.
 * WHAT DOES NOT:        anything that reads config, touches a database,
 *                       or needs a runtime API.
 */

/* ============================================================================
 * 13. PARSING AT EVERY BOUNDARY — and there are four of them
 * ============================================================================
 * A "boundary" is anywhere data arrives that TypeScript cannot vouch for.
 * At each one, `unknown` becomes a real type only by parsing. A cast just
 * asserts and moves the failure later, somewhere less debuggable.
 *
 *   1. THE REQUEST (server).   Elysia validates `body`/`params`/`query`
 *      against the schema before your handler runs, so a malformed request
 *      never reaches your code. This is why handlers in apps/api have no
 *      defensive checks at the top — the schema made those states
 *      unreachable. (elysia-playbook.ts section 2.)
 *
 *   2. THE DATABASE ROW (server).  Less obvious, and the one people skip.
 *      A row is `unknown`-ish in practice: the DB's `currency` is
 *      `varchar(6)`, so its TS type is `string`, while the DTO says
 *      `z.literal('RUB')`. Something must bridge that, and
 *      `productSchema.parse(row)` bridges it by CHECKING. `as Product`
 *      bridges it by lying. (dto-and-dao.ts section 3.)
 *
 *   3. THE RESPONSE (server).  `response: { 200: productSchema }` validates
 *      what you RETURN. It catches a handler that forgot a field, and —
 *      because zod strips unknown keys — it stops a database column leaking
 *      into a public response even if the mapper was sloppy.
 *
 *   4. THE RESPONSE (client).  The frontend parses what it receives. Belt
 *      and braces: it catches the deploy where the API is one version ahead
 *      of the app, and it turns "undefined is not a function" three
 *      components deep into one clear error at the fetch.
 *
 * THE COST, stated honestly: parsing is not free, and parsing a 5,000-row
 * list on both sides is measurable. Boundaries 1 and 3 are non-negotiable
 * (correctness and data leakage). Boundary 4 is worth it in development and
 * usually worth keeping in production. Boundary 2 is the one to relax first
 * if a hot list endpoint shows up in a profile — a partial `select()` of
 * known columns is already a strong guarantee (drizzle-playbook.ts 5.2).
 */

/* ============================================================================
 * 14. THE INPUT/OUTPUT TYPE SPLIT — the sharpest edge in this file
 * ============================================================================
 * A schema with `.transform()`, `.default()` or `.coerce` has TWO types,
 * and conflating them produces errors that read like nonsense.
 */

const orderNoteSchema = z.object({
  note: z.string().trim().max(1000).default(''),
  quantity: z.coerce.number().int().positive(),
});

type OrderNoteInput = z.input<typeof orderNoteSchema>; // what you may PASS IN
type OrderNoteOutput = z.output<typeof orderNoteSchema>; // what comes OUT

/*
 *   OrderNoteInput   { note?: string | undefined; quantity: unknown }
 *   OrderNoteOutput  { note: string;              quantity: number }
 *
 * `z.infer<T>` is an alias for `z.output<T>` — the OUTPUT side. That is the
 * right default (it is what your code handles after parsing), and it is
 * exactly why a function typed `(data: z.infer<typeof s>) => ...` cannot be
 * handed raw form values: the raw values are the INPUT type.
 *
 * WHERE THIS BITES IN PRACTICE:
 *   - A server function takes `z.infer<...>` (output) but a caller passes
 *     unparsed input. Fix: parse first, or type the parameter `z.input<>`.
 *   - `telegramHandleSchema` in packages/shared has input `string` and
 *     output `string`, so it looks exempt — it isn't. Its transform means a
 *     value that has NOT been parsed is not interchangeable with one that
 *     has, even though both are `string`. This is precisely what `.brand()`
 *     makes visible to the compiler (section 7).
 *   - Angular reactive forms hold INPUT-shaped values. The form's type and
 *     the API payload's type are genuinely different, and pretending
 *     otherwise is where `as any` creeps in.
 *
 * `.coerce` DESERVES ITS OWN WARNING. `z.coerce.number()` calls `Number()`
 * first, and `Number()` is permissive in ways you will not expect:
 *     ''        -> 0        (an empty form field becomes zero, not an error)
 *     '  12  '  -> 12
 *     []        -> 0
 *     null      -> 0
 *     true      -> 1
 * So `z.coerce.number().int().positive()` on `''` fails with "must be
 * positive" rather than "required", and on `null` does the same — a
 * confusing message for a missing field.
 *
 * USE `.coerce` WHERE EVERYTHING GENUINELY ARRIVES AS A STRING and there is
 * no other option: `process.env` (PORT is always a string — env.ts is
 * correct to use it) and URL query params. DO NOT use it on a JSON request
 * body, where a number is already a number and coercion only hides a client
 * bug. `z.number()` there will tell you the truth.
 */

/* ============================================================================
 * 15. SHAPING ERRORS FOR AN API RESPONSE
 * ============================================================================
 * Section 9 formatted errors for a FORM. A server needs the same data in a
 * different shape — one that survives JSON and matches the error contract
 * in api-architecture.ts section 4.
 */

/** One entry of the contract's `issues` array (api-architecture.ts section 4). */
interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

/** Flattens a ZodError into a JSON-safe list a client can map onto inputs. */
function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    // `issue.path` is an array of string | number (object keys and array
    // indices). Joining with '.' gives 'items.0.quantity', which an Angular
    // form can resolve directly. An empty path means the error is about the
    // whole object (a cross-field .refine()) — call that what it is.
    path: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}

/*
 * TWO THINGS NOT TO DO HERE:
 *
 *   DON'T `JSON.stringify(error)` INTO A RESPONSE. Measured on zod 4.6.4,
 *   issues do NOT carry the received value by default (keys: origin, code,
 *   path, message, plus the check's own params) — but that is an opt-in
 *   away (`reportInput`), and the dump is still developer detail, not a
 *   contract. The echo risk is real one layer up: ELYSIA'S default 422
 *   body carries `found` — the ENTIRE request body, echoed back (measured,
 *   1.4.30). On a contact form that is the customer's phone number in a
 *   response and every proxy log. elysia-playbook.ts section 6 replaces it
 *   with `{ code, message, issues: [{ path, message }] }` — the shape
 *   `toFieldIssues` below produces.
 *
 *   DON'T RELY ON zod's DEFAULT MESSAGES AS USER-FACING COPY. "Invalid
 *   input" is not something to show a customer, and the audience here reads
 *   Russian. Either supply the message at the schema (as
 *   `phoneNumberSchema` does: 'Enter a Russian number, e.g. +7 916
 *   123-45-67') or — better for anything localised — have the client map
 *   `field` + a stable `code` to its own copy. Same reasoning as branching
 *   on `code` rather than `message` in api-architecture.ts section 4.
 *
 * `z.treeifyError(error)` (v4) is the nested equivalent and is the nicer
 * fit when the payload itself is nested — an order with an `items` array
 * where line 3 is invalid.
 */

/* ============================================================================
 * 16. THE BACKEND DON'T-DO LIST
 * ============================================================================
 *
 * - `z.string().uuid()/.email()/.url()` (deprecated v3 spelling)  -> header
 * - Anything runtime-specific in `packages/shared`                -> S12
 * - A hand-written `interface` beside a schema of the same shape  -> S2
 * - `as Product` where `productSchema.parse(row)` belongs         -> S13
 * - A route with no `response` schema                             -> S13
 * - Assuming `z.infer` describes what you may pass IN             -> S14
 * - `.coerce.number()` on a JSON body                             -> S14
 * - Treating an empty string as a missing value under `.coerce`   -> S14
 * - Serialising a raw ZodError into a response                    -> S15
 * - Showing zod's default messages to a customer                  -> S15
 * - `.strict()` on a RESPONSE schema (breaks on any API addition) -> api-architecture.ts S7
 */

declare const _partTwo: {
  orderNoteSchema: typeof orderNoteSchema;
  toFieldIssues: typeof toFieldIssues;
  a: OrderNoteInput;
  b: OrderNoteOutput;
};

/* ============================================================================
 * TAKEAWAYS
 * ============================================================================
 * - One schema is the truth for a shape; derive the TypeScript type with
 *   `z.infer`, never hand-write a matching `interface` alongside it.
 * - `.parse()` where a mismatch means the system is broken; `.safeParse()`
 *   wherever invalid input is an expected, handleable case (forms, params).
 * - Build related DTOs FROM a base schema (`.omit`/`.pick`/`.partial`/`.extend`)
 *   instead of redeclaring overlapping shapes by hand.
 * - `.optional()`, `.nullable()`, and `.default()` solve three different
 *   problems — pick based on what the DATA actually does, not by habit.
 * - Parse `process.env` through a schema once at startup — it's the
 *   highest-value zod usage that has nothing to do with an HTTP request.
 * - Put the schema in a package BOTH apps import. That is what turns a
 *   contract change into a compile error instead of a production bug.
 * - Parse at every boundary — request, row, response. A cast asserts; a
 *   parse verifies, and only one of those catches the drift.
 * - A schema with a transform has an INPUT type and an OUTPUT type.
 *   `z.infer` is the output. Most confusing zod errors are that one fact.
 */
