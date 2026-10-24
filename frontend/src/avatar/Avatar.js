import * as THREE from 'three';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createSkinMaterial } from './SkinMaterial.js';
import { computePoseQuaternions } from './Pose.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

/**
 * Régions du corps utilisées pour l'enroulement des tatouages.
 * 0 tronc et tête · 1/3 bras (G/D) · 2/4 avant-bras et main · 5/7 cuisse · 6/8 jambe et pied
 */
function regionOfBone(name) {
  const side = name.endsWith('.L') ? 0 : name.endsWith('.R') ? 1 : -1;
  if (side < 0) return 0;
  if (name.startsWith('upperarm')) return side ? 3 : 1;
  if (/^(lowerarm|wrist|finger|metacarpal)/.test(name)) return side ? 4 : 2;
  if (name.startsWith('upperleg')) return side ? 7 : 5;
  if (/^(lowerleg|foot|toe)/.test(name)) return side ? 8 : 6;
  return 0;
}

const levels = (x) => {
  const min = Math.max(0, 1 - 2 * x);
  const max = Math.max(0, 2 * x - 1);
  return { min, max, average: 1 - min - max };
};

export const DEFAULT_SHAPE = {
  gender: 'male', // 'male' | 'female'
  height: 0.5,
  weight: 0.5,
  muscle: 0.5,
  proportions: 0.5,
  breast: 0.5,
};

/**
 * Avatar paramétrique : refait dans le navigateur le calcul de MakeHuman
 * (cibles pondérées), puis ajuste le squelette et les yeux à la nouvelle forme.
 * Tout est exprimé en décimètres dans le groupe `rig`, mis à l'échelle 0,1
 * (mètres) par le groupe parent.
 */
export class Avatar {
  constructor(data, { tattooMap, overlayMap }) {
    this.data = data;
    const { counts } = data;
    this.nCpu = counts.cpu;
    this.nBody = counts.body;
    this.nRender = counts.render;

    this.group = new THREE.Group();
    this.group.name = 'avatar';
    this.group.scale.setScalar(0.1);
    this.rig = this.group; // alias lisible

    this.cpuPos = new Float32Array(data.basePos.length);
    this.cpuNormal = new Float32Array(data.basePos.length);
    this.shape = { ...DEFAULT_SHAPE };
    this.pose = null;

    this._buildBodyGeometry();
    this._buildSkeleton();

    this.skinMaterial = createSkinMaterial({ tattooMap, overlayMap });
    this.body = new THREE.SkinnedMesh(this.geometry, this.skinMaterial);
    this.body.name = 'corps';
    this.body.frustumCulled = false;
    this.body.castShadow = true;
    this.body.receiveShadow = true;

    this._buildEyes();
    this._buildUnderwear();

    this.group.add(this.rootBone);
    this.group.add(this.body, this.eyes, this.briefs, this.top);
    this.skinnedMeshes = [this.body, this.eyes, this.briefs, this.top];
    for (const m of this.skinnedMeshes) m.bind(this.skeleton);

    // Maillage de sélection (positions posées calculées sur le processeur)
    this.pickGeometry = new THREE.BufferGeometry();
    this.pickGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nRender * 3), 3));
    this.pickGeometry.setIndex(this.geometry.index);
    this.pickMesh = new THREE.Mesh(this.pickGeometry, new THREE.MeshBasicMaterial({ visible: false }));
    this.pickMesh.raycast = acceleratedRaycast;
    this.pickMesh.name = 'selection';
    this.group.add(this.pickMesh);
    this._pickDirty = true;

    // hauteur du corps neutre (sert à convertir la taille des motifs en cm)
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < this.nBody * 3; i += 3) {
      lo = Math.min(lo, data.basePos[i]);
      hi = Math.max(hi, data.basePos[i]);
    }
    this.neutralHeightCm = (hi - lo) * 10;

    this.listeners = new Set();
    this.setShape(this.shape);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(kind) {
    for (const fn of this.listeners) fn(kind);
  }

  // ------------------------------------------------------------------ géométrie
  _buildBodyGeometry() {
    const d = this.data;
    const g = new THREE.BufferGeometry();
    const n = this.nRender;
    this.renderPos = new Float32Array(n * 3);
    this.renderNormal = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.renderPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.renderNormal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(d.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(d.skinWeight, 4, true));
    g.setAttribute('features', new THREE.Uint8BufferAttribute(d.features, 4, true));
    g.setAttribute('cloth', new THREE.Uint8BufferAttribute(d.cloth, 2, true));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));

    // Position et normale « canoniques » (corps neutre au repos) : c'est dans
    // cet espace que les tatouages sont projetés, ils suivent donc la peau
    // quand la morphologie ou la pose changent.
    const canon = new Float32Array(n * 3);
    const neutralNormals = this._computeNormals(d.basePos);
    const canonN = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
      const c = d.renderCpu[r] * 3;
      for (let k = 0; k < 3; k++) {
        canon[r * 3 + k] = d.basePos[c + k];
        canonN[r * 3 + k] = neutralNormals[c + k];
      }
    }
    g.setAttribute('canon', new THREE.BufferAttribute(canon, 3));
    g.setAttribute('canonNormal', new THREE.BufferAttribute(canonN, 3));
    this.canon = canon;
    this.canonNormal = canonN;

    // Région dominante de chaque sommet
    const region = new Float32Array(n);
    const names = d.bones.map((b) => b.name);
    for (let r = 0; r < n; r++) region[r] = regionOfBone(names[d.skinIndex[r * 4]]);
    g.setAttribute('region', new THREE.BufferAttribute(region, 1));
    this.region = region;

    this.geometry = g;
  }

  /** Normales lissées par sommet CPU (aucune couture d'UV). */
  _computeNormals(pos, out = new Float32Array(pos.length)) {
    out.fill(0);
    const q = this.data.quads;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const dd = new THREE.Vector3();
    const n1 = new THREE.Vector3();
    for (let f = 0; f < q.length; f += 4) {
      const i0 = q[f] * 3;
      const i1 = q[f + 1] * 3;
      const i2 = q[f + 2] * 3;
      const i3 = q[f + 3] * 3;
      a.fromArray(pos, i0);
      b.fromArray(pos, i1);
      c.fromArray(pos, i2);
      dd.fromArray(pos, i3);
      // normale du quad = produit vectoriel des diagonales
      n1.subVectors(c, a).cross(dd.sub(b));
      for (const i of [i0, i1, i2, i3]) {
        out[i] += n1.x;
        out[i + 1] += n1.y;
        out[i + 2] += n1.z;
      }
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l;
      out[i + 1] /= l;
      out[i + 2] /= l;
    }
    return out;
  }

  _buildSkeleton() {
    const d = this.data;
    this.bones = d.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      return bone;
    });
    this.boneIndex = Object.fromEntries(d.bones.map((b, i) => [b.name, i]));
    d.bones.forEach((b, i) => {
      if (b.parent >= 0) this.bones[b.parent].add(this.bones[i]);
      else this.rootBone = this.bones[i];
    });
    this.skeleton = new THREE.Skeleton(this.bones);
    this.joints = new Float32Array(d.jointNames.length * 3);
    this.jointIndex = Object.fromEntries(d.jointNames.map((j, i) => [j, i]));
  }

  _buildEyes() {
    const e = this.data.eye;
    const g = new THREE.BufferGeometry();
    this.eyePos = new Float32Array(e.count * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.eyePos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(e.uv, 2));
    const head = this.boneIndex.head;
    const si = new Uint8Array(e.count * 4);
    const sw = new Uint8Array(e.count * 4);
    for (let i = 0; i < e.count; i++) {
      si[i * 4] = head;
      sw[i * 4] = 255;
    }
    g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(sw, 4, true));
    g.setIndex(new THREE.BufferAttribute(e.index, 1));
    const tex = new THREE.TextureLoader().load('./avatar/eye.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // la cornée correspond à une zone transparente de la texture
    const mat = new THREE.MeshPhysicalMaterial({ map: tex, alphaTest: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
    this.eyes = new THREE.SkinnedMesh(g, mat);
    this.eyes.name = 'yeux';
    this.eyes.frustumCulled = false;
  }

  /** Crée un maillage qui réutilise les sommets du corps (sous-ensemble de faces). */
  createSubsetMesh(indexArray, material, name) {
    const g = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'features', 'cloth']) {
      g.setAttribute(key, this.geometry.getAttribute(key));
    }
    g.setIndex(new THREE.BufferAttribute(indexArray, 1));
    const m = new THREE.SkinnedMesh(g, material);
    m.name = name;
    m.frustumCulled = false;
    return m;
  }

  /**
   * Matériau de tissu légèrement décollé de la peau (évite le scintillement).
   * `channel` : canal de l'attribut `cloth` qui découpe la pièce (0 slip, 1 haut).
   */
  static offsetMaterial(params, offset, channel = -1) {
    const mat = new THREE.MeshStandardMaterial(params);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uOffset = { value: offset };
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float uOffset;\nattribute vec2 cloth;\nvarying float vCloth;\nvoid main() {')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed += normal * uOffset;
vCloth = ${channel === 0 ? 'cloth.x' : channel === 1 ? 'cloth.y' : '1.0'};`);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'varying float vCloth;\nvoid main() {\n  if (vCloth < 0.5) discard;');
    };
    mat.customProgramCacheKey = () => 'cloth' + channel;
    return mat;
  }

  _buildUnderwear() {
    const params = { color: 0x24232b, roughness: 0.82, metalness: 0 };
    this.briefsMaterial = Avatar.offsetMaterial(params, 0.018, 0);
    this.topMaterial = Avatar.offsetMaterial(params, 0.018, 1);
    this.briefs = this.createSubsetMesh(this.data.briefs, this.briefsMaterial, 'slip');
    this.top = this.createSubsetMesh(this.data.top, this.topMaterial, 'haut');
    this.briefs.castShadow = this.top.castShadow = true;
  }

  setUnderwearColor(hex) {
    this.briefsMaterial.color.set(hex);
    this.topMaterial.color.set(hex);
  }

  // ------------------------------------------------------------------ forme
  targetWeight(f, s) {
    const male = s.gender === 'male' ? 1 : 0;
    const gv = f.gender === 'male' ? male : 1 - male;
    if (gv === 0) return 0;
    if (f.cup) return gv * levels(s.breast)[f.cup];
    if (f.proportions) {
      const p = levels(s.proportions);
      return gv * (f.proportions === 'ideal' ? p.max : p.min);
    }
    if (f.height) return gv * levels(s.weight)[f.weight] * levels(s.height)[f.height];
    return gv * levels(s.muscle)[f.muscle] * levels(s.weight)[f.weight];
  }

  setShape(shape) {
    Object.assign(this.shape, shape);
    const d = this.data;
    const pos = this.cpuPos;
    pos.set(d.basePos);
    for (const t of d.targets) {
      if (!t.count) continue;
      const w = this.targetWeight(t.factors, this.shape);
      if (Math.abs(w) < 1e-4) continue;
      const s = w * t.scale;
      const idx = t.idx;
      const del = t.delta;
      for (let k = 0; k < t.count; k++) {
        const i = idx[k] * 3;
        pos[i] += del[k * 3] * s;
        pos[i + 1] += del[k * 3 + 1] * s;
        pos[i + 2] += del[k * 3 + 2] * s;
      }
    }
    this._computeNormals(pos, this.cpuNormal);
    const rc = d.renderCpu;
    for (let r = 0; r < this.nRender; r++) {
      const c = rc[r] * 3;
      this.renderPos[r * 3] = pos[c];
      this.renderPos[r * 3 + 1] = pos[c + 1];
      this.renderPos[r * 3 + 2] = pos[c + 2];
      this.renderNormal[r * 3] = this.cpuNormal[c];
      this.renderNormal[r * 3 + 1] = this.cpuNormal[c + 1];
      this.renderNormal[r * 3 + 2] = this.cpuNormal[c + 2];
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();

    this.top.visible = this.shape.gender === 'female';
    this._fitEyes();
    this._updateJoints();
    this._rebind();
    this._emit('shape');
  }

  _fitEyes() {
    const e = this.data.eye;
    const p = this.cpuPos;
    // Échelle de l'ajustement (règle MakeHuman) : écart entre deux sommets de référence
    const scale = e.scales.map(([a, b, den], k) => Math.abs(p[a * 3 + k] - p[b * 3 + k]) / den);
    for (let i = 0; i < e.count; i++) {
      for (let k = 0; k < 3; k++) {
        let v = 0;
        for (let j = 0; j < 3; j++) v += e.weights[i * 3 + j] * p[e.refs[i * 3 + j] * 3 + k];
        this.eyePos[i * 3 + k] = v + e.offsets[i * 3 + k] * scale[k];
      }
    }
    this.eyes.geometry.attributes.position.needsUpdate = true;
    this.eyes.geometry.computeVertexNormals();
  }

  _updateJoints() {
    const { jointVerts, jointStart } = this.data;
    const p = this.cpuPos;
    const nj = jointStart.length - 1;
    for (let j = 0; j < nj; j++) {
      let x = 0;
      let y = 0;
      let z = 0;
      const s = jointStart[j];
      const e = jointStart[j + 1];
      for (let k = s; k < e; k++) {
        const v = jointVerts[k] * 3;
        x += p[v];
        y += p[v + 1];
        z += p[v + 2];
      }
      const c = e - s || 1;
      this.joints[j * 3] = x / c;
      this.joints[j * 3 + 1] = y / c;
      this.joints[j * 3 + 2] = z / c;
    }
  }

  /** Position (dm) de la tête d'un os, selon la forme actuelle. */
  boneHead(name, target = new THREE.Vector3()) {
    const b = this.data.bones[this.boneIndex[name]];
    return target.fromArray(this.joints, b.head * 3);
  }

  boneTail(name, target = new THREE.Vector3()) {
    const b = this.data.bones[this.boneIndex[name]];
    return target.fromArray(this.joints, b.tail * 3);
  }

  /** Repositionne les os au repos, recalcule les matrices inverses, puis réapplique la pose. */
  _rebind() {
    const d = this.data;
    const head = new THREE.Vector3();
    const parentHead = new THREE.Vector3();
    d.bones.forEach((b, i) => {
      const bone = this.bones[i];
      head.fromArray(this.joints, b.head * 3);
      if (b.parent >= 0) {
        parentHead.fromArray(this.joints, d.bones[b.parent].head * 3);
        bone.position.subVectors(head, parentHead);
      } else {
        bone.position.copy(head);
      }
      bone.quaternion.identity();
    });
    // Pieds au sol
    let minY = Infinity;
    for (let i = 1; i < this.nBody * 3; i += 3) minY = Math.min(minY, this.cpuPos[i]);
    this.minY = minY;
    let maxY = -Infinity;
    for (let i = 1; i < this.nBody * 3; i += 3) maxY = Math.max(maxY, this.cpuPos[i]);
    this.heightDm = maxY - minY;
    this.group.position.y = -minY * 0.1;

    this.group.updateMatrixWorld(true);
    this.skeleton.calculateInverses();
    for (const m of this.skinnedMeshes) {
      m.bindMatrix.copy(m.matrixWorld);
      m.bindMatrixInverse.copy(m.matrixWorld).invert();
    }
    this.restPose = this.bones.map((b) => b.position.clone());
    if (this.pose) this.setPose(this.pose);
    else this._pickDirty = true;
  }

  /** Hauteur du corps en centimètres. */
  get heightCm() {
    return this.heightDm * 10;
  }

  // ------------------------------------------------------------------ pose
  setPose(pose) {
    this.pose = pose;
    for (const b of this.bones) b.quaternion.identity();
    const qs = computePoseQuaternions(this, pose);
    for (const [name, q] of Object.entries(qs)) {
      const i = this.boneIndex[name];
      if (i !== undefined) this.bones[i].quaternion.copy(q);
    }
    this.group.updateMatrixWorld(true);
    this._pickDirty = true;
    this._emit('pose');
  }

  /** Maillage posé utilisé pour la sélection à la souris (mis à jour à la demande). */
  getPickMesh() {
    if (this._pickDirty) {
      this.group.updateMatrixWorld(true);
      const out = this.pickGeometry.attributes.position.array;
      const v = new THREE.Vector3();
      for (let r = 0; r < this.nRender; r++) {
        v.fromArray(this.renderPos, r * 3);
        this.body.applyBoneTransform(r, v);
        out[r * 3] = v.x;
        out[r * 3 + 1] = v.y;
        out[r * 3 + 2] = v.z;
      }
      this.pickGeometry.attributes.position.needsUpdate = true;
      this.pickGeometry.computeBoundingSphere();
      this.pickGeometry.computeBoundingBox();
      this.pickGeometry.computeBoundsTree();
      this._pickDirty = false;
    }
    return this.pickMesh;
  }

  /** Position posée (espace monde) d'un point défini par une face et des coordonnées barycentriques. */
  posedPoint(face, bary, target = new THREE.Vector3()) {
    const pm = this.getPickMesh();
    const idx = this.geometry.index.array;
    const pos = pm.geometry.attributes.position.array;
    target.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const v = idx[face * 3 + k] * 3;
      target.x += pos[v] * bary[k];
      target.y += pos[v + 1] * bary[k];
      target.z += pos[v + 2] * bary[k];
    }
    return target.applyMatrix4(pm.matrixWorld);
  }

  /** Point canonique (corps neutre) correspondant à une face + barycentriques. */
  canonicalPoint(face, bary) {
    const idx = this.geometry.index.array;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    let region = 0;
    let best = -1;
    for (let k = 0; k < 3; k++) {
      const v = idx[face * 3 + k];
      p.x += this.canon[v * 3] * bary[k];
      p.y += this.canon[v * 3 + 1] * bary[k];
      p.z += this.canon[v * 3 + 2] * bary[k];
      n.x += this.canonNormal[v * 3] * bary[k];
      n.y += this.canonNormal[v * 3 + 1] * bary[k];
      n.z += this.canonNormal[v * 3 + 2] * bary[k];
      if (bary[k] > best) {
        best = bary[k];
        region = this.region[v];
      }
    }
    return { p, n: n.normalize(), region };
  }

  /** Os dominant d'un sommet de rendu. */
  dominantBone(renderVertex) {
    return this.data.bones[this.data.skinIndex[renderVertex * 4]].name;
  }

  /** Position canonique (corps neutre) de la tête d'un os. */
  canonicalBoneHead(name) {
    const b = this.data.bones[this.boneIndex[name]];
    const { jointVerts, jointStart, basePos } = this.data;
    const v = new THREE.Vector3();
    const s = jointStart[b.head];
    const e = jointStart[b.head + 1];
    for (let k = s; k < e; k++) {
      v.x += basePos[jointVerts[k] * 3];
      v.y += basePos[jointVerts[k] * 3 + 1];
      v.z += basePos[jointVerts[k] * 3 + 2];
    }
    return v.divideScalar(Math.max(1, e - s));
  }

  /**
   * Axe d'enroulement d'une région (espace canonique) : le membre est traité
   * comme un cylindre autour de cet axe.
   */
  canonicalRegionAxis(region) {
    const L = ['upperarm01.L', 'lowerarm01.L', 'wrist.L'];
    const R = ['upperarm01.R', 'lowerarm01.R', 'wrist.R'];
    const LL = ['upperleg01.L', 'lowerleg01.L', 'foot.L'];
    const RL = ['upperleg01.R', 'lowerleg01.R', 'foot.R'];
    const pairs = {
      0: ['spine05', 'neck01'],
      1: [L[0], L[1]], 2: [L[1], L[2]],
      3: [R[0], R[1]], 4: [R[1], R[2]],
      5: [LL[0], LL[1]], 6: [LL[1], LL[2]],
      7: [RL[0], RL[1]], 8: [RL[1], RL[2]],
    };
    const [a, b] = pairs[region] || pairs[0];
    const o = this.canonicalBoneHead(a);
    const t = this.canonicalBoneHead(b);
    return { origin: o, dir: t.sub(o).normalize() };
  }
}

// GROGNON
