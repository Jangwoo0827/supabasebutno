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

/**
 * Calls the admin API with the login cookie. The custom header is what the server requires from
 * pages of its own origin (a form on another site cannot send it).
 * `body` may be a plain object (sent as JSON), a string/Blob/ArrayBuffer (sent as is), or undefined.
 */
export async function api(method, path, body, { headers = {}, raw = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { 'X-SBB-CSRF': '1', ...headers } };
  if (body !== undefined) {
    const plain = body !== null && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body);
    if (plain) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else init.body = body;
  }
  let res;
  try {
    res = await fetch(`/admin${path}`, init);
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다.', 0, 'network_error');
  }
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* not JSON */
    }
    const e = payload?.error;
    if (res.status === 401 && path !== '/login') onSessionLost();
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
