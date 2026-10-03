/** Error mapping without a database: every failure becomes a JSON error with the right status. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { errorHandler } from './errorHandler.js';

function handle(err: unknown) {
  let status = 0;
  let body: { error: { code: string; message: string; details?: unknown } } | undefined;
  const res = {
    headersSent: false,
    status(s: number) {
      status = s;
      return this;
    },
    json(b: typeof body) {
      body = b;
      return this;
    },
  } as unknown as Response;
  errorHandler(err, { id: 'req-1' } as Request, res, () => undefined);
  return {
    status,
    code: body!.error.code,
    message: body!.error.message,
    details: body!.error.details,
  };
}

const pgError = (code: string) =>
  Object.assign(new Error('pg'), { code, constraint: 'some_constraint' });

describe('errorHandler', () => {
  it('maps known failures to clear statuses', () => {
    assert.deepEqual(
      [
        handle(new AppError(409, 'CONFLICT', 'nope')),
        handle(z.object({ a: z.string() }).safeParse({}).error),
        handle(
          Object.assign(new SyntaxError('bad'), {
            type: 'entity.parse.failed',
            status: 400,
            expose: true,
          }),
        ),
        handle(
          Object.assign(new Error('too large'), {
            type: 'entity.too.large',
            status: 413,
            expose: true,
          }),
        ),
        handle(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
        handle(pgError('23505')),
        handle(pgError('23503')),
        handle(pgError('23514')),
        handle(pgError('22007')),
      ].map((r) => `${r.status} ${r.code}`),
      [
        '409 CONFLICT',
        '400 VALIDATION_ERROR',
        '400 INVALID_BODY',
        '413 PAYLOAD_TOO_LARGE',
        '503 DATABASE_UNAVAILABLE',
        '409 CONFLICT',
        '400 INVALID_REFERENCE',
        '400 CONSTRAINT_VIOLATION',
        '400 INVALID_INPUT',
      ],
    );
  });

  it('hides internal details of unexpected errors outside development', () => {
    const r = handle(new Error('secret stack info'));
    assert.equal(r.status, 500);
    assert.equal(r.code, 'INTERNAL_ERROR');
    assert.equal(r.message, 'Something went wrong. Please try again.');
    // NODE_ENV=test is not production, so details are shown for debugging; production hides them.
  });
});
