import './styles.css';
import { App } from './App.js';
import { el, icon, iconButton, modal, toast } from './ui/controls.js';
import { bodyPanel, hairPanel, inspector, posePanel, tattooPanel } from './ui/Panels.js';
import { openImportDialog } from './ui/ImportDialog.js';
import { exportSheet, exportView } from './export/Export.js';
import { downloadBlob, fetchSharedProject, safeFileName, shareProject } from './state/Project.js';

const $ = (id) => document.getElementById(id);

async function start() {
  const app = new App($('viewport'));
  try {
    await app.init((msg) => ($('loader-text').textContent = msg));
  } catch (e) {
    console.error(e);
    $('loader-text').textContent = 'Impossible de charger l’avatar 3D. Vérifiez que votre navigateur prend en charge WebGL 2, puis rechargez la page.';
    return;
  }

  // ------------------------------------------------------------- import
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  document.body.append(fileInput);
  const importFile = async (file) => {
    if (!file) return;
    const result = await openImportDialog(file, { skinColor: app.state.avatar.skin });
    if (!result) return;
    const image = await app.addImage(result.canvas);
    showTab('tattoos');
    app.interaction.startPlacing(image, result.name);
    setHint('Cliquez sur le corps pour poser le motif. Échap pour annuler.');
  };
  fileInput.addEventListener('change', () => {
    importFile(fileInput.files[0]);
    fileInput.value = '';
  });
  const askImport = () => fileInput.click();

  // ------------------------------------------------------------- panneaux
  const panels = {
    body: { label: 'Corps', icon: 'body', el: bodyPanel(app) },
    hair: { label: 'Cheveux', icon: 'hair', el: hairPanel(app) },
    pose: { label: 'Pose', icon: 'pose', el: posePanel(app) },
    tattoos: { label: 'Tatouages', icon: 'tattoo', el: tattooPanel(app, { onImport: askImport }) },
  };
  const tabs = {};
  for (const [id, p] of Object.entries(panels)) {
    tabs[id] = el('button', {
      type: 'button', role: 'tab', class: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`,
      onclick: () => showTab(id),
    }, icon(p.icon), el('span', {}, p.label));
    $('tabs').append(tabs[id]);
    p.el.id = `panel-${id}`;
    p.el.setAttribute('role', 'tabpanel');
    p.el.setAttribute('aria-labelledby', `tab-${id}`);
    $('panels').append(p.el);
  }
  function showTab(id) {
    for (const [k, p] of Object.entries(panels)) {
      const on = k === id;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      p.el.hidden = !on;
    }
    document.body.dataset.tab = id;
  }
  showTab('body');

  const insp = inspector(app);
  $('inspector-slot').replaceWith(insp);

  // ------------------------------------------------------------- en-tête
  const undoBtn = iconButton('undo', 'Annuler (Ctrl+Z)', () => app.undo());
  const redoBtn = iconButton('redo', 'Rétablir (Ctrl+Maj+Z)', () => app.redo());
  $('history-buttons').append(undoBtn, redoBtn);
  app.history.onChange(() => {
    undoBtn.disabled = !app.history.canUndo;
    redoBtn.disabled = !app.history.canRedo;
  });

  const projectInput = el('input', { type: 'file', accept: '.json,.calquela,application/json', hidden: true });
  document.body.append(projectInput);
  projectInput.addEventListener('change', async () => {
    const f = projectInput.files[0];
    projectInput.value = '';
    if (!f) return;
    try {
      await app.loadProject(await f.text());
      toast(`Projet « ${app.state.name} » ouvert.`);
    } catch (e) {
      toast(e.message || 'Ce fichier ne peut pas être ouvert.', 'error');
    }
  });

  const save = () => {
    downloadBlob(new Blob([app.exportJson()], { type: 'application/json' }), `${safeFileName(app.state.name)}.calquela.json`);
    toast('Projet enregistré dans vos téléchargements.');
  };

  const share = async () => {
    const btn = actions.share;
    btn.disabled = true;
    try {
      const url = await shareProject(app.exportJson());
      const field = el('input', { type: 'text', class: 'input', readonly: true, value: url, 'aria-label': 'Lien de partage' });
      const copy = el('button', {
        type: 'button', class: 'btn btn--primary', onclick: async () => {
          try {
            await navigator.clipboard.writeText(url);
            copy.textContent = 'Lien copié';
          } catch {
            field.select();
          }
        },
      }, 'Copier le lien');
      modal({
        title: 'Partager le projet',
        content: el('div', { class: 'stack' },
          el('p', {}, 'Toute personne qui a ce lien peut ouvrir une copie du projet. Le lien expire au bout de 30 jours.'),
          field),
        actions: [el('span', { class: 'spacer' }), copy],
      });
      setTimeout(() => field.select(), 50);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  const exportMenu = () => {
    const m = modal({
      title: 'Exporter une image',
      content: el('div', { class: 'choice-list' },
        el('button', { type: 'button', class: 'choice', onclick: async () => { m.close(); await exportView(app); toast('Image enregistrée.'); } },
          el('strong', {}, 'Vue actuelle'), el('span', {}, 'Ce que vous voyez à l’écran, en haute définition.')),
        el('button', { type: 'button', class: 'choice', onclick: async () => { m.close(); await exportSheet(app); toast('Planche enregistrée.'); } },
          el('strong', {}, 'Planche quatre vues'), el('span', {}, 'Face, dos et profils sur une seule image, à montrer à votre tatoueur.')),
      ),
    });
  };

  const newProject = () => {
    const m = modal({
      title: 'Nouveau projet',
      content: el('p', {}, 'Le projet en cours sera remplacé. Enregistrez-le d’abord si vous voulez le garder.'),
      actions: [
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Annuler'),
        el('button', { type: 'button', class: 'btn btn--primary', onclick: async () => { m.close(); await app.newProject(); } }, 'Créer un nouveau projet'),
      ],
    });
  };

  const actions = {
    new: el('button', { type: 'button', class: 'btn btn--ghost', onclick: newProject }, 'Nouveau'),
    open: el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => projectInput.click() }, icon('open', 18), el('span', { class: 'label' }, 'Ouvrir')),
    save: el('button', { type: 'button', class: 'btn btn--ghost', onclick: save }, icon('save', 18), el('span', { class: 'label' }, 'Enregistrer')),
    share: el('button', { type: 'button', class: 'btn btn--ghost', onclick: share }, icon('share', 18), el('span', { class: 'label' }, 'Partager')),
    export: el('button', { type: 'button', class: 'btn btn--primary', onclick: exportMenu }, icon('export', 18), el('span', { class: 'label' }, 'Exporter')),
  };
  $('file-actions').append(...Object.values(actions));

  const nameInput = $('project-name');
  nameInput.addEventListener('change', () => app.setName(nameInput.value.trim()));
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());

  // ------------------------------------------------------------- vues
  const views = [['face', 'Face'], ['dos', 'Dos'], ['gauche', 'Gauche'], ['droite', 'Droite']];
  for (const [id, label] of views) {
    $('views').append(el('button', { type: 'button', class: 'view-btn', onclick: () => app.viewer.setView(id, app.avatar.heightCm / 100) }, label));
  }

  // ------------------------------------------------------------- aide contextuelle
  function setHint(text) {
    $('hint').textContent = text || '';
    $('hint').hidden = !text;
  }

  // ------------------------------------------------------------- synchronisation
  const syncAll = () => {
    for (const p of Object.values(panels)) p.el.sync();
    insp.sync();
    nameInput.value = app.state.name;
  };
  const updateInsets = () => app.viewer.setInsets(350, insp.hidden ? 0 : 314);
  app.on((what) => {
    if (what === 'state' || what === 'selection') queueMicrotask(updateInsets);
    if (what === 'state') syncAll();
    if (what === 'avatar') panels.body.el.sync();
    if (what === 'hair') panels.hair.el.sync();
    if (what === 'pose') panels.pose.el.sync();
    if (what === 'tattoos' || what === 'selection') {
      panels.tattoos.el.sync();
      insp.sync();
      if (!app.interaction.placing) setHint('');
    }
    if (what === 'tattoo-edit') insp.sync();
    if (what === 'selection' && app.selectedId) showTab('tattoos');
  });

  // ------------------------------------------------------------- clavier
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
    } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      app.redo();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (mod && e.key.toLowerCase() === 'd' && app.selectedId && !typing) {
      e.preventDefault();
      app.duplicateTattoo(app.selectedId);
    } else if (e.key === 'Escape') {
      if (app.interaction.placing) {
        app.interaction.cancelPlacing();
        setHint('');
      } else app.select(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId && !typing) {
      e.preventDefault();
      app.removeTattoo(app.selectedId);
    }
  });

  // ------------------------------------------------------------- glisser-déposer
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('dropzone').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropzone').hidden = true;
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    const f = e.dataTransfer.files[0];
    if (f && /\.(json|calquela)$/i.test(f.name)) {
      f.text().then((t) => app.loadProject(t)).then(() => toast('Projet ouvert.')).catch((err) => toast(err.message, 'error'));
    } else if (f) importFile(f);
  });

  // ------------------------------------------------------------- démarrage
  const params = new URLSearchParams(location.search);
  let loaded = false;
  if (params.get('p')) {
    try {
      $('loader-text').textContent = 'Ouverture du projet partagé…';
      await app.loadProject(await fetchSharedProject(params.get('p')));
      loaded = true;
      toast(`Projet partagé « ${app.state.name} » ouvert.`);
    } catch (e) {
      toast(e.message, 'error');
    }
    history.replaceState(null, '', location.pathname);
  }
  if (!loaded) {
    const saved = app.restoreAutosave();
    if (saved) {
      try {
        await app.applyState(saved.state, { resetHistory: true, images: saved.images });
        loaded = true;
      } catch {
        app.clearAutosave();
      }
    }
  }
  if (!loaded) await app.applyState(app.state, { resetHistory: true });
  syncAll();
  updateInsets();
  app.viewer.setView('face', app.avatar.heightCm / 100);
  $('loader').classList.add('is-done');
  setTimeout(() => $('loader').remove(), 600);
  window.calquela = app; // utile pour déboguer dans la console
}

start();

// GROGNON
