import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Upload exceeds ${limit} bytes`);
  }
}

export class ObjectMissingError extends Error {}

/** First bytes of an upload, kept so the content type can be sanity-checked against the real data. */
export const HEAD_BYTES = 16;

/**
 * Where file bytes are stored. Keys look like `<projectId>/<objectId>`. The local-disk
 * implementation below is the default; an S3-compatible backend only needs these four methods.
 */
export interface StorageBackend {
  /** Streams `body` into storage; rejects with PayloadTooLargeError (storing nothing) once `maxBytes` is exceeded. */
  put(key: string, body: ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<{ size: number; head: Uint8Array }>;
  /** Streams the object (optionally an inclusive byte range). Rejects with ObjectMissingError if it does not exist. */
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  /** Idempotent. */
  remove(key: string): Promise<void>;
}

const KEY_RE = /^([a-z0-9]{16})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Files live at `<root>/<projectId>/storage/<objectId>` (root = the server's `projects` directory). */
export class LocalDiskBackend implements StorageBackend {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The format check makes path traversal impossible; the prefix check is a second, independent guard. */
  private locate(key: string): { dir: string; file: string } {
    const m = KEY_RE.exec(key);
    if (!m) throw new Error('Invalid storage key');
    const dir = join(this.root, m[1]!, 'storage');
    const file = join(dir, m[2]!);
    if (!file.startsWith(this.root + sep)) throw new Error('Invalid storage path');
    return { dir, file };
  }

  async put(key: string, body: ReadableStream<Uint8Array>, opts: { maxBytes: number }) {
    const { dir, file } = this.locate(key);
    const tmp = join(dir, '.tmp', randomUUID());
    await mkdir(dirname(tmp), { recursive: true });

    let size = 0;
    let head = Buffer.alloc(0);
    const gate = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) return cb(new PayloadTooLargeError(opts.maxBytes));
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), gate, createWriteStream(tmp, { flags: 'wx' }));
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { size, head: new Uint8Array(head) };
  }

  async read(key: string, range?: { start: number; end: number }) {
    const { file } = this.locate(key);
    try {
      await stat(file);
    } catch {
      throw new ObjectMissingError();
    }
    return Readable.toWeb(createReadStream(file, range)) as unknown as ReadableStream<Uint8Array>;
  }

  async remove(key: string) {
    await rm(this.locate(key).file, { force: true });
  }
}
