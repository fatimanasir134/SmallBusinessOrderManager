/**
 * Runs a local PostgreSQL server from npm (`embedded-postgres`), so nobody has to install
 * Postgres or Docker: `npm run db:start`. Port, user, password, and database name are taken
 * from DATABASE_URL, and the data lives in EMBEDDED_PG_DIR (git-ignored).
 * Keep this process running while you work; Ctrl+C stops the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

async function main(): Promise<void> {
  const url = new URL(env.DATABASE_URL);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    logger.info('DATABASE_URL points to a remote server; embedded Postgres not needed', {
      host: url.hostname,
    });
    return;
  }

  const port = Number(url.port || 5432);
  const user = decodeURIComponent(url.username || 'postgres');
  const password = decodeURIComponent(url.password || 'postgres');
  const database = decodeURIComponent(url.pathname.slice(1)) || 'postgres';
  const dataDir = env.embeddedPgDir;

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user,
    password,
    persistent: true,
    // Without this, Windows picks a legacy code page (e.g. WIN1252) that can't store emoji.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (msg) => logger.debug('postgres', { msg: String(msg).trim() }),
    onError: (err) => logger.warn('postgres', { msg: String(err).trim() }),
  });

  // initdb only on first run; afterwards the cluster already exists.
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    logger.info('creating local PostgreSQL cluster (first run only)', { dataDir });
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    await pg.initialise();
  }

  await pg.start();

  const admin = pg.getPgClient('postgres', url.hostname);
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) {
    // Identifier comes from our own .env; quote it to allow names like "order-manager".
    await admin.query(
      `CREATE DATABASE "${database.replaceAll('"', '""')}" ENCODING 'UTF8' TEMPLATE template0`,
    );
    logger.info('database created', { database });
  }
  await admin.end();

  logger.info('embedded PostgreSQL running (Ctrl+C to stop)', {
    host: url.hostname,
    port,
    database,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('stopping embedded PostgreSQL');
    await pg.stop().catch((err) => logger.error('failed to stop PostgreSQL', { err }));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Keep the process alive while Postgres runs.
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('could not start embedded PostgreSQL', { err: message });
  if (/EADDRINUSE|already in use|could not bind/i.test(message)) {
    logger.error(
      `port is busy: is another Postgres already running? Change the port in DATABASE_URL.`,
    );
  }
  process.exit(1);
});
