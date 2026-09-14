import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { z } from 'zod';
import { createProductSchema, productIdSchema, productSchema } from '@pottery/shared';
import { db } from '../db/client';
import { products } from '../db/schema';

const notFoundSchema = z.object({ message: z.string() });

export const productsRoutes = new Elysia({ prefix: '/products' })
  .get(
    '/',
    async () => {
      const rows = await db.select().from(products);
      return rows.map((row) => productSchema.parse(row));
    },
    {
      response: productSchema.array(),
    },
  )
  .get(
    '/:id',
    async ({ params, status }) => {
      const [row] = await db.select().from(products).where(eq(products.id, params.id));
      if (!row) return status(404, { message: `Product ${params.id} not found` });
      return productSchema.parse(row);
    },
    {
      params: z.object({ id: z.uuid() }),
      response: {
        200: productSchema,
        404: notFoundSchema,
      },
    },
  )
  .post(
    '/',
    async ({ body, status }) => {
      const [row] = await db
        .insert(products)
        .values({ id: productIdSchema.parse(crypto.randomUUID()), ...body })
        .returning();
      return status(201, productSchema.parse(row));
    },
    {
      body: createProductSchema,
      response: {
        201: productSchema,
      },
    },
  );
