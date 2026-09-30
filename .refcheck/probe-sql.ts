import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gte, sql } from 'drizzle-orm';
import { integer, pgTable, uuid } from 'drizzle-orm/pg-core';
const products = pgTable('products', { id: uuid('id').primaryKey(), stockCount: integer('stock_count').notNull() });
const db = drizzle(postgres('postgres://nobody@127.0.0.1:1/none')); // never connects: toSQL() does not execute
const q = db.update(products).set({ stockCount: sql`${products.stockCount} - ${2}` }).where(and(eq(products.id, 'x'), gte(products.stockCount, 2))).returning().toSQL();
console.log(q.sql, q.params);
