import * as THREE from 'three';
import { Viewer } from './core/Viewer.js';
import { loadAvatarData } from './avatar/AvatarData.js';
import { Avatar } from './avatar/Avatar.js';
import { Hair } from './hair/Hair.js';
import { TattooBaker } from './tattoo/TattooBaker.js';
import { ImageLibrary, computeFrame, createTattoo, hitsImage, localCoords, newId } from './tattoo/Tattoos.js';
import { Interaction } from './tattoo/Interaction.js';
import { History } from './state/History.js';
import { defaultState, parseProject, serializeProject } from './state/Project.js';

const AUTOSAVE_KEY = 'calquela:projet-en-cours';

/**
 * Cœur de l'application : état du projet, synchronisation avec la scène 3D,
 * historique et sauvegarde automatique. L'interface (panneaux) appelle ces
 * méthodes et s'abonne aux changements.
 */
export class App {
  constructor(viewport) {
    this.viewport = viewport;
    this.state = defaultState();
    this.selectedId = null;
    this.history = new History();
    this.images = new ImageLibrary();
    this.listeners = new Set();
    this.ghost = null;
    this._bakeNeeded = true;
    this._outlineNeeded = true;
  }

  async init(onProgress) {
    this.viewer = new Viewer(this.viewport);
    this.baker = new TattooBaker(this.viewer.renderer);
    onProgress?.('Chargement de l’avatar…');
    const data = await loadAvatarData('./avatar/');
    this.avatar = new Avatar(data, { tattooMap: this.baker.texture, overlayMap: this.baker.overlayTexture });
    this.baker.setGeometry(this.avatar.geometry);
    this.viewer.scene.add(this.avatar.group);
    this.hair = new Hair(this.avatar);
    this.interaction = new Interaction({ viewer: this.viewer, avatar: this.avatar, container: this.viewport, app: this });
    this.viewer.beforeRender.add(() => this._flush());
    this.avatar.onChange((kind) => {
      if (kind === 'shape' || kind === 'pose') this._outlineNeeded = true;
    });
  }

  // ------------------------------------------------------------- abonnements
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what) {
    for (const fn of this.listeners) fn(what);
  }

  // ------------------------------------------------------------- application de l'état
  /** Applique un état complet (chargement, annuler/rétablir). */
  async applyState(state, { resetHistory = false, images } = {}) {
    if (images) {
      for (const [id, url] of Object.entries(images)) {
        if (!this.images.has(id)) await this.images.add(url, id);
      }
    }
    const prevHair = JSON.stringify(this.state.hair);
    const prevGender = this.state.avatar.gender;
    this.state = state;
    this._applyAvatar();
    this.avatar.setPose(state.pose);
    const hairChanged = JSON.stringify(state.hair) !== prevHair || state.avatar.gender !== prevGender || resetHistory;
    if (hairChanged) this.hair.setStyle(state.hair);
    if (this.selectedId && !state.tattoos.some((t) => t.id === this.selectedId)) this.selectedId = null;
    this.requestBake();
    if (resetHistory) this.history.reset(this.state);
    this.emit('state');
  }

  _applyAvatar() {
    const a = this.state.avatar;
    this.avatar.setShape({ gender: a.gender, height: a.height, weight: a.weight, muscle: a.muscle, proportions: a.proportions, breast: a.breast });
    this.avatar.skinMaterial.color.set(a.skin);
    this.avatar.setUnderwearColor(a.underwear);
  }

  /** Change la morphologie. `live` : pendant le glissement d'un curseur. */
  setAvatar(patch, live = false) {
    const genderChanged = patch.gender && patch.gender !== this.state.avatar.gender;
    Object.assign(this.state.avatar, patch);
    if ('skin' in patch) this.avatar.skinMaterial.color.set(patch.skin);
    if ('underwear' in patch) this.avatar.setUnderwearColor(patch.underwear);
    const shapeKeys = ['gender', 'height', 'weight', 'muscle', 'proportions', 'breast'];
    if (shapeKeys.some((k) => k in patch)) {
      this._applyAvatar();
      // la tête change peu : on régénère les cheveux à la fin du réglage
      if (genderChanged || !live) this._scheduleHair(genderChanged ? 0 : 60);
    }
    this.emit('avatar');
    if (!live) this.commit();
  }

  _scheduleHair(delay) {
    clearTimeout(this._hairTimer);
    this._hairTimer = setTimeout(() => this.hair.setStyle(this.state.hair), delay);
  }

  setHair(patch, live = false) {
    Object.assign(this.state.hair, patch);
    if ('color' in patch && Object.keys(patch).length === 1) {
      this.hair.setStyle({ color: patch.color }); // couleur seule : pas besoin de tout recalculer…
    } else if (!live) {
      this.hair.setStyle(this.state.hair);
    }
    this.emit('hair');
    if (!live) this.commit();
  }

  setPose(pose, live = false) {
    this.state.pose = pose;
    this.avatar.setPose(pose);
    this.emit('pose');
    if (!live) this.commit();
  }

  setName(name) {
    this.state.name = name.slice(0, 80) || 'Sans titre';
    this.commit();
  }

  // ------------------------------------------------------------- tatouages
  get selected() {
    return this.state.tattoos.find((t) => t.id === this.selectedId) || null;
  }

  frameOf(t, opacity) {
    const img = this.images.get(t.imageId);
    const f = computeFrame(t, this.avatar, img?.texture);
    if (opacity !== undefined) f.opacity = opacity;
    return f;
  }

  /** Motif le plus haut (dans l'ordre des calques) sous un point de la peau. */
  tattooAt(hit) {
    for (let i = this.state.tattoos.length - 1; i >= 0; i--) {
      const t = this.state.tattoos[i];
      if (!t.visible) continue;
      const img = this.images.get(t.imageId);
      if (!img) continue;
      const uv = localCoords(this.frameOf(t), hit.p, hit.n, hit.region);
      if (uv && (t.id === this.selectedId || hitsImage(img, uv))) return t;
    }
    return null;
  }

  select(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this._outlineNeeded = true;
    this.emit('selection');
  }

  async addImage(canvas) {
    return this.images.add(canvas);
  }

  placeTattoo(image, hit, name) {
    // taille de départ : environ 12 cm de large, ou moins pour une image très haute
    const aspect = image.height / image.width;
    const width = Math.min(1.2, 1.4 / Math.max(aspect, 0.01));
    const t = createTattoo(image, { p: hit.p, n: hit.n, region: hit.region, face: hit.face, bary: hit.bary }, { name, width });
    this.state.tattoos.push(t);
    this.setGhost(null);
    this.selectedId = t.id;
    this.requestBake();
    this.emit('tattoos');
    this.emit('selection');
    this.commit();
  }

  /** Modifie le motif sélectionné. `commit` : ajoute une étape à l'historique. */
  updateSelected(patch, commit = true) {
    const t = this.selected;
    if (!t) return;
    Object.assign(t, patch);
    if (patch.rotation !== undefined) t.rotation = ((((t.rotation + 180) % 360) + 360) % 360) - 180;
    this.requestBake();
    this.emit('tattoo-edit');
    if (commit) this.commit();
  }

  updateTattoo(id, patch) {
    const t = this.state.tattoos.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    this.requestBake();
    this.emit('tattoos');
    this.commit();
  }

  removeTattoo(id) {
    this.state.tattoos = this.state.tattoos.filter((t) => t.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.requestBake();
    this.emit('tattoos');
    this.emit('selection');
    this.commit();
  }

  duplicateTattoo(id) {
    const t = this.state.tattoos.find((x) => x.id === id);
    if (!t) return;
    const copy = { ...JSON.parse(JSON.stringify(t)), id: newId('t'), name: `${t.name} (copie)` };
    // décalé de 3 cm sur la peau, le long du motif
    const f = this.frameOf(t);
    const p = new THREE.Vector3().fromArray(t.center).addScaledVector(f.T, 0.3);
    copy.center = p.toArray();
    const i = this.state.tattoos.indexOf(t);
    this.state.tattoos.splice(i + 1, 0, copy);
    this.selectedId = copy.id;
    this.requestBake();
    this.emit('tattoos');
    this.emit('selection');
    this.commit();
  }

  moveTattoo(id, delta) {
    const list = this.state.tattoos;
    const i = list.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.requestBake();
    this.emit('tattoos');
    this.commit();
  }

  /** Aperçu du motif pendant qu'on choisit où le poser. */
  setGhost(g) {
    this.ghost = g;
    this.requestBake();
  }

  setGhostVisible(v) {
    if (!v && this.ghost) this.setGhost(null);
  }

  focusTattoo(id = this.selectedId) {
    const t = this.state.tattoos.find((x) => x.id === id);
    if (!t) return;
    const p = this.avatar.posedPoint(t.face, t.bary);
    // normale posée : approximation par le point voisin le long de la normale canonique
    const n = new THREE.Vector3().fromArray(t.normal);
    const rootQ = new THREE.Quaternion();
    this.avatar.bones[this.avatar.boneIndex[this.avatar.dominantBone(this.avatar.geometry.index.array[t.face * 3])]].getWorldQuaternion(rootQ);
    n.applyQuaternion(rootQ);
    this.viewer.focusOn(p, n, Math.max(0.55, t.width * 0.1 * 4.5));
  }

  requestBake() {
    this._bakeNeeded = true;
    this._outlineNeeded = true;
  }

  _flush() {
    if (this._bakeNeeded) {
      const frames = this.state.tattoos.filter((t) => t.visible).map((t) => this.frameOf(t));
      if (this.ghost) {
        const g = this.ghost;
        const tmp = createTattoo(g.image, g.anchor, { width: Math.min(1.2, 1.4 / Math.max(g.image.height / g.image.width, 0.01)) });
        frames.push(this.frameOf(tmp, 0.75));
      }
      this.baker.bake(frames);
      this._bakeNeeded = false;
    }
    if (this._outlineNeeded) {
      const t = this.selected;
      this.baker.bakeOutline(t && t.visible ? this.frameOf(t) : null);
      this._outlineNeeded = false;
    }
  }

  // ------------------------------------------------------------- historique
  commit() {
    if (this.history.commit(this.state)) this._autosave();
  }

  async undo() {
    const s = this.history.undo();
    if (s) await this.applyState(s);
    this._autosave();
  }

  async redo() {
    const s = this.history.redo();
    if (s) await this.applyState(s);
    this._autosave();
  }

  _autosave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeProject(this.state, this.images.images));
      } catch {
        // espace de stockage plein : la sauvegarde automatique est ignorée
      }
      this.images.prune(new Set([...this.history.usedImageIds(), ...this.state.tattoos.map((t) => t.imageId)]));
    }, 900);
  }

  restoreAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? parseProject(raw) : null;
    } catch {
      return null;
    }
  }

  clearAutosave() {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* rien */
    }
  }

  /** Projet complet (avec images) au format JSON. */
  exportJson() {
    return serializeProject(this.state, this.images.images);
  }

  async loadProject(text) {
    const { state, images } = parseProject(text);
    this.selectedId = null;
    await this.applyState(state, { resetHistory: true, images });
    this._autosave();
  }

  async newProject() {
    this.selectedId = null;
    await this.applyState(defaultState(), { resetHistory: true });
    this._autosave();
  }
}

// GROGNON
