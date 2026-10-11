import { api } from '../api.js';
import { actionButton, confirmDialog, guard, h, modal, toast } from '../ui.js';

const PAGE = 50;

function cellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** JSON editor dialog for one row. Resolves with the parsed object, or undefined if cancelled. */
function rowDialog(title, initial, hint) {
  return modal(title, (close) => {
    const text = h('textarea', { class: 'code', spellcheck: 'false' });
    text.value = JSON.stringify(initial, null, 2);
    const error = h('div', { class: 'error' });
    const save = h('button', { class: 'primary', onclick: () => {
      try {
        const parsed = JSON.parse(text.value);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 객체여야 합니다');
        close(parsed);
      } catch (err) {
        error.textContent = err.message;
      }
    } }, '저장');
    return h('div', { class: 'stack' }, hint && h('p', { class: 'muted' }, hint), text, error,
      h('div', { class: 'row end' }, h('button', { onclick: () => close(undefined) }, '취소'), save));
  }, { wide: true });
}

export async function renderData(root, project, rest) {
  const { tables } = await api('GET', `/projects/${project.id}/tables`);
  if (tables.length === 0) {
    root.append(h('div', { class: 'card empty' }, '테이블이 없습니다. "테이블" 탭에서 먼저 만드세요.'));
    return;
  }
  const state = { table: tables.find((t) => t.name === rest[0]) ?? tables[0], offset: 0, filter: '' };
  const pkOf = (t) => t.columns.find((c) => c.primary_key).name;

  const picker = h('select', { 'aria-label': '테이블' }, tables.map((t) => h('option', { value: t.name, selected: t === state.table }, t.name)));
  const filter = h('input', { type: 'text', class: 'mono', placeholder: '필터 예: done=eq.false&priority=gte.3', 'aria-label': '필터' });
  const info = h('span', { class: 'muted' });
  const view = h('div', null);
  const prev = h('button', { class: 'small' }, '← 이전');
  const next = h('button', { class: 'small' }, '다음 →');

  async function load() {
    const t = state.table;
    const params = new URLSearchParams(state.filter);
    params.set('limit', String(PAGE));
    params.set('offset', String(state.offset));
    params.set('order', `${pkOf(t)}.asc`);
    const res = await guard(() => api('GET', `/projects/${project.id}/rest/${encodeURIComponent(t.name)}?${params}`, undefined, { headers: { Prefer: 'count=exact' }, raw: true }));
    if (!res) return;
    const rows = await res.json();
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? rows.length);
    info.textContent = total === 0 ? '행 없음' : `${state.offset + 1}–${state.offset + rows.length} / ${total}`;
    prev.disabled = state.offset === 0;
    next.disabled = state.offset + rows.length >= total;

    const pk = pkOf(t);
    view.replaceChildren(rows.length === 0
      ? h('div', { class: 'card empty' }, '조건에 맞는 행이 없습니다.')
      : h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, t.columns.map((c) => h('th', null, c.name)), h('th', null, ''))),
          h('tbody', null, rows.map((row) => h('tr', null,
            t.columns.map((c) => {
              const text = cellText(row[c.name]);
              return text === null ? h('td', { class: 'cell null' }, 'NULL') : h('td', { class: 'cell', title: text }, text);
            }),
            h('td', { class: 'actions' },
              h('button', { class: 'small', onclick: () => edit(row) }, '수정'), ' ',
              h('button', { class: 'small danger', onclick: () => remove(row) }, '삭제'))))))));
    const idFilter = (row) => `${encodeURIComponent(pk)}=eq.${encodeURIComponent(row[pk])}`;
    view.idFilter = idFilter;
  }

  async function edit(row) {
    const pk = pkOf(state.table);
    const changed = await rowDialog(`행 수정 · ${state.table.name}`, row, 'JSON 을 수정하세요. 바뀐 값만 저장됩니다.');
    if (!changed) return;
    const patch = Object.fromEntries(Object.entries(changed).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(row[k])));
    if (Object.keys(patch).length === 0) return toast('바뀐 값이 없습니다');
    if (await guard(() => api('PATCH', `/projects/${project.id}/rest/${encodeURIComponent(state.table.name)}?${view.idFilter(row)}`, patch).then(() => true))) {
      toast(`저장했습니다 (${pk}=${row[pk]})`);
      load();
    }
  }

  async function remove(row) {
    const pk = pkOf(state.table);
    if (!(await confirmDialog(`${pk} = ${row[pk]} 행을 삭제합니다.`, { confirmLabel: '삭제', danger: true }))) return;
    if (await guard(() => api('DELETE', `/projects/${project.id}/rest/${encodeURIComponent(state.table.name)}?${view.idFilter(row)}`).then(() => true))) {
      toast('삭제했습니다');
      load();
    }
  }

  async function insert() {
    const template = Object.fromEntries(state.table.columns.filter((c) => !(c.primary_key && c.type === 'integer')).map((c) => [c.name, c.default !== undefined && typeof c.default !== 'object' ? c.default : null]));
    const row = await rowDialog(`행 추가 · ${state.table.name}`, template, '값을 채우세요. null 로 두거나 항목을 지우면 기본값이 쓰입니다 (NOT NULL 컬럼은 값이 필요).');
    if (!row) return;
    const cleaned = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
    if (await guard(() => api('POST', `/projects/${project.id}/rest/${encodeURIComponent(state.table.name)}`, cleaned).then(() => true))) {
      toast('추가했습니다');
      load();
    }
  }

  picker.addEventListener('change', () => {
    state.table = tables.find((t) => t.name === picker.value);
    state.offset = 0;
    state.filter = '';
    filter.value = '';
    load();
  });
  const apply = () => {
    state.filter = filter.value.trim();
    state.offset = 0;
    load();
  };
  filter.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
  prev.addEventListener('click', () => ((state.offset = Math.max(0, state.offset - PAGE)), load()));
  next.addEventListener('click', () => ((state.offset += PAGE), load()));

  root.append(
    h('div', { class: 'row' }, picker, h('div', { class: 'grow' }, filter), h('button', { onclick: apply }, '적용'), actionButton('+ 행 추가', insert, { cls: 'primary' })),
    h('div', { class: 'row between', style: null }, info, h('div', { class: 'row' }, prev, next)),
    view,
    h('p', { class: 'muted' }, '이 화면은 service_role 권한으로 접근 정책을 우회해서 보여줍니다. 필터 문법은 REST API 와 같습니다.'));
  await load();
}
