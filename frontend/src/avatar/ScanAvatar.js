import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createSkinMaterial } from './SkinMaterial.js';
import { computePoseQuaternions } from './Pose.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

/**
 * Personnage existant (bibliothèque Microsoft Rocketbox, licence MIT).
 *
 * Même interface que Avatar (corps MakeHuman) pour que les tatouages, la
 * sélection, les poses et l'export fonctionnent sans changement :
 *  - la peau du corps et de la tête est rendue avec le matériau de peau de
 *    CalqueLa (textures du personnage + tatouages cuits) ;
 *  - les UV du corps et de la tête se chevauchent : pour les tatouages, le
 *    corps est placé dans la moitié gauche de la texture et la tête dans la
 *    moitié droite (attribut bakeUv) ;
 *  - les positions « canoniques » (pose de repos) sont exprimées en
 *    décimètres, comme pour l'autre corps.
 * La morphologie est fixe : setShape, setSkin… ne font rien.
 */

// Noms logiques (ceux du corps MakeHuman, utilisés par Pose.js) → os du squelette Biped
const IDENTITY = new THREE.Quaternion();

const RIG = {
  'upperarm01.L': 'Bip01_L_UpperArm', 'lowerarm01.L': 'Bip01_L_Forearm', 'wrist.L': 'Bip01_L_Hand',
  'upperarm01.R': 'Bip01_R_UpperArm', 'lowerarm01.R': 'Bip01_R_Forearm', 'wrist.R': 'Bip01_R_Hand',
  'upperleg01.L': 'Bip01_L_Thigh', 'lowerleg01.L': 'Bip01_L_Calf', 'foot.L': 'Bip01_L_Foot',
  'upperleg01.R': 'Bip01_R_Thigh', 'lowerleg01.R': 'Bip01_R_Calf', 'foot.R': 'Bip01_R_Foot',
  neck01: 'Bip01_Neck', spine03: 'Bip01_Spine1', spine05: 'Bip01_Spine', head: 'Bip01_Head',
};

function regionOfBone(name) {
  const side = name.includes('_L_') ? 0 : name.includes('_R_') ? 1 : -1;
  if (side < 0) return 0;
  if (name.includes('UpperArm')) return side ? 3 : 1;
  if (/Forearm|Hand|Finger/.test(name)) return side ? 4 : 2;
  if (name.includes('Thigh')) return side ? 7 : 5;
  if (/Calf|Foot|Toe/.test(name)) return side ? 8 : 6;
  return 0;
}

export class ScanAvatar {
  /** Charge un personnage décrit dans models/index.json. */
  static async load(entry, { tattooMap, overlayMap }) {
    const base = `./models/${entry.id}/`;
    const manager = new THREE.LoadingManager();
    // les textures TGA d'origine sont remplacées par nos fichiers convertis
    manager.setURLModifier((url) => (/\.tga$/i.test(url) ? 'data:,' : url));
    const root = await new FBXLoader(manager).loadAsync(base + 'model.fbx');
    return new ScanAvatar(entry, root, { tattooMap, overlayMap });
  }

  constructor(entry, root, { tattooMap, overlayMap }) {
    this.entry = entry;
    this.id = entry.id;
    this.kind = 'scan';
    this.listeners = new Set();
    this.proxyMeshes = {};
    this.shape = { gender: entry.gender };
    this.pose = null;
    this.data = { meta: {}, proxies: {}, skins: {} };

    this.group = new THREE.Group();
    this.group.name = 'personnage';
    this.root = root;
    this.group.add(root);
    this.group.scale.setScalar(0.01); // centimètres → mètres

    let mesh = null;
    root.traverse((o) => {
      if (o.isSkinnedMesh && !mesh) mesh = o;
    });
    if (!mesh) throw new Error('Personnage sans maillage animable');
    this.body = mesh;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.skeleton = mesh.skeleton;
    this.bones = this.skeleton.bones;
    this.boneIndex = Object.fromEntries(this.bones.map((b, i) => [b.name, i]));

    // ---- matériaux
    const loader = new THREE.TextureLoader();
    const tex = (file, srgb = true) => {
      if (!file) return null;
      const t = loader.load(`./models/${entry.id}/${file}`);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      return t;
    };
    const f = entry.files;
    const skin = (part) => {
      const m = createSkinMaterial({ tattooMap, overlayMap });
      m.map = tex(f[part]);
      m.color.set(0xffffff);
      if (f[part + '_n']) {
        m.normalMap = tex(f[part + '_n'], false);
        m.normalScale.set(1, -1); // cartes de normales au format DirectX (3ds Max)
      }
      if (f[part + '_r']) {
        m.roughnessMap = tex(f[part + '_r'], false);
        m.roughness = 1;
      }
      m.userData.uniforms.uTextured.value = 1;
      m.userData.uniforms.uScalp.value = 0;
      return m;
    };
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const kinds = mats.map((m) => (/head/i.test(m.name) ? 'head' : /opacity/i.test(m.name) ? 'opacity' : 'body'));
    this.skinMaterial = skin('body');
    this.headMaterial = skin('head');
    const opacity = new THREE.MeshStandardMaterial({
      map: tex(f.opacity), alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.7,
    });
    opacity.visible = !!f.opacity; // sans texture de transparence, ces cartes resteraient opaques
    mesh.material = kinds.map((k) => (k === 'head' ? this.headMaterial : k === 'opacity' ? opacity : this.skinMaterial));
    for (const m of mats) m.dispose();

    // ---- géométrie : attributs nécessaires aux tatouages
    const g = mesh.geometry;
    g.deleteAttribute('color');
    const n = g.attributes.position.count;
    if (!g.index) {
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const triKind = new Uint8Array(n); // 0 corps, 1 tête, 2 transparent
    const index = g.index.array;
    for (const grp of g.groups) {
      const k = kinds[grp.materialIndex] === 'head' ? 1 : kinds[grp.materialIndex] === 'opacity' ? 2 : 0;
      for (let i = grp.start; i < grp.start + grp.count; i++) triKind[index[i]] = k;
    }
    const uv = g.attributes.uv;
    const bake = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const k = triKind[i];
      if (k === 2) {
        bake[i * 2] = -2; // hors de la texture : jamais tatoué
        bake[i * 2 + 1] = -2;
      } else {
        bake[i * 2] = uv.getX(i) * 0.5 + (k === 1 ? 0.5 : 0);
        bake[i * 2 + 1] = uv.getY(i);
      }
    }
    g.setAttribute('bakeUv', new THREE.BufferAttribute(bake, 2));
    g.setAttribute('features', new THREE.Uint8BufferAttribute(new Uint8Array(n * 4), 4, true));
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position.array;
    this.canon = new Float32Array(n * 3);
    this.canonNormal = new Float32Array(n * 3);
    g.setAttribute('canon', new THREE.BufferAttribute(this.canon, 3));
    g.setAttribute('canonNormal', new THREE.BufferAttribute(this.canonNormal, 3));
    this.region = new Float32Array(n);
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      this.region[i] = triKind[i] === 2 ? 0 : regionOfBone(this.bones[best].name);
    }
    g.setAttribute('region', new THREE.BufferAttribute(this.region, 1));
    this.geometry = g;
    this.nRender = n;
    this.renderPos = pos;

    // ---- pose de repos (rotations des os d'origine), hauteur, sol
    this.restLocal = this.bones.map((b) => b.quaternion.clone());
    this.group.updateMatrixWorld(true);
    this.restWorld = this.bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
    this.restHead = this.bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    // Espace canonique = pose de repos dans le repère de la scène (y vers le haut,
    // face vers +z), en décimètres, comme le corps sur mesure. Le fichier FBX peut
    // être en z vers le haut : on passe donc par les positions « monde » au repos.
    const v = new THREE.Vector3();
    const nv = new THREE.Vector3();
    const nrm = g.attributes.normal.array;
    const normalMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      v.fromArray(pos, i * 3);
      mesh.applyBoneTransform(i, v);
      v.applyMatrix4(mesh.matrixWorld).multiplyScalar(10);
      v.toArray(this.canon, i * 3);
      if (triKind[i] !== 2) {
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      nv.fromArray(nrm, i * 3).applyMatrix3(normalMat).normalize();
      nv.toArray(this.canonNormal, i * 3);
    }
    this.heightDm = maxY - minY;
    this.neutralHeightCm = this.heightDm * 10;
    this.groundOffset = -minY / 10; // pieds au sol (mètres)
    this.group.position.y = this.groundOffset;
    this.group.updateMatrixWorld(true);
    this.restWorld = this.bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
    this.restHead = this.bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    this.canonHead = this.restHead.map((p) => p.clone().sub(this.group.position).multiplyScalar(10));
    this.skinnedMeshes = [mesh];

    // ---- maillage de sélection (positions posées calculées sur le processeur)
    this.pickGeometry = new THREE.BufferGeometry();
    this.pickGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.pickGeometry.setIndex(g.index);
    this.pickMesh = new THREE.Mesh(this.pickGeometry, new THREE.MeshBasicMaterial({ visible: false }));
    this.pickMesh.raycast = acceleratedRaycast;
    mesh.parent.add(this.pickMesh);
    this.pickMesh.position.copy(mesh.position);
    this.pickMesh.quaternion.copy(mesh.quaternion);
    this.pickMesh.scale.copy(mesh.scale);
    this._pickDirty = true;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(kind) {
    for (const fn of this.listeners) fn(kind);
  }

  get heightCm() {
    return this.heightDm * 10;
  }

  // la morphologie d'un personnage existant est fixe
  setShape() {}
  setSkin() {}
  setEyeColor() {}
  setUnderwearColor() {}

  _bone(logical) {
    const name = RIG[logical];
    return name === undefined ? undefined : this.boneIndex[name];
  }

  /** Position de repos (monde) de la tête d'un os, par son nom logique. */
  boneHead(logical, target = new THREE.Vector3()) {
    const i = this._bone(logical);
    return i === undefined ? target.set(0, 0, 0) : target.copy(this.restHead[i]);
  }

  boneTail(logical, target = new THREE.Vector3()) {
    return this.boneHead(logical, target);
  }

  /**
   * Applique une pose. Pose.js calcule, pour chaque os, une rotation exprimée
   * dans le repère monde de la pose de repos ; ici les os ont déjà une rotation
   * au repos, d'où la conversion : locale = repos(parent)⁻¹ · delta · repos(os).
   */
  setPose(pose) {
    this.pose = pose;
    this.bones.forEach((b, i) => b.quaternion.copy(this.restLocal[i]));
    const qs = computePoseQuaternions(this, pose);
    // torsion du bras : pas d'os intermédiaire ici, on la combine à l'épaule
    for (const side of ['L', 'R']) {
      const t = qs['upperarm02.' + side];
      if (t && qs['upperarm01.' + side]) qs['upperarm01.' + side] = qs['upperarm01.' + side].clone().multiply(t);
      delete qs['upperarm02.' + side];
    }
    const deltas = new Map();
    for (const [logical, q] of Object.entries(qs)) {
      const i = this._bone(logical);
      if (i !== undefined) deltas.set(i, q);
    }
    // la rotation d'un os parent s'applique à ses enfants : on accumule les deltas
    // (exprimés dans le repère monde du repos), puis
    // locale = monde(parent)⁻¹ · delta cumulé · monde de repos(os)
    this.group.updateMatrixWorld(true);
    const parentWorld = new THREE.Quaternion();
    const visit = (o, acc) => {
      const i = o.isBone ? this.boneIndex[o.name] : undefined;
      let next = acc;
      if (i !== undefined) {
        const d = deltas.get(i);
        if (d) next = acc.clone().multiply(d);
        if (next !== IDENTITY) {
          o.parent.getWorldQuaternion(parentWorld);
          o.quaternion.copy(parentWorld.invert().multiply(next.clone().multiply(this.restWorld[i])));
          o.updateMatrixWorld(true);
        }
      }
      for (const c of o.children) visit(c, next);
    };
    visit(this.root, IDENTITY);
    this.group.updateMatrixWorld(true);
    this._pickDirty = true;
    this._emit('pose');
  }

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
      // « indirect » : l'index partagé avec le rendu n'est pas réordonné (les groupes de matériaux en dépendent)
      this.pickGeometry.computeBoundsTree({ indirect: true });
      this._pickDirty = false;
    }
    return this.pickMesh;
  }

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

  dominantBone(renderVertex) {
    const si = this.geometry.attributes.skinIndex;
    return this.bones[si.getComponent(renderVertex, 0)].name;
  }

  /** Position canonique (dm) de la tête d'un os, par son nom logique. */
  _canonBone(logical) {
    return this.canonHead[this._bone(logical)].clone();
  }

  canonicalRegionAxis(region) {
    const pairs = {
      0: ['spine05', 'neck01'],
      1: ['upperarm01.L', 'lowerarm01.L'], 2: ['lowerarm01.L', 'wrist.L'],
      3: ['upperarm01.R', 'lowerarm01.R'], 4: ['lowerarm01.R', 'wrist.R'],
      5: ['upperleg01.L', 'lowerleg01.L'], 6: ['lowerleg01.L', 'foot.L'],
      7: ['upperleg01.R', 'lowerleg01.R'], 8: ['lowerleg01.R', 'foot.R'],
    };
    const [a, b] = pairs[region] || pairs[0];
    const o = this._canonBone(a);
    const t = this._canonBone(b);
    return { origin: o, dir: t.sub(o).normalize() };
  }

  dispose() {
    this.group.removeFromParent();
  }
}

// GROGNON
