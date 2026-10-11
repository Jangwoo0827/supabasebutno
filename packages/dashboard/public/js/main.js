import { api, setSessionLostHandler } from './api.js';
import { clear, h, toast } from './ui.js';
import { renderProject } from './views/project.js';
import { renderProjects } from './views/projects.js';

const app = document.getElementById('app');
let loggedIn = false;

function showLogin(message) {
  loggedIn = false;
  clear(app);
  const token = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'ADMIN_TOKEN', 'aria-label': '관리자 토큰' });
  const error = h('div', { class: 'error' }, message ?? '');
  const submit = h('button', { class: 'primary', type: 'submit' }, '로그인');
  const form = h('form', { class: 'stack' },
    h('h1', null, 'supabasebutno'),
    h('p', { class: 'muted' }, '서버의 ADMIN_TOKEN을 입력하세요. 토큰은 이 브라우저에 저장되지 않고, 로그인 후에는 8시간짜리 세션 쿠키만 남습니다.'),
    h('div', null, h('label', null, '관리자 토큰'), token),
    error,
    submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      await api('POST', '/login', { token: token.value });
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
  token.focus();
}

async function logout() {
  await api('POST', '/logout').catch(() => undefined);
  showLogin();
}

function shell(content) {
  return h('div', null,
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, 'supabasebutno'),
      h('button', { class: 'small', onclick: logout }, '로그아웃')),
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

setSessionLostHandler(() => loggedIn && showLogin('세션이 만료되었습니다. 다시 로그인하세요.'));
window.addEventListener('hashchange', route);

(async function boot() {
  try {
    await api('GET', '/session');
    loggedIn = true;
    route();
  } catch (err) {
    if (err.status === 0) toast(err.message, 'error');
    showLogin();
  }
})();
