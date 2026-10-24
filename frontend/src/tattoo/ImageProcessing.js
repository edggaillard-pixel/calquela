/**
 * Détourage des motifs.
 * Le traitement principal est fait par le serveur Java (POST /api/tattoos/process).
 * Si le serveur ne répond pas (site hébergé en statique), on utilise ce portage
 * JavaScript du même algorithme.
 */

export const DEFAULT_SETTINGS = { mode: 'color', tolerance: 0.35, softness: 0.3, cleanup: 0.3 };

/** Charge un fichier image dans un canvas (taille max 2048 px). */
export async function fileToCanvas(file, maxSide = 2048) {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  return c;
}

const canvasToBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

function blobToCanvas(blob) {
  return createImageBitmap(blob).then((bmp) => {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c;
  });
}

let serverAvailable = true;

/** Détoure l'image : serveur si possible, sinon navigateur. Renvoie { canvas, local }. */
export async function processImage(source, settings) {
  if (serverAvailable) {
    try {
      const form = new FormData();
      form.append('image', await canvasToBlob(source), 'motif.png');
      form.append('mode', settings.mode);
      form.append('tolerance', settings.tolerance);
      form.append('softness', settings.softness);
      form.append('cleanup', settings.cleanup);
      const res = await fetch('./api/tattoos/process', { method: 'POST', body: form });
      if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
        return { canvas: await blobToCanvas(await res.blob()), local: false };
      }
      if (res.status === 422 || res.status === 413 || res.status === 415 || res.status === 429) {
        const body = await res.json().catch(() => ({}));
        throw new UserError(body.erreur || 'Image refusée par le serveur.');
      }
      serverAvailable = false; // 404/405 : pas de backend (hébergement statique)
    } catch (e) {
      if (e instanceof UserError) throw e;
      serverAvailable = false;
    }
  }
  return { canvas: processLocally(source, settings), local: true };
}

export class UserError extends Error {}

// ------------------------------------------------------------------ portage JS

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function processLocally(source, settings) {
  const w = source.width;
  const h = source.height;
  const n = w * h;
  const img = source.getContext('2d').getImageData(0, 0, w, h).data;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const sa = new Float32Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    r[i] = img[i * 4] / 255;
    g[i] = img[i * 4 + 1] / 255;
    b[i] = img[i * 4 + 2] / 255;
    sa[i] = img[i * 4 + 3] / 255;
    if (sa[i] < 0.98) transparent++;
  }
  const black = settings.mode === 'black';
  const t0 = 0.05 + settings.tolerance * 0.4;
  const soft = 0.03 + settings.softness * 0.3;
  const alpha = new Float32Array(n);
  const oR = new Float32Array(n);
  const oG = new Float32Array(n);
  const oB = new Float32Array(n);

  if (transparent > n * 0.02) {
    for (let i = 0; i < n; i++) {
      let a = sa[i];
      if (black) a *= smoothstep(t0, t0 + soft, 1 - Math.max(r[i], g[i], b[i]));
      alpha[i] = a;
      oR[i] = r[i];
      oG[i] = g[i];
      oB[i] = b[i];
    }
  } else {
    const dark = borderMedian([r, g, b], w, h, true) < 0.35;
    const bg = estimateBackground([r, g, b], w, h);
    for (let i = 0; i < n; i++) {
      let rr;
      let rg;
      let rb;
      if (!dark) {
        rr = clamp01(r[i] / Math.max(bg[0][i], 0.04));
        rg = clamp01(g[i] / Math.max(bg[1][i], 0.04));
        rb = clamp01(b[i] / Math.max(bg[2][i], 0.04));
      } else {
        rr = clamp01((r[i] - bg[0][i]) / Math.max(1 - bg[0][i], 0.04));
        rg = clamp01((g[i] - bg[1][i]) / Math.max(1 - bg[1][i], 0.04));
        rb = clamp01((b[i] - bg[2][i]) / Math.max(1 - bg[2][i], 0.04));
      }
      const maxc = Math.max(rr, rg, rb);
      const minc = Math.min(rr, rg, rb);
      let ink;
      if (black) {
        const chroma = maxc - minc;
        ink = (dark ? minc : 1 - maxc) * (1 - chroma) * (1 - chroma);
      } else {
        ink = dark ? maxc : 1 - minc;
      }
      const a = smoothstep(t0, t0 + soft, ink);
      alpha[i] = a;
      if (black) {
        oR[i] = 0.04;
        oG[i] = 0.04;
        oB[i] = 0.05;
      } else if (a > 0) {
        const k = Math.max(a, 0.08);
        if (!dark) {
          oR[i] = clamp01((rr - (1 - a)) / k);
          oG[i] = clamp01((rg - (1 - a)) / k);
          oB[i] = clamp01((rb - (1 - a)) / k);
        } else {
          oR[i] = clamp01(rr / k);
          oG[i] = clamp01(rg / k);
          oB[i] = clamp01(rb / k);
        }
      }
    }
  }
  removeSpecks(alpha, w, h, settings.cleanup);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.03) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new UserError("Aucun motif détecté : essayez d'augmenter la tolérance.");
  const m = 4;
  minX = Math.max(0, minX - m);
  minY = Math.max(0, minY - m);
  maxX = Math.min(w - 1, maxX + m);
  maxY = Math.min(h - 1, maxY + m);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const ctx = out.getContext('2d');
  const od = ctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y + minY) * w + x + minX;
      const o = (y * cw + x) * 4;
      od.data[o] = oR[i] * 255;
      od.data[o + 1] = oG[i] * 255;
      od.data[o + 2] = oB[i] * 255;
      od.data[o + 3] = clamp01(alpha[i]) * 255;
    }
  }
  ctx.putImageData(od, 0, 0);
  return out;
}

function borderMedian(ch, w, h) {
  const vals = [];
  const lum = (i) => 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
  for (let x = 0; x < w; x++) vals.push(lum(x), lum((h - 1) * w + x));
  for (let y = 0; y < h; y++) vals.push(lum(y * w), lum(y * w + w - 1));
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

function chMedianBorder(v, w, h) {
  const vals = [];
  for (let x = 0; x < w; x++) vals.push(v[x], v[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) vals.push(v[y * w], v[y * w + w - 1]);
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

const terms = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];

function fitCubic(val, use, sw, sh) {
  const k = 10;
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const i = sy * sw + sx;
      if (!use[i]) continue;
      const t = terms((2 * sx) / Math.max(1, sw - 1) - 1, (2 * sy) / Math.max(1, sh - 1) - 1);
      for (let a = 0; a < k; a++) {
        for (let c = 0; c < k; c++) A[a][c] += t[a] * t[c];
        A[a][k] += t[a] * val[i];
      }
    }
  }
  for (let a = 0; a < k; a++) A[a][a] += 1e-3;
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let a = col + 1; a < k; a++) if (Math.abs(A[a][col]) > Math.abs(A[piv][col])) piv = a;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let a = 0; a < k; a++) {
      if (a === col) continue;
      const f = A[a][col] / A[col][col];
      for (let c = col; c <= k; c++) A[a][c] -= f * A[col][c];
    }
  }
  return A.map((row, a) => row[k] / row[a]);
}

const evalCubic = (c, u, v) => terms(u, v).reduce((s, t, i) => s + t * c[i], 0);

/** Fond = surface polynomiale ajustée sur les pixels semblables au bord (voir version Java). */
function estimateBackground(ch, w, h) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 160));
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const m = sw * sh;
  const small = ch.map((c) => {
    const s = new Float32Array(m);
    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        s[sy * sw + sx] = c[Math.min(h - 1, sy * step + (step >> 1)) * w + Math.min(w - 1, sx * step + (step >> 1))];
      }
    }
    return s;
  });
  const ref = small.map((s) => chMedianBorder(s, sw, sh));
  let use = new Uint8Array(m);
  let count = 0;
  for (let i = 0; i < m; i++) {
    const d = Math.abs(small[0][i] - ref[0]) + Math.abs(small[1][i] - ref[1]) + Math.abs(small[2][i] - ref[2]);
    use[i] = d < 0.3 ? 1 : 0;
    count += use[i];
  }
  let coef;
  if (count < m * 0.15) {
    coef = ref.map((v) => [v, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  } else {
    for (let iter = 0; iter < 4; iter++) {
      coef = small.map((s) => fitCubic(s, use, sw, sh));
      const res = new Float32Array(m);
      let sum = 0;
      let k = 0;
      for (let sy = 0; sy < sh; sy++) {
        for (let sx = 0; sx < sw; sx++) {
          const i = sy * sw + sx;
          const u = (2 * sx) / Math.max(1, sw - 1) - 1;
          const v = (2 * sy) / Math.max(1, sh - 1) - 1;
          let d = 0;
          for (let c = 0; c < 3; c++) d += Math.abs(small[c][i] - evalCubic(coef[c], u, v));
          res[i] = d;
          if (use[i]) {
            sum += d;
            k++;
          }
        }
      }
      const limit = Math.max(0.05, (2.5 * sum) / Math.max(1, k));
      use = res.map((d) => (d < limit ? 1 : 0));
    }
  }
  const out = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let y = 0; y < h; y++) {
    const v = (2 * ((y + 0.5) / step - 0.5)) / Math.max(1, sh - 1) - 1;
    for (let x = 0; x < w; x++) {
      const u = (2 * ((x + 0.5) / step - 0.5)) / Math.max(1, sw - 1) - 1;
      const t = terms(u, v);
      for (let c = 0; c < 3; c++) {
        let s = 0;
        const cc = coef[c];
        for (let q = 0; q < 10; q++) s += t[q] * cc[q];
        out[c][y * w + x] = clamp01(s);
      }
    }
  }
  return out;
}

function removeSpecks(alpha, w, h, cleanup) {
  const n = w * h;
  const minArea = Math.round(cleanup * cleanup * 0.0006 * n) + 1;
  const label = new Int32Array(n);
  const keep = new Uint8Array(n);
  const stack = new Int32Array(n);
  const pix = new Int32Array(n);
  let cur = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || alpha[s] <= 0.5) continue;
    cur++;
    let sp = 0;
    let size = 0;
    stack[sp++] = s;
    label[s] = cur;
    while (sp) {
      const i = stack[--sp];
      pix[size++] = i;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nb) {
        if (j >= 0 && j < n && !label[j] && alpha[j] > 0.5) {
          label[j] = cur;
          stack[sp++] = j;
        }
      }
    }
    if (size >= minArea) for (let k = 0; k < size; k++) keep[pix[k]] = 1;
  }
  const near = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep[y * w + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) if (!near[i]) alpha[i] = 0;
}

// GROGNON
