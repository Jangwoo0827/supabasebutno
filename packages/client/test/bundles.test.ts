import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChromeStorage, createClient, memoryStorage } from '../src/index.js';
import { PASSWORD, eventually, startServer, type Harness } from './support.js';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const built = existsSync(join(dist, 'index.global.js'));
if (!built) throw new Error('Build the SDK first: npm run build -w @supabasebutno/client');

let h: Harness;
beforeAll(async () => {
  h = await startServer();
  await h.table('scores', [
    { name: 'id', type: 'integer', primary_key: true },
    { name: 'player', type: 'text', not_null: true },
    { name: 'time_ms', type: 'integer', not_null: true },
  ]);
  await h.policy('scores', {
    select: { roles: ['anon', 'authenticated'], where: true },
    insert: { roles: ['authenticated'], set: { player: '$uid' } },
  });
});
afterAll(async () => {
  await h.t.close();
});

/**
 * Runs the browser bundle the way a plain <script> tag would: a context with browser-style
 * globals only (no require, no module, no import), where the file defines the global `supabasebutno`.
 */
function browserContext() {
  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    fetch,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    WebSocket,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  return { ctx, store, run: (code: string) => vm.runInContext(code, ctx) };
}

describe.each([['index.global.js'], ['index.global.min.js']])('browser bundle %s (plain <script>)', (file) => {
  const code = readFileSync(join(dist, file), 'utf8');

  it('defines a global with createClient and needs no module system', () => {
    const { run } = browserContext();
    run(code);
    expect(run('typeof supabasebutno')).toBe('object');
    expect(run('typeof supabasebutno.createClient')).toBe('function');
    expect(run('typeof supabasebutno.SbbError')).toBe('function');
    expect(code).not.toMatch(/^\s*(import|export)\s/m); // classic script: no ES module syntax
    expect(code).not.toMatch(/\brequire\(/);
  });

  it('works end to end: sign up, write, read, persist the session in localStorage', async () => {
    const { run, store, ctx } = browserContext();
    run(code);
    ctx.URL_ = h.url;
    ctx.KEY_ = h.project.keys.anon;
    ctx.PASSWORD_ = PASSWORD;
    ctx.EMAIL_ = `game-${file.replaceAll('.', '-')}@example.com`; // the server is shared by both bundle runs
    const result = await run(`
      (async () => {
        const client = supabasebutno.createClient(URL_, KEY_);
        const signUp = await client.auth.signUp({ email: EMAIL_, password: PASSWORD_ });
        const add = await client.from('scores').insert({ time_ms: 95000 });
        const top = await client.from('scores').select('player,time_ms').eq('time_ms', 95000).limit(5);
        client.dispose();
        return JSON.stringify({ signUp: signUp.error, add: add.error, top: top.data });
      })()
    `);
    const out = JSON.parse(result);
    expect(out.signUp).toBeNull();
    expect(out.add).toBeNull();
    expect(out.top.length).toBeGreaterThanOrEqual(1);
    expect(out.top[0].time_ms).toBe(95000);
    expect([...store.keys()]).toEqual([`sbb.auth.${h.project.id}`]); // the page's localStorage holds the session
  });

  it('receives realtime events through the browser WebSocket', async () => {
    const { run, ctx } = browserContext();
    run(code);
    ctx.URL_ = h.url;
    ctx.KEY_ = h.project.keys.anon;
    const seen = (await run(`
      (async () => {
        const client = supabasebutno.createClient(URL_, KEY_);
        const got = [];
        let ready;
        const subscribed = new Promise((r) => (ready = r));
        client.channel('lb').on('postgres_changes', { event: 'INSERT', table: 'scores' }, (p) => got.push(p.new.time_ms))
          .subscribe((status) => status === 'SUBSCRIBED' && ready());
        await subscribed;
        const writer = supabasebutno.createClient(URL_, KEY_);
        await writer.auth.signUp({ email: 'rt-' + Math.random() + '@example.com', password: 'correct horse battery' });
        await writer.from('scores').insert({ time_ms: 77000 });
        for (let i = 0; i < 40 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        client.dispose(); writer.dispose();
        return JSON.stringify(got);
      })()
    `)) as string;
    expect(JSON.parse(seen)).toEqual([77000]);
  });
});

describe('module bundles', () => {
  it('ESM exports the public API', async () => {
    const m = await import(pathToFileURL(join(dist, 'index.js')).href);
    expect(Object.keys(m).sort()).toEqual(['SbbError', 'SupabaseButNoClient', 'browserStorage', 'createChromeStorage', 'createClient', 'memoryStorage']);
    expect(m.createClient(h.url, h.project.keys.anon)).toBeInstanceOf(m.SupabaseButNoClient);
  });

  it('CommonJS exports the same API', () => {
    const m = createRequire(import.meta.url)(join(dist, 'index.cjs'));
    expect(Object.keys(m).sort()).toEqual(['SbbError', 'SupabaseButNoClient', 'browserStorage', 'createChromeStorage', 'createClient', 'memoryStorage']);
  });

  it('the built bundle and the source behave the same', async () => {
    const m = await import(pathToFileURL(join(dist, 'index.js')).href);
    const bundled = m.createClient(h.url, h.project.keys.anon);
    const fromSource = createClient(h.url, h.project.keys.anon);
    const a = await bundled.from('scores').select('time_ms').order('time_ms');
    const b = await fromSource.from('scores').select('time_ms').order('time_ms');
    expect(a.data).toEqual(b.data);
    bundled.dispose();
    fromSource.dispose();
  });

  it('ships type declarations', () => {
    const types = readFileSync(join(dist, 'types', 'index.d.ts'), 'utf8');
    expect(types).toContain('createClient');
    expect(types).toContain('SbbError');
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(readFileSync(join(dist, 'index.js'), 'utf8')).not.toMatch(/from ['"][^.'"][^'"]*['"]/); // no bare-specifier imports
  });
});

describe('browser extensions (chrome.storage)', () => {
  const area = (style: 'callback' | 'promise') => {
    const data: Record<string, unknown> = {};
    const reply = <T>(value: T, cb?: (v: T) => void): Promise<T> | undefined => {
      if (style === 'callback') {
        queueMicrotask(() => cb?.(value));
        return undefined;
      }
      return Promise.resolve(value); // promise-only APIs (browser.*) ignore the callback
    };
    return {
      data,
      get: (key: string, cb?: (items: Record<string, unknown>) => void) => reply(key in data ? { [key]: data[key] } : {}, cb as never),
      set: (items: Record<string, unknown>, cb?: () => void) => (Object.assign(data, items), reply(undefined, cb as never)),
      remove: (key: string, cb?: () => void) => (delete data[key], reply(undefined, cb as never)),
    };
  };

  it.each([['callback'], ['promise']] as const)('keeps the session in a %s-style storage area', async (style) => {
    const a = area(style);
    const storage = createChromeStorage(a as never);
    const first = createClient(h.url, h.project.keys.anon, { auth: { storage } });
    await first.auth.signUp({ email: `ext-${style}@example.com`, password: PASSWORD });
    expect(Object.keys(a.data)).toEqual([`sbb.auth.${h.project.id}`]);
    expect(typeof a.data[`sbb.auth.${h.project.id}`]).toBe('string');

    // the extension's service worker restarts: a new client picks the session up again
    const second = createClient(h.url, h.project.keys.anon, { auth: { storage } });
    expect((await second.auth.getSession()).data!.session!.user.email).toBe(`ext-${style}@example.com`);
    await second.auth.signOut();
    expect(Object.keys(a.data)).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it('uses chrome.storage.local by default, and says what is wrong outside an extension', () => {
    const g = globalThis as { chrome?: unknown };
    expect(() => createChromeStorage()).toThrow(/chrome.storage is not available/);
    const a = area('promise');
    g.chrome = { storage: { local: a } };
    try {
      expect(() => createChromeStorage()).not.toThrow();
    } finally {
      delete g.chrome;
    }
  });

  it('copes with a storage area that fails', async () => {
    const failing = createChromeStorage({
      get: () => Promise.reject(new Error('quota')),
      set: () => Promise.reject(new Error('quota')),
      remove: () => Promise.reject(new Error('quota')),
    });
    const c = createClient(h.url, h.project.keys.anon, { auth: { storage: failing } });
    expect((await c.auth.signUp({ email: 'fail@example.com', password: PASSWORD })).error).toBeNull();
    expect((await c.auth.getUser()).error).toBeNull();
    expect((await c.auth.signOut()).error).toBeNull();
    c.dispose();
  });
});

describe('memory storage', () => {
  it('is per client', async () => {
    const s = memoryStorage();
    await s.setItem('a', '1');
    expect(await s.getItem('a')).toBe('1');
    expect(await s.getItem('b')).toBeNull();
    await s.removeItem('a');
    expect(await s.getItem('a')).toBeNull();
    expect(await eventually(() => true)).toBe(true);
  });
});
