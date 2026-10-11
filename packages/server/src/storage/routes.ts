import { Hono, type Context } from 'hono';
import { AppError, notFound } from '../core/errors.js';
import { PROJECT_ID_RE } from '../core/ids.js';
import { parseJson, parseOptionalJson } from '../http/helpers.js';
import { countAttempt } from '../http/rate.js';
import type { AppEnv, Deps } from '../http/types.js';
import { forbidden } from '../policy/plan.js';
import { contentDisposition, isInlineSafe, normalizeMime, objectPathFromUrl, parseRange } from './files.js';
import { createBucketSchema, listObjectsSchema, updateBucketSchema } from './schemas.js';
import { requireBucketName, type Actor, type StoredObject } from './service.js';

const emptyBody = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

const publicObject = (o: StoredObject) => ({
  id: o.id,
  bucket: o.bucket,
  path: o.path,
  size: o.size,
  mime_type: o.mime_type,
  owner_id: o.owner_id,
  created_at: o.created_at,
  updated_at: o.updated_at,
});

const actorOf = (c: Context<AppEnv>): Actor => ({ role: c.get('role'), userId: c.get('userId') });

/** Streams a stored object with conditional-request and Range support and conservative security headers. */
async function serve(c: Context<AppEnv>, deps: Deps, projectId: string, object: StoredObject, bucketIsPublic: boolean, viaPublicUrl: boolean) {
  const mime = object.mime_type;
  const etag = `"${object.id}"`; // a replaced file gets a new id, so the ETag changes with the content
  const forceDownload = c.req.query('download') !== undefined;
  const headers: Record<string, string> = {
    'Content-Type': mime,
    ETag: etag,
    'Last-Modified': new Date(object.updated_at).toUTCString(),
    'Accept-Ranges': 'bytes',
    // Stored files are untrusted input: never let a browser sniff or execute them on our origin.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': mime === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; sandbox",
    'Content-Disposition': contentDisposition(forceDownload || !isInlineSafe(mime) ? 'attachment' : 'inline', object.path),
    'Cache-Control': bucketIsPublic ? 'public, max-age=60' : 'private, no-store',
  };
  if (viaPublicUrl) headers['Cross-Origin-Resource-Policy'] = 'cross-origin'; // so <img>/<audio> on other sites can use it

  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);

  const range = parseRange(c.req.header('range'), object.size);
  if (range === 'invalid') return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${object.size}` });

  const stream = await deps.storage.read(projectId, object, range ?? undefined);
  if (range) {
    return c.body(stream, 206, {
      ...headers,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${object.size}`,
    });
  }
  return c.body(stream, 200, { ...headers, 'Content-Length': String(object.size) });
}

/**
 * Storage API for a project, authenticated by apikey (+ optional user token), or mounted
 * under /admin where it acts as service_role. `prefixSegments` is the number of URL
 * segments before `/object/...` (1 for `/storage`, 4 for `/admin/projects/:id/storage`).
 *
 *   buckets:  GET|POST /buckets   GET|PATCH|DELETE /buckets/:name              (service_role)
 *   objects:  POST|GET|DELETE /object/:bucket/<path>   POST /list/:bucket
 */
export function storageRoutes(deps: Deps, mount: { prefixSegments: number }): Hono<AppEnv> {
  const { registry, storage, limits } = deps;
  const router = new Hono<AppEnv>();

  const dbOf = (c: Context<AppEnv>) => registry.db(c.get('project').id);
  const requireService = (c: Context<AppEnv>) => {
    if (c.get('role') !== 'service_role') throw forbidden();
  };
  const objectPath = (c: Context<AppEnv>) => objectPathFromUrl(c.req.url, mount.prefixSegments + 2);

  // ---- buckets (service_role) ----------------------------------------------

  router.get('/buckets', async (c) => {
    requireService(c);
    return c.json({ buckets: await storage.listBuckets(await dbOf(c)) });
  });

  router.post('/buckets', async (c) => {
    requireService(c);
    const input = await parseJson(c, createBucketSchema);
    return c.json(await storage.createBucket(await dbOf(c), input), 201);
  });

  router.get('/buckets/:name', async (c) => {
    requireService(c);
    return c.json(await storage.requireBucket(await dbOf(c), requireBucketName(c.req.param('name'))));
  });

  router.patch('/buckets/:name', async (c) => {
    requireService(c);
    const patch = await parseJson(c, updateBucketSchema);
    return c.json(await storage.updateBucket(await dbOf(c), requireBucketName(c.req.param('name')), patch));
  });

  router.delete('/buckets/:name', async (c) => {
    requireService(c);
    const force = c.req.query('force') === 'true';
    await storage.deleteBucket(await dbOf(c), c.get('project').id, requireBucketName(c.req.param('name')), force);
    return c.body(null, 204);
  });

  // ---- objects -------------------------------------------------------------

  router.post('/object/:bucket/*', async (c) => {
    const actor = actorOf(c);
    if (actor.role === 'anon') throw forbidden(); // decided before the body is touched
    const bucket = requireBucketName(c.req.param('bucket'));
    const path = objectPath(c);
    if (actor.role === 'authenticated') countAttempt(limits.uploadUser, `${c.get('project').id}:${actor.userId}`);

    const contentType = normalizeMime(c.req.header('content-type'));
    if (contentType.startsWith('multipart/')) {
      throw new AppError(415, 'unsupported_media_type', 'Send the raw file bytes as the request body, with the file’s own Content-Type (not multipart/form-data)');
    }
    const length = c.req.header('content-length');
    const object = await storage.upload(await dbOf(c), c.get('project').id, actor, bucket, path, {
      body: c.req.raw.body ?? emptyBody(),
      contentType,
      contentLength: length !== undefined && /^\d{1,15}$/.test(length) ? Number(length) : undefined,
      upsert: c.req.header('x-upsert') === 'true',
    });
    c.header('Cache-Control', 'no-store');
    return c.json(publicObject(object), 201);
  });

  router.get('/object/:bucket/*', async (c) => {
    const bucket = requireBucketName(c.req.param('bucket'));
    const { bucket: b, object } = await storage.openable(await dbOf(c), actorOf(c), bucket, objectPath(c));
    return serve(c, deps, c.get('project').id, object, b.public, false);
  });

  router.delete('/object/:bucket/*', async (c) => {
    await storage.remove(await dbOf(c), c.get('project').id, actorOf(c), requireBucketName(c.req.param('bucket')), objectPath(c));
    return c.body(null, 204);
  });

  router.post('/list/:bucket', async (c) => {
    const opts = await parseOptionalJson(c, listObjectsSchema);
    const rows = await storage.list(await dbOf(c), actorOf(c), requireBucketName(c.req.param('bucket')), {
      prefix: opts.prefix,
      search: opts.search,
      limit: opts.limit,
      offset: opts.offset,
      sortBy: opts.sort_by,
      descending: opts.descending,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(rows);
  });

  return router;
}

/**
 * Unauthenticated downloads from PUBLIC buckets: `/storage/public/<projectId>/<bucket>/<path>`.
 * The project id is in the URL because, with no apikey, nothing else says which project's
 * files are meant. Private buckets and unknown files all answer an identical 404.
 */
export function publicStorageRoutes(deps: Deps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/:projectId/:bucket/*', async (c) => {
    const projectId = c.req.param('projectId');
    const project = PROJECT_ID_RE.test(projectId) ? await deps.registry.get(projectId) : undefined;
    if (!project) throw notFound('Object');
    const db = await deps.registry.db(project.id);
    const bucket = requireBucketName(c.req.param('bucket'));
    const path = objectPathFromUrl(c.req.url, 4);
    const found = await deps.storage.openable(db, { role: 'anon', userId: null }, bucket, path, true);
    return serve(c, deps, project.id, found.object, true, true);
  });

  return router;
}
