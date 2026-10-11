import { api } from '../api.js';
import { h } from '../ui.js';
import { renderData } from './data.js';
import { renderOverview } from './overview.js';
import { renderPolicies } from './policies.js';
import { renderStorage } from './storage.js';
import { renderTables } from './tables.js';
import { renderUsers } from './users.js';

const TABS = [
  ['overview', '개요 · API 키', renderOverview],
  ['tables', '테이블', renderTables],
  ['data', '데이터', renderData],
  ['policies', '접근 정책', renderPolicies],
  ['users', '사용자', renderUsers],
  ['storage', '파일', renderStorage],
];

export async function renderProject(root, id, tab, rest) {
  const project = await api('GET', `/projects/${encodeURIComponent(id)}`);
  const body = h('div', null);
  root.append(
    h('div', { class: 'row between' },
      h('div', null, h('a', { href: '#/', class: 'muted' }, '← 프로젝트'), h('h1', null, project.name), h('div', { class: 'muted mono' }, project.id))),
    h('nav', { class: 'tabs' }, TABS.map(([key, label]) => h('a', { class: `tab ${key === tab ? 'active' : ''}`, href: `#/p/${project.id}/${key}` }, label))),
    body);
  const view = TABS.find(([key]) => key === tab) ?? TABS[0];
  await view[2](body, project, rest);
}
