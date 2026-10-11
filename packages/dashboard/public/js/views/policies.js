import { api } from '../api.js';
import { actionButton, confirmDialog, guard, h, toast } from '../ui.js';

/** Starting points; each is checked against the real table by the server when saved. */
function presets(table) {
  // The ownership templates need a text/uuid column that will hold the user's id; offer them only if one exists.
  const owner = table.columns.find((c) => /^(user_id|owner|owner_id|author_id)$/.test(c.name) && ['text', 'uuid'].includes(c.type))?.name;
  const list = {
    '공개 읽기 (누구나 읽기만)': { select: { roles: ['anon', 'authenticated'], where: true } },
    '로그인한 사용자만 읽기·쓰기': {
      select: { roles: ['authenticated'], where: true },
      insert: { roles: ['authenticated'] },
      update: { roles: ['authenticated'], where: true },
      delete: { roles: ['authenticated'], where: true },
    },
  };
  if (owner) {
    list[`본인 행만 (${owner} = 로그인한 사용자)`] = {
      select: { roles: ['authenticated'], where: { [owner]: '$uid' } },
      insert: { roles: ['authenticated'], set: { [owner]: '$uid' } },
      update: { roles: ['authenticated'], where: { [owner]: '$uid' } },
      delete: { roles: ['authenticated'], where: { [owner]: '$uid' } },
    };
    list[`리더보드 (누구나 읽기, 로그인해야 기록, 본인 기록만 삭제)`] = {
      select: { roles: ['anon', 'authenticated'], where: true },
      insert: { roles: ['authenticated'], set: { [owner]: '$uid' } },
      delete: { roles: ['authenticated'], where: { [owner]: '$uid' } },
    };
  }
  return { list, owner };
}

export async function renderPolicies(root, project) {
  const [{ tables }, { policies }] = await Promise.all([api('GET', `/projects/${project.id}/tables`), api('GET', `/projects/${project.id}/policies`)]);
  if (tables.length === 0) {
    root.append(h('div', { class: 'card empty' }, '테이블이 없습니다.'));
    return;
  }
  const byTable = new Map(policies.map((p) => [p.table, p]));

  const picker = h('select', { 'aria-label': '테이블' }, tables.map((t) => h('option', { value: t.name }, `${t.name}${byTable.has(t.name) ? '  ✓' : ''}`)));
  const status = h('div', null);
  const editor = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': '정책 JSON' });
  const presetPicker = h('select', { 'aria-label': '템플릿' });
  const error = h('div', { class: 'error' });
  const ownerNote = h('div', { class: 'muted' });
  const current = () => tables.find((t) => t.name === picker.value);

  function show() {
    const t = current();
    const stored = byTable.get(t.name);
    status.replaceChildren(stored
      ? h('span', { class: 'badge ok' }, '정책 있음')
      : h('span', { class: 'badge warn' }, '정책 없음 — anon · 로그인 사용자 모두 접근 거부 (service_role 만 가능)'));
    editor.value = stored ? JSON.stringify(stored.policy, null, 2) : '';
    error.textContent = '';
    const { list, owner } = presets(t);
    ownerNote.textContent = owner ? '' : '"본인 행만"·"리더보드" 템플릿을 쓰려면 사용자 id 를 담을 text 컬럼(user_id, owner 등)이 필요합니다. 테이블 탭에서 추가하세요.';
    presetPicker.replaceChildren(h('option', { value: '' }, '템플릿에서 시작…'), ...Object.keys(list).map((k) => h('option', { value: k }, k)));
    presetPicker.onchange = () => {
      if (presetPicker.value) editor.value = JSON.stringify(list[presetPicker.value], null, 2);
      presetPicker.value = '';
    };
  }
  picker.addEventListener('change', show);

  const save = actionButton('저장', async () => {
    error.textContent = '';
    let parsed;
    try {
      parsed = JSON.parse(editor.value);
    } catch (err) {
      error.textContent = `JSON 형식 오류: ${err.message}`;
      return;
    }
    const t = current();
    try {
      const res = await api('PUT', `/projects/${project.id}/policies/${t.name}`, parsed);
      byTable.set(t.name, res);
      picker.options[picker.selectedIndex].textContent = `${t.name}  ✓`;
      show();
      toast('정책을 저장했습니다. 다음 요청부터 적용됩니다.');
    } catch (err) {
      error.textContent = err.message;
    }
  }, { cls: 'primary' });

  const remove = actionButton('정책 삭제', async () => {
    const t = current();
    if (!byTable.has(t.name)) return toast('삭제할 정책이 없습니다', 'error');
    if (!(await confirmDialog(`"${t.name}" 의 정책을 삭제하면 service_role 외에는 아무도 접근할 수 없게 됩니다.`, { confirmLabel: '삭제', danger: true }))) return;
    if (await guard(() => api('DELETE', `/projects/${project.id}/policies/${t.name}`).then(() => true))) {
      byTable.delete(t.name);
      picker.options[picker.selectedIndex].textContent = t.name;
      show();
      toast('삭제했습니다');
    }
  }, { cls: 'danger' });

  root.append(h('div', { class: 'stack' },
    h('div', { class: 'notice' }, '정책이 없는 테이블은 기본적으로 모두 거부됩니다. 허용할 동작(select / insert / update / delete)을 역할(anon / authenticated)별로 정의하세요. 정책 문법은 README 의 "접근 제어" 장을 참고하세요.'),
    h('div', { class: 'row' }, picker, presetPicker, status), ownerNote,
    editor, error,
    h('div', { class: 'row' }, save, remove)));
  show();
}
