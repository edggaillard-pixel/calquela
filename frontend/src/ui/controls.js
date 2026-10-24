// Petits composants d'interface en JavaScript natif (sans framework).

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/**
 * Curseur avec libellé et valeur affichée.
 * onInput : pendant le glissement · onCommit : au relâchement (historique).
 */
export function slider({ label, min = 0, max = 1, step = 0.01, value = 0, format = (v) => v, onInput, onCommit }) {
  const id = nextId('s');
  const out = el('output', { class: 'slider__value', for: id }, format(value));
  const input = el('input', { type: 'range', id, min, max, step, value });
  const fill = () => input.style.setProperty('--fill', `${((input.value - min) / (max - min)) * 100}%`);
  fill();
  input.addEventListener('input', () => {
    out.textContent = format(+input.value);
    fill();
    onInput?.(+input.value);
  });
  input.addEventListener('change', () => onCommit?.(+input.value));
  const root = el('div', { class: 'slider' }, el('div', { class: 'slider__head' }, el('label', { for: id }, label), out), input);
  root.set = (v) => {
    input.value = v;
    out.textContent = format(+v);
    fill();
  };
  root.input = input;
  return root;
}

/** Choix exclusif sous forme de boutons accolés. */
export function segmented({ options, value, onChange, label }) {
  const root = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) =>
    el('button', {
      type: 'button',
      role: 'radio',
      class: 'segmented__opt',
      'aria-checked': String(o.value === value),
      onclick: () => {
        root.set(o.value);
        onChange(o.value);
      },
    }, o.label),
  );
  root.append(...buttons);
  root.set = (v) => buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i].value === v)));
  return root;
}

/** Nuancier + sélecteur de couleur libre. */
export function swatches({ colors, value, onChange, label }) {
  const root = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label });
  const buttons = colors.map((c) =>
    el('button', {
      type: 'button',
      class: 'swatch',
      role: 'radio',
      title: c.label,
      'aria-label': c.label,
      style: `--c:${c.hex}`,
      onclick: () => {
        root.set(c.hex);
        onChange(c.hex);
      },
    }),
  );
  const custom = el('input', { type: 'color', class: 'swatch swatch--custom', title: 'Autre couleur', 'aria-label': 'Autre couleur', value });
  custom.addEventListener('input', () => {
    root.set(custom.value);
    onChange(custom.value, true);
  });
  custom.addEventListener('change', () => onChange(custom.value));
  root.append(...buttons, custom);
  root.set = (hex) => {
    let found = false;
    buttons.forEach((b, i) => {
      const on = colors[i].hex.toLowerCase() === String(hex).toLowerCase();
      found ||= on;
      b.setAttribute('aria-checked', String(on));
    });
    custom.setAttribute('aria-checked', String(!found));
    custom.value = hex;
  };
  root.set(value);
  return root;
}

export function toggle({ label, value, onChange }) {
  const input = el('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  const root = el('label', { class: 'toggle' }, input, el('span', { class: 'toggle__track', 'aria-hidden': 'true' }), el('span', {}, label));
  root.set = (v) => (input.checked = !!v);
  return root;
}

export function section(title, ...children) {
  return el('section', { class: 'group' }, el('h3', { class: 'group__title' }, title), ...children);
}

// Icônes au trait (24 × 24)
const ICONS = {
  body: '<path d="M12 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M8 8.5h8l-1 6h-1.5l-.5 8h-2l-.5-8H9z"/>',
  hair: '<path d="M5 13c0-5 3-9 7-9s7 4 7 9"/><path d="M5 13c0 3 1 6 2 8M19 13c0 3-1 6-2 8M9 6c1 3 3 5 7 6"/>',
  pose: '<circle cx="12" cy="4" r="2"/><path d="M4 9l8 1 8-1M12 10v5l-4 7M12 15l4 7"/>',
  tattoo: '<path d="M12 3c3 3 6 5 6 9a6 6 0 0 1-12 0c0-4 3-6 6-9Z"/><path d="M12 9v8M9 13h6" stroke-dasharray="2 2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.1 6.1C3.6 7.8 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.3-1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flip: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7 4 12l5 5ZM15 7l5 5-5 5Z"/>',
  eraser: '<path d="m7 21-4-4 11-11 7 7-7 8Z"/><path d="M7 21h13M9 10l7 7"/>',
  brush: '<path d="M18 3l3 3-9 9-3-3Z"/><path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 3 4 1 9 0 9-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5"/>',
};

export function icon(name, size = 20) {
  const span = el('span', { class: 'icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, label, onClick, extra = {}) {
  return el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick: onClick, ...extra }, icon(name));
}

// ----------------------------------------------------------------- messages
let toastHost;
export function toast(message, kind = 'info', duration = 3600) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = el('div', { class: `toast toast--${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add('toast--out');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

/** Fenêtre modale simple, fermée par Échap ou le bouton. */
export function modal({ title, content, actions = [], wide = false, onClose }) {
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const dialog = el('div', { class: `modal${wide ? ' modal--wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('header', { class: 'modal__head' }, el('h2', {}, title), iconButton('close', 'Fermer', close)),
    el('div', { class: 'modal__body' }, content),
    actions.length ? el('footer', { class: 'modal__foot' }, actions) : null,
  );
  const root = el('div', { class: 'modal-backdrop', onmousedown: (e) => e.target === root && close() }, dialog);
  document.body.append(root);
  document.addEventListener('keydown', onKey);
  setTimeout(() => dialog.querySelector('input, button:not(.icon-btn)')?.focus(), 30);
  return { close, root, dialog };
}

// GROGNON
