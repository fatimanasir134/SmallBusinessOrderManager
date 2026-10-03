/** Shared setup for tests that need PostgreSQL (the `<name>_test` database from setup.ts). */
import pg from 'pg';

/** Create the test database if needed. Returns false when Postgres isn't reachable. */
export async function ensureTestDatabase(): Promise<boolean> {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run against ${dbName}`);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch {
    return false;
  }
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}" ENCODING 'UTF8' TEMPLATE template0`);
    }
    return true;
  } finally {
    await admin.end();
  }
}

export const SKIP_WITHOUT_DB = 'PostgreSQL not running (npm run db:start)';
