import { api } from '../api.js';
import { actionButton, confirmDialog, guard, h, modal, toast } from '../ui.js';

const TYPES = ['text', 'integer', 'real', 'boolean', 'json', 'timestamp', 'uuid'];

function describeDefault(d) {
  if (d === undefined) return '';
  if (d === null) return 'NULL';
  if (typeof d === 'object') return d.fn ? `${d.fn}()` : (d.sql ?? '');
  return typeof d === 'string' ? JSON.stringify(d) : String(d);
}

/** One editable column definition; `read()` returns the API object or throws a readable error. */
function columnEditor({ forNewTable }) {
  const name = h('input', { type: 'text', placeholder: 'column_name', 'aria-label': '컬럼 이름', class: 'mono' });
  const type = h('select', { 'aria-label': '타입' }, TYPES.map((t) => h('option', { value: t }, t)));
  const pk = h('input', { type: 'checkbox' });
  const notNull = h('input', { type: 'checkbox' });
  const unique = h('input', { type: 'checkbox' });
  const kind = h('select', { 'aria-label': '기본값 종류' },
    h('option', { value: 'none' }, '기본값 없음'), h('option', { value: 'value' }, '값'), h('option', { value: 'null' }, 'NULL'),
    forNewTable && h('option', { value: 'now' }, 'now() · 현재 시각'), forNewTable && h('option', { value: 'uuid' }, 'uuid() · 랜덤 UUID'));
  const value = h('input', { type: 'text', placeholder: '값', 'aria-label': '기본값' });
  const sync = () => (value.style.display = kind.value === 'value' ? '' : 'none');
  kind.addEventListener('change', sync);
  sync();

  const el = h('div', { class: 'row' },
    h('div', { class: 'grow' }, name), type,
    forNewTable && h('label', { class: 'check' }, pk, '기본 키'),
    h('label', { class: 'check' }, notNull, 'NOT NULL'),
    forNewTable && h('label', { class: 'check' }, unique, 'UNIQUE'),
    kind, value);

  const read = () => {
    const col = { name: name.value.trim(), type: type.value };
    if (!col.name) throw new Error('컬럼 이름을 입력하세요');
    if (pk.checked) col.primary_key = true;
    if (notNull.checked) col.not_null = true;
    if (unique.checked) col.unique = true;
    if (kind.value === 'null') col.default = null;
    else if (kind.value === 'now' || kind.value === 'uuid') col.default = { fn: kind.value };
    else if (kind.value === 'value') {
      const raw = value.value;
      if (['integer', 'real'].includes(col.type)) {
        if (raw.trim() === '' || Number.isNaN(Number(raw))) throw new Error(`"${col.name}" 의 기본값은 숫자여야 합니다`);
        col.default = Number(raw);
      } else if (col.type === 'boolean') {
        if (!['true', 'false'].includes(raw.trim())) throw new Error(`"${col.name}" 의 기본값은 true 또는 false 여야 합니다`);
        col.default = raw.trim() === 'true';
      } else col.default = raw;
    }
    return col;
  };
  return { el, read };
}

async function createTableDialog(project) {
  return modal('새 테이블', (close) => {
    const name = h('input', { type: 'text', placeholder: 'table_name', class: 'mono' });
    const rows = h('div', { class: 'stack' });
    const editors = [];
    const addRow = (preset) => {
      const ed = columnEditor({ forNewTable: true });
      editors.push(ed);
      rows.append(ed.el);
      return ed;
    };
    const id = addRow();
    id.el.querySelector('input[type=text]').value = 'id';
    id.el.querySelector('select').value = 'integer';
    id.el.querySelectorAll('input[type=checkbox]')[0].checked = true;
    addRow();
    const error = h('div', { class: 'error' });
    const save = actionButton('만들기', async () => {
      error.textContent = '';
      try {
        const columns = editors.map((e) => e.read()).filter((c) => c.name);
        await api('POST', `/projects/${project.id}/tables`, { name: name.value.trim(), columns });
        close(true);
      } catch (err) {
        error.textContent = err.message;
      }
    }, { cls: 'primary' });
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, '소문자·숫자·밑줄만 쓸 수 있고 글자로 시작해야 합니다. 기본 키 컬럼이 정확히 하나 필요합니다 (integer 는 자동 증가).'),
      h('div', null, h('label', null, '테이블 이름'), name), h('label', null, '컬럼'), rows,
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => addRow() }, '+ 컬럼 추가')), error,
      h('div', { class: 'row end' }, h('button', { onclick: () => close(false) }, '취소'), save));
  }, { wide: true });
}

function alterDialog(project, table, kind) {
  return modal(`${table.name} · ${{ add: '컬럼 추가', rename: '컬럼 이름 변경', drop: '컬럼 삭제', rename_table: '테이블 이름 변경' }[kind]}`, (close) => {
    const error = h('div', { class: 'error' });
    const names = table.columns.map((c) => c.name);
    let build;
    let content;
    if (kind === 'add') {
      const ed = columnEditor({ forNewTable: false });
      content = [h('p', { class: 'muted' }, '기존 테이블에는 now()/uuid() 기본값, UNIQUE, 기본 키 컬럼을 추가할 수 없고 (SQLite 제약), NOT NULL 이면 기본값이 필요합니다.'), ed.el];
      build = () => ({ add_columns: [ed.read()] });
    } else if (kind === 'rename') {
      const from = h('select', null, names.map((n) => h('option', { value: n }, n)));
      const to = h('input', { type: 'text', placeholder: '새 이름', class: 'mono' });
      content = [h('div', { class: 'row' }, from, '→', to)];
      build = () => ({ rename_columns: [{ from: from.value, to: to.value.trim() }] });
    } else if (kind === 'drop') {
      const which = h('select', null, table.columns.filter((c) => !c.primary_key && !c.unique).map((c) => h('option', { value: c.name }, c.name)));
      content = [h('p', { class: 'muted' }, '기본 키와 UNIQUE 컬럼은 삭제할 수 없습니다. 컬럼의 데이터는 영구 삭제됩니다.'), which];
      build = () => ({ drop_columns: [which.value] });
    } else {
      const to = h('input', { type: 'text', value: table.name, class: 'mono' });
      content = [to, h('p', { class: 'muted' }, '접근 정책은 새 이름으로 따라갑니다.')];
      build = () => ({ rename_to: to.value.trim() });
    }
    const save = actionButton('적용', async () => {
      error.textContent = '';
      try {
        await api('PATCH', `/projects/${project.id}/tables/${table.name}`, build());
        close(true);
      } catch (err) {
        error.textContent = err.message;
      }
    }, { cls: 'primary' });
    return h('div', { class: 'stack' }, content, error, h('div', { class: 'row end' }, h('button', { onclick: () => close(false) }, '취소'), save));
  }, { wide: kind === 'add' });
}

export async function renderTables(root, project) {
  const holder = h('div', { class: 'stack' });
  const refresh = async () => {
    const { tables } = await api('GET', `/projects/${project.id}/tables`);
    holder.replaceChildren(
      ...(tables.length === 0
        ? [h('div', { class: 'card empty' }, '테이블이 없습니다.')]
        : tables.map((t) =>
            h('div', { class: 'card stack' },
              h('div', { class: 'row between' },
                h('h3', { class: 'mono' }, t.name),
                h('div', { class: 'row' },
                  ...['add', 'rename', 'drop', 'rename_table'].map((k) =>
                    h('button', { class: 'small', onclick: async () => { if (await alterDialog(project, t, k)) { toast('변경했습니다'); refresh(); } } },
                      { add: '+ 컬럼', rename: '컬럼 이름', drop: '컬럼 삭제', rename_table: '테이블 이름' }[k])),
                  h('button', { class: 'small danger', onclick: async () => {
                    if (!(await confirmDialog('테이블과 모든 행, 접근 정책이 영구 삭제됩니다.', { confirmLabel: '테이블 삭제', danger: true, typeToConfirm: t.name }))) return;
                    if (await guard(() => api('DELETE', `/projects/${project.id}/tables/${t.name}`).then(() => true))) { toast('삭제했습니다'); refresh(); }
                  } }, '삭제'))),
              h('div', { class: 'table-wrap' }, h('table', null,
                h('thead', null, h('tr', null, ['컬럼', '타입', '제약', '기본값'].map((x) => h('th', null, x)))),
                h('tbody', null, t.columns.map((c) => h('tr', null,
                  h('td', { class: 'mono' }, c.name), h('td', null, c.type),
                  h('td', null, [c.primary_key && h('span', { class: 'badge ok' }, 'PK'), c.not_null && !c.primary_key && h('span', { class: 'badge' }, 'NOT NULL'), c.unique && h('span', { class: 'badge' }, 'UNIQUE')].filter(Boolean).flatMap((b) => [b, ' '])),
                  h('td', { class: 'mono' }, describeDefault(c.default)))))))))));
  };
  await refresh();
  root.append(
    h('div', { class: 'row between' }, h('h2', null, '테이블'),
      h('button', { class: 'primary', onclick: async () => { if (await createTableDialog(project)) { toast('테이블을 만들었습니다'); refresh(); } } }, '+ 새 테이블')),
    holder);
}
