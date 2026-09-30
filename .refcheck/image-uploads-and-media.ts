/**
 * FILE & IMAGE UPLOADS — receiving bytes you did not write.
 *
 * Pottery Market sells photographed objects: `products.images` is a
 * `text[]` of URLs, and nothing in this reference set explained how a file
 * gets there. This is that file.
 *
 * Self-contained and type-checked. Verify from the Pottery repo root:
 *
 *   cp examples/backend/image-uploads-and-media.ts <pottery>/.refcheck/
 *   cd <pottery> && ./node_modules/.bin/tsc -p .refcheck/tsconfig.json
 *
 * VERIFICATION STATUS, stated up front because half of this file is
 * security advice and you should know which half was executed:
 *   MEASURED against elysia 1.4.30 + Bun 1.3.14 — multipart receiving,
 *   zod file validation, the spoofed content-type, magic-byte sniffing,
 *   size limits, filename attacks. Section 9 quotes the real output.
 *   NOT RUN HERE — image resizing (`sharp` is not a dependency of this
 *   project) and object storage. Those sections are marked and describe
 *   the shape, not measured behaviour.
 *
 * THE ONE IDEA: every other input your API takes is a value you validate.
 * An upload is a BLOB OF BYTES FROM A STRANGER that you are about to put
 * on a disk and later serve back to other people's browsers. Every rule
 * here follows from those two facts — storing it, and serving it.
 */

import { Elysia } from 'elysia';
import { z } from 'zod';
import { extname } from 'node:path';

/* ============================================================================
 * 1. WHAT MAKES AN UPLOAD DIFFERENT
 * ============================================================================
 * Four properties no other request body has:
 *
 *   1. UNBOUNDED SIZE. A JSON body is a few KB. An upload is whatever the
 *      client decided to send — a 4GB video, a hundred times, in parallel.
 *      "Never let user input decide how much memory you allocate"
 *      (node-runtime-playbook.ts section 8) is the governing rule, and here
 *      it is not a nicety.
 *
 *   2. THE METADATA IS CLIENT-CONTROLLED AND IT ALL LIES. The filename, the
 *      extension, and the `Content-Type` are values the client typed. None
 *      of them describe the bytes. Section 3 measures exactly how little
 *      they mean.
 *
 *   3. IT ENDS UP ON A FILESYSTEM. That introduces path traversal and
 *      filename collisions, which a JSON body simply cannot cause.
 *
 *   4. IT WILL BE SERVED BACK TO A BROWSER. That makes it a potential XSS
 *      vector (section 4), which is the part people miss entirely — the
 *      upload is safe sitting on disk and dangerous the moment a browser
 *      renders it.
 */

/* ============================================================================
 * 2. RECEIVING MULTIPART IN ELYSIA — measured
 * ============================================================================
 * No body parser to configure and no `multer` equivalent. A `multipart/
 * form-data` request arrives as web-standard `File` objects, and zod
 * validates them like anything else.
 */

const MAX_BYTES = 2 * 1024 * 1024; // 2MB — a generous product photo

/**
 * The FIRST line of defence: declare what you accept, in the schema.
 * A failure here returns 422 before your handler runs — measured, with the
 * custom message surfacing intact (section 9).
 */
export const uploadedImageSchema = z
  .instanceof(File)
  .refine((f) => f.size > 0, 'File is empty')
  .refine((f) => f.size <= MAX_BYTES, 'File must be 2MB or smaller');

export const uploadBodySchema = z.object({
  file: uploadedImageSchema,
  // Alt text belongs WITH the upload. Collecting it later means never.
  // See examples/frontend/semantic-html.html on why `alt` is not optional.
  alt: z.string().trim().min(1).max(200),
});

declare function storeImage(file: File, alt: string): Promise<{ url: string }>;

export const uploadRoutes = new Elysia({ prefix: '/admin/images' }).post(
  '/',
  async ({ body, status }) => {
    const { url } = await storeImage(body.file, body.alt);
    return status(201, { url });
  },
  {
    body: uploadBodySchema,
    response: { 201: z.object({ url: z.url() }) },
  },
);

/*
 * NOTE WHAT THE SCHEMA CANNOT DO, and it is the important limitation:
 * `z.instanceof(File)` and `f.size` check the ENVELOPE. They say nothing
 * about the bytes. Measured — an HTML file announced as `image/png` passes
 * this schema with a 200 (section 9). Validation of the CONTENT is a
 * separate step and it is section 3.
 *
 * SIZE LIMITS ARE LAYERED, and the schema is the innermost layer:
 *
 *   1. The reverse proxy / platform  (nginx `client_max_body_size`) —
 *      rejects before a byte reaches your process. The only layer that
 *      protects you from having to read the body at all.
 *   2. The server's own body limit — Elysia/Bun accept a `maxRequestBodySize`
 *      at the server level.
 *   3. The zod refine above — the clearest error message, but by the time
 *      it runs the bytes have already been received.
 *
 * You want all three. Relying only on #3 means a 4GB upload is fully
 * transferred before being rejected, which is a denial-of-service with
 * extra steps.
 */

/* ============================================================================
 * 3. NEVER TRUST THE DECLARED TYPE — sniff the bytes
 * ============================================================================
 * MEASURED (section 9): a file containing `<html><script>alert(1)</script>`,
 * uploaded with `type: 'image/png'` and named `pot.png`, is accepted by the
 * schema in section 2 with **status 200**. Nothing in the envelope was
 * false in a way a schema can detect — the client simply declared a type
 * and the declaration was a lie.
 *
 * Real files begin with a signature ("magic bytes"). That is what actually
 * identifies a format.
 */

const MAGIC = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
} as const;

export type SniffedType = keyof typeof MAGIC | 'image/webp';

/** Identify a file from its CONTENT. Returns null for anything unrecognised. */
export function sniffImageType(bytes: Uint8Array): SniffedType | null {
  for (const [type, sig] of Object.entries(MAGIC)) {
    if (sig.every((byte, i) => bytes[i] === byte)) return type as keyof typeof MAGIC;
  }
  // WebP is a RIFF container: "RIFF" .... "WEBP" — the format tag sits at
  // offset 8, after the 4-byte length, so a prefix check alone is not enough.
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (riff.every((b, i) => bytes[i] === b) && webp.every((b, i) => bytes[i + 8] === b)) {
    return 'image/webp';
  }
  return null;
}

/**
 * The real check. Reads only the first bytes — you do not need the whole
 * file in memory to identify it.
 */
export async function validateImageContent(file: File): Promise<SniffedType> {
  const header = await readHeader(file, 16);
  const actual = sniffImageType(header);
  if (actual === null) {
    throw new Error('That file is not a PNG, JPEG, GIF or WebP image.');
  }
  return actual;
}

/** Read only the first `n` bytes, then stop reading. */
async function readHeader(file: File, n: number): Promise<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    const { value } = await reader.read();
    return value ? value.slice(0, n) : new Uint8Array(0);
  } finally {
    // Release the stream so the rest of the upload is not pulled through.
    await reader.cancel();
  }
}

/*
 * WHY A STREAM AND NOT `file.slice(0, 16)`. The `Blob.slice()` route is the
 * obvious one and it WORKS AT RUNTIME under Bun — but it does not typecheck
 * with this project's config, which sets `"types": ["bun"]` and
 * `"lib": ["ESNext"]` with no DOM lib:
 *
 *     error TS2339: Property 'slice' does not exist on type 'File'.
 *
 * Verified: `slice` is present on the runtime prototype and Bun declares
 * `interface File extends Blob`, but the `Blob` in scope without the DOM
 * lib does not expose it. Rather than reach for `(file as Blob).slice(...)`
 * — a cast to silence a compiler that is telling the truth about the types
 * available — read one chunk from the stream. It is portable, needs no
 * cast, and expresses the intent directly.
 *
 * Either way the point stands: read a PREFIX. Calling
 * `await file.arrayBuffer()` to check a header pulls the entire file into
 * memory — for one 2MB photo that is fine, for the concurrent case it is
 * exactly the allocation you were trying to bound.
 *
 * (Measured caveat: the first chunk is whatever size the runtime hands you,
 * not the `n` you asked for — for a small file it was the whole 18 bytes.
 * So slice the result down, as above, and never assume the chunk is
 * exactly `n` or that one read reached `n` bytes. For a 16-byte magic
 * check the first chunk is always ample; a longer prefix needs a loop.)
 *
 * AN ALLOWLIST, NEVER A BLOCKLIST. `MAGIC` lists what is permitted.
 * "Reject .exe and .php" is a blocklist and it is always incomplete —
 * there is always another extension, another container, another platform.
 * Name the four formats you serve and refuse everything else.
 *
 * SNIFFING IS NOT A FULL VALIDATION. Correct magic bytes mean "this is
 * plausibly a PNG", not "this is a safe PNG". A file can carry a valid
 * header and malformed data designed to crash or exploit a decoder. The
 * strong version of this check is to DECODE the image and re-encode it
 * (section 5) — which discards anything that is not pixels.
 */

/* ============================================================================
 * 4. THE TWO FORMATS THAT ARE TRAPS
 * ============================================================================
 *
 * SVG IS A SCRIPT DOCUMENT WEARING AN IMAGE COSTUME. It is XML, and it can
 * contain `<script>`. Served from your origin with `Content-Type:
 * image/svg+xml` and opened directly, it EXECUTES — in your origin, with
 * access to your cookies. It is a stored-XSS vector that most upload
 * validators wave through because "it's an image".
 *
 * Measured: the SVG payload in section 9 is correctly REJECTED by
 * `sniffImageType` — not because SVG was special-cased, but because it has
 * no binary signature and the function is an allowlist. That is the
 * allowlist earning its keep.
 *
 * If you ever must accept SVG: sanitise it server-side (DOMPurify with an
 * SVG profile), serve it from a SEPARATE origin, and send
 * `Content-Disposition: attachment`. For a pottery shop, just don't accept
 * it — photographs are not vector art.
 *
 * DECOMPRESSION BOMBS. A ~1KB PNG can declare dimensions of 50,000 x
 * 50,000. Nothing is wrong with the file; the damage happens when a decoder
 * allocates width x height x 4 bytes — 10GB — and the process dies. The
 * size limit in section 2 does not help, because the FILE is tiny.
 *
 * The defence is a DIMENSION limit, checked before full decode. Image
 * libraries expose the header dimensions cheaply; `sharp` will also refuse
 * oversized input via `limitInputPixels`. Set a maximum (8000 x 8000 is
 * generous for product photography) and reject above it.
 */

/* ============================================================================
 * 5. PROCESSING — the pipeline, and why re-encoding is a security control
 * ============================================================================
 * NOT MEASURED HERE: `sharp` is not a dependency of this project, so the
 * code below describes the shape rather than quoting a run. Treat it as a
 * design sketch, not a verified snippet.
 *
 *   import sharp from 'sharp';
 *
 *   const pipeline = sharp(buffer, { limitInputPixels: 8000 * 8000 })
 *     .rotate()                      // apply EXIF orientation, then drop it
 *     .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
 *     .webp({ quality: 82 });
 *
 *   const full  = await pipeline.toBuffer();
 *   const thumb = await sharp(buffer).resize(400, 400, { fit: 'cover' })
 *                                    .webp({ quality: 75 }).toBuffer();
 *
 * FOUR THINGS THAT PIPELINE BUYS, only one of which is about file size:
 *
 *   RE-ENCODING SANITISES. The output is written from decoded pixels, so
 *   anything that was not pixels — an embedded script, a malformed chunk, a
 *   polyglot file that is both a GIF and a JS file — does not survive. This
 *   is a stronger guarantee than any amount of inspecting the input, and it
 *   is the main reason to process rather than store the original.
 *
 *   `.rotate()` WITH NO ARGUMENT applies the EXIF orientation tag and then
 *   strips metadata. Without it, phone photos appear sideways in the
 *   browser — the pixels are landscape and a tag says "rotate 90°", which
 *   `<img>` honours inconsistently. This is the single most common "my
 *   uploaded photo is rotated" bug.
 *
 *   STRIPPING EXIF IS A PRIVACY REQUIREMENT, NOT AN OPTIMISATION. Phone
 *   photos carry GPS COORDINATES. Publishing a product photo with its EXIF
 *   intact publishes the location of the studio — someone's home, in a
 *   one-person pottery business. sharp drops metadata by default on
 *   re-encode; that default is doing something important.
 *
 *   VARIANTS BELONG ON THE SERVER. A grid of 40 thumbnails should not be 40
 *   full-resolution images the browser scales down. Generate a thumbnail
 *   and a display size at upload time — once — rather than making every
 *   visitor download 4MB to look at a 400px square.
 *
 * DO THIS OUTSIDE THE REQUEST IF IT GETS SLOW. Image processing is CPU
 * work, and CPU work blocks the one thread (node-runtime-playbook.ts
 * section 1.2). sharp is native and releases the thread for most of its
 * work, so a single 2MB photo inline is acceptable. A batch of twenty is
 * not — accept the upload, return 202, process after.
 */

/* ============================================================================
 * 6. FILENAMES — generate them, never accept them
 * ============================================================================
 * MEASURED (section 9): `../../../etc/passwd` as a filename, joined naively
 * onto an upload directory, RESOLVES OUTSIDE IT. That is path traversal,
 * and it is a file-write primitive — the worst kind of bug.
 */

const ALLOWED_EXT = /^\.(png|jpe?g|webp|gif)$/;

/**
 * The client's filename is used for exactly one thing: a hint at the
 * extension, which is then validated against an allowlist. Everything else
 * about it is discarded.
 */
export function safeStoredName(clientName: string, sniffed: SniffedType): string {
  // Prefer the extension implied by the SNIFFED type — it is the only
  // trustworthy source. The client's extension is a fallback for formats
  // that share a signature, and it is allowlisted either way.
  const byType: Record<SniffedType, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  const fromClient = extname(clientName).toLowerCase();
  const ext = byType[sniffed] || (ALLOWED_EXT.test(fromClient) ? fromClient : '');
  return `${crypto.randomUUID()}${ext}`;
}

/*
 * A GENERATED UUID NEUTRALISES THE WHOLE CLASS AT ONCE. Measured against
 * `../../../etc/passwd`, `a/b/c.png`, a NUL-byte name (`pot.png\0.exe`),
 * a whitespace-only name and an emoji name — every one of them stores as
 * `<uuid>.<allowlisted-ext>` and none can escape the directory, collide
 * with an existing file, or carry a second extension.
 *
 * It also fixes problems that are not attacks: two customers uploading
 * `IMG_0001.jpg` no longer overwrite each other, and a filename that is
 * legal on Linux but not on Windows (`con`, `aux`, a trailing dot) cannot
 * break your dev machine.
 *
 * KEEP THE ORIGINAL NAME IN A COLUMN if you want to show it back to the
 * admin. It is data, not a path. That distinction is the whole lesson:
 * user input can be DISPLAYED safely; it must not be EXECUTED, and a
 * filesystem path is a kind of execution.
 *
 * AND IF YOU EVER DO JOIN A USER-SUPPLIED SEGMENT onto a directory, verify
 * containment afterwards rather than trusting the join:
 *
 *   const target = resolve(uploadDir, candidate);
 *   if (!target.startsWith(resolve(uploadDir) + sep)) throw new Error('bad path');
 *
 * `startsWith` on the resolved path, plus the separator — without the
 * separator, `/uploads-evil` passes a `startsWith('/uploads')` check.
 */

/* ============================================================================
 * 7. STORAGE — and the transactional hole nobody mentions
 * ============================================================================
 */

/*
 * WHERE FILES GO, in the order to consider:
 *
 *   OBJECT STORAGE (S3-compatible — including Yandex Object Storage, which
 *   is the sane choice for a Russian-hosted project). Files are not on your
 *   application server, so deploys, restarts and a second instance all stop
 *   mattering. Serve via CDN. This is the right default the moment the app
 *   runs anywhere but one box.
 *
 *   LOCAL DISK. Fine for a single self-hosted instance. Two requirements
 *   people forget: the directory must NOT be inside your deploy directory
 *   (or a deploy wipes it), and it must be in the backup —
 *   postgres-backups-and-recovery.md backs up the DATABASE, and a database
 *   full of URLs pointing at files you no longer have is not a restore.
 *
 *   THE DATABASE ITSELF (a `bytea` column). Almost always wrong. It bloats
 *   the database, makes every backup enormous, and streams badly. The one
 *   argument for it — transactional consistency — is real, and is exactly
 *   what the next paragraph is about.
 */

/*
 * THE TRANSACTIONAL HOLE. This is the architectural point of the whole
 * file, and it follows directly from dto-and-dao.ts section 5.
 *
 * A file write and a database row CANNOT be in the same transaction. The
 * filesystem has no rollback. So one of these two failures is always
 * possible:
 *
 *   Write the file, then INSERT -> if the INSERT fails, an ORPHANED FILE
 *                                  sits on disk forever.
 *   INSERT, then write the file -> if the write fails, a row points at a
 *                                  MISSING FILE and the page shows a broken
 *                                  image.
 *
 * PREFER THE FIRST. An orphaned file is invisible to users, costs a few
 * kilobytes, and can be swept up later. A broken image is on the product
 * page right now. When you must choose which way to be inconsistent, choose
 * the direction the customer cannot see.
 *
 * Concretely:
 *   1. Validate (sections 2-4).
 *   2. Process and write to storage with a generated name (sections 5-6).
 *   3. THEN, in one transaction, insert the row referencing it.
 *   4. If step 3 throws, best-effort delete the file — and do not let that
 *      cleanup throw over the original error (node-runtime-playbook.ts
 *      section 4.2: never destroy the evidence).
 *
 * AND RUN A SWEEPER. A periodic job that lists stored objects, checks each
 * against the database, and deletes anything older than a day with no row.
 * It is twenty lines and it is the difference between "orphans are
 * acceptable" and "orphans accumulate forever".
 *
 * NEVER DELETE THE FILE INSIDE THE TRANSACTION either — if the transaction
 * later rolls back, the row comes back and the file does not.
 */

/* ============================================================================
 * 8. SERVING — headers, and where NOT to serve from
 * ============================================================================
 *
 * Content-Type          the SNIFFED type, never the client's claim.
 * X-Content-Type-Options: nosniff
 *                       stops the browser second-guessing you and
 *                       rendering a "png" as HTML. Non-negotiable on
 *                       user-uploaded content.
 * Cache-Control: public, max-age=31536000, immutable
 *                       safe precisely BECAUSE the name is a UUID — the
 *                       content at that URL can never change, so it can be
 *                       cached forever. Changing a photo produces a new
 *                       UUID and a new URL. That is content-addressing, and
 *                       it is a real benefit of section 6 rather than a
 *                       side effect.
 *
 * SERVE FROM A DIFFERENT ORIGIN IF YOU CAN. A separate domain (or at
 * minimum a subdomain outside your cookie scope) means that even if
 * something slips through validation and executes, it executes somewhere
 * with no session cookie and no same-origin access to your app. Defence in
 * depth: it is the layer that saves you when layers 2-4 were wrong.
 *
 * DO NOT STREAM FILES THROUGH THE APPLICATION unless you must. A Bun
 * process forwarding bytes is a slow, expensive proxy that ties up your one
 * thread. Let nginx, the platform, or the CDN serve static files. Route
 * through the app only when access must be CHECKED per request — and note
 * that for private files a signed, expiring URL is usually better than
 * proxying.
 */

/* ============================================================================
 * 9. THE MEASUREMENTS
 * ============================================================================
 * Run against elysia 1.4.30 + Bun 1.3.14, via `app.handle()` with real
 * `FormData` — no server, no port (testing/backend-testing.ts section 4).
 *
 * --- multipart receiving, and the spoofed type ---
 *
 *   png   -> 200 {"name":"pot.png","type":"image/png","size":16}
 *   LIE   -> 200 {"name":"pot.png","type":"image/png","size":38}
 *            ^ the body was <html><script>alert(1)</script></html>
 *   svg   -> 200 {"name":"x.svg","type":"image/svg+xml","size":71}
 *
 * All three ACCEPTED by an envelope-only schema. That is the vulnerability.
 *
 * --- magic-byte sniffing of the same payloads ---
 *
 *   PNG                -> image/png
 *   JPEG               -> image/jpeg
 *   GIF                -> image/gif
 *   SVG                -> REJECTED (not a known image)
 *   HTML-claiming-png  -> REJECTED (not a known image)
 *
 * --- size limits via zod .refine() ---
 *
 *   16 bytes -> 200
 *   3 MB     -> 422 {"on":"body","property":"file",
 *                    "message":"File must be 2MB or smaller"}
 *   0 bytes  -> 422 {"message":"File is empty"}
 *
 * --- filenames a client can send ---
 *
 *   "../../../etc/passwd"   naive resolve ESCAPES the upload dir: YES
 *   "a/b/c.png"             basename -> "c.png"
 *   "pot.png\u0000.exe"     survives basename() intact
 *   "  .png", emoji names   accepted by the filesystem, useless as names
 *
 * --- THE FUNCTIONS IN THIS FILE, EXECUTED ---
 *
 * `validateImageContent` (reading a stream prefix, not the whole file):
 *
 *   real PNG            -> accepted as image/png
 *   real JPEG           -> accepted as image/jpeg
 *   real WEBP           -> accepted as image/webp     (the offset-8 check)
 *   HTML claiming PNG   -> REJECTED: not a PNG, JPEG, GIF or WebP image
 *   SVG with <script>   -> REJECTED: not a PNG, JPEG, GIF or WebP image
 *
 * `safeStoredName(name, 'image/png')` — every hostile name collapses to a
 * clean, path-free, single-extension file:
 *
 *   "pot.png"              -> de2b7d81-...-aa94b2da8d59.png
 *   "../../../etc/passwd"  -> 3708ab38-...-b7625a11f756.png
 *   "a/b/c.png"            -> 804ce21e-...-2599d739364c.png
 *   "pot.png\u0000.exe"    -> 51c57d77-...-f6fa3c6ad162.png
 *   "shell.php.png"        -> 0e884776-...-5737fd718058.png
 *
 * Note the last one especially: the double extension that defeats naive
 * "just check it ends in .png" validation is simply gone, because the
 * stored name is generated rather than derived.
 *
 * `uploadBodySchema` end to end: a valid file + alt parses; a missing
 * `alt` fails with "expected string, received undefined".
 */

/* ============================================================================
 * 10. THE DON'T-DO LIST
 * ============================================================================
 *
 * - Trusting `file.type` or the extension                         -> S3
 * - A blocklist of bad extensions instead of an allowlist         -> S3
 * - `await file.arrayBuffer()` just to read a header              -> S3
 * - Accepting SVG without sanitising and isolating it             -> S4
 * - No dimension cap (a 1KB file can demand 10GB to decode)       -> S4
 * - Serving the original bytes instead of re-encoded output       -> S5
 * - Publishing photos with EXIF GPS intact                        -> S5
 * - Full-size images where a thumbnail is displayed               -> S5
 * - Heavy image processing inline in the request                  -> S5
 * - Using the client's filename as a path                         -> S6
 * - `startsWith(dir)` without the trailing separator              -> S6
 * - Only enforcing size in the schema (no proxy/server limit)     -> S2
 * - Assuming file + row can be written atomically                 -> S7
 * - Writing the row before the file (visible broken images)       -> S7
 * - An uploads directory inside the deploy dir, or out of backup  -> S7
 * - Deleting a file inside a transaction that may roll back       -> S7
 * - No orphan sweeper                                             -> S7
 * - Serving uploads without `X-Content-Type-Options: nosniff`     -> S8
 * - Serving user content from your app's cookie origin            -> S8
 * - Proxying static files through the application                 -> S8
 */

export const _referenced = {
  uploadedImageSchema,
  uploadBodySchema,
  uploadRoutes,
  sniffImageType,
  validateImageContent,
  safeStoredName,
};
