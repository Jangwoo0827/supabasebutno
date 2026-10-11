import { api } from '../api.js';
import { actionButton, confirmDialog, copyText, guard, h, toast } from '../ui.js';

function keyBox(label, value, note, danger) {
  let shown = false;
  const text = h('div', { class: 'secret' }, '•'.repeat(40));
  const toggle = h('button', { class: 'small' }, '보기');
  toggle.addEventListener('click', () => {
    shown = !shown;
    text.textContent = shown ? value : '•'.repeat(40);
    toggle.textContent = shown ? '숨기기' : '보기';
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'row between' },
      h('h3', null, label, ' ', h('span', { class: `badge ${danger ? 'warn' : ''}` }, danger ? '비밀' : '공개 가능')),
      h('div', { class: 'row' }, toggle, h('button', { class: 'small', onclick: () => copyText(value) }, '복사'))),
    text,
    h('div', { class: 'muted' }, note));
}

export async function renderOverview(root, project) {
  let current = project;
  const keysBox = h('div', { class: 'stack' });
  const paint = () => {
    keysBox.replaceChildren(
      keyBox('anon key', current.keys.anon, '브라우저·앱·게임·확장 프로그램에 넣어도 되는 키입니다. 할 수 있는 일은 테이블 접근 정책이 결정합니다.', false),
      keyBox('service_role key', current.keys.service_role, '모든 접근 정책을 우회합니다. 서버에서만 쓰고, 절대 클라이언트 코드나 공개 저장소에 넣지 마세요.', true));
  };
  paint();

  const rotate = actionButton('키 다시 발급 (이전 키 즉시 폐기)', async () => {
    if (!(await confirmDialog('모든 anon / service_role 키가 즉시 무효가 됩니다. 이 키를 쓰는 앱은 새 키로 교체하기 전까지 동작하지 않습니다.', { confirmLabel: '다시 발급', danger: true }))) return;
    const next = await guard(() => api('POST', `/projects/${project.id}/rotate-keys`));
    if (next) {
      current = next;
      paint();
      toast('새 키를 발급했습니다');
    }
  }, { cls: 'danger' });

  const remove = actionButton('프로젝트 삭제', async () => {
    if (!(await confirmDialog('DB, 사용자, 업로드한 파일이 모두 영구 삭제됩니다. 되돌릴 수 없습니다.', { confirmLabel: '영구 삭제', danger: true, typeToConfirm: project.name }))) return;
    if (await guard(() => api('DELETE', `/projects/${project.id}?confirm=${encodeURIComponent(project.name)}`).then(() => true))) {
      toast('프로젝트를 삭제했습니다');
      location.hash = '#/';
    }
  }, { cls: 'danger' });

  const origin = location.origin;
  const snippet = `<script src="supabasebutno.min.js"></script>\n<script>\n  const client = supabasebutno.createClient('${origin}', 'ANON_KEY');\n  client.from('todos').select('*').then(({ data, error }) => console.log(data, error));\n</script>`;

  root.append(h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', null, 'API 키'), keysBox, h('div', { class: 'row' }, rotate)),
    h('div', { class: 'card stack' }, h('h2', null, '연결하기'),
      h('div', null, h('label', null, 'API 주소'), h('div', { class: 'row' }, h('code', null, origin), h('button', { class: 'small', onclick: () => copyText(origin) }, '복사'))),
      h('div', null, h('label', null, '실시간(WebSocket)'), h('code', null, `${origin.replace(/^http/, 'ws')}/realtime`)),
      h('pre', null, snippet)),
    h('div', { class: 'card stack' }, h('h2', null, '위험 구역'), h('p', { class: 'muted' }, '프로젝트를 삭제하면 모든 데이터가 사라집니다.'), h('div', { class: 'row' }, remove))));
}
