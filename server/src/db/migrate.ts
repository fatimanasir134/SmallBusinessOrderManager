/**
 * Minimal SQL migration runner. Files in server/migrations named `NNN_description.sql` are applied
 * in order, each in its own transaction, and recorded in `schema_migrations`.
 * Applied migrations are never edited: add a new file instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getPool, query, transaction } from './client.js';

export const MIGRATIONS_DIR = path.join(SERVER_ROOT, 'migrations');

// Arbitrary constant: stops two processes (e.g. server + CLI) from migrating at the same time.
const MIGRATION_LOCK_ID = 727_001;

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

/** Apply pending migrations. Returns the names that were applied. */
export async function runMigrations(): Promise<string[]> {
  const lock = await getPool().connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
    );

    const applied: string[] = [];
    for (const file of migrationFiles()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await transaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      logger.info('migration applied', { migration: file });
      applied.push(file);
    }
    if (applied.length === 0) logger.debug('database schema is up to date');
    return applied;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    lock.release();
  }
}

/** Drop everything in the public schema. Used by `db:reset` only. */
export async function dropAllTables(): Promise<void> {
  await query('DROP SCHEMA public CASCADE');
  await query('CREATE SCHEMA public');
  logger.info('database schema dropped');
}
