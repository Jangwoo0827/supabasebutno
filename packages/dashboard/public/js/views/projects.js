import { api } from '../api.js';
import { actionButton, formatDate, guard, h, toast } from '../ui.js';

export async function renderProjects(root) {
  const { projects } = await api('GET', '/projects');

  const name = h('input', { type: 'text', placeholder: '새 프로젝트 이름', maxlength: 64, 'aria-label': '프로젝트 이름' });
  const create = actionButton('프로젝트 만들기', async () => {
    if (!name.value.trim()) return toast('이름을 입력하세요', 'error');
    const project = await guard(() => api('POST', '/projects', { name: name.value }));
    if (project) {
      toast(`"${project.name}" 프로젝트를 만들었습니다`);
      location.hash = `#/p/${project.id}`;
    }
  }, { cls: 'primary' });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create.click());

  root.append(
    h('div', { class: 'row between' }, h('h1', null, '프로젝트'), h('div', { class: 'row' }, name, create)),
    projects.length === 0
      ? h('div', { class: 'card empty' }, '아직 프로젝트가 없습니다. 위에서 하나 만들어 보세요.')
      : h('div', { class: 'cards' }, projects.map((p) =>
          h('a', { class: 'card link', href: `#/p/${p.id}` },
            h('h3', null, p.name),
            h('div', { class: 'muted mono' }, p.id),
            h('div', { class: 'muted' }, formatDate(p.created_at))))));
}
