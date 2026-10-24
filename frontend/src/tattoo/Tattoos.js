import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;

/** Régions traitées comme un seul membre pour l'enroulement. */
const LIMB_MASK = {
  0: 1 << 0,
  1: (1 << 1) | (1 << 2), 2: (1 << 1) | (1 << 2),
  3: (1 << 3) | (1 << 4), 4: (1 << 3) | (1 << 4),
  5: (1 << 5) | (1 << 6), 6: (1 << 5) | (1 << 6),
  7: (1 << 7) | (1 << 8), 8: (1 << 7) | (1 << 8),
};

let counter = 0;
export const newId = (prefix = 't') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Bibliothèque des motifs (images détourées). Chaque image est gardée en
 * data URL PNG (pour l'enregistrement du projet) et en texture.
 */
export class ImageLibrary {
  constructor() {
    this.images = new Map();
  }

  has(id) {
    return this.images.has(id);
  }

  get(id) {
    return this.images.get(id);
  }

  /** Ajoute une image à partir d'un canvas ou d'une data URL. */
  async add(source, id = newId('img')) {
    const canvas = source instanceof HTMLCanvasElement ? source : await dataUrlToCanvas(source);
    const dataUrl = source instanceof HTMLCanvasElement ? canvas.toDataURL('image/png') : source;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace; // valeurs sRGB brutes, décodées par la peau
    tex.premultiplyAlpha = true;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    // petite copie de l'alpha pour savoir si l'on clique sur le motif
    const small = document.createElement('canvas');
    const k = Math.min(1, 128 / Math.max(canvas.width, canvas.height));
    small.width = Math.max(1, Math.round(canvas.width * k));
    small.height = Math.max(1, Math.round(canvas.height * k));
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    const px = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    const alpha = new Uint8Array(small.width * small.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    const entry = { id, dataUrl, canvas, texture: tex, width: canvas.width, height: canvas.height, alpha, aw: small.width, ah: small.height };
    this.images.set(id, entry);
    return entry;
  }

  /** Supprime les images qui ne sont plus utilisées. */
  prune(usedIds) {
    for (const [id, e] of this.images) {
      if (!usedIds.has(id)) {
        e.texture.dispose();
        this.images.delete(id);
      }
    }
  }
}

export function dataUrlToCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = url;
  });
}

/** Crée un tatouage à partir d'un point de la peau. */
export function createTattoo(image, anchor, opts = {}) {
  const aspect = image.height / image.width;
  return {
    id: newId('t'),
    name: opts.name || 'Motif',
    imageId: image.id,
    center: anchor.p.toArray(),
    normal: anchor.n.toArray(),
    region: anchor.region,
    face: anchor.face,
    bary: anchor.bary,
    mode: opts.mode || 'plan',
    width: opts.width || 1.0, // décimètres (10 cm)
    aspect,
    rotation: 0,
    opacity: 1,
    mirror: false,
    visible: true,
  };
}

/**
 * Repère de projection d'un tatouage (espace canonique).
 * Plan : T (droite), B (haut), N (normale). Enroulé : cylindre autour du membre.
 */
export function computeFrame(t, avatar, texture) {
  const N = new THREE.Vector3().fromArray(t.normal).normalize();
  const center = new THREE.Vector3().fromArray(t.center);
  const up = Math.abs(N.dot(UP)) > 0.92 ? FWD : UP;
  const T = new THREE.Vector3().crossVectors(up, N).normalize();
  const B = new THREE.Vector3().crossVectors(N, T).normalize();
  const rot = (t.rotation || 0) * DEG;
  T.applyAxisAngle(N, rot);
  B.applyAxisAngle(N, rot);
  if (t.mirror) T.negate();
  const width = t.width;
  const height = t.width * t.aspect;
  const frame = {
    mode: t.mode,
    center,
    T,
    B,
    N,
    width,
    height,
    depth: Math.max(width, height) * 0.55 + 0.25,
    opacity: t.visible ? t.opacity : 0,
    texture,
    rotation: rot,
    mirror: t.mirror,
  };
  if (t.mode === 'wrap') {
    const { origin, dir } = avatar.canonicalRegionAxis(t.region);
    const D = dir.clone();
    if (D.y < 0) D.negate();
    const rel = center.clone().sub(origin);
    const a0 = rel.dot(D);
    const radial = rel.clone().addScaledVector(D, -a0);
    let radius = radial.length();
    const E1 = radius > 1e-4 ? radial.clone().divideScalar(radius) : N.clone();
    radius = Math.max(radius, 0.15);
    Object.assign(frame, { axisO: origin, axisD: D, axisE1: E1, radius, a0, regionMask: LIMB_MASK[t.region] ?? 1 });
  }
  return frame;
}

/**
 * Coordonnées (u, v) d'un point canonique dans un tatouage, ou null s'il est
 * en dehors. Même calcul que le shader de cuisson.
 */
export function localCoords(frame, p, n, region) {
  let u;
  let v;
  if (frame.mode === 'wrap') {
    if (!(frame.regionMask & (1 << region))) return null;
    const d = p.clone().sub(frame.axisO);
    const along = d.dot(frame.axisD);
    const radial = d.clone().addScaledVector(frame.axisD, -along);
    const rl = radial.length();
    if (rl < frame.radius * 0.3 || rl > frame.radius * 2.2) return null;
    const e2 = new THREE.Vector3().crossVectors(frame.axisD, frame.axisE1);
    const ang = Math.atan2(radial.dot(e2), radial.dot(frame.axisE1));
    const s = ang * frame.radius;
    const a = along - frame.a0;
    const c = Math.cos(frame.rotation);
    const sn = Math.sin(frame.rotation);
    u = ((c * s + sn * a) * (frame.mirror ? -1 : 1)) / frame.width + 0.5;
    v = (-sn * s + c * a) / frame.height + 0.5;
  } else {
    const d = p.clone().sub(frame.center);
    if (Math.abs(d.dot(frame.N)) > frame.depth) return null;
    if (n.dot(frame.N) < -0.05) return null;
    u = d.dot(frame.T) / frame.width + 0.5;
    v = d.dot(frame.B) / frame.height + 0.5;
  }
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}

/** Le point touche-t-il une partie visible du motif ? */
export function hitsImage(image, uv, tolerance = 0.06) {
  if (!uv) return false;
  // tolérance : on accepte un clic proche du motif
  const r = Math.max(1, Math.round(tolerance * Math.max(image.aw, image.ah)));
  const cx = Math.round(uv.u * (image.aw - 1));
  const cy = Math.round((1 - uv.v) * (image.ah - 1));
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= image.aw || y >= image.ah) continue;
      if (image.alpha[y * image.aw + x] > 40) return true;
    }
  }
  return false;
}

// GROGNON
