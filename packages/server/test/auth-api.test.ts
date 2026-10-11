import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
let project: Awaited<ReturnType<TestApp['createProject']>>;

const PASSWORD = 'correct horse battery';

async function setup(overrides: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp(overrides);
  project = await t.createProject('game');
}
beforeEach(() => setup());
afterEach(async () => {
  await t.close();
});

const anon = () => project.keys.anon;
interface CallOpts {
  body?: unknown;
  token?: string;
  apikey?: string;
  ip?: string;
}
const api = (method: string, path: string, o: CallOpts = {}) => {
  const headers: Record<string, string> = { apikey: o.apikey ?? anon() };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.ip) headers['x-forwarded-for'] = o.ip;
  return t.call(method, path, { body: o.body, headers });
};
const signup = (email = 'player@example.com', extra: Record<string, unknown> = {}, o: CallOpts = {}) =>
  api('POST', '/auth/signup', { ...o, body: { email, password: PASSWORD, ...extra } });
const login = (email = 'player@example.com', password = PASSWORD, o: CallOpts = {}) =>
  api('POST', '/auth/login', { ...o, body: { email, password } });
const projectDb = () => t.registry.db(project.id);

describe('sign up', () => {
  it('creates a user and returns a ready-to-use session', async () => {
    const res = await signup('Player@Example.com', { data: { name: 'Ada' } });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(res.json.access_token.split('.')).toHaveLength(3);
    expect(res.json.refresh_token.length).toBeGreaterThanOrEqual(43);
    expect(res.json.user).toMatchObject({ email: 'player@example.com', user_metadata: { name: 'Ada' } });
    expect(res.json.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.text).not.toMatch(/argon2|password_hash/);

    const me = await api('GET', '/auth/user', { token: res.json.access_token });
    expect(me.json.email).toBe('player@example.com');
  });

  it('rejects an e-mail that is already registered, ignoring case', async () => {
    await signup('a@example.com');
    const dup = await signup('A@EXAMPLE.COM');
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('user_exists');
  });

  it('validates input', async () => {
    const bad: Record<string, unknown>[] = [
      { email: 'not-an-email' },
      { email: '' },
      { email: 'a@b.co', password: 'short' },
      { email: 'a@b.co', password: 'x'.repeat(129) },
      { email: 'a@b.co', password: 'é'.repeat(129) },
      { email: 'a@b.co', password: 12345678 },
      { email: 'a@b.co', password: PASSWORD, role: 'admin' },
      { email: 'a@b.co', password: PASSWORD, data: { blob: 'x'.repeat(5000) } },
    ];
    for (const body of bad) {
      const res = await api('POST', '/auth/signup', { body });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await api('POST', '/auth/signup', { body: '{nope' })).status).toBe(400);
  });

  it('stores only an argon2id hash of the password and a hash of the refresh token', async () => {
    const res = await signup();
    const db = await projectDb();
    const user = (await db.get<{ password_hash: string }>('SELECT password_hash FROM _auth_users'))!;
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.password_hash).not.toContain(PASSWORD);
    const tokens = await db.all<{ token_hash: string }>('SELECT token_hash FROM _auth_refresh_tokens');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[0]!.token_hash).not.toBe(res.json.refresh_token);
  });

  it('needs an API key', async () => {
    const res = await t.call('POST', '/auth/signup', { body: { email: 'a@b.co', password: PASSWORD } });
    expect(res.status).toBe(401);
  });
});

describe('log in', () => {
  beforeEach(async () => void (await signup()));

  it('logs in with e-mail (case-insensitive) and password', async () => {
    for (const email of ['player@example.com', 'PLAYER@Example.COM', '  player@example.com  ']) {
      const res = await login(email);
      expect(res.status, email).toBe(200);
      expect(res.json.user.email).toBe('player@example.com');
    }
  });

  it('answers wrong password and unknown e-mail identically', async () => {
    const wrongPw = await login('player@example.com', 'wrong password!');
    const unknown = await login('nobody@example.com');
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.json.error.code).toBe('invalid_credentials');
    expect(unknown.json.error.code).toBe('invalid_credentials');
    expect(wrongPw.json.error.message).toBe(unknown.json.error.message);
  });

  it('gives each login its own session', async () => {
    const a = await login();
    const b = await login();
    expect(a.json.refresh_token).not.toBe(b.json.refresh_token);
    expect((await api('GET', '/auth/user', { token: a.json.access_token })).status).toBe(200);
    expect((await api('GET', '/auth/user', { token: b.json.access_token })).status).toBe(200);
  });

  it('keeps users of different projects apart', async () => {
    const other = await t.createProject('other');
    const res = await api('POST', '/auth/login', { apikey: other.keys.anon, body: { email: 'player@example.com', password: PASSWORD } });
    expect(res.status).toBe(401);
    // the same e-mail can register independently in the other project
    const reg = await api('POST', '/auth/signup', { apikey: other.keys.anon, body: { email: 'player@example.com', password: 'a different password' } });
    expect(reg.status).toBe(201);
  });
});

describe('access tokens', () => {
  let session: { access_token: string; refresh_token: string };
  beforeEach(async () => {
    session = (await signup()).json;
  });

  it('identify the user to the API', async () => {
    const who = await api('GET', '/whoami', { token: session.access_token });
    expect(who.json).toMatchObject({ role: 'authenticated', user: { id: expect.any(String) } });
    expect((await api('GET', '/whoami')).json).toMatchObject({ role: 'anon', user: null });
  });

  it('do not turn a service key into anything else, and do not grant REST access by themselves', async () => {
    const asService = await api('GET', '/whoami', { apikey: project.keys.service_role, token: session.access_token });
    expect(asService.json.role).toBe('service_role');
    // Phase 3 (policies) decides what `authenticated` may do; until then it is denied.
    expect((await api('GET', '/rest/anything', { token: session.access_token })).status).toBe(403);
  });

  it('are required for user endpoints', async () => {
    expect((await api('GET', '/auth/user')).json.error.code).toBe('missing_token');
    expect((await api('PUT', '/auth/user', { body: { data: { a: 1 } } })).status).toBe(401);
    expect((await api('POST', '/auth/logout')).status).toBe(401);
  });

  it('are rejected when garbled, tampered with, or from another project', async () => {
    const [h, p, s] = session.access_token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'someone-else' })).toString('base64url');
    for (const token of ['garbage', `${h}.${forgedPayload}.${s}`, `${h}.${p}.${s.slice(0, -3)}abc`]) {
      const res = await api('GET', '/auth/user', { token });
      expect(res.status, token.slice(0, 20)).toBe(401);
      expect(res.json.error.code).toBe('invalid_token');
    }
    const other = await t.createProject('other');
    const cross = await api('GET', '/auth/user', { apikey: other.keys.anon, token: session.access_token });
    expect(cross.status).toBe(401);
  });

  it('expire, and the client is told so it can refresh', async () => {
    t.clock.advanceSeconds(901 + 5);
    const res = await api('GET', '/auth/user', { token: session.access_token });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('token_expired');
    expect((await api('GET', '/rest/todos', { token: session.access_token })).json.error.code).toBe('token_expired');
  });

  it('ignore an API key sent as the Authorization bearer (some clients do this)', async () => {
    const res = await api('GET', '/whoami', { token: anon() });
    expect(res.status).toBe(200);
    expect(res.json.role).toBe('anon');
  });

  it('are not honoured as API keys, nor API keys as user tokens', async () => {
    expect((await api('GET', '/whoami', { apikey: session.access_token })).status).toBe(401);
    expect((await api('GET', '/auth/user', { token: project.keys.service_role })).status).toBe(401);
  });

  it('stop working the moment the user is deleted', async () => {
    const db = await projectDb();
    await db.run('DELETE FROM _auth_users');
    expect((await api('GET', '/auth/user', { token: session.access_token })).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotate: each use returns a new pair and the access token keeps working', async () => {
    const first = (await signup()).json;
    const second = await api('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(second.status).toBe(200);
    expect(second.json.refresh_token).not.toBe(first.refresh_token);
    expect(second.json.user.email).toBe('player@example.com');
    expect((await api('GET', '/auth/user', { token: second.json.access_token })).status).toBe(200);
    const third = await api('POST', '/auth/refresh', { body: { refresh_token: second.json.refresh_token } });
    expect(third.status).toBe(200);
  });

  it('tolerate an immediate retry (two tabs refreshing at once)', async () => {
    const first = (await signup()).json;
    const a = await api('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    t.clock.advanceSeconds(3);
    const b = await api('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json.refresh_token).not.toBe(a.json.refresh_token);
  });

  it('detect reuse of an old token and revoke the whole session (theft response)', async () => {
    const first = (await signup()).json;
    const second = (await api('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } })).json;
    t.clock.advanceSeconds(60);

    // an attacker (or a stale client) replays the first token
    const replay = await api('POST', '/auth/refresh', { body: { refresh_token: first.refresh_token } });
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe('refresh_token_reused');

    // the legitimate holder of the newest token is signed out too: their session is gone
    expect((await api('POST', '/auth/refresh', { body: { refresh_token: second.refresh_token } })).status).toBe(401);
    expect((await api('GET', '/auth/user', { token: second.access_token })).status).toBe(401);
  });

  it('only revoke the affected session, not the user other devices', async () => {
    const phone = (await signup()).json;
    const laptop = (await login()).json;
    await api('POST', '/auth/refresh', { body: { refresh_token: phone.refresh_token } });
    t.clock.advanceSeconds(60);
    await api('POST', '/auth/refresh', { body: { refresh_token: phone.refresh_token } }); // replay -> phone session revoked
    expect((await api('GET', '/auth/user', { token: laptop.access_token })).status).toBe(200);
  });

  it('are rejected when unknown, malformed or expired', async () => {
    const s = (await signup()).json;
    for (const refresh_token of ['x'.repeat(43), 'short', s.refresh_token.slice(0, -1) + 'A']) {
      const res = await api('POST', '/auth/refresh', { body: { refresh_token } });
      expect([400, 401]).toContain(res.status);
    }
    t.clock.advance(31 * 86_400_000);
    const expired = await api('POST', '/auth/refresh', { body: { refresh_token: s.refresh_token } });
    expect(expired.status).toBe(401);
    expect(expired.json.error.code).toBe('invalid_refresh_token');
  });

  it('work even when the client still sends an expired access token', async () => {
    const s = (await signup()).json;
    t.clock.advanceSeconds(2000);
    const res = await api('POST', '/auth/refresh', { token: s.access_token, body: { refresh_token: s.refresh_token } });
    expect(res.status).toBe(200);
  });

  it('cannot be used across projects', async () => {
    const s = (await signup()).json;
    const other = await t.createProject('other');
    const res = await api('POST', '/auth/refresh', { apikey: other.keys.anon, body: { refresh_token: s.refresh_token } });
    expect(res.status).toBe(401);
  });
});

describe('log out', () => {
  it('revokes the current session immediately, leaving other devices alone', async () => {
    const phone = (await signup()).json;
    const laptop = (await login()).json;

    const out = await api('POST', '/auth/logout', { token: phone.access_token });
    expect(out.status).toBe(204);
    expect((await api('GET', '/auth/user', { token: phone.access_token })).status).toBe(401);
    expect((await api('POST', '/auth/refresh', { body: { refresh_token: phone.refresh_token } })).status).toBe(401);
    expect((await api('GET', '/auth/user', { token: laptop.access_token })).status).toBe(200);
  });

  it('can sign out everywhere', async () => {
    const phone = (await signup()).json;
    const laptop = (await login()).json;
    expect((await api('POST', '/auth/logout', { token: phone.access_token, body: { scope: 'global' } })).status).toBe(204);
    expect((await api('GET', '/auth/user', { token: laptop.access_token })).status).toBe(401);
    expect((await api('POST', '/auth/refresh', { body: { refresh_token: laptop.refresh_token } })).status).toBe(401);
    expect((await login()).status).toBe(200); // the account itself is fine
  });

  it('rejects unknown scopes', async () => {
    const s = (await signup()).json;
    expect((await api('POST', '/auth/logout', { token: s.access_token, body: { scope: 'nuclear' } })).status).toBe(400);
  });
});

describe('update user', () => {
  let s: { access_token: string };
  beforeEach(async () => {
    s = (await signup('player@example.com', { data: { name: 'Ada', level: 3 } })).json;
  });

  it('merges metadata and deletes keys set to null', async () => {
    const res = await api('PUT', '/auth/user', { token: s.access_token, body: { data: { level: 4, color: 'red', name: null } } });
    expect(res.status).toBe(200);
    expect(res.json.user_metadata).toEqual({ level: 4, color: 'red' });
    expect((await api('GET', '/auth/user', { token: s.access_token })).json.user_metadata).toEqual({ level: 4, color: 'red' });
  });

  it('bounds metadata size', async () => {
    const res = await api('PUT', '/auth/user', { token: s.access_token, body: { data: { big: 'x'.repeat(5000) } } });
    expect(res.status).toBe(400);
  });

  it('changes the password only with the current one, and signs out other devices', async () => {
    const other = (await login()).json;
    const newPw = 'a brand new passphrase';

    const noCurrent = await api('PUT', '/auth/user', { token: s.access_token, body: { password: newPw } });
    expect(noCurrent.status).toBe(400);
    const wrong = await api('PUT', '/auth/user', { token: s.access_token, body: { password: newPw, current_password: 'wrong wrong' } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe('invalid_current_password');
    expect((await login()).status).toBe(200); // unchanged so far

    const ok = await api('PUT', '/auth/user', { token: s.access_token, body: { password: newPw, current_password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect((await login('player@example.com', PASSWORD)).status).toBe(401);
    expect((await login('player@example.com', newPw)).status).toBe(200);
    expect((await api('GET', '/auth/user', { token: s.access_token })).status).toBe(200); // current device stays signed in
    expect((await api('GET', '/auth/user', { token: other.access_token })).status).toBe(401); // others are signed out
  });

  it('throttles guessing of the current password', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await api('PUT', '/auth/user', { token: s.access_token, body: { password: 'new password!', current_password: `guess-${i}-xxxx` } })).status;
    }
    expect(last).toBe(400);
    for (let i = 0; i < 40; i++) await api('PUT', '/auth/user', { token: s.access_token, body: { password: 'new password!', current_password: `g${i}-xxxxxx` } });
    const blocked = await api('PUT', '/auth/user', { token: s.access_token, body: { password: 'new password!', current_password: PASSWORD } });
    expect(blocked.status).toBe(429);
  });

  it('refuses unknown fields and empty updates', async () => {
    expect((await api('PUT', '/auth/user', { token: s.access_token, body: {} })).status).toBe(400);
    expect((await api('PUT', '/auth/user', { token: s.access_token, body: { email: 'x@y.zz' } })).status).toBe(400);
  });
});

describe('password recovery', () => {
  beforeEach(async () => void (await signup()));
  const tokenFromMail = () => /\n\n(\S{40,})\n\n/.exec(t.outbox.at(-1)!.text)![1]!;

  it('mails a one-time token and lets the user set a new password', async () => {
    const res = await api('POST', '/auth/recover', { body: { email: 'Player@Example.com' } });
    expect(res.status).toBe(200);
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]).toMatchObject({ to: 'player@example.com' });

    const token = tokenFromMail();
    const newPw = 'my shiny new password';
    expect((await api('POST', '/auth/reset', { body: { token, password: newPw } })).status).toBe(204);
    expect((await login('player@example.com', PASSWORD)).status).toBe(401);
    expect((await login('player@example.com', newPw)).status).toBe(200);

    const again = await api('POST', '/auth/reset', { body: { token, password: 'yet another password' } });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe('invalid_or_expired_token');
  });

  it('does not reveal whether an address is registered', async () => {
    const known = await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    const unknown = await api('POST', '/auth/recover', { body: { email: 'nobody@example.com' } });
    expect(unknown.status).toBe(known.status);
    expect(unknown.json).toEqual(known.json);
    expect(t.outbox).toHaveLength(1); // only the real account got mail
  });

  it('stores only a hash of the token and expires it after an hour', async () => {
    await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    const token = tokenFromMail();
    const row = (await (await projectDb()).get<{ token_hash: string }>('SELECT token_hash FROM _auth_recovery_tokens'))!;
    expect(row.token_hash).not.toBe(token);
    t.clock.advance(61 * 60_000);
    expect((await api('POST', '/auth/reset', { body: { token, password: 'a password long enough' } })).status).toBe(400);
  });

  it('a newer request invalidates the older token', async () => {
    await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    const old = tokenFromMail();
    await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    expect((await api('POST', '/auth/reset', { body: { token: old, password: 'a password long enough' } })).status).toBe(400);
    expect((await api('POST', '/auth/reset', { body: { token: tokenFromMail(), password: 'a password long enough' } })).status).toBe(204);
  });

  it('signs out every session on reset', async () => {
    const s = (await login()).json;
    await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    await api('POST', '/auth/reset', { body: { token: tokenFromMail(), password: 'a password long enough' } });
    expect((await api('GET', '/auth/user', { token: s.access_token })).status).toBe(401);
    expect((await api('POST', '/auth/refresh', { body: { refresh_token: s.refresh_token } })).status).toBe(401);
  });

  it('rejects invalid tokens and weak new passwords', async () => {
    expect((await api('POST', '/auth/reset', { body: { token: 'x'.repeat(43), password: 'a password long enough' } })).status).toBe(400);
    await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    expect((await api('POST', '/auth/reset', { body: { token: tokenFromMail(), password: 'short' } })).status).toBe(400);
  });

  it('is rate limited per account and per client', async () => {
    for (let i = 0; i < 3; i++) expect((await api('POST', '/auth/recover', { body: { email: 'player@example.com' } })).status).toBe(200);
    const blocked = await api('POST', '/auth/recover', { body: { email: 'player@example.com' } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('rate limiting', () => {
  beforeEach(async () => void (await signup()));

  it('locks an account/client pair after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login('player@example.com', 'wrong password')).status).toBe(401);
    const blocked = await login('player@example.com', PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('rate_limited');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('unlocks when the window passes', async () => {
    for (let i = 0; i < 5; i++) await login('player@example.com', 'wrong password');
    t.clock.advance(15 * 60_000 + 1000);
    // the limiter clocks are real-time based on the injected clock
    expect((await login('player@example.com', PASSWORD)).status).toBe(200);
  });

  it('counts failures only: a success resets the account counter', async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await login('player@example.com', 'wrong password');
      expect((await login('player@example.com', PASSWORD)).status).toBe(200);
    }
  });

  it('does not let a stranger lock the real owner out', async () => {
    const proxied = await makeTestApp({ trustProxyHops: 1 });
    try {
      const p = await proxied.createProject('proxied');
      const call = (email: string, password: string, ip: string) =>
        proxied.call('POST', '/auth/login', { body: { email, password }, headers: { apikey: p.keys.anon, 'x-forwarded-for': ip } });
      await proxied.call('POST', '/auth/signup', { body: { email: 'owner@example.com', password: PASSWORD }, headers: { apikey: p.keys.anon, 'x-forwarded-for': '10.0.0.1' } });

      for (let i = 0; i < 8; i++) await call('owner@example.com', 'guess guess', '66.66.66.66'); // attacker
      expect((await call('owner@example.com', 'guess guess', '66.66.66.66')).status).toBe(429);
      expect((await call('owner@example.com', PASSWORD, '10.0.0.1')).status).toBe(200); // the owner, elsewhere, is fine
    } finally {
      await proxied.close();
    }
  });

  it('cannot be dodged by forging the left side of X-Forwarded-For', async () => {
    const proxied = await makeTestApp({ trustProxyHops: 1 });
    try {
      const p = await proxied.createProject('proxied');
      for (let i = 0; i < 5; i++) {
        await proxied.call('POST', '/auth/login', { body: { email: 'v@example.com', password: 'guess guess' }, headers: { apikey: p.keys.anon, 'x-forwarded-for': `1.2.3.${i}, 66.66.66.66` } });
      }
      const res = await proxied.call('POST', '/auth/login', { body: { email: 'v@example.com', password: 'guess guess' }, headers: { apikey: p.keys.anon, 'x-forwarded-for': '7.7.7.7, 66.66.66.66' } });
      expect(res.status).toBe(429);
    } finally {
      await proxied.close();
    }
  });

  it('limits sign-ups per client', async () => {
    let status = 0;
    for (let i = 0; i < 11; i++) status = (await signup(`bulk${i}@example.com`)).status;
    expect(status).toBe(429);
  });

  it('limits one client guessing across many accounts', async () => {
    let status = 0;
    for (let i = 0; i < 31; i++) status = (await login(`victim${i}@example.com`, 'guess guess')).status;
    expect(status).toBe(429);
  });
});

describe('admin brute force protection', () => {
  it('blocks a client after 10 wrong admin tokens, even if the next one is right', async () => {
    for (let i = 0; i < 10; i++) expect((await t.admin('GET', '/projects', undefined, `wrong-${i}`.padEnd(40, 'x'))).status).toBe(401);
    const blocked = await t.admin('GET', '/projects');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });
});

describe('internals stay private', () => {
  it('auth tables cannot be reached through REST or the table API', async () => {
    await signup();
    for (const name of ['_auth_users', '_auth_sessions', '_auth_refresh_tokens', '_auth_recovery_tokens']) {
      expect((await t.call('GET', `/rest/${name}`, { headers: { apikey: project.keys.service_role } })).status, name).toBe(404);
      expect((await t.admin('GET', `/projects/${project.id}/tables/${name}`)).status, name).toBe(404);
      expect((await t.admin('DELETE', `/projects/${project.id}/tables/${name}`)).status, name).toBe(404);
    }
    const listed = await t.admin('GET', `/projects/${project.id}/tables`);
    expect(listed.json.tables).toEqual([]);
  });

  it('deleting a project removes its users', async () => {
    await signup();
    expect((await t.admin('DELETE', `/projects/${project.id}?confirm=game`)).status).toBe(204);
    expect((await login()).status).toBe(401);
  });
});
