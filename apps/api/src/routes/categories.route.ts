import { Elysia } from 'elysia';
import { categoryIdSchema, categorySchema, createCategorySchema } from '@pottery/shared';
import { db } from '../db/client';
import { categories } from '../db/schema';

export const categoriesRoutes = new Elysia({ prefix: '/categories' })
  .get('/', async () => {
    const rows = await db.select().from(categories);
    return rows.map((row) => categorySchema.parse(row));
  }, {
    response: categorySchema.array(),
  })
  .post(
    '/',
    async ({ body, status }) => {
      const [row] = await db
        .insert(categories)
        .values({ id: categoryIdSchema.parse(crypto.randomUUID()), ...body })
        .returning();
      return status(201, categorySchema.parse(row));
    },
    {
      body: createCategorySchema,
      response: {
        201: categorySchema,
      },
    },
  );
