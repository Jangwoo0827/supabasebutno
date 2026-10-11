import { SbbError, attempt, type Result } from './errors.js';
import type { Http } from './http.js';

export interface FileObject {
  id: string;
  /** Path within the bucket, e.g. `avatars/me/photo.png`. */
  path: string;
  size: number;
  mime_type: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Bucket {
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface BucketOptions {
  public?: boolean;
  /** Largest file in bytes. `null` = only the server-wide limit. */
  file_size_limit?: number | null;
  /** e.g. `['image/png', 'audio/*']`. `null` = anything. */
  allowed_mime_types?: string[] | null;
}

export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>;

export interface ListOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'path' | 'created_at' | 'size';
  descending?: boolean;
  /** Only names containing this text. */
  search?: string;
}

/** `a b/c.png` -> `a%20b/c.png`: each segment encoded, separators kept. */
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

function contentTypeOf(body: UploadBody, explicit?: string): string {
  if (explicit) return explicit;
  if (typeof Blob !== 'undefined' && body instanceof Blob && body.type) return body.type;
  if (typeof body === 'string') return 'text/plain;charset=UTF-8';
  return 'application/octet-stream';
}

/**
 * Files of one bucket. Users upload and manage their own files; reading depends on the
 * bucket: public buckets can be read by anyone (see getPublicUrl), private ones only by the owner.
 */
export class BucketClient {
  constructor(
    private readonly http: Http,
    private readonly projectRef: string,
    private readonly bucket: string,
  ) {}

  private objectPath(path: string) {
    return `/storage/object/${encodeURIComponent(this.bucket)}/${encodePath(path)}`;
  }

  /** Uploads raw bytes. The Content-Type is taken from `options.contentType`, or from the Blob/File itself. */
  upload(path: string, body: UploadBody, options: { contentType?: string; upsert?: boolean } = {}): Promise<Result<FileObject>> {
    return attempt(async () => {
      if (typeof FormData !== 'undefined' && (body as unknown) instanceof FormData) {
        throw new SbbError('Upload the file itself (a Blob, File, ArrayBuffer or string), not a FormData', 'invalid_argument', 0);
      }
      const headers: Record<string, string> = { 'Content-Type': contentTypeOf(body, options.contentType) };
      if (options.upsert) headers['x-upsert'] = 'true';
      const { data } = await this.http.request<FileObject>({ method: 'POST', path: this.objectPath(path), headers, body: body as BodyInit });
      return data;
    });
  }

  /** Downloads a file you are allowed to read (your own, or any file of a public bucket). */
  download(path: string): Promise<Result<Blob>> {
    return attempt(async () => (await this.http.request<Blob>({ method: 'GET', path: this.objectPath(path), responseType: 'blob' })).data);
  }

  /** Deletes files you own. Stops at the first failure; `data` lists the paths removed so far. */
  remove(paths: string[]): Promise<Result<string[]>> {
    return attempt(async () => {
      const removed: string[] = [];
      for (const path of paths) {
        await this.http.request({ method: 'DELETE', path: this.objectPath(path), responseType: 'none' });
        removed.push(path);
      }
      return removed;
    });
  }

  /** Lists your own files (all files with a service key). `prefix` limits to a folder-like path start, e.g. `'avatars/'`. */
  list(prefix = '', options: ListOptions = {}): Promise<Result<FileObject[]>> {
    return attempt(
      async () =>
        (
          await this.http.request<FileObject[]>({
            method: 'POST',
            path: `/storage/list/${encodeURIComponent(this.bucket)}`,
            json: { prefix: prefix || undefined, search: options.search, limit: options.limit, offset: options.offset, sort_by: options.sortBy, descending: options.descending },
          })
        ).data,
    );
  }

  /**
   * URL that serves a file of a PUBLIC bucket to anyone, with no API key, e.g. as `<img src>`.
   * It is computed locally; for a private bucket the URL answers 404.
   */
  getPublicUrl(path: string, options: { download?: boolean } = {}): { data: { publicUrl: string } } {
    const url = `${this.http.url}/storage/public/${this.projectRef}/${encodeURIComponent(this.bucket)}/${encodePath(path)}`;
    return { data: { publicUrl: options.download ? `${url}?download` : url } };
  }
}

/** `client.storage`: `from(bucket)` for files, plus bucket management (needs the service key, keep it on the server). */
export class StorageClient {
  constructor(
    private readonly http: Http,
    private readonly projectRef: string,
  ) {}

  from(bucket: string): BucketClient {
    return new BucketClient(this.http, this.projectRef, bucket);
  }

  listBuckets(): Promise<Result<Bucket[]>> {
    return attempt(async () => (await this.http.request<{ buckets: Bucket[] }>({ method: 'GET', path: '/storage/buckets' })).data.buckets);
  }

  getBucket(name: string): Promise<Result<Bucket>> {
    return attempt(async () => (await this.http.request<Bucket>({ method: 'GET', path: `/storage/buckets/${encodeURIComponent(name)}` })).data);
  }

  createBucket(name: string, options: BucketOptions = {}): Promise<Result<Bucket>> {
    return attempt(async () => (await this.http.request<Bucket>({ method: 'POST', path: '/storage/buckets', json: { name, ...options } })).data);
  }

  updateBucket(name: string, options: BucketOptions): Promise<Result<Bucket>> {
    return attempt(async () => (await this.http.request<Bucket>({ method: 'PATCH', path: `/storage/buckets/${encodeURIComponent(name)}`, json: options })).data);
  }

  /** With `force`, files inside are deleted too. */
  deleteBucket(name: string, options: { force?: boolean } = {}): Promise<Result<null>> {
    return attempt(async () => {
      await this.http.request({ method: 'DELETE', path: `/storage/buckets/${encodeURIComponent(name)}`, query: new URLSearchParams(options.force ? { force: 'true' } : {}), responseType: 'none' });
      return null;
    });
  }
}
