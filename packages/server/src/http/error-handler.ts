import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError } from '../core/errors.js';
import type { AppEnv } from './types.js';

/**
 * Error contract: `{ "error": { "code", "message", "details"?, "request_id" } }`.
 * Only AppError / validation errors expose their message. Everything else is an
 * internal error: logged server-side with the request id, generic to the client.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const request_id = c.get('requestId');

  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details, request_id } }, err.status);
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return c.json({ error: { code: 'validation_error', message: 'Invalid request', details, request_id } }, 400);
  }
  if (err instanceof HTTPException && err.status < 500) {
    return c.json({ error: { code: 'http_error', message: err.message || 'Request failed', request_id } }, err.status);
  }

  console.error(`[${request_id}] unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
  return c.json({ error: { code: 'internal_error', message: 'Internal server error', request_id } }, 500);
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: 'not_found', message: 'Route not found', request_id: c.get('requestId') } }, 404);
