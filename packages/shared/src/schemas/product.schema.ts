import { z } from 'zod';

export const productIdSchema = z.uuid().brand<'ProductId'>();
export type ProductId = z.infer<typeof productIdSchema>;

export const categoryIdSchema = z.uuid().brand<'CategoryId'>();
export type CategoryId = z.infer<typeof categoryIdSchema>;

export const productSchema = z.object({
  id: productIdSchema,
  categoryId: categoryIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  material: z.string().min(1),
  sizeLabel: z.string().min(1),
  pricePence: z.number().int().nonnegative(),
  currency: z.literal('RUB'),
  stockCount: z.number().int().nonnegative(),
  images: z.array(z.url()).min(1),
});
export type Product = z.infer<typeof productSchema>;

// Server DTOs derive from the base schema instead of being hand-duplicated —
// see zod-patterns.ts section 3 (.omit/.pick/.partial/.extend) for the rest of this toolkit.
export const createProductSchema = productSchema.omit({ id: true });
export type CreateProductPayload = z.infer<typeof createProductSchema>;

export const categorySchema = z.object({
  id: categoryIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type Category = z.infer<typeof categorySchema>;

export const createCategorySchema = categorySchema.omit({ id: true });
export type CreateCategoryPayload = z.infer<typeof createCategorySchema>;
