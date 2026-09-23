import { z } from 'zod';


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
