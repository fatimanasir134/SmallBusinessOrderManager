/**
 * Loaded before every test file (see the "test" script). Points the app at a separate
 * `<name>_test` database so tests never touch the demo data, and keeps logs quiet.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // No .env: fall back to the process environment / defaults.
}

const base = new URL(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/order_manager',
);
if (!base.pathname.endsWith('_test')) base.pathname = `${base.pathname}_test`;
process.env.DATABASE_URL = base.toString();
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
process.env.NODE_ENV = 'test';
process.env.GEMINI_MIN_INTERVAL_MS = '0'; // tests use fake Gemini; no pacing
// Tests must never spend real Gemini quota: the real client is unconfigured (fakes are injected).
process.env.GEMINI_API_KEY = '';
process.env.API_TOKEN = '';
