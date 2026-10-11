import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError, conflict, notFound } from '../core/errors.js';
import type { Database } from '../db/driver.js';
import type { Role } from '../http/types.js';
import { forbidden } from '../policy/plan.js';
import { ObjectMissingError, PayloadTooLargeError, type StorageBackend } from './backend.js';
import { contentMatchesMime, mimeAllowed, validateObjectPath } from './files.js';

/** Who is asking. Storage has its own simple access rules (see the comment on StorageService). */
export interface Actor {
  role: Role;
  userId: string | null;
}

export interface Bucket {
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface StoredObject {
  id: string;
  bucket: string;
  path: string;
  size: number;
  mime_type: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

interface BucketRow {
  name: string;
  public: number;
  file_size_limit: number | null;
  allowed_mime_types: string | null;
  created_at: string;
  updated_at: string;
}

const toBucket = (r: BucketRow): Bucket => ({
  name: r.name,
  public: r.public === 1,
  file_size_limit: r.file_size_limit,
  allowed_mime_types: r.allowed_mime_types ? (JSON.parse(r.allowed_mime_types) as string[]) : null,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const isService = (a: Actor) => a.role === 'service_role';

export interface UploadRequest {
  body: ReadableStream<Uint8Array>;
  /** Already normalised (lower-case, no parameters). */
  contentType: string;
  contentLength?: number;
  upsert: boolean;
}

export interface ListOptions {
  prefix?: string;
  search?: string;
  limit: number;
  offset: number;
  sortBy: 'path' | 'created_at' | 'size';
  descending: boolean;
}

/**
 * Buckets and files of one project.
 *
 * Access rules (deliberately simple and fixed; there are no per-file policies):
 *   - service_role: everything.
 *   - upload: signed-in users only. The uploader becomes the file's owner.
 *   - download: public bucket -> anyone; private bucket -> the owner only.
 *   - replace / delete: the owner only.
 *   - list: signed-in users see only their own files.
 * Files the caller may not see answer 404, so existence is not revealed.
 */
export class StorageService {
  constructor(
    private readonly backend: StorageBackend,
    private readonly config: Config,
    private readonly now: () => number,
  ) {}

  private readonly keyOf = (projectId: string, objectId: string) => `${projectId}/${objectId}`;
  private readonly iso = () => new Date(this.now()).toISOString();

  // ---- buckets -------------------------------------------------------------

  async listBuckets(db: Database): Promise<Bucket[]> {
    return (await db.all<BucketRow>('SELECT * FROM _storage_buckets ORDER BY name')).map(toBucket);
  }

  async findBucket(db: Database, name: string): Promise<Bucket | undefined> {
    const row = await db.get<BucketRow>('SELECT * FROM _storage_buckets WHERE name = ?', [name]);
    return row && toBucket(row);
  }

  async requireBucket(db: Database, name: string): Promise<Bucket> {
    const bucket = await this.findBucket(db, name);
    if (!bucket) throw notFound('Bucket');
    return bucket;
  }

  async createBucket(
    db: Database,
    input: { name: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null },
  ): Promise<Bucket> {
    const now = this.iso();
    try {
      await db.run(
        'INSERT INTO _storage_buckets (name, public, file_size_limit, allowed_mime_types, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [input.name, input.public ? 1 : 0, input.file_size_limit, input.allowed_mime_types && JSON.stringify(input.allowed_mime_types), now, now],
      );
    } catch (err) {
      if (db.dialect.isUniqueViolation(err)) throw conflict('bucket_exists', `Bucket "${input.name}" already exists`);
      throw err;
    }
    return this.requireBucket(db, input.name);
  }

  async updateBucket(
    db: Database,
    name: string,
    patch: { public?: boolean; file_size_limit?: number | null; allowed_mime_types?: string[] | null },
  ): Promise<Bucket> {
    const current = await this.requireBucket(db, name);
    const next = { ...current, ...patch };
    await db.run('UPDATE _storage_buckets SET public = ?, file_size_limit = ?, allowed_mime_types = ?, updated_at = ? WHERE name = ?', [
      next.public ? 1 : 0,
      next.file_size_limit,
      next.allowed_mime_types && JSON.stringify(next.allowed_mime_types),
      this.iso(),
      name,
    ]);
    return this.requireBucket(db, name);
  }

  /** A bucket with files is only deleted with `force`, which removes the files too. */
  async deleteBucket(db: Database, projectId: string, name: string, force: boolean): Promise<void> {
    await this.requireBucket(db, name);
    const objects = await db.all<{ id: string }>('SELECT id FROM _storage_objects WHERE bucket = ?', [name]);
    if (objects.length > 0 && !force) {
      throw conflict('bucket_not_empty', `Bucket "${name}" contains ${objects.length} file(s). Delete them first or pass ?force=true`);
    }
    await db.run('DELETE FROM _storage_buckets WHERE name = ?', [name]); // rows go with it (ON DELETE CASCADE)
    for (const o of objects) await this.backend.remove(this.keyOf(projectId, o.id));
  }

  // ---- objects -------------------------------------------------------------

  private async findObject(db: Database, bucket: string, path: string): Promise<StoredObject | undefined> {
    return db.get<StoredObject>('SELECT * FROM _storage_objects WHERE bucket = ? AND path = ?', [bucket, path]);
  }

  /** Bytes used in the project, and (for a signed-in user) by that user, excluding bytes about to be replaced. */
  private async checkQuota(db: Database, actor: Actor, incoming: number, replacing: number): Promise<void> {
    if (isService(actor)) return;
    const project = (await db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM _storage_objects'))!.n;
    if (project - replacing + incoming > this.config.storageProjectQuotaBytes) {
      throw new AppError(413, 'quota_exceeded', "The project's storage quota is full");
    }
    const mine = (await db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM _storage_objects WHERE owner_id = ?', [actor.userId]))!.n;
    if (mine - replacing + incoming > this.config.storageUserQuotaBytes) {
      throw new AppError(413, 'quota_exceeded', 'Your storage quota is full');
    }
  }

  async upload(db: Database, projectId: string, actor: Actor, bucketName: string, path: string, req: UploadRequest): Promise<StoredObject> {
    if (!isService(actor) && actor.role !== 'authenticated') throw forbidden();
    validateObjectPath(path);
    const bucket = await this.requireBucket(db, bucketName);

    if (!mimeAllowed(req.contentType, bucket.allowed_mime_types)) {
      throw new AppError(415, 'unsupported_media_type', `Bucket "${bucket.name}" does not accept ${req.contentType}`);
    }
    const limit = Math.min(bucket.file_size_limit ?? Infinity, this.config.maxUploadBytes);
    const tooLarge = () => new AppError(413, 'payload_too_large', `Files in this bucket may be at most ${limit} bytes`);
    if (req.contentLength !== undefined && req.contentLength > limit) throw tooLarge();

    // Cheap early rejection when the size is announced; the authoritative check runs again after the upload.
    if (req.contentLength !== undefined) {
      const existing = await this.findObject(db, bucket.name, path);
      await this.checkQuota(db, actor, req.contentLength, existing && existing.owner_id === actor.userId ? existing.size : 0);
    }

    const id = randomUUID();
    const key = this.keyOf(projectId, id);
    let stored: { size: number; head: Uint8Array };
    try {
      stored = await this.backend.put(key, req.body, { maxBytes: limit });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) throw tooLarge();
      throw err;
    }

    try {
      if (!contentMatchesMime(req.contentType, stored.head)) {
        throw new AppError(415, 'content_mismatch', `The file content does not look like ${req.contentType}`);
      }
      let replaced: string | undefined;
      const now = this.iso();
      await db.transaction(async (tx) => {
        const existing = await this.findObject(tx, bucket.name, path);
        let credit = 0;
        if (existing) {
          const mayReplace = req.upsert && (isService(actor) || existing.owner_id === actor.userId);
          // A stranger replacing someone else's file gets the same answer as a plain collision: no extra information.
          if (!mayReplace) throw conflict('object_exists', 'An object already exists at this path');
          replaced = existing.id;
          credit = existing.size;
        }
        await this.checkQuota(tx, actor, stored.size, credit);
        if (existing) {
          await tx.run('UPDATE _storage_objects SET id = ?, size = ?, mime_type = ?, updated_at = ? WHERE bucket = ? AND path = ?', [
            id, stored.size, req.contentType, now, bucket.name, path,
          ]);
        } else {
          await tx.run(
            'INSERT INTO _storage_objects (id, bucket, path, size, mime_type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, bucket.name, path, stored.size, req.contentType, actor.userId, now, now],
          );
        }
      });
      if (replaced) await this.backend.remove(this.keyOf(projectId, replaced));
      return (await this.findObject(db, bucket.name, path))!;
    } catch (err) {
      await this.backend.remove(key); // never leave an unreferenced file behind
      if (db.dialect.isUniqueViolation(err)) throw conflict('object_exists', 'An object already exists at this path');
      throw err;
    }
  }

  /**
   * Finds an object the actor may read, or throws 404. `viaPublicUrl` is for the unauthenticated
   * /storage/public route, which only ever serves public buckets.
   */
  async openable(db: Database, actor: Actor, bucketName: string, path: string, viaPublicUrl = false): Promise<{ bucket: Bucket; object: StoredObject }> {
    validateObjectPath(path);
    const bucket = await this.findBucket(db, bucketName);
    const object = bucket && (await this.findObject(db, bucketName, path));
    if (!bucket || !object) throw notFound('Object');
    const allowed = viaPublicUrl ? bucket.public : isService(actor) || bucket.public || (actor.userId !== null && object.owner_id === actor.userId);
    if (!allowed) throw notFound('Object');
    return { bucket, object };
  }

  async read(projectId: string, object: StoredObject, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
    try {
      return await this.backend.read(this.keyOf(projectId, object.id), range);
    } catch (err) {
      if (err instanceof ObjectMissingError) throw notFound('Object'); // row without file (e.g. restored from a partial backup)
      throw err;
    }
  }

  async remove(db: Database, projectId: string, actor: Actor, bucketName: string, path: string): Promise<void> {
    validateObjectPath(path);
    const object = await this.findObject(db, bucketName, path);
    const mine = object && actor.userId !== null && object.owner_id === actor.userId;
    if (!object || !(isService(actor) || mine)) throw notFound('Object');
    await db.run('DELETE FROM _storage_objects WHERE id = ?', [object.id]);
    await this.backend.remove(this.keyOf(projectId, object.id));
  }

  async list(db: Database, actor: Actor, bucketName: string, opts: ListOptions): Promise<Omit<StoredObject, 'bucket'>[]> {
    if (!isService(actor) && actor.role !== 'authenticated') throw forbidden();
    await this.requireBucket(db, bucketName);
    const where = ['bucket = ?'];
    const params: (string | number)[] = [bucketName];
    if (opts.prefix) {
      where.push(`path LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLike(opts.prefix)}%`);
    }
    if (opts.search) {
      where.push(`path LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(opts.search)}%`);
    }
    if (!isService(actor)) {
      where.push('owner_id = ?');
      params.push(actor.userId!);
    }
    const sortColumn = { path: 'path', created_at: 'created_at', size: 'size' }[opts.sortBy]; // whitelisted, never user text
    const rows = await db.all<StoredObject>(
      `SELECT * FROM _storage_objects WHERE ${where.join(' AND ')} ORDER BY ${sortColumn} ${opts.descending ? 'DESC' : 'ASC'}, id LIMIT ? OFFSET ?`,
      [...params, opts.limit, opts.offset],
    );
    return rows.map(({ bucket: _bucket, ...rest }) => rest);
  }
}

/** Ensures the (user-supplied) bucket name has the right shape before it reaches a query. */
export const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
export function requireBucketName(name: string | undefined): string {
  if (!name || !BUCKET_NAME_RE.test(name)) throw notFound('Bucket');
  return name;
}
