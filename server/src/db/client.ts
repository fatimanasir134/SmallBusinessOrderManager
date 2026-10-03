import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// Return plain JSON-friendly values instead of pg's defaults.
types.setTypeParser(types.builtins.NUMERIC, (v) => Number.parseFloat(v)); // percentages
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10)); // COUNT(*), SUM(...)
types.setTypeParser(types.builtins.DATE, (v) => v); // keep 'YYYY-MM-DD', avoid timezone shifts
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

/** Host/port/database without credentials, safe to log. */
export function describeDatabase(url = env.DATABASE_URL): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
    // An idle client can error if the server restarts; log it instead of crashing the process.
    pool.on('error', (err) => logger.error('idle database client error', { err }));
  }
  return pool;
}

/**
 * Connect, retrying while the database starts up (e.g. embedded Postgres launched by `npm run dev`).
 */
export async function connectDb({ attempts = 30, delayMs = 1000 } = {}): Promise<void> {
  const target = describeDatabase();
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await getPool().query<{ encoding: string }>(
        'SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()',
      );
      const encoding = res.rows[0]?.encoding;
      logger.info('database connected', { database: target, encoding });
      if (encoding !== 'UTF8') {
        logger.warn('database is not UTF8: messages with emoji or non-Latin text will fail', {
          encoding,
        });
      }
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(
          `Could not connect to PostgreSQL at ${target}: ${(err as Error).message}. ` +
            'Is it running? Start the embedded database with `npm run db:start`.',
        );
      }
      if (attempt === 1 || attempt % 5 === 0) {
        logger.info('waiting for database', { database: target, attempt });
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Run a query and return its rows. */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

/** Run a query and return the first row, or undefined. */
export async function queryOne<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T | undefined> {
  return (await query<T>(text, params, db))[0];
}

/** Run fn inside a transaction on a single client; rolls back if it throws. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end();
}
