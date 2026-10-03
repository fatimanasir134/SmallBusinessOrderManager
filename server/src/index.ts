import { env } from './config/env.js';
import { createApp } from './app.js';
import { closeDb, connectDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { isDatabaseEmpty, seedDatabase } from './db/seed.js';
import { isGeminiConfigured } from './ai/gemini.js';
import { logger } from './lib/logger.js';

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception, shutting down', { err });
  process.exit(1);
});

async function main() {
  await connectDb();
  await runMigrations();
  if (await isDatabaseEmpty()) {
    logger.info('empty database: loading demo data');
    await seedDatabase();
  }

  if (!isGeminiConfigured()) {
    logger.warn('GEMINI_API_KEY is not set: AI features are disabled until it is added to .env');
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info('server listening', {
      url: `http://localhost:${env.PORT}`,
      env: env.NODE_ENV,
      model: env.GEMINI_MODEL,
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') logger.error(`port ${env.PORT} is already in use`);
    else logger.error('server error', { err });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      closeDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('failed to start', { err: err instanceof Error ? err.message : err });
  process.exit(1);
});
