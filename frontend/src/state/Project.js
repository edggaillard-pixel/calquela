import { DEFAULT_POSE, clonePose } from '../avatar/Pose.js';

export const APP_ID = 'CalqueLa';
export const FORMAT_VERSION = 1;

export const SKIN_TONES = [
  { label: 'Très clair', hex: '#e8c4ae' },
  { label: 'Clair', hex: '#d7a98c' },
  { label: 'Clair doré', hex: '#c99a7c' },
  { label: 'Mat', hex: '#b07f5f' },
  { label: 'Hâlé', hex: '#986645' },
  { label: 'Brun', hex: '#7a4e33' },
  { label: 'Foncé', hex: '#5a3824' },
  { label: 'Très foncé', hex: '#3e261a' },
];

export const UNDERWEAR_COLORS = [
  { label: 'Noir', hex: '#24232b' },
  { label: 'Blanc', hex: '#e9e8e4' },
  { label: 'Gris', hex: '#8b8b90' },
  { label: 'Bleu nuit', hex: '#25304d' },
  { label: 'Bordeaux', hex: '#5e1f2a' },
];

export function defaultState() {
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    name: 'Sans titre',
    avatar: {
      gender: 'male',
      height: 0.5,
      weight: 0.5,
      muscle: 0.5,
      proportions: 0.5,
      breast: 0.5,
      skin: '#c99a7c',
      underwear: '#24232b',
    },
    hair: { style: 'court', color: '#3a2518', fringe: false, length: 1 },
    pose: clonePose(DEFAULT_POSE),
    tattoos: [],
  };
}

/** Fichier de projet complet : état + images (data URL PNG). */
export function serializeProject(state, images) {
  const used = new Set(state.tattoos.map((t) => t.imageId));
  const imgs = {};
  for (const id of used) {
    const e = images.get(id);
    if (e) imgs[id] = e.dataUrl;
  }
  return JSON.stringify({ ...state, savedAt: new Date().toISOString(), images: imgs });
}

/** Vérifie et complète un projet lu depuis un fichier ou un lien. */
export function parseProject(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('Fichier illisible.');
  }
  if (!data || data.app !== APP_ID) throw new Error("Ce fichier n'est pas un projet CalqueLa.");
  const base = defaultState();
  const state = {
    ...base,
    name: typeof data.name === 'string' ? data.name.slice(0, 80) : base.name,
    avatar: { ...base.avatar, ...(data.avatar || {}) },
    hair: { ...base.hair, ...(data.hair || {}) },
    pose: { ...base.pose, ...(data.pose || {}) },
    tattoos: Array.isArray(data.tattoos) ? data.tattoos.filter((t) => t && t.imageId && Array.isArray(t.center)) : [],
  };
  const images = data.images && typeof data.images === 'object' ? data.images : {};
  for (const [id, url] of Object.entries(images)) {
    if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) delete images[id];
  }
  state.tattoos = state.tattoos.filter((t) => images[t.imageId]);
  return { state, images };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(name) {
  return (name || 'projet').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'projet';
}

/** Envoie le projet au serveur et renvoie le lien de partage. */
export async function shareProject(json) {
  const res = await fetch('./api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 404 || res.status === 405) throw new Error('Le partage par lien demande le serveur CalqueLa.');
    throw new Error(body.erreur || 'Partage impossible.');
  }
  const { id } = await res.json();
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('p', id);
  return url.toString();
}

export async function fetchSharedProject(id) {
  if (!/^[A-Za-z0-9]{12}$/.test(id)) throw new Error('Lien de partage invalide.');
  const res = await fetch(`./api/projects/${id}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'Projet introuvable ou expiré.' : 'Chargement impossible.');
  return res.text();
}

// GROGNON
