/** An expected, client-facing error. Anything else is treated as a 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const aiNotConfigured = () =>
  new AppError(
    503,
    'AI_NOT_CONFIGURED',
    'Gemini is not configured. Set GEMINI_API_KEY in the .env file and restart the server.',
  );

/** Gemini failures, by cause. The HTTP status says whether retrying later makes sense. */
export const aiError = (message: string, details?: unknown) =>
  new AppError(502, 'AI_ERROR', message, details);

export const aiRateLimited = (retryAfterSeconds?: number) =>
  new AppError(
    429,
    'AI_RATE_LIMITED',
    'Gemini rate limit or quota reached. Try again ' +
      (retryAfterSeconds ? `in about ${Math.ceil(retryAfterSeconds)} seconds.` : 'shortly.'),
    retryAfterSeconds ? { retryAfterSeconds: Math.ceil(retryAfterSeconds) } : undefined,
  );

export const aiTimeout = (timeoutMs: number) =>
  new AppError(
    504,
    'AI_TIMEOUT',
    `Gemini did not respond within ${Math.round(timeoutMs / 1000)}s.`,
  );

export const aiUnavailable = (message = 'Gemini is temporarily unavailable. Try again shortly.') =>
  new AppError(503, 'AI_UNAVAILABLE', message);

export const aiBlocked = (reason: string) =>
  new AppError(422, 'AI_BLOCKED', `Gemini declined to answer (${reason}).`, { reason });

export const aiInvalidResponse = (message: string, details?: unknown) =>
  new AppError(502, 'AI_INVALID_RESPONSE', message, details);
