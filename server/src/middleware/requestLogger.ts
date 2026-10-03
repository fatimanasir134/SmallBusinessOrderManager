import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w.-]{1,100}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const fields = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    };
    if (res.statusCode >= 500) logger.error('request failed', fields);
    else if (res.statusCode >= 400) logger.warn('request rejected', fields);
    else logger.info('request', fields);
  });
  next();
};
