/**
 * Optional protection for requests that change data. When API_TOKEN is set, every non-GET request
 * needs `Authorization: Bearer <API_TOKEN>`. The dev web server adds the header in its proxy, so the
 * token never reaches the browser. Off when API_TOKEN is empty (the default, for easy demos).
 */
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireTokenForWrites(token: string | undefined): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  const expected = Buffer.from(token);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const given = Buffer.from(req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      return next(
        new AppError(401, 'UNAUTHORIZED', 'A valid API token is required to change data.'),
      );
    }
    next();
  };
}
