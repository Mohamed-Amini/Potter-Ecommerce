import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
const client = postgres(process.env['DATABASE_URL']!, { max: 1 }); // ONE connection: the temp table only exists on it
await client`create temp table refcheck_keyset (id uuid primary key default gen_random_uuid(), created_at timestamptz not null)`;
// 60 rows over only 7 distinct timestamps -> heavy ties, the case keyset must survive
await client`insert into refcheck_keyset (created_at) select timestamptz '2026-09-01 10:00+00' + ((g % 7) * interval '1 minute') from generate_series(1, 60) g`;
const t = pgTable('refcheck_keyset', { id: uuid('id').primaryKey(), createdAt: timestamp('created_at', { withTimezone: true }).notNull() });
const db = drizzle(client);
const order = [desc(t.createdAt), desc(t.id)] as const;
const page1 = await db.select().from(t).orderBy(...order).limit(20);
const last = page1.at(-1)!;
const builder = await db.select().from(t).where(or(lt(t.createdAt, last.createdAt), and(eq(t.createdAt, last.createdAt), lt(t.id, last.id)))).orderBy(...order).limit(20);
const raw = await db.select().from(t).where(sql`(${t.createdAt}, ${t.id}) < (${last.createdAt.toISOString()}::timestamptz, ${last.id}::uuid)`).orderBy(...order).limit(20);
const naive = await db.select().from(t).where(lt(t.createdAt, last.createdAt)).orderBy(...order).limit(20);
const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
const overlap = (a: { id: string }[], b: { id: string }[]) => [...ids(a)].filter((x) => ids(b).has(x)).length;
const all = await db.select().from(t).orderBy(...order);
const expected = all.slice(20, 40).map((r) => r.id).join();
console.log('builder: rows', builder.length, 'overlap w/ page1', overlap(page1, builder), 'matches true page 2:', builder.map((r) => r.id).join() === expected);
console.log('raw ::timestamptz: rows', raw.length, 'overlap', overlap(page1, raw), 'matches true page 2:', raw.map((r) => r.id).join() === expected);
console.log('naive createdAt-only cursor: matches true page 2:', naive.map((r) => r.id).join() === expected, '| rows lost:', all.slice(20, 40).filter((r) => !ids(naive).has(r.id)).length);
await client.end();
