import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { REPO_ROOT, env } from './config/env.js';
import { requireTokenForWrites } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRouter } from './routes/index.js';

/** The built web app (`npm run build`). When present, the API server also serves it. */
const DEFAULT_WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

export function createApp({
  apiToken = env.API_TOKEN,
  webDist = DEFAULT_WEB_DIST,
}: { apiToken?: string; webDist?: string | null } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use((_req, res, next) => {
    // Forbid MIME sniffing and framing; send no referrer.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({ origin: env.corsOrigins }));
  app.use(requireTokenForWrites(apiToken));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', apiRouter);

  // Production: one service serves both the API and the web app (single URL, no CORS).
  const indexHtml = webDist ? path.join(webDist, 'index.html') : null;
  if (webDist && indexHtml && fs.existsSync(indexHtml)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    // Client-side routes (/orders/4, /audit, ...) all load the app shell.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
