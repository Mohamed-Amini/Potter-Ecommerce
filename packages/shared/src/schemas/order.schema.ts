import { z } from 'zod';
import { phoneNumberSchema } from './contact.schema';
import { productIdSchema } from './product.schema';

export const orderRequestIdSchema = z.uuid().brand<'OrderRequestId'>();
export type OrderRequestId = z.infer<typeof orderRequestIdSchema>;


export const telegramHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^(https?:\/\/)?(t\.me\/)?@?/i, '').toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/,
        'A Telegram username is 5-32 characters, starts with a letter, and uses only letters, numbers and underscores',
      ),
  );

export const emailSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.email('Enter a valid email address'));


export const contactSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('telegram'), value: telegramHandleSchema }),
  z.object({ method: z.literal('phone'), value: phoneNumberSchema }),
  z.object({ method: z.literal('email'), value: emailSchema }),
]);
export type Contact = z.infer<typeof contactSchema>;

export const orderLineInputSchema = z.object({
  productId: productIdSchema,
  quantity: z.number().int().positive().max(99),
});
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

export const createOrderRequestSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  contact: contactSchema,
  note: z.string().trim().max(1000).optional(),
  items: z.array(orderLineInputSchema).min(1).max(50),
});
export type CreateOrderRequestPayload = z.infer<typeof createOrderRequestSchema>;

export const orderStatusSchema = z.enum([
  'new',
  'contacted',
  'confirmed',
  'shipped',
  'completed',
  'cancelled',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;


export const orderLineSchema = z.object({
  productId: productIdSchema,
  name: z.string().min(1),
  priceMinor: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderRequestSchema = z.object({
  id: orderRequestIdSchema,
  referenceNumber: z.number().int().positive(),
  customerName: z.string().min(1),
  contact: contactSchema,
  note: z.string().nullable(),
  itemsTotalMinor: z.number().int().nonnegative(),
  agreedTotalMinor: z.number().int().nonnegative().nullable(),
  status: orderStatusSchema,
  items: z.array(orderLineSchema).min(1),
  createdAt: z.iso.datetime(),
});
export type OrderRequest = z.infer<typeof orderRequestSchema>;
