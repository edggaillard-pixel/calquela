import * as THREE from 'three';
import { Avatar } from '../avatar/Avatar.js';

/**
 * Cheveux procéduraux : des mèches (rubans fins) poussent depuis le cuir
 * chevelu de l'avatar, suivent la forme de la tête et tombent sous l'effet de
 * la gravité en évitant la tête, le cou et les épaules.
 * Tout est calculé en décimètres, dans le repère de repos de l'avatar.
 */

export const HAIR_STYLES = [
  { id: 'chauve', label: 'Chauve' },
  { id: 'rase', label: 'Rasé' },
  { id: 'court', label: 'Court' },
  { id: 'carre', label: 'Carré' },
  { id: 'long', label: 'Longs' },
  { id: 'queue', label: 'Queue de cheval' },
  { id: 'chignon', label: 'Chignon' },
  { id: 'boucles', label: 'Bouclés' },
];

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

// ---------------------------------------------------------------- utilitaires
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Ellipsoid {
  constructor(center, radii) {
    this.c = center;
    this.r = radii;
  }

  /** Repousse p hors de l'ellipsoïde gonflé de `extra`. */
  push(p, extra = 0) {
    const rx = this.r.x + extra;
    const ry = this.r.y + extra;
    const rz = this.r.z + extra;
    const qx = (p.x - this.c.x) / rx;
    const qy = (p.y - this.c.y) / ry;
    const qz = (p.z - this.c.z) / rz;
    const l = Math.hypot(qx, qy, qz);
    if (l < 1 && l > 1e-6) {
      p.set(this.c.x + (qx / l) * rx, this.c.y + (qy / l) * ry, this.c.z + (qz / l) * rz);
      return true;
    }
    return false;
  }

  /** Place p exactement sur la surface gonflée de `extra` (cheveux plaqués). */
  project(p, extra = 0) {
    const rx = this.r.x + extra;
    const ry = this.r.y + extra;
    const rz = this.r.z + extra;
    const qx = (p.x - this.c.x) / rx;
    const qy = (p.y - this.c.y) / ry;
    const qz = (p.z - this.c.z) / rz;
    const l = Math.hypot(qx, qy, qz) || 1;
    p.set(this.c.x + (qx / l) * rx, this.c.y + (qy / l) * ry, this.c.z + (qz / l) * rz);
  }
}

class Capsule {
  constructor(a, b, radius) {
    this.a = a;
    this.b = b;
    this.radius = radius;
    this.ab = b.clone().sub(a);
    this.len2 = this.ab.lengthSq();
  }

  push(p, extra = 0) {
    const t = Math.max(0, Math.min(1, p.clone().sub(this.a).dot(this.ab) / this.len2));
    const q = this.a.clone().addScaledVector(this.ab, t);
    const d = p.clone().sub(q);
    const l = d.length();
    const r = this.radius + extra;
    if (l < r && l > 1e-6) {
      p.copy(q).addScaledVector(d, r / l);
      return true;
    }
    return false;
  }
}

function fitEllipsoid(points, shrink = 1) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of points) {
    min.min(p);
    max.max(p);
  }
  const c = min.clone().add(max).multiplyScalar(0.5);
  const r = max.clone().sub(min).multiplyScalar(0.5 * shrink);
  return new Ellipsoid(c, r);
}

// ---------------------------------------------------------------- générateur
export class Hair {
  constructor(avatar) {
    this.avatar = avatar;
    this.style = 'court';
    this.color = new THREE.Color('#3a2518');
    this.fringe = false;
    this.length = 1; // multiplicateur de longueur
    this.density = /Android|iPhone|iPad/i.test(navigator.userAgent) ? 0.6 : 1; // nombre de mèches

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.62,
      envMapIntensity: 0.35,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.capMaterial = Avatar.offsetMaterial({ color: 0xffffff, roughness: 0.9 }, 0.03);
    this.cap = avatar.createSubsetMesh(avatar.data.scalp, this.capMaterial, 'calotte');
    this.cap.bind(avatar.skeleton, avatar.body.bindMatrix);
    avatar.group.add(this.cap);
    avatar.skinnedMeshes.push(this.cap);

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'cheveux';
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.holder = new THREE.Group();
    this.holder.add(this.mesh);
    avatar.bones[avatar.boneIndex.head].add(this.holder);
    this._applyColor();
  }

  setStyle({ style, color, fringe, length } = {}) {
    if (style !== undefined) this.style = style;
    if (color !== undefined) this.color.set(color);
    if (fringe !== undefined) this.fringe = fringe;
    if (length !== undefined) this.length = length;
    this._applyColor();
    // la couleur seule ne demande pas de recalculer les mèches
    if (style !== undefined || fringe !== undefined || length !== undefined) this.rebuild();
  }

  _applyColor() {
    const u = this.avatar.skinMaterial.userData.uniforms;
    u.uHair.value.copy(this.color);
    u.uBrow.value.copy(this.color).multiplyScalar(0.8);
    this.capMaterial.color.copy(this.color).multiplyScalar(0.75);
    this.material.color.copy(this.color);
    // cuir chevelu teinté : « rasé » le montre, les autres coupes l'utilisent comme racines
    u.uScalp.value = this.style === 'chauve' ? 0 : this.style === 'rase' ? 0.8 : 0.95;
    this.cap.visible = !['chauve', 'rase'].includes(this.style);
  }

  /** Formes de collision calculées sur la forme actuelle du corps. */
  _colliders() {
    const av = this.avatar;
    const pos = av.renderPos;
    const names = av.data.bones.map((b) => b.name);
    const headPts = [];
    const torsoPts = [];
    const neckY = av.boneHead('neck01').y;
    const chestY = av.boneHead('spine02').y;
    for (let r = 0; r < av.nRender; r++) {
      const bone = names[av.data.skinIndex[r * 4]];
      const p = new THREE.Vector3().fromArray(pos, r * 3);
      if (bone === 'head' || bone === 'jaw') headPts.push(p);
      else if (av.region[r] === 0 && p.y > chestY && p.y < neckY && !bone.startsWith('neck')) torsoPts.push(p);
    }
    const head = fitEllipsoid(headPts, 0.93);
    const torso = fitEllipsoid(torsoPts, 0.92);
    const neck = new Capsule(av.boneHead('neck01'), av.boneHead('head'), 0.52);
    const shoulders = ['L', 'R'].map((s) => new Capsule(av.boneHead('clavicle.' + s), av.boneTail('shoulder01.' + s), 0.5));
    return { head, torso, neck, shoulders, all: [torso, neck, ...shoulders] };
  }

  /** Racines réparties uniformément (par aire) sur le cuir chevelu. */
  _roots(count, rand) {
    const av = this.avatar;
    const idx = av.data.scalp;
    const pos = av.renderPos;
    const nrm = av.renderNormal;
    const areas = [];
    let total = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < idx.length; i += 3) {
      a.fromArray(pos, idx[i] * 3);
      b.fromArray(pos, idx[i + 1] * 3);
      c.fromArray(pos, idx[i + 2] * 3);
      total += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      areas.push(total);
    }
    const roots = [];
    for (let k = 0; k < count; k++) {
      const x = rand() * total;
      let lo = 0;
      let hi = areas.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (areas[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      let u = rand();
      let v = rand();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;
      const i0 = idx[lo * 3] * 3;
      const i1 = idx[lo * 3 + 1] * 3;
      const i2 = idx[lo * 3 + 2] * 3;
      const p = new THREE.Vector3(
        pos[i0] * w + pos[i1] * u + pos[i2] * v,
        pos[i0 + 1] * w + pos[i1 + 1] * u + pos[i2 + 1] * v,
        pos[i0 + 2] * w + pos[i1 + 2] * u + pos[i2 + 2] * v,
      );
      const n = new THREE.Vector3(
        nrm[i0] * w + nrm[i1] * u + nrm[i2] * v,
        nrm[i0 + 1] * w + nrm[i1 + 1] * u + nrm[i2 + 1] * v,
        nrm[i0 + 2] * w + nrm[i1 + 2] * u + nrm[i2 + 2] * v,
      ).normalize();
      roots.push({ p, n });
    }
    return roots;
  }

  rebuild() {
    const geo = this.mesh.geometry;
    if (['chauve', 'rase'].includes(this.style)) {
      this.mesh.geometry = new THREE.BufferGeometry();
      geo.dispose();
      return;
    }
    const av = this.avatar;
    const rand = mulberry32(1234);
    const col = this._colliders();
    const H = col.head;
    const headJoint = av.boneHead('head');
    this.holder.position.copy(headJoint).negate();

    const style = this.style;
    const L = this.length;
    const browY = av.boneHead('eye.L').y + 0.22;
    const chinY = av.boneHead('jaw').y - 0.62;
    const strands = [];
    // zone du visage que les mèches ne doivent pas couvrir
    const eyeY = av.boneHead('eye.L').y;
    const face = new Ellipsoid(
      new THREE.Vector3(H.c.x, eyeY - 0.62, H.c.z + H.r.z * 0.5),
      new THREE.Vector3(H.r.x * 0.66, 0.95, H.r.z * 0.8),
    );

    const settings = {
      court: { count: 9000, len: 0.32, segs: 6, grav: 0, width: 0.07, offset: 0.05, curl: 0, hug: true },
      carre: { count: 10000, len: 2.7, segs: 16, grav: 0.55, width: 0.065, offset: 0.07, curl: 0, cutY: chinY },
      long: { count: 10000, len: 4.6, segs: 22, grav: 0.6, width: 0.065, offset: 0.07, curl: 0 },
      queue: { count: 9000, len: 3.0, segs: 18, grav: 0.6, width: 0.06, offset: 0.035, curl: 0 },
      chignon: { count: 9000, len: 1.6, segs: 10, grav: 0, width: 0.06, offset: 0.035, curl: 0 },
      boucles: { count: 9000, len: 1.1, segs: 14, grav: 0.1, width: 0.07, offset: 0.16, curl: 0.09, hug: true },
    }[style];
    if (!settings) return;
    const roots = this._roots(Math.round(settings.count * this.density), rand);

    // point d'attache (queue de cheval, chignon)
    const tie = new THREE.Vector3(H.c.x, H.c.y + H.r.y * (style === 'chignon' ? 0.55 : 0.05), H.c.z - H.r.z * 1.0);
    const tieOut = new THREE.Vector3(0, style === 'chignon' ? 0.4 : -0.15, -1).normalize();

    for (const { p: root, n } of roots) {
      const pts = [];
      const vol = settings.offset * (0.6 + 0.8 * rand());
      const front = (root.z - H.c.z) / H.r.z; // 1 = devant, -1 = arrière
      let p = root.clone().addScaledVector(n, 0.005);
      pts.push(p.clone());

      // direction d'écoulement le long du crâne
      const dx = root.x - H.c.x;
      const side = Math.sign(dx || (rand() - 0.5));
      const topness = Math.max(0, n.y);
      let bangs = false;
      const want = new THREE.Vector3();
      if (style === 'court' || style === 'boucles') {
        // vers le bas sur les côtés et l'arrière, vers l'avant sur le dessus
        want.set(dx * 0.4, -1 + topness, -0.35 * topness);
      } else if (this.fringe && front > 0.45 && Math.abs(dx) < H.r.x * 0.7 && style !== 'queue' && style !== 'chignon') {
        bangs = true;
        want.set(dx * 0.3, -0.6, 1);
      } else {
        // raie au milieu : les mèches descendent sur les côtés et vers l'arrière
        const s = 0.9 * Math.min(1, Math.abs(dx) / 0.18);
        want.set(side * (0.15 + 0.5 * s), -1, -0.45);
      }
      const flow = want.addScaledVector(n, -want.dot(n)).normalize();
      let dir = flow.clone().addScaledVector(n, 0.08).normalize();

      const total = (style === 'queue' || style === 'chignon' ? settings.len : settings.len * L) * (0.85 + 0.3 * rand());
      const segs = settings.segs;
      const step = total / segs;
      let tied = false;
      const strandRand = rand();
      for (let i = 1; i <= segs; i++) {
        if ((style === 'queue' || style === 'chignon') && !tied) {
          // vers le point d'attache, en restant plaqué au crâne
          const toTie = tie.clone().sub(p);
          if (toTie.length() < 0.12) {
            tied = true;
            if (style === 'chignon') break;
            p = tie.clone().add(new THREE.Vector3((rand() - 0.5) * 0.12, (rand() - 0.5) * 0.12, 0));
            dir = tieOut.clone();
            pts.push(p.clone());
            continue;
          }
          dir.lerp(toTie.normalize(), 0.45).normalize();
          const np = p.clone().addScaledVector(dir, Math.min(step * 1.6, 0.25));
          H.project(np, vol);
          dir = np.clone().sub(p).normalize();
          p = np;
          pts.push(p.clone());
          if (i === segs && !tied) {
            // trop loin : on prolonge jusqu'au point d'attache
            pts.push(tie.clone());
          }
          continue;
        }
        if (bangs && p.y < browY) break;
        if (settings.cutY !== undefined && p.y < settings.cutY + (rand() - 0.5) * 0.08) break;
        const g = settings.grav * (tied ? 1.2 : Math.min(1, i / (segs * 0.25)));
        dir.y -= g * step * 2.2;
        dir.normalize();
        const np = p.clone().addScaledVector(dir, step);
        if (settings.hug) H.project(np, vol * Math.min(1, i / 2));
        else if (!tied) H.push(np, vol);
        if (!bangs) face.push(np, 0);
        for (const c of col.all) c.push(np, 0.04 + vol * 0.3);
        dir = np.clone().sub(p).normalize();
        p = np;
        pts.push(p.clone());
      }
      if (pts.length >= 2) strands.push({ pts, n, seed: strandRand, width: settings.width, curl: settings.curl });
    }

    if (style === 'chignon') {
      // chignon : mèches enroulées sur une sphère
      const bunR = 0.42;
      const center = tie.clone().addScaledVector(tieOut, bunR * 0.75);
      for (let k = 0; k < Math.round(2200 * this.density); k++) {
        const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
        const start = new THREE.Vector3().randomDirection().cross(axis).normalize();
        const r = bunR * (0.7 + 0.3 * rand());
        const pts = [];
        const arc = Math.PI * (1 + rand());
        for (let i = 0; i <= 12; i++) {
          const v = start.clone().applyAxisAngle(axis, (arc * i) / 12).multiplyScalar(r);
          pts.push(center.clone().add(v));
        }
        strands.push({ pts, n: start, seed: rand(), width: 0.05, curl: 0 });
      }
    }

    this.mesh.geometry = this._buildRibbons(strands, H.c);
    geo.dispose();
  }

  /** Construit les rubans : 2 sommets par point de mèche. */
  _buildRibbons(strands, headCenter) {
    let nPts = 0;
    for (const s of strands) nPts += s.pts.length;
    const pos = new Float32Array(nPts * 2 * 3);
    const nor = new Float32Array(nPts * 2 * 3);
    const colr = new Float32Array(nPts * 2 * 3);
    const uv = new Float32Array(nPts * 2 * 2);
    const index = [];
    let v = 0;
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    const out = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (const s of strands) {
      const pts = s.pts;
      const m = pts.length;
      // boucles : hélice autour de la ligne centrale
      if (s.curl > 0) {
        const phase = s.seed * Math.PI * 2;
        for (let i = 1; i < m; i++) {
          tan.subVectors(pts[Math.min(m - 1, i + 1)], pts[i - 1]).normalize();
          side.crossVectors(tan, s.n).normalize();
          out.crossVectors(side, tan);
          const a = phase + i * 1.9;
          const amp = s.curl * Math.min(1, i / 3);
          pts[i].addScaledVector(side, Math.cos(a) * amp).addScaledVector(out, Math.sin(a) * amp);
        }
      }
      const shade = 0.78 + 0.34 * s.seed;
      const base = v;
      for (let i = 0; i < m; i++) {
        const t = i / (m - 1);
        tan.subVectors(pts[Math.min(m - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
        out.subVectors(pts[i], headCenter).normalize().lerp(s.n, 0.5).normalize();
        side.crossVectors(tan, out).normalize();
        const w = s.width * (1 - 0.75 * t * t);
        const bright = shade * (0.72 + 0.28 * Math.min(1, t * 4)) * (1 + 0.1 * t);
        for (let k = 0; k < 2; k++) {
          tmp.copy(pts[i]).addScaledVector(side, (k ? 0.5 : -0.5) * w);
          pos.set([tmp.x, tmp.y, tmp.z], v * 3);
          nor.set([out.x, out.y, out.z], v * 3);
          colr.set([bright, bright, bright], v * 3);
          uv.set([k, t], v * 2);
          v++;
        }
        if (i < m - 1) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// GROGNON
