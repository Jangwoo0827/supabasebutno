import { api, clearRemote, configureRemote, isRemote, setSessionLostHandler } from './api.js';
import { clear, h, toast } from './ui.js';
import { renderProject } from './views/project.js';
import { renderProjects } from './views/projects.js';

const app = document.getElementById('app');
let loggedIn = false;

// The page can be served by the API server itself (cookie login), or hosted elsewhere — e.g. GitHub Pages — where
// the build script marks it `remote`: then the user names the API server and the admin token is sent as a Bearer header.
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
const REMOTE_MODE = meta('sbb-mode') === 'remote';
const TOKEN_KEY = 'sbb.admin.token'; // sessionStorage: gone when the tab closes
const URL_KEY = 'sbb.api.url'; // localStorage: the address is not a secret

const store = (area, key, value) => {
  try {
    if (value === null) area.removeItem(key);
    else area.setItem(key, value);
  } catch {
    /* storage unavailable: the login simply will not survive a reload */
  }
};
const load = (area, key) => {
  try {
    return area.getItem(key);
  } catch {
    return null;
  }
};

/** "https://api.example.com/" -> "https://api.example.com"; throws a readable message for anything else. */
function normalizeApiUrl(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error('API 주소를 https://api.example.com 형태로 입력하세요.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('주소는 http:// 또는 https:// 로 시작해야 합니다.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (location.protocol === 'https:' && url.protocol === 'http:' && !local) {
    throw new Error('HTTPS 페이지에서는 http:// 서버에 연결할 수 없습니다 (브라우저가 막음). 서버 앞에 HTTPS 를 설정하세요.');
  }
  if (url.protocol === 'http:' && !local) throw new Error('관리자 토큰이 암호화되지 않은 채 전송됩니다. HTTPS 주소를 사용하세요.');
  return url.origin;
}

function showLogin(message) {
  loggedIn = false;
  clear(app);
  const apiUrl = REMOTE_MODE
    ? h('input', { type: 'text', class: 'mono', autocomplete: 'url', placeholder: 'https://api.example.com', 'aria-label': 'API 주소', value: load(localStorage, URL_KEY) || meta('sbb-api-url') })
    : null;
  const token = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'ADMIN_TOKEN', 'aria-label': '관리자 토큰' });
  const error = h('div', { class: 'error' }, message ?? '');
  const submit = h('button', { class: 'primary', type: 'submit' }, '로그인');
  const form = h('form', { class: 'stack' },
    h('h1', null, 'supabasebutno'),
    REMOTE_MODE
      ? h('p', { class: 'muted' }, '연결할 API 서버 주소와 ADMIN_TOKEN 을 입력하세요. 토큰은 이 탭의 sessionStorage 에만 두고 탭을 닫으면 사라지며, 입력한 서버로만 전송됩니다.')
      : h('p', { class: 'muted' }, '서버의 ADMIN_TOKEN을 입력하세요. 토큰은 이 브라우저에 저장되지 않고, 로그인 후에는 8시간짜리 세션 쿠키만 남습니다.'),
    apiUrl && h('div', null, h('label', null, 'API 주소'), apiUrl),
    h('div', null, h('label', null, '관리자 토큰'), token),
    error,
    submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      if (REMOTE_MODE) {
        const base = normalizeApiUrl(apiUrl.value);
        configureRemote(base, token.value);
        try {
          await api('GET', '/session', undefined, { quiet: true });
        } catch (err) {
          clearRemote();
          throw err;
        }
        store(localStorage, URL_KEY, base);
        store(sessionStorage, TOKEN_KEY, token.value);
      } else {
        await api('POST', '/login', { token: token.value });
      }
      token.value = '';
      loggedIn = true;
      route();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      token.select();
    }
  });
  app.append(h('div', { class: 'login' }, h('div', { class: 'card' }, form)));
  (apiUrl && !apiUrl.value ? apiUrl : token).focus();
}

async function logout() {
  if (isRemote()) {
    clearRemote();
    store(sessionStorage, TOKEN_KEY, null);
  } else {
    await api('POST', '/logout').catch(() => undefined);
  }
  showLogin();
}

function shell(content) {
  return h('div', null,
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, 'supabasebutno'),
      h('div', { class: 'row' }, isRemote() && h('span', { class: 'muted mono' }, new URL(load(localStorage, URL_KEY) || location.href).host), h('button', { class: 'small', onclick: logout }, '로그아웃'))),
    h('main', { class: 'container' }, content));
}

async function route() {
  if (!loggedIn) return;
  const [section, id, tab, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const content = h('div', null);
  clear(app).append(shell(content));
  try {
    if (section === 'p' && id) await renderProject(content, id, tab || 'overview', rest);
    else await renderProjects(content);
  } catch (err) {
    content.replaceChildren(h('div', { class: 'card stack' }, h('h2', null, '불러오지 못했습니다'), h('p', { class: 'error' }, err.message), h('a', { href: '#/' }, '← 프로젝트 목록')));
  }
}

setSessionLostHandler(() => {
  if (!loggedIn) return;
  if (isRemote()) {
    clearRemote();
    store(sessionStorage, TOKEN_KEY, null);
  }
  showLogin('세션이 만료되었거나 토큰이 바뀌었습니다. 다시 로그인하세요.');
});
window.addEventListener('hashchange', route);

(async function boot() {
  try {
    if (REMOTE_MODE) {
      const base = load(localStorage, URL_KEY);
      const token = load(sessionStorage, TOKEN_KEY);
      if (!base || !token) return showLogin();
      configureRemote(base, token);
    }
    await api('GET', '/session', undefined, { quiet: true });
    loggedIn = true;
    route();
  } catch (err) {
    clearRemote();
    if (err.status === 0) toast(err.message, 'error');
    showLogin();
  }
})();
