import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { z } from 'zod';
import {
  apiErrorSchema,
  createProductSchema,
  editProductSchema,
  productIdSchema,
  productSchema,
} from '@pottery/shared';
import { db } from '../db/client';
import { products } from '../db/schema';
import { NotFoundError } from '../errors';


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
      if (!row) return status(404, {code: 'NOT_FOUND' , message: `Product ${params.id} not found` });
      return productSchema.parse(row);
    },
    {
      params: z.object({ id: z.uuid() }),
      response: {
        200: productSchema,
        404: apiErrorSchema,
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
  )
  .patch(
    '/:id',
    async ({ params, body, status }) => {
      if (Object.keys(body).length === 0) {
        return status(400, { code: 'BAD_REQUEST' , message: 'Send at least one field to change.' });
      }
      const [row] = await db
        .update(products)
        .set(body)
        .where(eq(products.id, params.id))
        .returning();

      if (!row) throw new NotFoundError('Product', params.id);
      return status(200, productSchema.parse(row));
    },
    {
      body: editProductSchema,
      params: z.object({ id: z.uuid() }),
      response: {
        200: productSchema,
        400: apiErrorSchema,
        404: apiErrorSchema,
        409: apiErrorSchema,
      },
    },
  ).delete(
    '/:id',
    async ({ params, status }) => {
      const [row] = await db.delete(products).where(eq(products.id, params.id)).returning();
      if (!row) throw new NotFoundError('Product', params.id);
      return status(204, undefined);
    },
    {
      params: z.object({ id: z.uuid() }),
      response: {
        204: z.undefined(),
        404: apiErrorSchema,
        409: apiErrorSchema,
      },
    },
  );


