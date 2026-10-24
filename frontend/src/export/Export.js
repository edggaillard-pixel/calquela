import * as THREE from 'three';
import { downloadBlob, safeFileName } from '../state/Project.js';

const BG = '#eceae5';

/** Exécute `fn` sans le contour du motif sélectionné. */
function withoutOutline(app, fn) {
  const sel = app.selectedId;
  app.selectedId = null;
  app._outlineNeeded = true;
  try {
    return fn();
  } finally {
    app.selectedId = sel;
    app.requestBake();
  }
}

function canvasBlob(c) {
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/** Image de la vue actuelle, en haute définition. */
export async function exportView(app) {
  const v = app.viewer;
  const w = Math.min(3000, Math.round(v.canvas.clientWidth * 2));
  const h = Math.min(3000, Math.round(v.canvas.clientHeight * 2));
  const shot = withoutOutline(app, () => v.capture(w, h));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(shot, 0, 0);
  signature(ctx, w, h);
  downloadBlob(await canvasBlob(out), `${safeFileName(app.state.name)}.png`);
}

/** Planche à montrer au tatoueur : face, dos, gauche, droite. */
export async function exportSheet(app) {
  const v = app.viewer;
  const cell = { w: 900, h: 1300 };
  const pad = 40;
  const head = 110;
  const W = cell.w * 4 + pad * 5;
  const H = cell.h + head + pad * 2;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const heightM = app.avatar.heightCm / 100;
  const cam = new THREE.PerspectiveCamera(24, cell.w / cell.h, 0.05, 50);
  const target = new THREE.Vector3(0, heightM * 0.52, 0);
  const vFov = (cam.fov * Math.PI) / 180;
  const dist = (heightM * 0.6) / Math.tan(vFov / 2);
  const views = [
    ['Face', 0],
    ['Dos', Math.PI],
    ['Gauche', Math.PI / 2],
    ['Droite', -Math.PI / 2],
  ];
  withoutOutline(app, () => views.forEach(([label, az], i) => {
    cam.position.set(Math.sin(az) * dist, target.y + 0.05, Math.cos(az) * dist);
    cam.lookAt(target);
    const shot = v.capture(cell.w, cell.h, cam);
    const x = pad + i * (cell.w + pad);
    ctx.drawImage(shot, x, head + pad);
    ctx.fillStyle = '#5e5e66';
    ctx.font = '500 30px "Bricolage Grotesque", system-ui, sans-serif';
    ctx.fillText(label, x + 8, head + pad + 40);
  }));
  ctx.fillStyle = '#26262b';
  ctx.font = '600 52px "Bricolage Grotesque", system-ui, sans-serif';
  ctx.fillText(app.state.name, pad, 82);
  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  ctx.font = '400 28px "Bricolage Grotesque", system-ui, sans-serif';
  ctx.fillStyle = '#5e5e66';
  const info = `${app.state.tattoos.length} motif${app.state.tattoos.length > 1 ? 's' : ''}, ${date}`;
  ctx.fillText(info, W - pad - ctx.measureText(info).width, 82);
  signature(ctx, W, H);
  downloadBlob(await canvasBlob(out), `${safeFileName(app.state.name)}-planche.png`);
}

function signature(ctx, w, h) {
  ctx.save();
  ctx.font = '600 26px "Bricolage Grotesque", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(38,38,43,0.55)';
  const t = 'CalqueLa';
  ctx.fillText(t, w - ctx.measureText(t).width - 28, h - 26);
  ctx.restore();
}

// GROGNON
