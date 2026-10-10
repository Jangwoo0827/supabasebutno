import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from '../core/errors.js';

/** Reads the JSON body; invalid JSON becomes a 400. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('invalid_json', 'Request body must be valid JSON');
  }
}

/** Parses the JSON body and validates it. ZodErrors are turned into 400 responses by the global error handler. */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return schema.parse(await readJson(c));
}
