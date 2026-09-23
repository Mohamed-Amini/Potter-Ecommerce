import { integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at').notNull().defaultNow();

export const categories = pgTable('categories', {
  id: id(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  name: text('name').notNull(),
});

export const products = pgTable('products', {
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
});

export const contactMethod = pgEnum('contact_method', ['telegram', 'phone', 'email']);

export const orderStatus = pgEnum('order_status', [
  'confirmed',
  'shipped',
  'completed',
  'cancelled',
]);

export const orderRequests = pgTable('order_requests', {
  id: id(),
  referenceNumber: integer('reference_number').generatedAlwaysAsIdentity(),
  customerName: varchar('customer_name', { length: 100 }).notNull(),
  contactMethod: contactMethod('contact_method').notNull(),
  contactValue: varchar('contact_value', { length: 254 }).notNull(),
  note: text('note'),
  itemsTotalMinor: integer('items_total_minor').notNull(),
  agreedTotalMinor: integer('agreed_total_minor'),
  status: orderStatus('status').notNull().default('confirmed'),
  contactedAt: timestamp('contacted_at'),
  confirmedAt: timestamp('confirmed_at'),
  completedAt: timestamp('completed_at'),
  cancelledAt: timestamp('cancelled_at'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const orderRequestItems = pgTable('order_request_items', {
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
});

export const contactMessages = pgTable('contact_messages', {
  id: id(),
  name: text('name').notNull(),
  email: varchar('email', { length: 254 }).notNull(),
  message: text('message').notNull(),
  createdAt: createdAt(),
});
