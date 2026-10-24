import { el, icon, iconButton, section, segmented, slider, swatches, toggle } from './controls.js';
import { SKIN_TONES, UNDERWEAR_COLORS } from '../state/Project.js';
import { HAIR_COLORS, HAIR_STYLES } from '../hair/Hair.js';
import { POSE_PRESETS, clonePose } from '../avatar/Pose.js';

const pct = (v) => `${Math.round(v * 100)} %`;
const words = (low, mid, high) => (v) => (v < 0.34 ? low : v > 0.66 ? high : mid);

// ======================================================================= Corps
export function bodyPanel(app) {
  const a = () => app.state.avatar;
  const heightOut = (v) => {
    // valeur affichée en mètres, calculée sur l'avatar réel
    return `${(app.avatar.heightCm / 100).toFixed(2).replace('.', ',')} m`;
  };
  const gender = segmented({
    label: 'Genre',
    value: a().gender,
    options: [
      { value: 'male', label: 'Homme' },
      { value: 'female', label: 'Femme' },
    ],
    onChange: (v) => app.setAvatar({ gender: v }),
  });
  const mk = (key, label, format) =>
    slider({
      label,
      value: a()[key],
      format,
      onInput: (v) => {
        app.setAvatar({ [key]: v }, true);
        height.set(a().height);
      },
      onCommit: (v) => app.setAvatar({ [key]: v }),
    });
  const height = mk('height', 'Taille', heightOut);
  const weight = mk('weight', 'Corpulence', words('Mince', 'Moyenne', 'Forte'));
  const muscle = mk('muscle', 'Musculature', words('Peu marquée', 'Moyenne', 'Athlétique'));
  const proportions = mk('proportions', 'Proportions', words('Atypiques', 'Courantes', 'Classiques'));
  const breast = mk('breast', 'Poitrine', words('Petite', 'Moyenne', 'Généreuse'));
  const skin = swatches({ label: 'Teint', colors: SKIN_TONES, value: a().skin, onChange: (hex, live) => app.setAvatar({ skin: hex }, live) });
  const under = swatches({ label: 'Sous-vêtements', colors: UNDERWEAR_COLORS, value: a().underwear, onChange: (hex, live) => app.setAvatar({ underwear: hex }, live) });

  const root = el('div', { class: 'panel-body' },
    section('Silhouette', gender, height, weight, muscle, proportions, breast),
    section('Teint', skin),
    section('Sous-vêtements', under),
  );
  root.sync = () => {
    gender.set(a().gender);
    for (const [k, s] of Object.entries({ height, weight, muscle, proportions, breast })) s.set(a()[k]);
    breast.hidden = a().gender !== 'female';
    skin.set(a().skin);
    under.set(a().underwear);
  };
  return root;
}

// ======================================================================= Cheveux
export function hairPanel(app) {
  const h = () => app.state.hair;
  const styles = el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Coupe' });
  const styleButtons = HAIR_STYLES.map((s) =>
    el('button', { type: 'button', class: 'chip', role: 'radio', onclick: () => app.setHair({ style: s.id }) }, s.label),
  );
  styles.append(...styleButtons);
  const colors = swatches({ label: 'Couleur', colors: HAIR_COLORS, value: h().color, onChange: (hex) => app.setHair({ color: hex }) });
  const length = slider({
    label: 'Longueur',
    min: 0.6,
    max: 1.4,
    value: h().length,
    format: words('Plus courts', 'Normale', 'Plus longs'),
    onCommit: (v) => app.setHair({ length: v }),
  });
  const fringe = toggle({ label: 'Frange', value: h().fringe, onChange: (v) => app.setHair({ fringe: v }) });
  const root = el('div', { class: 'panel-body' },
    section('Coupe', styles, el('div', { class: 'stack' }, length, fringe)),
    section('Couleur', colors),
    el('p', { class: 'hint' }, 'Les cheveux sont générés mèche par mèche : un changement de coupe prend un court instant.'),
  );
  root.sync = () => {
    styleButtons.forEach((b, i) => b.setAttribute('aria-checked', String(HAIR_STYLES[i].id === h().style)));
    colors.set(h().color);
    length.set(h().length);
    fringe.set(h().fringe);
    length.hidden = !['carre', 'long', 'boucles'].includes(h().style);
    fringe.hidden = !['carre', 'long'].includes(h().style);
  };
  return root;
}

// ======================================================================= Pose
export function posePanel(app) {
  let symmetric = true;
  const pose = () => app.state.pose;
  const presets = el('div', { class: 'chips' }, POSE_PRESETS.map((p) =>
    el('button', { type: 'button', class: 'chip', onclick: () => app.setPose(clonePose(p.pose)) }, p.label),
  ));
  const deg = (v) => `${Math.round(v)}°`;
  const sliders = [];

  /** Curseur relié à un chemin dans la pose ; côté miroir si symétrie. */
  const bind = (label, path, min, max) => {
    const get = (p) => path.reduce((o, k) => o[k], p);
    const setIn = (p, pth, v) => {
      let o = p;
      for (let i = 0; i < pth.length - 1; i++) o = o[pth[i]];
      o[pth[pth.length - 1]] = v;
    };
    const mirror = path.map((k) => k.replace(/L$/, '§').replace(/R$/, 'L').replace('§', 'R'));
    const apply = (v, live) => {
      const p = clonePose(pose());
      setIn(p, path, v);
      if (symmetric && mirror.join() !== path.join()) setIn(p, mirror, v);
      app.setPose(p, live);
    };
    const s = slider({ label, min, max, step: 1, value: get(pose()), format: deg, onInput: (v) => apply(v, true), onCommit: (v) => apply(v, false) });
    s.sync = () => s.set(get(pose()));
    sliders.push(s);
    return s;
  };

  const sym = toggle({ label: 'Gauche et droite identiques', value: symmetric, onChange: (v) => (symmetric = v) });
  const root = el('div', { class: 'panel-body' },
    section('Poses rapides', presets),
    section('Bras', sym,
      el('h4', { class: 'sub' }, 'Bras gauche'),
      bind('Écarter', ['armL', 'raise'], 0, 180),
      bind('Avant / arrière', ['armL', 'forward'], -60, 120),
      bind('Plier le coude', ['elbowL'], 0, 150),
      el('h4', { class: 'sub' }, 'Bras droit'),
      bind('Écarter', ['armR', 'raise'], 0, 180),
      bind('Avant / arrière', ['armR', 'forward'], -60, 120),
      bind('Plier le coude', ['elbowR'], 0, 150),
    ),
    section('Jambes',
      el('h4', { class: 'sub' }, 'Jambe gauche'),
      bind('Écarter', ['legL', 'side'], -10, 70),
      bind('Lever', ['legL', 'forward'], -40, 110),
      bind('Plier le genou', ['kneeL'], 0, 140),
      el('h4', { class: 'sub' }, 'Jambe droite'),
      bind('Écarter', ['legR', 'side'], -10, 70),
      bind('Lever', ['legR', 'forward'], -40, 110),
      bind('Plier le genou', ['kneeR'], 0, 140),
    ),
    section('Tête et buste',
      bind('Tourner la tête', ['head', 'turn'], -70, 70),
      bind('Incliner la tête', ['head', 'tilt'], -30, 35),
      bind('Tourner le buste', ['torso', 'turn'], -45, 45),
      bind('Pencher le buste', ['torso', 'bend'], -20, 40),
    ),
  );
  root.sync = () => sliders.forEach((s) => s.sync());
  return root;
}

// ======================================================================= Tatouages
export function tattooPanel(app, { onImport }) {
  const list = el('ol', { class: 'layers', 'aria-label': 'Motifs posés (le dernier est au-dessus)' });
  const empty = el('div', { class: 'empty' },
    el('p', {}, 'Aucun motif pour l’instant.'),
    el('p', { class: 'hint' }, 'Importez le dessin d’un artiste : le fond est retiré automatiquement, puis cliquez sur le corps pour le poser. Vous pouvez aussi déposer une image n’importe où dans la fenêtre.'),
  );
  const importBtn = el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: onImport }, icon('plus', 18), 'Importer un motif');
  const root = el('div', { class: 'panel-body' }, importBtn, section('Calques', empty, list),
    el('div', { class: 'shortcuts' },
      el('h3', { class: 'group__title' }, 'Raccourcis'),
      el('dl', {},
        el('dt', {}, 'Glisser'), el('dd', {}, 'déplacer le motif sur la peau'),
        el('dt', {}, 'Molette'), el('dd', {}, 'agrandir ou réduire'),
        el('dt', {}, 'Maj + molette'), el('dd', {}, 'faire pivoter'),
        el('dt', {}, 'Suppr'), el('dd', {}, 'supprimer'),
        el('dt', {}, 'Ctrl + Z'), el('dd', {}, 'annuler'),
      ),
    ),
  );

  root.sync = () => {
    const ts = app.state.tattoos;
    empty.hidden = ts.length > 0;
    list.replaceChildren(
      ...[...ts].reverse().map((t) => {
        const img = app.images.get(t.imageId);
        const thumb = el('span', { class: 'layer__thumb' });
        if (img) thumb.style.backgroundImage = `url(${img.dataUrl})`;
        const item = el('li', { class: 'layer', 'aria-current': String(t.id === app.selectedId) },
          el('button', { type: 'button', class: 'layer__main', onclick: () => { app.select(t.id); app.focusTattoo(t.id); } },
            thumb, el('span', { class: 'layer__name' }, t.name)),
          iconButton(t.visible ? 'eye' : 'eyeOff', t.visible ? 'Masquer' : 'Afficher', () => app.updateTattoo(t.id, { visible: !t.visible })),
          iconButton('trash', 'Supprimer', () => app.removeTattoo(t.id)),
        );
        if (!t.visible) item.classList.add('is-hidden');
        return item;
      }),
    );
  };
  return root;
}

// ======================================================================= Inspecteur
export function inspector(app) {
  const cm = (dm) => {
    const scale = app.avatar.heightCm / app.avatar.neutralHeightCm;
    return `${Math.round(dm * 10 * scale)} cm`;
  };
  const name = el('input', { type: 'text', class: 'input', maxlength: 40, 'aria-label': 'Nom du motif' });
  name.addEventListener('change', () => app.updateSelected({ name: name.value.trim() || 'Motif' }));
  const size = slider({ label: 'Largeur', min: 0.15, max: 8, step: 0.01, value: 1, format: cm, onInput: (v) => app.updateSelected({ width: v }, false), onCommit: () => app.commit() });
  const rot = slider({ label: 'Rotation', min: -180, max: 180, step: 1, value: 0, format: (v) => `${Math.round(v)}°`, onInput: (v) => app.updateSelected({ rotation: v }, false), onCommit: () => app.commit() });
  const opacity = slider({ label: 'Intensité de l’encre', min: 0.2, max: 1, step: 0.01, value: 1, format: pct, onInput: (v) => app.updateSelected({ opacity: v }, false), onCommit: () => app.commit() });
  const mode = segmented({
    label: 'Application',
    value: 'plan',
    options: [
      { value: 'plan', label: 'À plat' },
      { value: 'wrap', label: 'Enroulé' },
    ],
    onChange: (v) => app.updateSelected({ mode: v }),
  });
  const modeHint = el('p', { class: 'hint' });
  const mirror = toggle({ label: 'Retourner (miroir)', value: false, onChange: (v) => app.updateSelected({ mirror: v }) });

  const actions = el('div', { class: 'row' },
    iconButton('target', 'Centrer la vue', () => app.focusTattoo()),
    iconButton('copy', 'Dupliquer', () => app.duplicateTattoo(app.selectedId)),
    iconButton('up', 'Passer devant', () => app.moveTattoo(app.selectedId, 1)),
    iconButton('down', 'Passer derrière', () => app.moveTattoo(app.selectedId, -1)),
    el('span', { class: 'spacer' }),
    iconButton('trash', 'Supprimer', () => app.removeTattoo(app.selectedId), { class: 'icon-btn icon-btn--danger' }),
  );

  const root = el('aside', { class: 'inspector sheet', 'aria-label': 'Réglages du motif' },
    el('header', { class: 'inspector__head' }, name, iconButton('close', 'Fermer', () => app.select(null))),
    size, rot, opacity,
    el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Application sur la peau'), mode, modeHint),
    mirror,
    actions,
  );
  root.sync = () => {
    const t = app.selected;
    root.hidden = !t;
    if (!t) return;
    if (document.activeElement !== name) name.value = t.name;
    size.set(t.width);
    rot.set(t.rotation);
    opacity.set(t.opacity);
    mode.set(t.mode);
    mirror.set(t.mirror);
    modeHint.textContent = t.mode === 'wrap'
      ? 'Le motif fait le tour du membre, comme un bracelet ou une manchette.'
      : 'Le motif est projeté face à la peau, idéal pour le dos, le torse ou l’intérieur du bras.';
  };
  return root;
}

// GROGNON
