// Small DOM helpers. Everything is built with createElement / textContent, never from HTML strings,
// so data from the database (table cells, e-mail addresses, file names) can never become markup.

/** h('button', { class: 'primary', onclick: fn }, 'Save') */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (['value', 'checked', 'disabled', 'selected', 'readOnly'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/**
 * Shows a dialog. `build(close)` returns the content; call close(value) to dismiss.
 * Resolves with whatever was passed to close (undefined on Escape / backdrop click).
 */
export function modal(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => e.key === 'Escape' && done(undefined);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && done(undefined) },
      h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), build(done)));
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    overlay.querySelector('input, textarea, select, button')?.focus();
  });
}

/** Yes/no question. With `typeToConfirm`, the user must type that exact text first (for irreversible actions). */
export function confirmDialog(message, { confirmLabel = '확인', danger = false, typeToConfirm } = {}) {
  return modal('확인', (close) => {
    const input = typeToConfirm ? h('input', { type: 'text', autocomplete: 'off', placeholder: typeToConfirm }) : null;
    const ok = h('button', { class: `${danger ? 'danger solid' : 'primary'}`, disabled: !!typeToConfirm, onclick: () => close(true) }, confirmLabel);
    input?.addEventListener('input', () => (ok.disabled = input.value !== typeToConfirm));
    return h('div', { class: 'stack' },
      h('p', null, message),
      typeToConfirm && h('div', null, h('label', null, ['계속하려면 ', h('code', null, typeToConfirm), ' 을(를) 입력하세요']), input),
      h('div', { class: 'row end' }, h('button', { onclick: () => close(false) }, '취소'), ok));
  }).then((v) => v === true);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했습니다');
  } catch {
    toast('복사하지 못했습니다. 직접 선택해서 복사하세요.', 'error');
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/** Runs an async action and shows its error as a toast. Returns undefined on failure. */
export async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err?.message ?? String(err), 'error');
    return undefined;
  }
}

/** A button that disables itself while its (async) handler runs. */
export function actionButton(label, handler, { cls = '', title } = {}) {
  const b = h('button', { class: cls, title });
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await handler();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
