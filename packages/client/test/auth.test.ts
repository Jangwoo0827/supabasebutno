import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, memoryStorage, type AuthChangeEvent, type StorageAdapter } from '../src/index.js';
import { PASSWORD, eventually, sleep, startServer, type Harness } from './support.js';

let h: Harness;
const clients: { dispose(): void }[] = [];
const track = <T extends { dispose(): void }>(c: T) => (clients.push(c), c);

afterEach(async () => {
  clients.splice(0).forEach((c) => c.dispose());
  await h?.t.close();
});

/** fetch that records which endpoints were called and can be told to fail. */
function spyFetch() {
  const log: string[] = [];
  const failing = new Set<string>();
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    log.push(path);
    if ([...failing].some((p) => path.startsWith(p))) throw new TypeError('fetch failed');
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  return { fn, log, count: (p: string) => log.filter((x) => x === p).length, fail: (p: string) => failing.add(p), heal: () => failing.clear() };
}

const events = (c: { auth: { onAuthStateChange: (cb: (e: AuthChangeEvent) => void) => unknown } }) => {
  const seen: AuthChangeEvent[] = [];
  c.auth.onAuthStateChange((e) => seen.push(e));
  return seen;
};

describe('signing up, in and out', () => {
  beforeEach(async () => {
    h = await startServer();
  });

  it('signs up with metadata and is signed in straight away', async () => {
    const c = track(h.client('anon'));
    const res = await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD, data: { name: 'Ada' } });
    expect(res.error).toBeNull();
    expect(res.data!.user).toMatchObject({ email: 'ada@example.com', user_metadata: { name: 'Ada' } });
    expect(res.data!.session.access_token.split('.')).toHaveLength(3);

    const session = (await c.auth.getSession()).data!.session!;
    expect(session.user.id).toBe(res.data!.user.id);
    expect((await c.auth.getUser()).data!.user.email).toBe('ada@example.com');
  });

  it('reports bad credentials and duplicates without storing a session', async () => {
    const c = track(h.client('anon'));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    await c.auth.signOut();

    expect((await c.auth.signUp({ email: 'ADA@example.com', password: PASSWORD })).error).toMatchObject({ code: 'user_exists', status: 409 });
    expect((await c.auth.signInWithPassword({ email: 'ada@example.com', password: 'wrong password' })).error).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect((await c.auth.signInWithPassword({ email: 'nobody@example.com', password: PASSWORD })).error?.code).toBe('invalid_credentials');
    expect((await c.auth.signUp({ email: 'bad', password: PASSWORD })).error).toMatchObject({ code: 'validation_error' });
    expect((await c.auth.getSession()).data!.session).toBeNull();

    const ok = await c.auth.signInWithPassword({ email: 'Ada@Example.com', password: PASSWORD });
    expect(ok.data!.user.email).toBe('ada@example.com');
  });

  it('signs out: the session is gone, calls go out as anon', async () => {
    const c = track(h.client('anon'));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const token = (await c.auth.getSession()).data!.session!.access_token;
    expect((await c.auth.signOut()).error).toBeNull();
    expect((await c.auth.getSession()).data!.session).toBeNull();
    expect((await c.auth.getUser()).error).toMatchObject({ code: 'missing_token' });

    // the old token really was revoked on the server
    const raw = await fetch(`${h.url}/auth/user`, { headers: { apikey: h.project.keys.anon, authorization: `Bearer ${token}` } });
    expect(raw.status).toBe(401);
  });

  it('can sign out everywhere', async () => {
    const phone = track(h.client('anon'));
    const laptop = track(h.client('anon'));
    await phone.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    await laptop.auth.signInWithPassword({ email: 'ada@example.com', password: PASSWORD });
    await phone.auth.signOut({ scope: 'global' });
    expect((await laptop.auth.getUser()).error).toBeTruthy();
    expect((await laptop.auth.getSession()).data!.session).toBeNull(); // the refresh was refused, so the session ended locally
  });

  it('still signs out locally when the server cannot be reached', async () => {
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    spy.fail('/auth/logout');
    const res = await c.auth.signOut();
    expect(res.error).toMatchObject({ code: 'network_error' });
    expect((await c.auth.getSession()).data!.session).toBeNull();
  });

  it('updates metadata and changes the password (needs the current one)', async () => {
    const c = track(h.client('anon'));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD, data: { name: 'Ada', level: 1 } });
    const upd = await c.auth.updateUser({ data: { level: 2, name: null as never } });
    expect(upd.data!.user.user_metadata).toEqual({ level: 2 });
    expect((await c.auth.getSession()).data!.session!.user.user_metadata).toEqual({ level: 2 });

    expect((await c.auth.updateUser({ password: 'a brand new passphrase' })).error).toMatchObject({ code: 'invalid_current_password' });
    expect((await c.auth.updateUser({ password: 'a brand new passphrase', currentPassword: PASSWORD })).error).toBeNull();
    const other = track(h.client('anon'));
    expect((await other.auth.signInWithPassword({ email: 'ada@example.com', password: PASSWORD })).error).toBeTruthy();
    expect((await other.auth.signInWithPassword({ email: 'ada@example.com', password: 'a brand new passphrase' })).error).toBeNull();
  });

  it('runs the password-reset flow end to end', async () => {
    const c = track(h.client('anon'));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    expect((await c.auth.resetPasswordForEmail('ada@example.com')).error).toBeNull();
    expect((await c.auth.resetPasswordForEmail('nobody@example.com')).error).toBeNull(); // same answer for unknown addresses
    await eventually(() => h.t.outbox.length === 1);
    const token = /\n\n(\S{40,})\n\n/.exec(h.t.outbox[0]!.text)![1]!;

    expect((await c.auth.resetPassword({ token, password: 'my shiny new password' })).error).toBeNull();
    expect((await c.auth.getSession()).data!.session).toBeNull(); // every session ended
    expect((await c.auth.resetPassword({ token, password: 'again and again' })).error).toMatchObject({ code: 'invalid_or_expired_token' });
    expect((await c.auth.signInWithPassword({ email: 'ada@example.com', password: 'my shiny new password' })).error).toBeNull();
  });

  it('announces what happens, in order', async () => {
    const c = track(h.client('anon'));
    const seen = events(c);
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    await c.auth.updateUser({ data: { a: 1 } });
    await c.auth.refreshSessionNow();
    await c.auth.signOut();
    await c.auth.signInWithPassword({ email: 'ada@example.com', password: PASSWORD });
    expect(seen).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED', 'TOKEN_REFRESHED', 'SIGNED_OUT', 'SIGNED_IN']);
  });

  it('unsubscribe stops notifications, and a failing listener does not break the others', async () => {
    const c = track(h.client('anon'));
    const seen: string[] = [];
    const sub = c.auth.onAuthStateChange((e) => seen.push(`a:${e}`));
    c.auth.onAuthStateChange(() => {
      throw new Error('listener bug');
    });
    c.auth.onAuthStateChange((e) => seen.push(`c:${e}`));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    sub.data.subscription.unsubscribe();
    await c.auth.signOut();
    expect(seen).toContain('a:SIGNED_IN');
    expect(seen).toContain('c:SIGNED_OUT');
    expect(seen).not.toContain('a:SIGNED_OUT');
  });
});

describe('keeping the session', () => {
  beforeEach(async () => {
    h = await startServer();
  });

  it('restores a stored session in a new client (page reload)', async () => {
    const storage = memoryStorage();
    const first = track(h.client('anon', { auth: { storage } }));
    await first.auth.signUp({ email: 'ada@example.com', password: PASSWORD });

    const second = track(h.client('anon', { auth: { storage } }));
    const seen: { event: string; email?: string }[] = [];
    second.auth.onAuthStateChange((event, s) => seen.push({ event, email: s?.user.email }));
    await eventually(() => seen.length > 0);
    expect(seen[0]).toEqual({ event: 'INITIAL_SESSION', email: 'ada@example.com' });
    expect((await second.auth.getUser()).data!.user.email).toBe('ada@example.com');
  });

  it('works with an asynchronous storage (like chrome.storage in an extension)', async () => {
    const data = new Map<string, string>();
    const slow: StorageAdapter = {
      getItem: async (k) => (await sleep(5), data.get(k) ?? null),
      setItem: async (k, v) => (await sleep(5), void data.set(k, v)),
      removeItem: async (k) => (await sleep(5), void data.delete(k)),
    };
    const a = track(h.client('anon', { auth: { storage: slow } }));
    await a.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    expect(data.size).toBe(1);
    const b = track(h.client('anon', { auth: { storage: slow } }));
    expect((await b.auth.getSession()).data!.session!.user.email).toBe('ada@example.com');
    await b.auth.signOut();
    expect(data.size).toBe(0);
  });

  it('stores nothing when persistSession is off', async () => {
    const storage = memoryStorage();
    const c = track(h.client('anon', { auth: { storage, persistSession: false } }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    expect(storage.getItem(`sbb.auth.${h.project.id}`)).toBeNull();
    expect((await c.auth.getUser()).error).toBeNull(); // still works for this page
    const fresh = track(h.client('anon', { auth: { storage, persistSession: false } }));
    expect((await fresh.auth.getSession()).data!.session).toBeNull();
  });

  it('ignores corrupted or foreign data in storage', async () => {
    for (const junk of ['not json', '{"access_token":5}', 'null', '[]', '{"user":{}}']) {
      const storage = memoryStorage();
      storage.setItem(`sbb.auth.${h.project.id}`, junk);
      const c = track(h.client('anon', { auth: { storage } }));
      expect((await c.auth.getSession()).data!.session, junk).toBeNull();
    }
  });

  it('keeps sessions of different projects apart and lets you choose the key', async () => {
    const storage = memoryStorage();
    const c = track(h.client('anon', { auth: { storage, storageKey: 'my-game-auth' } }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    expect(storage.getItem('my-game-auth')).toContain('refresh_token');
    expect(storage.getItem(`sbb.auth.${h.project.id}`)).toBeNull();
  });

  it('does not break when storage throws', async () => {
    const broken: StorageAdapter = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const c = track(h.client('anon', { auth: { storage: broken } }));
    expect((await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD })).error).toBeNull();
    expect((await c.auth.getUser()).error).toBeNull(); // works in memory
    expect((await c.auth.signOut()).error).toBeNull();
  });

  it('follows sign-ins and sign-outs made in another browser tab', async () => {
    const store = new Map<string, string>();
    const listeners: ((e: { key: string | null }) => void)[] = [];
    const g = globalThis as any;
    const saved = { localStorage: g.localStorage, addEventListener: g.addEventListener, removeEventListener: g.removeEventListener };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    g.addEventListener = (type: string, fn: (e: { key: string | null }) => void) => type === 'storage' && listeners.push(fn);
    g.removeEventListener = () => undefined;
    try {
      const tabA = track(h.client('anon')); // uses the fake localStorage by default
      const seen = events(tabA);
      await eventually(() => seen.length === 1); // INITIAL_SESSION
      const key = `sbb.auth.${h.project.id}`;

      // "tab B" signs in
      const tabB = track(h.client('anon', { auth: { storage: memoryStorage() } }));
      const signedIn = await tabB.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
      store.set(key, JSON.stringify(signedIn.data!.session));
      listeners.forEach((l) => l({ key }));
      await eventually(() => seen.includes('SIGNED_IN'));
      expect((await tabA.auth.getSession()).data!.session!.user.email).toBe('ada@example.com');

      // "tab B" signs out
      store.delete(key);
      listeners.forEach((l) => l({ key }));
      await eventually(() => seen.includes('SIGNED_OUT'));
      expect((await tabA.auth.getSession()).data!.session).toBeNull();

      listeners.forEach((l) => l({ key: 'something-else' })); // unrelated keys are ignored
      expect(seen.filter((e) => e === 'SIGNED_OUT')).toHaveLength(1);
    } finally {
      Object.assign(g, saved);
      if (!saved.localStorage) delete g.localStorage;
      if (!saved.addEventListener) delete g.addEventListener;
      if (!saved.removeEventListener) delete g.removeEventListener;
    }
  });
});

describe('renewing the access token', () => {
  let skew = 0; // makes the SDK believe time has passed, without touching the server clock
  beforeEach(async () => {
    skew = 0;
    h = await startServer();
  });
  const now = () => Date.now() + skew;

  it('renews shortly before it expires, on the next request', async () => {
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn, now }));
    const seen = events(c);
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const before = (await c.auth.getSession()).data!.session!;
    expect(spy.count('/auth/refresh')).toBe(0);

    skew = 850_000; // 50 s of life left, inside the 60 s margin
    expect((await c.auth.getUser()).error).toBeNull();
    skew = 0; // the new token is fresh on the real clock; only the old one looked nearly expired
    const after = (await c.auth.getSession()).data!.session!;
    expect(spy.count('/auth/refresh')).toBe(1);
    // (access tokens issued within the same second are identical strings, so compare the rotating refresh token)
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(seen).toContain('TOKEN_REFRESHED');
  });

  it('shares one renewal between simultaneous requests', async () => {
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn, now }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    skew = 850_000;
    const results = await Promise.all([c.auth.getUser(), c.auth.getUser(), c.auth.getUser(), c.auth.getSession(), c.from('anything').select()]);
    expect(results.slice(0, 4).every((r) => r.error === null)).toBe(true);
    expect(spy.count('/auth/refresh')).toBe(1);
  });

  it('renews and retries once when the server says the token has expired', async () => {
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    h.t.clock.advanceSeconds(1000); // the server now considers the access token expired; the SDK has no way to know
    spy.log.length = 0;

    const res = await c.auth.getUser();
    expect(res.error).toBeNull();
    expect(res.data!.user.email).toBe('ada@example.com');
    expect(spy.log).toEqual(['/auth/user', '/auth/refresh', '/auth/user']);
  });

  it('ends the session locally when the refresh token is no longer accepted', async () => {
    const a = track(h.client('anon'));
    const seen = events(a);
    await a.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const b = track(h.client('anon'));
    await b.auth.signInWithPassword({ email: 'ada@example.com', password: PASSWORD });
    await b.auth.signOut({ scope: 'global' }); // kills a's session on the server

    const res = await a.auth.getUser();
    expect(res.error).toBeTruthy();
    expect((await a.auth.getSession()).data!.session).toBeNull();
    expect(seen).toContain('SIGNED_OUT');
  });

  it('keeps the session when the server is merely unreachable during renewal', async () => {
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn, now }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const before = (await c.auth.getSession()).data!.session!;

    skew = 850_000;
    spy.fail('/auth/refresh');
    expect((await c.auth.getUser()).error).toBeNull(); // the old token still works, so the request succeeds
    expect((await c.auth.getSession()).data!.session!.refresh_token).toBe(before.refresh_token); // and the session was not thrown away

    spy.heal();
    expect((await c.auth.getUser()).error).toBeNull();
    skew = 0;
    expect((await c.auth.getSession()).data!.session!.refresh_token).not.toBe(before.refresh_token);
  });

  it('renews in the background before expiry, with no requests being made', async () => {
    await h.t.close();
    h = await startServer({ accessTokenTtlSeconds: 60 });
    const c = track(h.client('anon', { auth: { refreshMarginSeconds: 59 } })); // renew about 1 s after sign-in
    const seen = events(c);
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const first = (await c.auth.getSession()).data!.session!.refresh_token;
    await eventually(() => seen.includes('TOKEN_REFRESHED'), 4000);
    expect((await c.auth.getSession()).data!.session!.refresh_token).not.toBe(first);
  });

  it('stops background renewal when asked, and when disposed', async () => {
    await h.t.close();
    h = await startServer({ accessTokenTtlSeconds: 60 });
    const spy = spyFetch();
    const c = track(h.client('anon', { fetch: spy.fn, auth: { refreshMarginSeconds: 59, autoRefreshToken: false } }));
    await c.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    await sleep(1500);
    expect(spy.count('/auth/refresh')).toBe(0); // switched off

    c.auth.startAutoRefresh();
    await eventually(() => spy.count('/auth/refresh') >= 1, 4000);
    c.dispose();
    const after = spy.count('/auth/refresh');
    await sleep(1500);
    expect(spy.count('/auth/refresh')).toBe(after);
  });
});
