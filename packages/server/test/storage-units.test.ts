import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { LocalDiskBackend, ObjectMissingError, PayloadTooLargeError } from '../src/storage/backend.js';
import {
  contentDisposition,
  contentMatchesMime,
  isInlineSafe,
  mimeAllowed,
  normalizeMime,
  objectPathFromUrl,
  parseRange,
  validateObjectPath,
} from '../src/storage/files.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError: ${e}`;
  }
  return 'ok';
};

describe('validateObjectPath', () => {
  it.each(['a.png', 'avatars/me/photo.png', 'a b/c d.txt', 'Ünïcödé/한글.png', '.hidden', 'a..b', 'x'.repeat(255)])('accepts %s', (p) => {
    expect(code(() => validateObjectPath(p))).toBe('ok');
  });

  it.each([
    ['empty', ''],
    ['leading slash', '/a'],
    ['trailing slash', 'a/'],
    ['double slash', 'a//b'],
    ['dot segment', 'a/./b'],
    ['dot-dot segment', 'a/../b'],
    ['leading dot-dot', '../etc/passwd'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['too long segment', 'x'.repeat(256)],
    ['too long path', `${'a/'.repeat(600)}b`],
    ['too deep', Array(25).fill('a').join('/')],
  ])('rejects %s', (_label, p) => {
    expect(code(() => validateObjectPath(p))).toBe('invalid_path');
  });
});

describe('objectPathFromUrl', () => {
  const at = (path: string, skip = 3) => objectPathFromUrl(`http://x${path}`, skip);

  it('extracts and decodes the path after the bucket', () => {
    expect(at('/storage/object/avatars/a/b.png')).toBe('a/b.png');
    expect(at('/storage/object/avatars/a%20b/%ED%95%9C.png')).toBe('a b/한.png');
    expect(at('/admin/projects/p/storage/object/b/x.png', 6)).toBe('x.png');
  });

  it('keeps an encoded slash inside its segment and rejects it', () => {
    expect(code(() => at('/storage/object/avatars/a%2Fb.png'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/..%2F..%2Fsecret'))).toBe('invalid_path');
  });

  it('rejects traversal in plain and encoded form, and bad encodings', () => {
    expect(code(() => at('/storage/object/avatars/a/../b'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/%2e%2e/b'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/%2E%2E'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/%zz'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/a%00b'))).toBe('invalid_path');
    expect(code(() => at('/storage/object/avatars/'))).toBe('invalid_path');
  });
});

describe('content types', () => {
  it('normalises declared types', () => {
    expect(normalizeMime('Image/PNG; charset=binary')).toBe('image/png');
    expect(normalizeMime(undefined)).toBe('application/octet-stream');
    expect(normalizeMime('')).toBe('application/octet-stream');
    expect(normalizeMime('application/vnd.api+json')).toBe('application/vnd.api+json');
  });

  it('rejects malformed types', () => {
    for (const bad of ['png', 'image/', '/png', 'image/png/extra', 'text/html\r\nX-Evil: 1', 'a b/c', `x/${'y'.repeat(130)}`]) {
      expect(code(() => normalizeMime(bad)), bad).toBe('invalid_content_type');
    }
  });

  it('matches allow-lists with wildcards', () => {
    expect(mimeAllowed('image/png', null)).toBe(true);
    expect(mimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeAllowed('image/png', ['image/png', 'audio/*'])).toBe(true);
    expect(mimeAllowed('text/html', ['image/*'])).toBe(false);
    expect(mimeAllowed('imagex/png', ['image/*'])).toBe(false);
    expect(mimeAllowed('image/svg+xml', ['image/png'])).toBe(false);
  });

  it('checks file signatures for the types that have one', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const html = new TextEncoder().encode('<html><script>alert(1)</script>');
    expect(contentMatchesMime('image/png', png)).toBe(true);
    expect(contentMatchesMime('image/png', html)).toBe(false);
    expect(contentMatchesMime('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(contentMatchesMime('image/gif', new TextEncoder().encode('GIF89a'))).toBe(true);
    expect(contentMatchesMime('application/pdf', new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(contentMatchesMime('application/pdf', html)).toBe(false);
    const webp = Uint8Array.from([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP')]);
    expect(contentMatchesMime('image/webp', webp)).toBe(true);
    expect(contentMatchesMime('image/webp', new TextEncoder().encode('RIFF....WAVE'))).toBe(false);
    expect(contentMatchesMime('text/plain', html)).toBe(true); // no signature to check
    expect(contentMatchesMime('image/png', new Uint8Array())).toBe(false); // empty file cannot be a PNG
  });

  it('only lets safe types render inline', () => {
    for (const ok of ['image/png', 'image/jpeg', 'audio/mpeg', 'video/mp4', 'application/pdf', 'text/plain']) expect(isInlineSafe(ok), ok).toBe(true);
    for (const bad of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'application/octet-stream']) {
      expect(isInlineSafe(bad), bad).toBe(false);
    }
  });
});

describe('contentDisposition', () => {
  it('uses the file name, with an ASCII fallback and an encoded UTF-8 name', () => {
    expect(contentDisposition('inline', 'a/b/photo.png')).toBe(`inline; filename="photo.png"; filename*=UTF-8''photo.png`);
    expect(contentDisposition('attachment', '한글 파일.png')).toBe(`attachment; filename="__ __.png"; filename*=UTF-8''%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.png`);
  });

  it('cannot be used to inject headers or break out of the quoted name', () => {
    const header = contentDisposition('attachment', 'a"; filename="evil.exe\r\nX-Evil: 1.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/filename="[^"]*"/g)).toHaveLength(1);
    expect(header).not.toContain('evil.exe"');
  });
});

describe('parseRange', () => {
  it('parses single ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('flags unsatisfiable ranges and ignores unsupported syntax', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=50-10', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1', 0)).toBe('invalid');
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-9', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
  });
});

describe('LocalDiskBackend', () => {
  let root: string;
  let backend: LocalDiskBackend;
  const project = 'abcdefghij012345';
  const key = (id: string) => `${project}/${id}`;
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
  const slurp = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer()).toString();
  const storageDir = () => join(root, project, 'storage');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sbb-store-'));
    backend = new LocalDiskBackend(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores, reads (whole and ranged) and removes', async () => {
    const res = await backend.put(key(ID), stream('hello ', 'world'), { maxBytes: 100 });
    expect(res.size).toBe(11);
    expect(Buffer.from(res.head).toString()).toBe('hello world');
    expect(await slurp(await backend.read(key(ID)))).toBe('hello world');
    expect(await slurp(await backend.read(key(ID), { start: 6, end: 10 }))).toBe('world');
    await backend.remove(key(ID));
    await expect(backend.read(key(ID))).rejects.toBeInstanceOf(ObjectMissingError);
    await backend.remove(key(ID)); // idempotent
  });

  it('keeps only the first 16 bytes as the head', async () => {
    const res = await backend.put(key(ID), stream('x'.repeat(50)), { maxBytes: 100 });
    expect(res.head.length).toBe(16);
  });

  it('stores empty files', async () => {
    const res = await backend.put(key(ID), stream(), { maxBytes: 100 });
    expect(res.size).toBe(0);
    expect(await slurp(await backend.read(key(ID)))).toBe('');
  });

  it('enforces the size limit while streaming and leaves nothing behind', async () => {
    await expect(backend.put(key(ID), stream('a'.repeat(60), 'b'.repeat(60)), { maxBytes: 100 })).rejects.toBeInstanceOf(PayloadTooLargeError);
    const entries = await readdir(storageDir());
    expect(entries.filter((e) => e !== '.tmp')).toEqual([]);
    expect(await readdir(join(storageDir(), '.tmp'))).toEqual([]);
  });

  it('cleans up when the source stream fails midway', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('partial'));
      },
      pull() {
        throw new Error('connection reset');
      },
    });
    await expect(backend.put(key(ID), broken, { maxBytes: 100 })).rejects.toThrow();
    expect((await readdir(storageDir())).filter((e) => e !== '.tmp')).toEqual([]);
    expect(await readdir(join(storageDir(), '.tmp'))).toEqual([]);
  });

  it('files are named by id inside the project storage directory', async () => {
    await backend.put(key(ID), stream('x'), { maxBytes: 10 });
    expect(await readFile(join(storageDir(), ID), 'utf8')).toBe('x');
  });

  it('refuses keys that could escape the storage directory', async () => {
    for (const bad of [
      '../../etc/passwd',
      `${project}/../../x`,
      `${project}/${ID}/../x`,
      `${project}/not-a-uuid`,
      `${project.toUpperCase()}/${ID}`,
      `${project}\\${ID}`,
      `${project}/${ID}\0`,
      '',
    ]) {
      await expect(backend.put(bad, stream('x'), { maxBytes: 10 })).rejects.toThrow('Invalid storage');
      await expect(backend.read(bad)).rejects.toThrow('Invalid storage');
      await expect(backend.remove(bad)).rejects.toThrow('Invalid storage');
    }
  });
});
