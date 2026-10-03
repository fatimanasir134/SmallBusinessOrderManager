import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ folder (works from both src/config and dist/config). */
export const SERVER_ROOT = path.resolve(here, '../..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// Load the repo-level .env if present. Variables already set in the environment take precedence.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  // No .env file: rely on the process environment.
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must start with postgres:// or postgresql://')
    .default('postgres://postgres:postgres@localhost:5433/order_manager'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Embedded Postgres data folder used by `npm run db:start`, relative to server/.
  EMBEDDED_PG_DIR: z.string().min(1).default('./data/postgres'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Optional: when set (16+ chars), requests that change data need "Authorization: Bearer <token>".
  // Empty or "off"/"none"/"false"/"disabled" turns it off (for hosts whose forms require a value).
  API_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && !/^(off|none|false|disabled)$/i.test(v) ? v : undefined))
    .refine((v) => v === undefined || v.length >= 16, 'must be at least 16 characters'),
  // Optional at boot so the app can start without AI; AI endpoints return 503 when missing.
  GEMINI_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.6-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Total tries per call, including the first (retries cover rate limits, overload, timeouts).
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  // Comma-separated models to try when GEMINI_MODEL is rate-limited or overloaded (each has its own free quota).
  GEMINI_FALLBACK_MODELS: z.string().default(''),
  // Minimum gap between calls to the same model; keeps bursts under free-tier per-minute limits.
  GEMINI_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(4000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // The logger depends on env, so report config errors directly.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  embeddedPgDir: path.isAbsolute(raw.EMBEDDED_PG_DIR)
    ? raw.EMBEDDED_PG_DIR
    : path.resolve(SERVER_ROOT, raw.EMBEDDED_PG_DIR),
  geminiFallbackModels: raw.GEMINI_FALLBACK_MODELS.split(',')
    .map((m) => m.trim())
    .filter(Boolean),
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  version: process.env.npm_package_version ?? '0.1.0',
} as const;

export type Env = typeof env;
