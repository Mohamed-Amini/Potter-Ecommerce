import { integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

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
  name: text('name').notNull(),
  description: text('description').notNull(),
  material: text('material').notNull(),
  sizeLabel: text('size_label').notNull(),
  pricePence: integer('price_pence').notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  stockCount: integer('stock_count').notNull().default(0),
  images: text('images').array().notNull(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  phoneNumber: varchar('phone_number', { length: 20 }).notNull().unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  createdAt: createdAt(),
});

export const phoneVerifications = pgTable('phone_verifications', {
  id: id(),
  phoneNumber: varchar('phone_number', { length: 20 }).notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: createdAt(),
});

export const baskets = pgTable('baskets', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const basketItems = pgTable('basket_items', {
  id: id(),
  basketId: uuid('basket_id')
    .notNull()
    .references(() => baskets.id),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  quantity: integer('quantity').notNull().default(1),
  unitPricePenceAtAdd: integer('unit_price_pence_at_add').notNull(),
});

export const favourites = pgTable(
  'favourites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.productId] })],
);

export const customOrderStatus = pgEnum('custom_order_status', [
  'new',
  'quoted',
  'accepted',
  'declined',
  'completed',
]);

export const customOrderRequests = pgTable('custom_order_requests', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  categoryId: uuid('category_id').references(() => categories.id),
  description: text('description').notNull(),
  referenceImages: jsonb('reference_images').$type<string[]>(),
  budgetPence: integer('budget_pence'),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactPhone: varchar('contact_phone', { length: 20 }),
  status: customOrderStatus('status').notNull().default('new'),
  quotedPricePence: integer('quoted_price_pence'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const contactMessages = pgTable('contact_messages', {
  id: id(),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  message: text('message').notNull(),
  createdAt: createdAt(),
});
