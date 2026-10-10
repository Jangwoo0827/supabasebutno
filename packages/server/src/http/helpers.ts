import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from '../core/errors.js';

/** Parses the JSON body and validates it. ZodErrors are turned into 400 responses by the global error handler. */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('invalid_json', 'Request body must be valid JSON');
  }
  return schema.parse(body);
}
