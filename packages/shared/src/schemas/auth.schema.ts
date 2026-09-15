import { z } from 'zod';

export const userIdSchema = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;


const toRussianE164 = (raw: string): string => {
  const compact = raw.replace(/[\s()\-.]/g, '');
  if (/^8\d{10}$/.test(compact)) return `+7${compact.slice(1)}`;
  if (/^7\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+7${compact}`;
  return compact;
};


export const phoneNumberSchema = z
  .string()
  .trim()
  .transform(toRussianE164)
  .pipe(z.string().regex(/^\+7\d{10}$/, 'Enter a Russian number, e.g. +7 916 123-45-67'));
export type PhoneNumber = z.infer<typeof phoneNumberSchema>;


export const verificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const requestCodeSchema = z.object({
  phoneNumber: phoneNumberSchema,
});
export type RequestCodePayload = z.infer<typeof requestCodeSchema>;

export const verifyCodeSchema = z.object({
  phoneNumber: phoneNumberSchema,
  code: verificationCodeSchema,
});
export type VerifyCodePayload = z.infer<typeof verifyCodeSchema>;


export const requestCodeResultSchema = z.object({
  expiresInSeconds: z.number().int().positive(),
});
export type RequestCodeResult = z.infer<typeof requestCodeResultSchema>;


export const userSchema = z.object({
  id: userIdSchema,
  phoneNumber: phoneNumberSchema,
  firstName: z.string().min(2).max(25).nullable(),
  middleName: z.string().min(2).max(25).nullable(),
  lastName: z.string().min(2).max(25).nullable(),
  email: z.email().nullable(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const updateProfileSchema = userSchema.pick({ firstName: true, middleName: true ,lastName: true }).partial();
export type UpdateProfilePayload = z.infer<typeof updateProfileSchema>;

export const authSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  user: userSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;
