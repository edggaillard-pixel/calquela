import { el, modal, segmented, slider, toast } from './controls.js';
import { DEFAULT_SETTINGS, fileToCanvas, processImage, UserError } from '../tattoo/ImageProcessing.js';

const pct = (v) => `${Math.round(v * 100)} %`;

/**
 * Fenêtre d'import d'un motif : détourage automatique, réglages, retouche à
 * la gomme. Résout avec { canvas, name } ou null si l'utilisateur annule.
 */
export function openImportDialog(file, { skinColor }) {
  return new Promise(async (resolve) => {
    let source;
    try {
      source = await fileToCanvas(file);
    } catch {
      toast("Ce fichier n'est pas une image lisible (PNG, JPEG ou WebP).", 'error');
      resolve(null);
      return;
    }
    const name = (file.name || 'Motif').replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || 'Motif';
    const settings = { ...DEFAULT_SETTINGS };
    let processed = null; // résultat du détourage
    let work = null; // résultat + retouches
    let tool = 'none';
    let brush = 24;
    let showOriginal = false;
    let backdrop = 'skin';
    let done = false;

    const stageCanvas = el('canvas', { class: 'import__canvas', 'aria-label': 'Aperçu du motif détouré' });
    const stage = el('div', { class: 'import__stage', 'data-bg': backdrop }, stageCanvas);
    stage.style.setProperty('--skin', skinColor);
    const status = el('p', { class: 'import__status', role: 'status' }, 'Détourage en cours…');

    const draw = () => {
      const img = showOriginal ? source : work;
      if (!img) return;
      stageCanvas.width = img.width;
      stageCanvas.height = img.height;
      stageCanvas.getContext('2d').drawImage(img, 0, 0);
    };

    let pending = 0;
    const run = async () => {
      const ticket = ++pending;
      status.textContent = 'Détourage en cours…';
      stage.classList.add('is-busy');
      try {
        const { canvas, local } = await processImage(source, settings);
        if (ticket !== pending) return;
        processed = canvas;
        work = document.createElement('canvas');
        work.width = canvas.width;
        work.height = canvas.height;
        work.getContext('2d').drawImage(canvas, 0, 0);
        status.textContent = local
          ? 'Détouré dans le navigateur (serveur indisponible).'
          : `Détouré par le serveur · ${canvas.width} × ${canvas.height} px`;
        placeBtn.disabled = false;
        draw();
      } catch (e) {
        if (ticket !== pending) return;
        status.textContent = e instanceof UserError ? e.message : 'Le détourage a échoué. Essayez une autre image.';
        placeBtn.disabled = !work;
      } finally {
        if (ticket === pending) stage.classList.remove('is-busy');
      }
    };
    let timer;
    const rerun = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 280);
    };

    // ------------------------------------------------ retouche au pinceau
    let painting = false;
    const paint = (e) => {
      if (!work || tool === 'none' || showOriginal) return;
      const r = stageCanvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * work.width;
      const y = ((e.clientY - r.top) / r.height) * work.height;
      const rad = (brush / r.width) * work.width;
      const ctx = work.getContext('2d');
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      if (tool === 'erase') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
      } else {
        ctx.clip();
        ctx.clearRect(x - rad, y - rad, rad * 2, rad * 2);
        ctx.drawImage(processed, 0, 0);
      }
      ctx.restore();
      draw();
    };
    stageCanvas.addEventListener('pointerdown', (e) => {
      if (tool === 'none') return;
      painting = true;
      stageCanvas.setPointerCapture(e.pointerId);
      paint(e);
    });
    stageCanvas.addEventListener('pointermove', (e) => painting && paint(e));
    stageCanvas.addEventListener('pointerup', () => (painting = false));
    stageCanvas.addEventListener('pointercancel', () => (painting = false));

    const toolSeg = segmented({
      label: 'Outil de retouche',
      value: 'none',
      options: [
        { value: 'none', label: 'Aucun' },
        { value: 'erase', label: 'Gomme' },
        { value: 'restore', label: 'Restaurer' },
      ],
      onChange: (v) => {
        tool = v;
        stage.dataset.tool = v;
      },
    });

    const controls = el('div', { class: 'import__controls' },
      el('div', { class: 'field' },
        el('span', { class: 'field__label' }, 'Encre conservée'),
        segmented({
          label: 'Encre conservée',
          value: settings.mode,
          options: [
            { value: 'color', label: 'Toutes les couleurs' },
            { value: 'black', label: 'Trait noir' },
          ],
          onChange: (v) => {
            settings.mode = v;
            run();
          },
        }),
      ),
      slider({ label: 'Retrait du fond', value: settings.tolerance, format: pct, onInput: (v) => { settings.tolerance = v; rerun(); } }),
      slider({ label: 'Douceur des bords', value: settings.softness, format: pct, onInput: (v) => { settings.softness = v; rerun(); } }),
      slider({ label: 'Nettoyage des taches', value: settings.cleanup, format: pct, onInput: (v) => { settings.cleanup = v; rerun(); } }),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Retouche au pinceau'), toolSeg),
      slider({ label: 'Taille du pinceau', min: 4, max: 80, step: 1, value: brush, format: (v) => `${v} px`, onInput: (v) => (brush = v) }),
      el('p', { class: 'hint' }, 'Changer un réglage de détourage efface les retouches.'),
      el('div', { class: 'field' },
        el('span', { class: 'field__label' }, 'Fond de l’aperçu'),
        segmented({
          label: 'Fond de l’aperçu',
          value: backdrop,
          options: [
            { value: 'skin', label: 'Peau' },
            { value: 'checker', label: 'Damier' },
            { value: 'white', label: 'Blanc' },
          ],
          onChange: (v) => (stage.dataset.bg = v),
        }),
      ),
    );

    const compareBtn = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      'aria-pressed': 'false',
      onclick: () => {
        showOriginal = !showOriginal;
        compareBtn.setAttribute('aria-pressed', String(showOriginal));
        compareBtn.textContent = showOriginal ? 'Voir le résultat' : 'Voir l’original';
        draw();
      },
    }, 'Voir l’original');

    const placeBtn = el('button', {
      type: 'button',
      class: 'btn btn--primary',
      disabled: true,
      onclick: () => {
        done = true;
        dlg.close();
        resolve({ canvas: work, name });
      },
    }, 'Poser sur le corps');

    const dlg = modal({
      title: 'Importer un motif',
      wide: true,
      content: el('div', { class: 'import' }, el('div', { class: 'import__left' }, stage, status), controls),
      actions: [
        compareBtn,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Annuler'),
        placeBtn,
      ],
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    run();
  });
}

// GROGNON
