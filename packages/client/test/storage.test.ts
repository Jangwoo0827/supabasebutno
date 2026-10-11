import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, startServer, type Harness } from './support.js';

let h: Harness;
const clients: { dispose(): void }[] = [];
const track = <T extends { dispose(): void }>(c: T) => (clients.push(c), c);

afterEach(async () => {
  clients.splice(0).forEach((c) => c.dispose());
  await h?.t.close();
});

// A real PNG signature followed by filler, so the server's content check accepts it as image/png.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 120 }, (_, i) => i)]);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

async function signedIn(email = 'ada@example.com') {
  const c = track(h.client('anon'));
  const res = await c.auth.signUp({ email, password: PASSWORD });
  expect(res.error).toBeNull();
  return c;
}

beforeEach(async () => {
  h = await startServer();
  const svc = track(h.client('service'));
  expect((await svc.storage.createBucket('pics', { public: true })).error).toBeNull();
  expect((await svc.storage.createBucket('vault')).error).toBeNull();
});

describe('uploading and downloading', () => {
  it('accepts every kind of body and picks a sensible content type', async () => {
    const c = await signedIn();
    const bucket = c.storage.from('pics');

    const blob = await bucket.upload('blob.png', new Blob([PNG], { type: 'image/png' }));
    expect(blob.data).toMatchObject({ path: 'blob.png', mime_type: 'image/png', size: PNG.length });

    const typed = await bucket.upload('typed.png', PNG, { contentType: 'image/png' });
    expect(typed.error).toBeNull();
    const buffer = await bucket.upload('buffer.png', PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer, { contentType: 'image/png' });
    expect(buffer.error).toBeNull();

    const text = await bucket.upload('note.txt', 'héllo wörld');
    expect(text.data).toMatchObject({ mime_type: 'text/plain', size: new TextEncoder().encode('héllo wörld').length });

    const raw = await bucket.upload('data.bin', new Uint8Array([1, 2, 3]));
    expect(raw.data!.mime_type).toBe('application/octet-stream');

    const file = await bucket.upload('file.png', new File([PNG], 'whatever.png', { type: 'image/png' }));
    expect(file.data!.mime_type).toBe('image/png');

    const stream = await bucket.upload('stream.png', new Blob([PNG]).stream(), { contentType: 'image/png' });
    expect(stream.error).toBeNull();
    expect(stream.data!.size).toBe(PNG.length);
  });

  it('downloads exactly what was uploaded', async () => {
    const c = await signedIn();
    await c.storage.from('vault').upload('a/b/data.bin', new Uint8Array(Array.from({ length: 256 }, (_, i) => i)));
    const res = await c.storage.from('vault').download('a/b/data.bin');
    expect(res.error).toBeNull();
    expect(Array.from(await bytesOf(res.data!))).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it('handles awkward file names', async () => {
    const c = await signedIn();
    const names = ['with space.png', 'a#b.png', 'q?mark.png', '100%.png', '한글/파일 1.png', 'plus+sign.png', 'a&b=c.png', "it's.png"];
    for (const name of names) {
      const up = await c.storage.from('pics').upload(name, PNG, { contentType: 'image/png' });
      expect(up.error, name).toBeNull();
      expect(up.data!.path).toBe(name);
      expect((await bytesOf((await c.storage.from('pics').download(name)).data!)).length, name).toBe(PNG.length);
      const { publicUrl } = c.storage.from('pics').getPublicUrl(name).data;
      const plain = await fetch(publicUrl); // no API key, no token: just a URL
      expect(plain.status, name).toBe(200);
      expect((await plain.arrayBuffer()).byteLength).toBe(PNG.length);
    }
  });

  it('refuses things the server refuses, with its error codes', async () => {
    const anon = track(h.client('anon'));
    expect((await anon.storage.from('pics').upload('x.png', PNG, { contentType: 'image/png' })).error).toMatchObject({ code: 'forbidden', status: 403 });

    const c = await signedIn();
    await c.storage.from('pics').upload('taken.png', PNG, { contentType: 'image/png' });
    expect((await c.storage.from('pics').upload('taken.png', PNG, { contentType: 'image/png' })).error).toMatchObject({ code: 'object_exists', status: 409 });
    expect((await c.storage.from('pics').upload('taken.png', PNG, { contentType: 'image/png', upsert: true })).error).toBeNull();

    expect((await c.storage.from('pics').upload('huge.png', new Uint8Array(2_000_000), { contentType: 'application/octet-stream' })).error).toMatchObject({ code: 'payload_too_large', status: 413 });
    expect((await c.storage.from('pics').upload('evil.png', '<script>alert(1)</script>', { contentType: 'image/png' })).error).toMatchObject({ code: 'content_mismatch', status: 415 });
    expect((await c.storage.from('pics').upload('../x.png', PNG, { contentType: 'image/png' })).error).toBeTruthy();
    expect((await c.storage.from('nope').upload('x.png', PNG, { contentType: 'image/png' })).error).toMatchObject({ code: 'not_found' });
  });

  it('rejects FormData with advice instead of uploading a multipart envelope', async () => {
    const c = await signedIn();
    const form = new FormData();
    form.append('file', new Blob([PNG]), 'x.png');
    const res = await c.storage.from('pics').upload('x.png', form as never);
    expect(res.error).toMatchObject({ code: 'invalid_argument' });
    expect(res.error!.message).toMatch(/FormData/);
  });

  it('renews an expired token and retries an upload, but cannot replay a stream', async () => {
    const c = await signedIn();
    h.t.clock.advanceSeconds(1000); // the server now considers the access token expired
    const blobUpload = await c.storage.from('pics').upload('retry.png', new Blob([PNG], { type: 'image/png' }));
    expect(blobUpload.error).toBeNull();

    h.t.clock.advanceSeconds(1000);
    const streamUpload = await c.storage.from('pics').upload('stream.png', new Blob([PNG]).stream(), { contentType: 'image/png' });
    expect(streamUpload.error).toMatchObject({ code: 'token_expired' }); // a consumed stream cannot be sent twice
    // the failed attempt still renewed the session, so the next call works
    expect((await c.storage.from('pics').upload('stream.png', new Blob([PNG]).stream(), { contentType: 'image/png' })).error).toBeNull();
  });
});

describe('who can read what', () => {
  it('serves public buckets to everyone and private ones to their owner only', async () => {
    const owner = await signedIn('owner@example.com');
    const other = await signedIn('other@example.com');
    const anon = track(h.client('anon'));
    await owner.storage.from('pics').upload('p.png', PNG, { contentType: 'image/png' });
    await owner.storage.from('vault').upload('secret.png', PNG, { contentType: 'image/png' });

    for (const c of [owner, other, anon]) expect((await c.storage.from('pics').download('p.png')).error).toBeNull();
    expect((await owner.storage.from('vault').download('secret.png')).error).toBeNull();
    for (const c of [other, anon]) expect((await c.storage.from('vault').download('secret.png')).error).toMatchObject({ code: 'not_found', status: 404 });

    const publicVault = owner.storage.from('vault').getPublicUrl('secret.png').data.publicUrl;
    expect((await fetch(publicVault)).status).toBe(404);
  });

  it('builds public URLs locally, with an option to force a download', async () => {
    const c = track(h.client('anon'));
    const { publicUrl } = c.storage.from('pics').getPublicUrl('dir/a b.png').data;
    expect(publicUrl).toBe(`${h.url}/storage/public/${h.project.id}/pics/dir/a%20b.png`);
    expect(c.storage.from('pics').getPublicUrl('a.png', { download: true }).data.publicUrl).toMatch(/\?download$/);
  });

  it('serves HTML as a download, not as a page', async () => {
    const svc = track(h.client('service'));
    await svc.storage.from('pics').upload('page.html', '<script>alert(1)</script>', { contentType: 'text/html' });
    const res = await fetch(svc.storage.from('pics').getPublicUrl('page.html').data.publicUrl);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('listing and removing', () => {
  it('lists a user own files and removes them', async () => {
    const a = await signedIn('a@example.com');
    const b = await signedIn('b@example.com');
    for (const name of ['x/1.png', 'x/2.png', 'y/3.png']) await a.storage.from('pics').upload(name, PNG, { contentType: 'image/png' });
    await b.storage.from('pics').upload('b.png', PNG, { contentType: 'image/png' });

    expect((await a.storage.from('pics').list()).data!.map((f) => f.path)).toEqual(['x/1.png', 'x/2.png', 'y/3.png']);
    expect((await a.storage.from('pics').list('x/')).data!.map((f) => f.path)).toEqual(['x/1.png', 'x/2.png']);
    expect((await a.storage.from('pics').list('', { search: '3', limit: 5 })).data!.map((f) => f.path)).toEqual(['y/3.png']);
    expect((await a.storage.from('pics').list('', { sortBy: 'path', descending: true, limit: 1 })).data!.map((f) => f.path)).toEqual(['y/3.png']);
    expect((await b.storage.from('pics').list()).data!.map((f) => f.path)).toEqual(['b.png']);
    expect((await track(h.client('anon')).storage.from('pics').list()).error).toMatchObject({ code: 'forbidden' });

    expect((await a.storage.from('pics').remove(['x/1.png', 'x/2.png'])).data).toEqual(['x/1.png', 'x/2.png']);
    expect((await a.storage.from('pics').list()).data!.map((f) => f.path)).toEqual(['y/3.png']);
    expect((await b.storage.from('pics').remove(['y/3.png'])).error).toMatchObject({ code: 'not_found' }); // not b's file
    expect((await a.storage.from('pics').download('x/1.png')).error?.status).toBe(404);
  });
});

describe('managing buckets (service key)', () => {
  it('creates, reads, updates and deletes buckets', async () => {
    const svc = track(h.client('service'));
    const made = await svc.storage.createBucket('docs', { public: false, file_size_limit: 1000, allowed_mime_types: ['text/*'] });
    expect(made.data).toMatchObject({ name: 'docs', public: false, file_size_limit: 1000, allowed_mime_types: ['text/*'] });
    expect((await svc.storage.listBuckets()).data!.map((b) => b.name)).toEqual(['docs', 'pics', 'vault']);
    expect((await svc.storage.getBucket('docs')).data!.file_size_limit).toBe(1000);
    expect((await svc.storage.updateBucket('docs', { public: true, file_size_limit: null })).data).toMatchObject({ public: true, file_size_limit: null });
    expect((await svc.storage.createBucket('docs')).error).toMatchObject({ code: 'bucket_exists' });

    await svc.storage.from('docs').upload('a.txt', 'hi', { contentType: 'text/plain' });
    expect((await svc.storage.deleteBucket('docs')).error).toMatchObject({ code: 'bucket_not_empty' });
    expect((await svc.storage.deleteBucket('docs', { force: true })).error).toBeNull();
    expect((await svc.storage.getBucket('docs')).error?.status).toBe(404);
  });

  it('is closed to anon and signed-in users', async () => {
    const c = await signedIn();
    const anon = track(h.client('anon'));
    for (const client of [c, anon]) {
      expect((await client.storage.listBuckets()).error?.code).toBe('forbidden');
      expect((await client.storage.createBucket('mine')).error?.code).toBe('forbidden');
      expect((await client.storage.deleteBucket('pics')).error?.code).toBe('forbidden');
    }
  });
});
