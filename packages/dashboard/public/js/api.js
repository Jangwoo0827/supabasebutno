export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onSessionLost = () => {};
export const setSessionLostHandler = (fn) => (onSessionLost = fn);

// Two ways to reach the admin API:
//  - served by the API server itself: same origin, login cookie (the default);
//  - "remote" (e.g. hosted on GitHub Pages): another origin, so no cookie — the admin token is sent as a Bearer header.
const remote = { base: null, token: null };
export const isRemote = () => remote.base !== null;
export const configureRemote = (base, token) => Object.assign(remote, { base, token });
export const clearRemote = () => Object.assign(remote, { base: null, token: null });
/** Address of the API server, as apps should use it. */
export const apiOrigin = () => remote.base ?? location.origin;

/**
 * Calls the admin API. Same-origin: login cookie plus a custom header the server requires (a form on another site
 * cannot send it). Remote: Bearer token, no cookies.
 * `body` may be a plain object (sent as JSON), a string/Blob/ArrayBuffer (sent as is), or undefined.
 */
export async function api(method, path, body, { headers = {}, raw = false, quiet = false } = {}) {
  const init = isRemote()
    ? { method, credentials: 'omit', headers: { Authorization: `Bearer ${remote.token}`, ...headers } }
    : { method, credentials: 'same-origin', headers: { 'X-SBB-CSRF': '1', ...headers } };
  if (body !== undefined) {
    const plain = body !== null && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body);
    if (plain) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else init.body = body;
  }
  let res;
  try {
    res = await fetch(`${remote.base ?? ''}/admin${path}`, init);
  } catch {
    throw new ApiError(
      isRemote() ? `API 서버(${remote.base})에 연결할 수 없습니다. 주소, HTTPS 여부, 서버의 ADMIN_CORS_ORIGINS 설정을 확인하세요.` : '서버에 연결할 수 없습니다.',
      0,
      'network_error',
    );
  }
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* not JSON */
    }
    const e = payload?.error;
    if (res.status === 401 && !quiet && path !== '/login') onSessionLost();
    throw new ApiError(describe(e) ?? `요청이 실패했습니다 (HTTP ${res.status})`, res.status, e?.code ?? 'http_error', e?.details);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** "message (path: detail)" for validation errors, so the user sees which field is wrong. */
function describe(e) {
  if (!e) return null;
  const only = Array.isArray(e.details) && e.details.length === 1 ? e.details[0] : null;
  if (only && (only.message === e.message || e.message.endsWith(only.message))) return only.path ? `${only.path}: ${only.message}` : only.message; // avoid saying the same thing twice
  if (Array.isArray(e.details) && e.details.length) {
    return `${e.message}\n${e.details.map((d) => (d.path ? `• ${d.path}: ${d.message}` : `• ${d.message}`)).join('\n')}`;
  }
  return e.message;
}
