import { makeTestApp } from '../../server/test/helpers.js';
import { createClient, type ClientOptions } from '../src/index.js';

export type Harness = Awaited<ReturnType<typeof startServer>>;

/** A real server (HTTP + WebSocket) on a free port, with one project, for SDK tests. */
export async function startServer(config: Parameters<typeof makeTestApp>[0] = {}, realtime: Record<string, unknown> = {}) {
  const t = await makeTestApp(config, { realtime: { authTimeoutMs: 1000, ...realtime } });
  const net = await t.listen();
  const project = await t.createProject('sdk');
  const client = (key: 'anon' | 'service', options: ClientOptions = {}) =>
    createClient(net.httpUrl, key === 'anon' ? project.keys.anon : project.keys.service_role, options);
  /** Creates a table through the admin API. */
  const table = async (name: string, columns: unknown[]) => {
    const res = await t.admin('POST', `/projects/${project.id}/tables`, { name, columns });
    if (res.status !== 201) throw new Error(`table ${name} failed: ${res.text}`);
  };
  const policy = async (tableName: string, body: unknown) => {
    const res = await t.admin('PUT', `/projects/${project.id}/policies/${tableName}`, body);
    if (res.status !== 200) throw new Error(`policy ${tableName} failed: ${res.text}`);
  };
  return { t, net, project, url: net.httpUrl, client, table, policy };
}

export const PASSWORD = 'correct horse battery';

/** A syntactically valid API key (right `ref` claim, bogus signature) for tests that never reach a server. */
export function fakeKey(ref = 'abcdefghij012345') {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', ref })}.sig`;
}

/** Records every request and answers with canned responses. */
export function mockFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response> = () => json([])) {
  const calls: { url: URL; method: string; headers: Record<string, string>; body: string | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: String(init.method ?? 'GET'), headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === 'string' ? init.body : undefined });
    return respond(url, init);
  }) as typeof fetch;
  return { fn, calls, last: () => calls[calls.length - 1]! };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value. */
export async function eventually<T>(fn: () => T | Promise<T>, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}
