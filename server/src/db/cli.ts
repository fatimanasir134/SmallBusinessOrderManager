/**
 * Database commands:
 *   npm run db:migrate   apply pending migrations
 *   npm run db:seed      replace all business data with the demo data set
 *   npm run db:reset     drop everything, migrate, and seed
 *   npm run db:status    check connectivity and show migrations and row counts
 *   npm run db:check     verify business invariants (stock, capacity, human-only decisions)
 */
import { logger } from '../lib/logger.js';
import { closeDb, connectDb, describeDatabase, query, queryOne } from './client.js';
import { checkConsistency } from './consistency.js';
import { dropAllTables, runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';

const COMMANDS = ['migrate', 'seed', 'reset', 'status', 'check'] as const;
type Command = (typeof COMMANDS)[number];

async function status(): Promise<void> {
  const info = await queryOne<{ version: string; database: string; user: string }>(
    'SELECT version(), current_database() AS database, current_user AS user',
  );
  const migrations = await query<{ name: string; applied_at: string }>(
    `SELECT name, applied_at FROM schema_migrations ORDER BY name`,
  ).catch(() => []);
  const tables = await query<{ name: string; rows: number }>(
    `SELECT relname AS name, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname`,
  );

  console.log(`\nConnected to ${describeDatabase()} as ${info?.user}`);
  console.log(info?.version.split(',')[0]);
  console.log(`\nMigrations applied: ${migrations.length}`);
  for (const m of migrations) console.log(`  ✓ ${m.name}  (${m.applied_at})`);
  console.log('\nTables (approximate row counts):');
  for (const t of tables) console.log(`  ${t.name.padEnd(24)} ${t.rows}`);
  console.log();
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    console.error(`Usage: tsx src/db/cli.ts <${COMMANDS.join('|')}>`);
    process.exitCode = 1;
    return;
  }

  await connectDb({ attempts: 5 });
  switch (command) {
    case 'migrate':
      await runMigrations();
      break;
    case 'seed':
      await runMigrations();
      await seedDatabase();
      break;
    case 'reset':
      await dropAllTables();
      await runMigrations();
      await seedDatabase();
      break;
    case 'status':
      await status();
      break;
    case 'check': {
      const report = await checkConsistency();
      console.log(report.ok ? '\n✓ All business invariants hold.\n' : '\n✗ Problems found:');
      for (const p of report.problems) console.log(`  - ${p}`);
      if (!report.ok) process.exitCode = 1;
      break;
    }
  }
  logger.info(`db:${command} complete`);
}

main()
  .catch((err) => {
    logger.error('database command failed', { err: err instanceof Error ? err.message : err });
    process.exitCode = 1;
  })
  .finally(() => closeDb());
