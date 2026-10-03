import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@sbom/shared';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/** Express error handler: turns any thrown error into a consistent JSON body. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiErrorBody['error'] = {
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong. Please try again.',
  };

  if (err instanceof AppError) {
    status = err.status;
    body = { code: err.code, message: err.message, details: err.details };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.flatten() };
  } else if (isBodyParserError(err)) {
    status = 400;
    body = { code: 'INVALID_BODY', message: 'Request body is not valid JSON' };
  } else if (isClientHttpError(err)) {
    // e.g. body-parser's 413 for an oversized body
    status = err.status;
    body = {
      code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message: status === 413 ? 'Request body is too large' : err.message,
    };
  } else if (isDatabaseDown(err)) {
    status = 503;
    body = { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable right now.' };
  } else {
    const pgError = mapPostgresError(err);
    if (pgError) [status, body] = pgError;
  }

  if (err instanceof AppError) {
    // Expected failure: the request logger already records the status, so just note the reason.
    if (status >= 500) logger.warn(err.message, { requestId: req.id, code: err.code });
  } else if (status >= 500) {
    logger.error('unhandled error', { requestId: req.id, err });
    if (!env.isProduction && err instanceof Error) body.details = { message: err.message };
  }

  if (res.headersSent) return;
  res.status(status).json({ error: { ...body, requestId: req.id } } satisfies ApiErrorBody);
};

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

function isDatabaseDown(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ECONNREFUSED' || code === '57P01' || code === '57P03';
}

/** Constraint violations from Postgres (SQLSTATE class 23) become 4xx instead of 500. */
function mapPostgresError(err: unknown): [number, ApiErrorBody['error']] | undefined {
  const detail =
    typeof err === 'object' && err !== null && 'constraint' in err
      ? { constraint: err.constraint }
      : undefined;
  switch (errorCode(err)) {
    case '23505':
      return [409, { code: 'CONFLICT', message: 'That record already exists', details: detail }];
    case '23503':
      return [
        400,
        {
          code: 'INVALID_REFERENCE',
          message: 'A referenced record does not exist',
          details: detail,
        },
      ];
    case '22007': // invalid date
    case '22008': // date out of range
    case '22P02': // invalid text representation
    case '22003': // number out of range
      return [400, { code: 'INVALID_INPUT', message: 'A value is not valid' }];
    case '23514':
    case '23502':
      return [
        400,
        {
          code: 'CONSTRAINT_VIOLATION',
          message: 'The data breaks a business rule',
          details: detail,
        },
      ];
    default:
      return undefined;
  }
}

function isClientHttpError(err: unknown): err is { status: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500 &&
    'expose' in err &&
    err.expose === true
  );
}

function isBodyParserError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed'
  );
}
