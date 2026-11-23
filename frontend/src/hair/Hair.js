import * as THREE from 'three';
import { Avatar } from '../avatar/Avatar.js';

/**
 * Cheveux : vrais modèles 3D du pack « MakeHuman system assets » (CC0).
 * Chaque coupe est ajustée au crâne de l'avatar (comme les yeux) et suit
 * donc la morphologie et les mouvements de la tête. La texture est stockée
 * en niveaux de gris pour pouvoir teinter les cheveux de n'importe quelle couleur.
 */

export const HAIR_STYLES = [
  { id: 'chauve', label: 'Chauve', model: null },
  { id: 'rase', label: 'Rasé', model: null },
  { id: 'tres-court', label: 'Très court', model: 'short04' },
  { id: 'court', label: 'Court', model: 'short02' },
  { id: 'mi-court', label: 'Mi-court', model: 'short03' },
  { id: 'carre', label: 'Carré', model: 'bob01' },
  { id: 'long', label: 'Longs', model: 'long01' },
  { id: 'queue', label: 'Queue de cheval', model: 'ponytail01' },
  { id: 'tresse', label: 'Tresse', model: 'braid01' },
  { id: 'afro', label: 'Afro', model: 'afro01' },
];

// anciennes coupes (projets enregistrés avant le passage aux vrais modèles)
const LEGACY = { chignon: 'tresse', boucles: 'afro', 'carre-plongeant': 'carre' };

export const HAIR_COLORS = [
  { label: 'Noir', hex: '#16110f' },
  { label: 'Brun', hex: '#3a2518' },
  { label: 'Châtain', hex: '#664126' },
  { label: 'Auburn', hex: '#7c331d' },
  { label: 'Roux', hex: '#a9542a' },
  { label: 'Blond foncé', hex: '#9c7446' },
  { label: 'Blond', hex: '#cfae78' },
  { label: 'Platine', hex: '#e4dac4' },
  { label: 'Gris', hex: '#8f8e8b' },
];

export class Hair {
  constructor(avatar) {
    this.avatar = avatar;
    this.style = 'court';
    this.color = new THREE.Color('#3a2518');
    this.density = 1; // conservé pour compatibilité
    this.materials = {};
    this.current = null;

    // calotte teintée sous les cheveux : évite de voir la peau entre les mèches
    this.capMaterial = Avatar.offsetMaterial({ color: 0xffffff, roughness: 0.9 }, 0.02);
    this.cap = avatar.createSubsetMesh(avatar.data.scalp, this.capMaterial, 'calotte');
    this.cap.bind(avatar.skeleton, avatar.body.bindMatrix);
    this.cap.userData.noAO = true;
    avatar.group.add(this.cap);
    avatar.skinnedMeshes.push(this.cap);
    this._apply();
  }

  static resolve(id) {
    const s = LEGACY[id] || id;
    return HAIR_STYLES.find((h) => h.id === s) || HAIR_STYLES.find((h) => h.id === 'court');
  }

  setStyle({ style, color } = {}) {
    if (style !== undefined) this.style = Hair.resolve(style).id;
    if (color !== undefined) this.color.set(color);
    this._apply();
  }

  /** Compatibilité : les modèles se réajustent seuls avec la morphologie. */
  rebuild() {
    this._apply();
  }

  _material(model) {
    if (!this.materials[model]) {
      const p = this.avatar.data.proxies[model];
      this.materials[model] = new THREE.MeshStandardMaterial({
        map: this.avatar.loadTexture(p.texture),
        color: 0xffffff,
        roughness: 0.72,
        metalness: 0,
        envMapIntensity: 0.35,
        alphaTest: 0.3,
        alphaToCoverage: true,
        side: THREE.DoubleSide,
      });
    }
    return this.materials[model];
  }

  _apply() {
    const def = Hair.resolve(this.style);
    // un seul modèle visible à la fois
    for (const [id, m] of Object.entries(this.avatar.proxyMeshes)) {
      if (this.avatar.data.proxies[id].kind === 'hair') m.visible = id === def.model;
    }
    if (def.model) {
      const mat = this._material(def.model);
      // la texture est en gris clair : on éclaircit un peu la teinte pour compenser
      mat.color.copy(this.color).multiplyScalar(1.25);
      this.current = this.avatar.getProxyMesh(def.model, mat);
      this.current.visible = true;
    } else {
      this.current = null;
    }
    const u = this.avatar.skinMaterial.userData.uniforms;
    u.uHair.value.copy(this.color);
    this.avatar.eyebrowMaterial?.color.copy(this.color).multiplyScalar(0.85);
    this.capMaterial.color.copy(this.color).multiplyScalar(0.9);
    // cuir chevelu teinté : visible pour « Rasé », racines sous les autres coupes
    u.uScalp.value = def.id === 'chauve' ? 0 : def.id === 'rase' ? 0.8 : 0.9;
    this.cap.visible = !!def.model && def.model !== 'afro01';
  }
}

// GROGNON
