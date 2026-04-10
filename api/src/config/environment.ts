/**
 * @file environment.ts
 * Parses and validates all environment variables at startup using Zod.
 * The application will throw a descriptive error and refuse to start if any
 * required variable is missing or malformed — no silent fallbacks.
 */

import { z } from 'zod';

const envSchema = z.object({
  // ── Application ──────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_VERSION: z.string().default('v1'),
  API_BASE_URL: z.string().url(),

  // ── Database ─────────────────────────────────────────────────────────────
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL: z.string().transform((v) => v === 'true').default('false'),
  DB_POOL_MIN: z.coerce.number().int().default(2),
  DB_POOL_MAX: z.coerce.number().int().default(20),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().default(0),
  REDIS_DRIVER_LOCATION_TTL: z.coerce.number().int().default(30),
  REDIS_SESSION_TTL: z.coerce.number().int().default(86400),

  // ── JWT ──────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // ── Encryption ───────────────────────────────────────────────────────────
  ENCRYPTION_KEY: z.string().length(32),

  // ── Pricing ──────────────────────────────────────────────────────────────
  DEFAULT_CURRENCY: z.enum(['BHD', 'SAR', 'AED', 'USD']).default('BHD'),
  BASE_FARE_BHD: z.coerce.number().default(1.0),
  PER_KM_FARE_BHD: z.coerce.number().default(0.3),
  BASE_FARE_SAR: z.coerce.number().default(10.0),
  PER_KM_FARE_SAR: z.coerce.number().default(2.5),
  BASE_FARE_AED: z.coerce.number().default(5.0),
  PER_KM_FARE_AED: z.coerce.number().default(1.5),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(15),
  DRIVER_PAYOUT_PERCENT: z.coerce.number().min(0).max(100).default(85),

  // ── Dispatch engine ───────────────────────────────────────────────────────
  DISPATCH_RADIUS_KM: z.coerce.number().default(5),
  DISPATCH_MAX_RETRIES: z.coerce.number().int().default(3),
  DISPATCH_RETRY_INTERVAL_MS: z.coerce.number().int().default(15000),
  DISPATCH_DRIVER_RESPONSE_TIMEOUT_MS: z.coerce.number().int().default(30000),

  // ── Rate limiting ────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().default(100),

  // ── Logging ──────────────────────────────────────────────────────────────
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.string().transform((v) => v === 'true').default('true'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

/**
 * Returns the validated environment config.
 * Parsed once on first call; cached for all subsequent calls.
 */
export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`\n[Environment] Invalid configuration:\n${formatted}\n`);
  }

  _env = result.data;
  return _env;
}
