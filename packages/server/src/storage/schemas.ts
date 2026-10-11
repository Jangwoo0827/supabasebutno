import { z } from 'zod';
import { MIME_PATTERN_RE } from './files.js';
import { BUCKET_NAME_RE } from './service.js';

const bucketName = z.string().regex(BUCKET_NAME_RE, 'must match ^[a-z0-9][a-z0-9_-]{1,62}$');
const sizeLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const mimePatterns = z
  .array(z.string().transform((s) => s.trim().toLowerCase()).pipe(z.string().regex(MIME_PATTERN_RE, 'must look like image/png or image/*')))
  .min(1)
  .max(50)
  .nullable();

export const createBucketSchema = z.strictObject({
  name: bucketName,
  public: z.boolean().default(false),
  file_size_limit: sizeLimit.default(null),
  allowed_mime_types: mimePatterns.default(null),
});

export const updateBucketSchema = z
  .strictObject({
    public: z.boolean().optional(),
    file_size_limit: sizeLimit.optional(),
    allowed_mime_types: mimePatterns.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field to change');

export const listObjectsSchema = z.strictObject({
  prefix: z.string().max(1024).optional(),
  search: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).max(1_000_000_000).default(0),
  sort_by: z.enum(['path', 'created_at', 'size']).default('path'),
  descending: z.boolean().default(false),
});
