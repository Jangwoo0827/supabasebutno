import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
let project: Awaited<ReturnType<TestApp['createProject']>>;
let alice: { id: string; token: string };
let bob: { id: string; token: string };

const PASSWORD = 'correct horse battery';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);

beforeEach(async () => {
  t = await makeTestApp();
  project = await t.createProject('files-app');
  const make = async (email: string) => {
    const res = await t.call('POST', '/auth/signup', { body: { email, password: PASSWORD }, headers: { apikey: project.keys.anon } });
    return { id: res.json.user.id as string, token: res.json.access_token as string };
  };
  alice = await make('alice@example.com');
  bob = await make('bob@example.com');
});
afterEach(async () => {
  await t.close();
});

type Who = 'anon' | 'service' | typeof alice;
const headersFor = (who: Who): Record<string, string> => {
  if (who === 'service') return { apikey: project.keys.service_role };
  const h: Record<string, string> = { apikey: project.keys.anon };
  if (who !== 'anon') h.authorization = `Bearer ${who.token}`;
  return h;
};

/** Binary-capable request (t.call only does JSON). */
async function raw(method: string, path: string, opts: { headers?: Record<string, string>; body?: RequestInit['body']; stream?: boolean } = {}) {
  const init: RequestInit & { duplex?: 'half' } = { method, headers: opts.headers, body: opts.body ?? undefined };
  if (opts.stream) init.duplex = 'half';
  const res = await t.app.request(path, init);
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = bytes.length ? JSON.parse(bytes.toString()) : null;
  } catch {
    /* binary */
  }
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString(), json };
}

const upload = (who: Who, bucket: string, path: string, body: Buffer | string | null, extra: Record<string, string> = {}) =>
  raw('POST', `/storage/object/${bucket}/${path}`, {
    headers: { ...headersFor(who), 'content-type': 'image/png', ...extra },
    body: body === null ? null : typeof body === 'string' ? body : new Uint8Array(body),
  });
const download = (who: Who, bucket: string, path: string, extra: Record<string, string> = {}) =>
  raw('GET', `/storage/object/${bucket}/${path}`, { headers: { ...headersFor(who), ...extra } });
const publicUrl = (bucket: string, path: string, pid = () => project.id) => `/storage/public/${pid()}/${bucket}/${path}`;
const api = (method: string, path: string, who: Who, body?: unknown) => t.call(method, path, { body, headers: headersFor(who) });
const bucket = (name: string, opts: Record<string, unknown> = {}) => api('POST', '/storage/buckets', 'service', { name, ...opts });

/** Files physically on disk for this project (excluding the temp area). */
async function filesOnDisk() {
  const dir = join(t.dataDir, 'projects', project.id, 'storage');
  try {
    return (await readdir(dir)).filter((n) => n !== '.tmp');
  } catch {
    return [];
  }
}
const tempFiles = async () => {
  try {
    return await readdir(join(t.dataDir, 'projects', project.id, 'storage', '.tmp'));
  } catch {
    return [];
  }
};

describe('buckets', () => {
  it('are created, read, updated and listed by service_role', async () => {
    const created = await bucket('avatars', { public: true, file_size_limit: 5000, allowed_mime_types: ['Image/PNG', 'image/jpeg'] });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'avatars', public: true, file_size_limit: 5000, allowed_mime_types: ['image/png', 'image/jpeg'] });

    expect((await api('GET', '/storage/buckets/avatars', 'service')).json.name).toBe('avatars');
    expect((await api('GET', '/storage/buckets', 'service')).json.buckets).toHaveLength(1);

    const patched = await api('PATCH', '/storage/buckets/avatars', 'service', { public: false, file_size_limit: null, allowed_mime_types: null });
    expect(patched.json).toMatchObject({ public: false, file_size_limit: null, allowed_mime_types: null });
  });

  it('default to private with no limits', async () => {
    expect((await bucket('docs')).json).toMatchObject({ public: false, file_size_limit: null, allowed_mime_types: null });
  });

  it('cannot be managed with anon or user keys', async () => {
    await bucket('docs');
    for (const who of ['anon', alice] as const) {
      expect((await api('GET', '/storage/buckets', who)).status).toBe(403);
      expect((await api('POST', '/storage/buckets', who, { name: 'mine' })).status).toBe(403);
      expect((await api('PATCH', '/storage/buckets/docs', who, { public: true })).status).toBe(403);
      expect((await api('DELETE', '/storage/buckets/docs', who)).status).toBe(403);
    }
    expect((await api('GET', '/storage/buckets/docs', 'service')).json.public).toBe(false);
  });

  it('validate names and settings, and reject duplicates', async () => {
    for (const name of ['', 'a', 'Upper', '-lead', 'has space', 'a/b', '../x', 'x'.repeat(64), 'tab\t']) {
      expect((await bucket(name)).status, JSON.stringify(name)).toBe(400);
    }
    for (const extra of [{ file_size_limit: 0 }, { file_size_limit: -5 }, { file_size_limit: 1.5 }, { allowed_mime_types: [] }, { allowed_mime_types: ['png'] }, { allowed_mime_types: ['image/'] }, { public: 'yes' }, { owner: 'x' }]) {
      expect((await bucket('ok', extra)).status, JSON.stringify(extra)).toBe(400);
    }
    await bucket('docs');
    const dup = await bucket('docs');
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('bucket_exists');
    expect((await api('PATCH', '/storage/buckets/docs', 'service', {})).status).toBe(400);
  });

  it('refuse to delete a bucket that still holds files, unless forced; forcing also removes the bytes', async () => {
    await bucket('docs');
    await upload(alice, 'docs', 'a.png', PNG);
    await upload(alice, 'docs', 'b.png', PNG);
    expect(await filesOnDisk()).toHaveLength(2);

    const refused = await api('DELETE', '/storage/buckets/docs', 'service');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('bucket_not_empty');
    expect(await filesOnDisk()).toHaveLength(2);

    expect((await raw('DELETE', '/storage/buckets/docs?force=true', { headers: headersFor('service') })).status).toBe(204);
    expect(await filesOnDisk()).toEqual([]);
    expect((await api('GET', '/storage/buckets/docs', 'service')).status).toBe(404);
  });

  it('empty buckets delete without force', async () => {
    await bucket('docs');
    expect((await api('DELETE', '/storage/buckets/docs', 'service')).status).toBe(204);
  });
});

describe('uploading', () => {
  beforeEach(async () => void (await bucket('docs')));

  it('lets signed-in users upload and records them as owner', async () => {
    const res = await upload(alice, 'docs', 'me/avatar.png', PNG);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ bucket: 'docs', path: 'me/avatar.png', size: PNG.length, mime_type: 'image/png', owner_id: alice.id });
    expect(res.json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await filesOnDisk()).toEqual([res.json.id]); // stored under its id, not its path
  });

  it('refuses anon before reading the body', async () => {
    const res = await upload('anon', 'docs', 'x.png', PNG);
    expect(res.status).toBe(403);
    expect(await filesOnDisk()).toEqual([]);
    expect(await tempFiles()).toEqual([]);
  });

  it('lets service_role upload (no owner)', async () => {
    const res = await upload('service', 'docs', 'x.png', PNG);
    expect(res.status).toBe(201);
    expect(res.json.owner_id).toBeNull();
  });

  it('404s for unknown buckets and 400s for bad paths, without touching the disk', async () => {
    expect((await upload(alice, 'nope', 'a.png', PNG)).status).toBe(404);
    // (Plain "." / ".." / backslash are resolved by the HTTP client or URL parser before the request arrives;
    // the raw forms are covered in storage-units.test.ts.)
    const bad = ['a%2Fb.png', 'a//b.png', 'a%00b.png', 'a%5Cb.png', 'a%0Ab.png', `${'x'.repeat(300)}.png`];
    for (const p of bad) {
      const res = await upload(alice, 'docs', p, PNG);
      // 400 from our validation; a decoded newline never even matches a route (404). Either way: refused.
      expect([400, 404], p).toContain(res.status);
      if (res.status === 400) expect(res.json.error.code, p).toBe('invalid_path');
    }
    expect(await filesOnDisk()).toEqual([]);
  });

  it('accepts unicode paths and spaces', async () => {
    const res = await upload(alice, 'docs', encodeURIComponent('한글 폴더') + '/' + encodeURIComponent('파일 1.png'), PNG);
    expect(res.status).toBe(201);
    expect(res.json.path).toBe('한글 폴더/파일 1.png');
  });

  it('rejects collisions unless upsert is requested', async () => {
    await upload(alice, 'docs', 'a.png', PNG);
    const dup = await upload(alice, 'docs', 'a.png', PNG);
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('object_exists');
    expect(await filesOnDisk()).toHaveLength(1); // the rejected upload left no file behind
    expect(await tempFiles()).toEqual([]);
  });

  it('upsert replaces the file for its owner, deleting the old bytes and changing the ETag', async () => {
    const first = await upload(alice, 'docs', 'a.png', PNG);
    const bigger = Buffer.concat([PNG, Buffer.alloc(50, 9)]);
    const second = await upload(alice, 'docs', 'a.png', bigger, { 'x-upsert': 'true' });
    expect(second.status).toBe(201);
    expect(second.json.id).not.toBe(first.json.id);
    expect(second.json.size).toBe(bigger.length);
    expect(second.json.created_at).toBe(first.json.created_at);
    expect(await filesOnDisk()).toEqual([second.json.id]);
    expect((await download(alice, 'docs', 'a.png')).bytes.equals(bigger)).toBe(true);
  });

  it('upsert by someone else is just a collision (no information, no overwrite)', async () => {
    await upload(alice, 'docs', 'a.png', PNG);
    const res = await upload(bob, 'docs', 'a.png', Buffer.concat([PNG, Buffer.alloc(5)]), { 'x-upsert': 'true' });
    expect(res.status).toBe(409);
    expect((await download(alice, 'docs', 'a.png')).bytes.equals(PNG)).toBe(true);
    expect(await filesOnDisk()).toHaveLength(1);
    // service_role may overwrite anything
    expect((await upload('service', 'docs', 'a.png', PNG, { 'x-upsert': 'true' })).status).toBe(201);
  });

  it('stores empty files', async () => {
    const res = await upload(alice, 'docs', 'empty.txt', null, { 'content-type': 'text/plain' });
    expect(res.status).toBe(201);
    expect(res.json.size).toBe(0);
    expect((await download(alice, 'docs', 'empty.txt')).bytes.length).toBe(0);
  });

  it('defaults to application/octet-stream and rejects multipart forms and junk types', async () => {
    const noType = await raw('POST', '/storage/object/docs/blob.bin', { headers: headersFor(alice), body: new Uint8Array([1, 2, 3]) });
    expect(noType.status).toBe(201);
    expect(noType.json.mime_type === 'application/octet-stream' || noType.json.mime_type === 'text/plain').toBe(true);
    expect((await upload(alice, 'docs', 'f.bin', 'x', { 'content-type': 'multipart/form-data; boundary=x' })).status).toBe(415);
    expect((await upload(alice, 'docs', 'g.bin', 'x', { 'content-type': 'not a type' })).status).toBe(400);
  });

  it('is not subject to the 100 kB JSON body limit, while JSON endpoints still are', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(300_000, 1)]);
    expect((await upload(alice, 'docs', 'big.png', big)).status).toBe(201);
    const tooBigJson = await t.call('POST', '/storage/buckets', { body: { name: 'x', junk: 'y'.repeat(200_000) }, headers: headersFor('service') });
    expect(tooBigJson.status).toBe(413);
  });
});

describe('upload limits', () => {
  it('enforce the bucket size limit from Content-Length, before any bytes are stored', async () => {
    await bucket('small', { file_size_limit: 200 });
    const res = await upload(alice, 'small', 'a.png', Buffer.concat([PNG, Buffer.alloc(500)]));
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('payload_too_large');
    expect(await filesOnDisk()).toEqual([]);
  });

  it('enforce it while streaming when no Content-Length is announced, and clean up', async () => {
    await bucket('small', { file_size_limit: 200 });
    const chunks = [PNG, Buffer.alloc(100, 1), Buffer.alloc(100, 2)];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new Uint8Array(ch));
        c.close();
      },
    });
    const res = await raw('POST', '/storage/object/small/stream.png', { headers: { ...headersFor(alice), 'content-type': 'image/png' }, body, stream: true });
    expect(res.status).toBe(413);
    expect(await filesOnDisk()).toEqual([]);
    expect(await tempFiles()).toEqual([]);
  });

  it('cap every bucket at MAX_UPLOAD_BYTES, even unlimited ones', async () => {
    await bucket('docs');
    const res = await upload(alice, 'docs', 'huge.png', Buffer.concat([PNG, Buffer.alloc(1_100_000)]));
    expect(res.status).toBe(413);
  });

  it('restrict content types per bucket', async () => {
    await bucket('images', { allowed_mime_types: ['image/png', 'audio/*'] });
    expect((await upload(alice, 'images', 'a.png', PNG)).status).toBe(201);
    expect((await upload(alice, 'images', 'a.mp3', 'ID3', { 'content-type': 'audio/mpeg' })).status).toBe(201);
    const html = await upload(alice, 'images', 'x.html', '<script>1</script>', { 'content-type': 'text/html' });
    expect(html.status).toBe(415);
    expect(html.json.error.code).toBe('unsupported_media_type');
    expect((await upload(alice, 'images', 'x.svg', '<svg/>', { 'content-type': 'image/svg+xml' })).status).toBe(415);
    expect(await filesOnDisk()).toHaveLength(2);
  });

  it('reject content that does not match the declared image type (HTML disguised as PNG)', async () => {
    await bucket('images', { allowed_mime_types: ['image/*'] });
    const res = await upload(alice, 'images', 'evil.png', '<html><script>alert(document.cookie)</script></html>');
    expect(res.status).toBe(415);
    expect(res.json.error.code).toBe('content_mismatch');
    expect(await filesOnDisk()).toEqual([]);
    expect(await tempFiles()).toEqual([]);
    expect((await api('POST', '/storage/list/images', 'service')).json).toEqual([]);
  });

  // Test config: 1 MB per file, 5 MB per user, 20 MB per project.
  const sized = (bytes: number) => Buffer.concat([PNG, Buffer.alloc(bytes - PNG.length, 3)]);

  it('enforce per-user quotas, counting replacements by their difference', async () => {
    await bucket('docs');
    for (const i of [1, 2, 3, 4, 5]) expect((await upload(alice, 'docs', `f${i}.png`, sized(1_000_000))).status).toBe(201);
    const over = await upload(alice, 'docs', 'f6.png', sized(1_000));
    expect(over.status).toBe(413);
    expect(over.json.error.code).toBe('quota_exceeded');
    expect(await filesOnDisk()).toHaveLength(5); // the rejected bytes were not kept

    // replacing a file frees its old size first
    expect((await upload(alice, 'docs', 'f1.png', sized(400_000), { 'x-upsert': 'true' })).status).toBe(201);
    expect((await upload(alice, 'docs', 'f6.png', sized(500_000))).status).toBe(201);
    expect((await upload(alice, 'docs', 'f7.png', sized(200_000))).status).toBe(413);

    // other users have their own allowance, and service_role is exempt
    expect((await upload(bob, 'docs', 'b.png', sized(1_000_000))).status).toBe(201);
    expect((await upload('service', 'docs', 's.png', sized(1_000_000))).status).toBe(201);
  });

  it('enforce the per-project quota across users', async () => {
    await bucket('docs');
    const users = [alice, bob];
    for (const n of [3, 4, 5]) {
      const res = await t.call('POST', '/auth/signup', { body: { email: `user${n}@example.com`, password: PASSWORD }, headers: { apikey: project.keys.anon } });
      users.push({ id: res.json.user.id, token: res.json.access_token });
    }
    // four users fill 5 MB each = 20 MB, the whole project quota
    for (const [i, user] of users.slice(0, 4).entries()) {
      for (const j of [1, 2, 3, 4, 5]) expect((await upload(user, 'docs', `u${i}-${j}.png`, sized(1_000_000))).status).toBe(201);
    }
    const res = await upload(users[4]!, 'docs', 'late.png', sized(1_000));
    expect(res.status).toBe(413);
    expect(res.json.error.message).toMatch(/project/);
  });

  it('count quotas even when the size is not announced', async () => {
    await bucket('docs');
    for (let i = 0; i < 4; i++) await upload(alice, 'docs', `f${i}.png`, sized(1_000_000));
    await upload(alice, 'docs', 'f4.png', sized(500_000)); // 4.5 MB used
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(sized(900_000)));
        c.close();
      },
    });
    const res = await raw('POST', '/storage/object/docs/streamed.png', { headers: { ...headersFor(alice), 'content-type': 'image/png' }, body, stream: true });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('quota_exceeded');
    expect(await filesOnDisk()).toHaveLength(5);
    expect(await tempFiles()).toEqual([]);
  });

  it('rate-limit uploads per signed-in user', async () => {
    await bucket('docs');
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await upload(alice, 'docs', `n${i}.png`, PNG)).status;
    expect(last).toBe(429);
  });
});

describe('downloading', () => {
  it('serves public buckets to anyone with an apikey, and via the key-less public URL', async () => {
    await bucket('pub', { public: true });
    await upload(alice, 'pub', 'dir/pic.png', PNG);

    for (const who of ['anon', alice, bob, 'service'] as const) {
      const res = await download(who, 'pub', 'dir/pic.png');
      expect(res.status).toBe(200);
      expect(res.bytes.equals(PNG)).toBe(true);
    }
    const noKey = await raw('GET', publicUrl('pub', 'dir/pic.png'));
    expect(noKey.status).toBe(200);
    expect(noKey.bytes.equals(PNG)).toBe(true);
    expect(noKey.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('keeps private buckets private: owner and service only, others get a plain 404', async () => {
    await bucket('priv');
    await upload(alice, 'priv', 'secret.png', PNG);
    expect((await download(alice, 'priv', 'secret.png')).status).toBe(200);
    expect((await download('service', 'priv', 'secret.png')).status).toBe(200);
    const missing = await download(bob, 'priv', 'nothing-here.png');
    for (const who of ['anon', bob] as const) {
      const res = await download(who, 'priv', 'secret.png');
      expect(res.status).toBe(404);
      expect(res.json.error).toMatchObject({ code: missing.json.error.code, message: missing.json.error.message }); // indistinguishable from a missing file
    }
    // the key-less public URL never serves private buckets, even for the owner
    expect((await raw('GET', publicUrl('priv', 'secret.png'))).status).toBe(404);
  });

  it('answers the same 404 for unknown projects, buckets and files on the public URL', async () => {
    await bucket('pub', { public: true });
    await bucket('priv');
    await upload(alice, 'priv', 'a.png', PNG);
    const bodies = new Set<string>();
    for (const path of [publicUrl('pub', 'ghost.png'), publicUrl('priv', 'a.png'), publicUrl('nope', 'a.png'), `/storage/public/aaaaaaaaaaaaaaaa/pub/a.png`, '/storage/public/..%2F/pub/a.png']) {
      const res = await raw('GET', path);
      expect(res.status, path).toBe(404);
      bodies.add(JSON.stringify(res.json.error.code));
    }
    expect(bodies.size).toBe(1);
  });

  it('sets headers that stop stored files from attacking the origin', async () => {
    await bucket('pub', { public: true });
    await upload(alice, 'pub', 'pic.png', PNG);
    const png = await download('anon', 'pub', 'pic.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(png.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(png.headers.get('content-security-policy')).toContain('sandbox');
    expect(png.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(png.headers.get('cross-origin-resource-policy')).toBe('same-origin'); // only the public URL opts out
    expect(png.headers.get('cache-control')).toBe('public, max-age=60');

    // HTML and SVG are served as downloads, never rendered on our origin
    await bucket('any', { public: true });
    await upload(alice, 'any', 'page.html', '<script>alert(1)</script>', { 'content-type': 'text/html' });
    await upload(alice, 'any', 'logo.svg', '<svg onload="alert(1)"/>', { 'content-type': 'image/svg+xml' });
    for (const [file, type] of [['page.html', 'text/html'], ['logo.svg', 'image/svg+xml']]) {
      const res = await download('anon', 'any', file!);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await download('anon', 'pub', 'pic.png?download')).headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('never caches private files', async () => {
    await bucket('priv');
    await upload(alice, 'priv', 'a.png', PNG);
    expect((await download(alice, 'priv', 'a.png')).headers.get('cache-control')).toBe('private, no-store');
  });

  it('supports conditional requests', async () => {
    await bucket('pub', { public: true });
    const up = await upload(alice, 'pub', 'a.png', PNG);
    const first = await download('anon', 'pub', 'a.png');
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(`"${up.json.id}"`);
    const cached = await download('anon', 'pub', 'a.png', { 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.bytes.length).toBe(0);
    expect((await download('anon', 'pub', 'a.png', { 'if-none-match': '"other"' })).status).toBe(200);
  });

  it('supports byte ranges', async () => {
    await bucket('pub', { public: true });
    const data = Buffer.from('0123456789'.repeat(10));
    await upload(alice, 'pub', 'r.txt', data, { 'content-type': 'text/plain' });
    const part = await download('anon', 'pub', 'r.txt', { range: 'bytes=5-14' });
    expect(part.status).toBe(206);
    expect(part.text).toBe('5678901234');
    expect(part.headers.get('content-range')).toBe('bytes 5-14/100');
    expect(part.headers.get('content-length')).toBe('10');
    expect((await download('anon', 'pub', 'r.txt', { range: 'bytes=-5' })).text).toBe('56789');
    const bad = await download('anon', 'pub', 'r.txt', { range: 'bytes=500-' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */100');
    expect((await download('anon', 'pub', 'r.txt', { range: 'bytes=0-1,5-6' })).status).toBe(200); // multi-range: whole file
    expect((await download('anon', 'pub', 'r.txt')).headers.get('accept-ranges')).toBe('bytes');
  });

  it('returns the exact bytes for binary files', async () => {
    await bucket('pub', { public: true });
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await upload(alice, 'pub', 'all.bin', all, { 'content-type': 'application/octet-stream' });
    expect((await download('anon', 'pub', 'all.bin')).bytes.equals(all)).toBe(true);
  });

  it('404s when the file row exists but the bytes are gone', async () => {
    await bucket('pub', { public: true });
    const up = await upload(alice, 'pub', 'a.png', PNG);
    await t.app.request('/storage/buckets/pub', { method: 'GET', headers: headersFor('service') });
    const { rm } = await import('node:fs/promises');
    await rm(join(t.dataDir, 'projects', project.id, 'storage', up.json.id));
    expect((await download('anon', 'pub', 'a.png')).status).toBe(404);
  });

  it('turning a bucket private takes effect immediately', async () => {
    await bucket('pub', { public: true });
    await upload(alice, 'pub', 'a.png', PNG);
    expect((await download('anon', 'pub', 'a.png')).status).toBe(200);
    await api('PATCH', '/storage/buckets/pub', 'service', { public: false });
    expect((await download('anon', 'pub', 'a.png')).status).toBe(404);
    expect((await raw('GET', publicUrl('pub', 'a.png'))).status).toBe(404);
    expect((await download(alice, 'pub', 'a.png')).status).toBe(200);
  });
});

describe('deleting and listing', () => {
  beforeEach(async () => void (await bucket('docs', { public: true })));

  it('lets owners and service_role delete; everyone else sees 404 and nothing changes', async () => {
    await upload(alice, 'docs', 'a.png', PNG);
    for (const who of ['anon', bob] as const) expect((await raw('DELETE', '/storage/object/docs/a.png', { headers: headersFor(who) })).status).toBe(404);
    expect(await filesOnDisk()).toHaveLength(1);

    expect((await raw('DELETE', '/storage/object/docs/a.png', { headers: headersFor(alice) })).status).toBe(204);
    expect(await filesOnDisk()).toEqual([]);
    expect((await download(alice, 'docs', 'a.png')).status).toBe(404);
    expect((await raw('DELETE', '/storage/object/docs/a.png', { headers: headersFor(alice) })).status).toBe(404);

    await upload(alice, 'docs', 'b.png', PNG);
    expect((await raw('DELETE', '/storage/object/docs/b.png', { headers: headersFor('service') })).status).toBe(204);
  });

  it('lists only the caller own files (service_role lists all); anon cannot list', async () => {
    await upload(alice, 'docs', 'a/1.png', PNG);
    await upload(alice, 'docs', 'a/2.png', PNG);
    await upload(bob, 'docs', 'b/1.png', PNG);
    const names = (res: { json: any }) => res.json.map((o: { path: string }) => o.path);

    expect(names(await api('POST', '/storage/list/docs', alice))).toEqual(['a/1.png', 'a/2.png']);
    expect(names(await api('POST', '/storage/list/docs', bob))).toEqual(['b/1.png']);
    expect(names(await api('POST', '/storage/list/docs', 'service'))).toEqual(['a/1.png', 'a/2.png', 'b/1.png']);
    expect((await api('POST', '/storage/list/docs', 'anon')).status).toBe(403);
    expect((await api('POST', '/storage/list/ghost', 'service')).status).toBe(404);
  });

  it('filters, sorts and pages', async () => {
    for (const [p, size] of [['x/small.png', 0], ['x/big.png', 400], ['y/mid.png', 100]] as const) await upload('service', 'docs', p, Buffer.concat([PNG, Buffer.alloc(size)]));
    const list = async (body: unknown) => (await api('POST', '/storage/list/docs', 'service', body)).json.map((o: { path: string }) => o.path);
    expect(await list({ prefix: 'x/' })).toEqual(['x/big.png', 'x/small.png']);
    expect(await list({ search: 'mid' })).toEqual(['y/mid.png']);
    expect(await list({ sort_by: 'size', descending: true })).toEqual(['x/big.png', 'y/mid.png', 'x/small.png']);
    expect(await list({ limit: 1, offset: 1 })).toEqual(['x/small.png']);
    expect(await list({})).toHaveLength(3);
    expect((await api('POST', '/storage/list/docs', 'service', { limit: 0 })).status).toBe(400);
    expect((await api('POST', '/storage/list/docs', 'service', { sort_by: 'id; DROP TABLE _storage_objects' })).status).toBe(400);
  });

  it('treats LIKE wildcards in prefix and search literally', async () => {
    expect((await upload('service', 'docs', `${encodeURIComponent('100%')}/a.png`, PNG)).status).toBe(201);
    expect((await upload('service', 'docs', '1000/b.png', PNG)).status).toBe(201);
    const list = async (body: unknown) => (await api('POST', '/storage/list/docs', 'service', body)).json.map((o: { path: string }) => o.path);
    expect(await list({ prefix: '100%' })).toEqual(['100%/a.png']);
    expect(await list({ prefix: '%' })).toEqual([]);
    expect(await list({ search: '_' })).toEqual([]);
  });
});

describe('admin access (dashboard)', () => {
  it('manages buckets and files for any project with the admin token', async () => {
    const base = `/admin/projects/${project.id}/storage`;
    expect((await t.admin('POST', `/projects/${project.id}/storage/buckets`, { name: 'docs', public: true })).status).toBe(201);
    expect((await t.admin('GET', `/projects/${project.id}/storage/buckets`)).json.buckets).toHaveLength(1);

    const up = await raw('POST', `${base}/object/docs/from-admin.png`, { headers: { authorization: `Bearer ${(await import('./helpers.js')).ADMIN_TOKEN}`, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
    expect(up.status).toBe(201);
    const files = await t.admin('POST', `/projects/${project.id}/storage/list/docs`, {});
    expect(files.json.map((o: { path: string }) => o.path)).toEqual(['from-admin.png']);
    const dl = await raw('GET', `${base}/object/docs/from-admin.png`, { headers: { authorization: `Bearer ${(await import('./helpers.js')).ADMIN_TOKEN}` } });
    expect(dl.bytes.equals(PNG)).toBe(true);
    expect((await t.admin('DELETE', `/projects/${project.id}/storage/object/docs/from-admin.png`)).status).toBe(204);
  });

  it('is closed without the admin token', async () => {
    expect((await t.call('GET', `/admin/projects/${project.id}/storage/buckets`)).status).toBe(401);
    expect((await t.call('GET', `/admin/projects/${project.id}/storage/buckets`, { headers: headersFor('service') })).status).toBe(401);
    expect((await t.call('GET', `/admin/projects/${project.id}/storage/buckets`, { headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(401);
    expect((await t.admin('GET', '/projects/aaaaaaaaaaaaaaaa/storage/buckets')).status).toBe(404);
  });
});

describe('isolation', () => {
  it('keeps each project own buckets and files', async () => {
    const other = await t.createProject('other-app');
    await bucket('shared-name', { public: true });
    await upload(alice, 'shared-name', 'a.png', PNG);

    const otherHeaders = { apikey: other.keys.service_role };
    expect((await t.call('GET', '/storage/buckets', { headers: otherHeaders })).json.buckets).toEqual([]);
    expect((await raw('GET', '/storage/object/shared-name/a.png', { headers: otherHeaders })).status).toBe(404);
    expect((await raw('GET', `/storage/public/${other.id}/shared-name/a.png`)).status).toBe(404);
    expect((await raw('GET', publicUrl('shared-name', 'a.png'))).status).toBe(200);
  });

  it('deleting a project deletes its files from disk', async () => {
    await bucket('docs');
    await upload(alice, 'docs', 'a.png', PNG);
    const dir = join(t.dataDir, 'projects', project.id);
    expect((await readdir(dir)).includes('storage')).toBe(true);
    expect((await t.admin('DELETE', `/projects/${project.id}?confirm=files-app`)).status).toBe(204);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('keeps the storage tables out of reach of the REST and table APIs', async () => {
    for (const name of ['_storage_objects', '_storage_buckets']) {
      expect((await api('GET', `/rest/${name}`, 'service')).status).toBe(404);
      expect((await t.admin('GET', `/projects/${project.id}/tables/${name}`)).status).toBe(404);
    }
  });
});
