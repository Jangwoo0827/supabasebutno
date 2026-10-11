import { api } from '../api.js';
import { actionButton, confirmDialog, formatBytes, formatDate, guard, h, modal, toast } from '../ui.js';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function bucketDialog(project, existing) {
  return modal(existing ? `버킷 설정 · ${existing.name}` : '새 버킷', (close) => {
    const name = h('input', { type: 'text', class: 'mono', placeholder: 'avatars', readOnly: !!existing, value: existing?.name ?? '' });
    const isPublic = h('input', { type: 'checkbox', checked: existing?.public ?? false });
    const limit = h('input', { type: 'number', min: 1, placeholder: '비워두면 서버 기본값', value: existing?.file_size_limit ?? '' });
    const mimes = h('input', { type: 'text', class: 'mono', placeholder: 'image/*, audio/mpeg', value: (existing?.allowed_mime_types ?? []).join(', ') });
    const error = h('div', { class: 'error' });
    const save = actionButton('저장', async () => {
      error.textContent = '';
      const body = {
        public: isPublic.checked,
        file_size_limit: limit.value ? Number(limit.value) : null,
        allowed_mime_types: mimes.value.trim() ? mimes.value.split(',').map((s) => s.trim()).filter(Boolean) : null,
      };
      try {
        if (existing) await api('PATCH', `/projects/${project.id}/storage/buckets/${existing.name}`, body);
        else await api('POST', `/projects/${project.id}/storage/buckets`, { name: name.value.trim(), ...body });
        close(true);
      } catch (err) {
        error.textContent = err.message;
      }
    }, { cls: 'primary' });
    return h('div', { class: 'stack' },
      h('div', null, h('label', null, '이름 (소문자·숫자·-·_)'), name),
      h('label', { class: 'check' }, isPublic, '공개 버킷 (누구나 URL 로 읽기. 끄면 업로드한 사용자만 읽음)'),
      h('div', null, h('label', null, '파일 최대 크기 (바이트)'), limit),
      h('div', null, h('label', null, '허용 파일 타입 (쉼표로 구분, 비우면 모두)'), mimes),
      error, h('div', { class: 'row end' }, h('button', { onclick: () => close(false) }, '취소'), save));
  });
}

export async function renderStorage(root, project) {
  const base = `/projects/${project.id}/storage`;
  const state = { bucket: null, prefix: '', search: '' };
  const bucketsBox = h('div', { class: 'stack' });
  const filesBox = h('div', { class: 'stack' });

  async function refreshBuckets() {
    const { buckets } = await api('GET', `${base}/buckets`);
    if (!buckets.some((b) => b.name === state.bucket)) state.bucket = buckets[0]?.name ?? null;
    bucketsBox.replaceChildren(buckets.length === 0
      ? h('div', { class: 'card empty' }, '버킷이 없습니다. 파일을 올리려면 먼저 버킷을 만드세요.')
      : h('div', { class: 'cards' }, buckets.map((b) =>
          h('div', { class: `card stack ${b.name === state.bucket ? '' : ''}` },
            h('div', { class: 'row between' }, h('h3', { class: 'mono' }, b.name), h('span', { class: `badge ${b.public ? 'ok' : ''}` }, b.public ? '공개' : '비공개')),
            h('div', { class: 'muted' }, `최대 ${b.file_size_limit ? formatBytes(b.file_size_limit) : '서버 기본값'} · ${b.allowed_mime_types ? b.allowed_mime_types.join(', ') : '모든 타입'}`),
            h('div', { class: 'row' },
              h('button', { class: 'small primary', onclick: () => { state.bucket = b.name; state.prefix = ''; state.search = ''; refreshBuckets(); refreshFiles(); } }, state.bucket === b.name ? '보는 중' : '파일 보기'),
              h('button', { class: 'small', onclick: async () => { if (await bucketDialog(project, b)) { toast('저장했습니다'); refreshBuckets(); } } }, '설정'),
              h('button', { class: 'small danger', onclick: async () => {
                if (!(await confirmDialog(`"${b.name}" 버킷과 안의 모든 파일이 영구 삭제됩니다.`, { confirmLabel: '삭제', danger: true, typeToConfirm: b.name }))) return;
                if (await guard(() => api('DELETE', `${base}/buckets/${b.name}?force=true`).then(() => true))) { toast('삭제했습니다'); refreshBuckets(); refreshFiles(); }
              } }, '삭제'))))));
  }

  async function download(file) {
    const res = await guard(() => api('GET', `${base}/object/${encodeURIComponent(state.bucket)}/${encodePath(file.path)}`, undefined, { raw: true }));
    if (!res) return;
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: file.path.split('/').pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function refreshFiles() {
    if (!state.bucket) return filesBox.replaceChildren();
    const files = await guard(() => api('POST', `${base}/list/${encodeURIComponent(state.bucket)}`, { prefix: state.prefix || undefined, search: state.search || undefined, limit: 200 }));
    if (!files) return;
    const prefix = h('input', { type: 'text', class: 'mono', placeholder: '폴더/접두사', value: state.prefix, 'aria-label': '접두사' });
    const search = h('input', { type: 'text', placeholder: '이름 검색', value: state.search, 'aria-label': '검색' });
    const run = () => { state.prefix = prefix.value; state.search = search.value; refreshFiles(); };
    for (const i of [prefix, search]) i.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    const picker = h('input', { type: 'file', 'aria-label': '업로드할 파일' });
    const target = h('input', { type: 'text', class: 'mono', placeholder: '저장 경로 (비우면 파일 이름)', 'aria-label': '저장 경로' });
    const upload = actionButton('업로드', async () => {
      const file = picker.files[0];
      if (!file) return toast('파일을 선택하세요', 'error');
      const path = target.value.trim() || file.name;
      const done = await guard(() => api('POST', `${base}/object/${encodeURIComponent(state.bucket)}/${encodePath(path)}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' } }).then(() => true));
      if (done) { toast('업로드했습니다'); refreshFiles(); }
    }, { cls: 'primary' });

    filesBox.replaceChildren(
      h('h2', null, h('span', { class: 'mono' }, state.bucket), ' 의 파일'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, prefix), h('div', { class: 'grow' }, search), h('button', { onclick: run }, '적용')),
      files.length === 0
        ? h('div', { class: 'card empty' }, '파일이 없습니다.')
        : h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['경로', '크기', '타입', '소유자', '수정', ''].map((x) => h('th', null, x)))),
            h('tbody', null, files.map((f) => h('tr', null,
              h('td', { class: 'mono' }, f.path), h('td', null, formatBytes(f.size)), h('td', null, f.mime_type), h('td', { class: 'mono' }, f.owner_id ?? '—'), h('td', null, formatDate(f.updated_at)),
              h('td', { class: 'actions' },
                h('button', { class: 'small', onclick: () => download(f) }, '다운로드'), ' ',
                h('button', { class: 'small danger', onclick: async () => {
                  if (!(await confirmDialog(`"${f.path}" 파일을 삭제합니다.`, { confirmLabel: '삭제', danger: true }))) return;
                  if (await guard(() => api('DELETE', `${base}/object/${encodeURIComponent(state.bucket)}/${encodePath(f.path)}`).then(() => true))) { toast('삭제했습니다'); refreshFiles(); }
                } }, '삭제'))))))),
      h('div', { class: 'card stack' }, h('h3', null, '파일 올리기 (같은 경로면 덮어씀)'), h('div', { class: 'row' }, picker, h('div', { class: 'grow' }, target), upload)));
  }

  root.append(
    h('div', { class: 'row between' }, h('h2', null, '버킷'), h('button', { class: 'primary', onclick: async () => { if (await bucketDialog(project, null)) { toast('버킷을 만들었습니다'); refreshBuckets().then(refreshFiles); } } }, '+ 새 버킷')),
    bucketsBox, filesBox);
  await refreshBuckets();
  await refreshFiles();
}
