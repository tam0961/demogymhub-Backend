import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8082),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  JWT_SECRET: z.string().min(32),
  JWT_SECRET_PREV: z.string().min(32).optional(),
  JWT_ISSUER: z.string().default('https://api.gymhub.local'),
  JWT_AUDIENCE: z.string().default('gymhub-web'),
  ACCESS_TTL_SEC: z.coerce.number().default(900),
  REFRESH_TTL_SEC: z.coerce.number().default(604800),
  REFRESH_COOKIE_NAME: z.string().default('__Secure-rt'),
  RENEW_GRACE_SEC: z.coerce.number().default(10),
  ALLOWED_ORIGINS: z.string().default(''),
  LOGIN_IP_LIMIT: z.coerce.number().default(100),
  LOGIN_EMAIL_LIMIT: z.coerce.number().default(10),
  LOGIN_WINDOW_SEC: z.coerce.number().default(900),
  LOCKOUT_THRESHOLD: z.coerce.number().default(5),
  LOCKOUT_SEC: z.coerce.number().default(900),
  SEED_ADMIN_EMAIL: z.string().default('admin@gymhub.local'),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_OWNER_EMAIL: z.string().optional(),
  SEED_OWNER_PASSWORD: z.string().optional(),
  SEED_OWNER_NAME: z.string().optional(),
  SEED_DEMO: z.string().default('false'),
  SEED_DEMO_PASSWORD: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  WEBHOOK_TOLERANCE_SEC: z.coerce.number().default(300),
  VIETQR_BANK_ID: z.string().default(''),
  VIETQR_ACCOUNT_NO: z.string().default(''),
  VIETQR_ACCOUNT_NAME: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.APP_ENV === 'production',
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
