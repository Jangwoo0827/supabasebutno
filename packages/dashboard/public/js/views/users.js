import { api } from '../api.js';
import { actionButton, confirmDialog, formatDate, guard, h, toast } from '../ui.js';

const PAGE = 50;

export async function renderUsers(root, project) {
  const state = { offset: 0 };
  const info = h('span', { class: 'muted' });
  const body = h('div', null);
  const prev = h('button', { class: 'small' }, '← 이전');
  const next = h('button', { class: 'small' }, '다음 →');

  async function load() {
    const { users, total } = await api('GET', `/projects/${project.id}/users?limit=${PAGE}&offset=${state.offset}`);
    info.textContent = total === 0 ? '사용자 없음' : `${state.offset + 1}–${state.offset + users.length} / ${total}`;
    prev.disabled = state.offset === 0;
    next.disabled = state.offset + users.length >= total;
    body.replaceChildren(users.length === 0
      ? h('div', { class: 'card empty' }, '아직 가입한 사용자가 없습니다.')
      : h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['이메일', 'ID', '가입', '마지막 로그인', '활성 세션', '메타데이터', ''].map((x) => h('th', null, x)))),
          h('tbody', null, users.map((u) => h('tr', null,
            h('td', null, u.email), h('td', { class: 'mono' }, u.id), h('td', null, formatDate(u.created_at)), h('td', null, formatDate(u.last_sign_in_at)),
            h('td', null, String(u.active_sessions)),
            h('td', { class: 'cell', title: JSON.stringify(u.user_metadata) }, JSON.stringify(u.user_metadata)),
            h('td', { class: 'actions' },
              actionButton('로그아웃 시키기', async () => {
                if (await guard(() => api('POST', `/projects/${project.id}/users/${u.id}/sign-out`).then(() => true))) {
                  toast('모든 세션을 종료했습니다');
                  load();
                }
              }, { cls: 'small' }), ' ',
              actionButton('삭제', async () => {
                if (!(await confirmDialog(`${u.email} 계정과 모든 세션이 영구 삭제됩니다. (이 사용자의 행이나 파일은 지워지지 않습니다.)`, { confirmLabel: '삭제', danger: true }))) return;
                if (await guard(() => api('DELETE', `/projects/${project.id}/users/${u.id}`).then(() => true))) {
                  toast('삭제했습니다');
                  load();
                }
              }, { cls: 'small danger' }))))))));
  }
  prev.addEventListener('click', () => ((state.offset = Math.max(0, state.offset - PAGE)), load()));
  next.addEventListener('click', () => ((state.offset += PAGE), load()));

  root.append(h('div', { class: 'row between' }, h('h2', null, '사용자'), h('div', { class: 'row' }, info, prev, next)), body,
    h('p', { class: 'muted' }, '비밀번호 해시는 표시하지 않습니다. 사용자는 앱에서 가입합니다 (POST /auth/signup).'));
  await load();
}
