import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  DATABASE_URL: z.url(),
  TELEGRAM_BOT_TOKEN: z.string().nonempty(),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/, 'Must be a Telegram chat id, e.g. 123456789'),
});

function loadEnv(raw: NodeJS.ProcessEnv): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
    );
  }
  return result.data;
}

export const env = loadEnv(process.env);
