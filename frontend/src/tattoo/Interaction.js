import * as THREE from 'three';

/**
 * Manipulation directe des tatouages dans la vue 3D :
 *  - clic sur un motif : sélection ; glisser : déplacement sur la peau
 *  - molette sur le motif sélectionné : taille ; Maj + molette : rotation
 *  - deux doigts sur le motif (tactile) : taille et rotation
 *  - mode « pose » : le motif suit le pointeur, un clic le pose
 */
export class Interaction {
  constructor({ viewer, avatar, container, app }) {
    this.viewer = viewer;
    this.avatar = avatar;
    this.app = app;
    this.canvas = viewer.canvas;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.ndc = new THREE.Vector2();
    this.drag = null;
    this.placing = null;
    this.pointers = new Map();
    this.pinch = null;

    const c = this.canvas;
    // capture sur le conteneur : on décide avant la caméra (OrbitControls)
    container.addEventListener('pointerdown', (e) => e.target === c && this._down(e), { capture: true });
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('pointerleave', () => this.placing && this.app.setGhostVisible(false));
    // capture sur le conteneur : passe avant le zoom de la caméra
    container.addEventListener('wheel', (e) => this._wheel(e), { capture: true, passive: false });
  }

  /** Intersection du pointeur avec la peau → point canonique + position posée. */
  hit(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.viewer.camera);
    const mesh = this.avatar.getPickMesh();
    const hits = this.raycaster.intersectObject(mesh, false);
    if (!hits.length) return null;
    const h = hits[0];
    const idx = mesh.geometry.index.array;
    const pos = mesh.geometry.attributes.position;
    const local = mesh.worldToLocal(h.point.clone());
    const tri = new THREE.Triangle(
      new THREE.Vector3().fromBufferAttribute(pos, idx[h.faceIndex * 3]),
      new THREE.Vector3().fromBufferAttribute(pos, idx[h.faceIndex * 3 + 1]),
      new THREE.Vector3().fromBufferAttribute(pos, idx[h.faceIndex * 3 + 2]),
    );
    const b = tri.getBarycoord(local, new THREE.Vector3());
    const bary = [b.x, b.y, b.z];
    const canon = this.avatar.canonicalPoint(h.faceIndex, bary);
    return { ...canon, face: h.faceIndex, bary, point: h.point };
  }

  startPlacing(imageEntry, name) {
    this.placing = { image: imageEntry, name };
    this.canvas.classList.add('is-placing');
  }

  cancelPlacing() {
    if (!this.placing) return;
    this.placing = null;
    this.canvas.classList.remove('is-placing');
    this.app.setGhost(null);
  }

  _down(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.app.selected && this.drag) {
      // passage au geste à deux doigts
      const [a, b] = [...this.pointers.values()];
      const t = this.app.selected;
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), width: t.width, rotation: t.rotation };
      this.drag = null;
      e.stopPropagation();
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.placing) return; // le clic est traité au relâchement
    const h = this.hit(e.clientX, e.clientY);
    if (!h) return;
    const t = this.app.tattooAt(h);
    if (t) {
      this.app.select(t.id);
      // décalage écran entre le pointeur et le centre du motif
      const center = this.avatar.posedPoint(t.face, t.bary).project(this.viewer.camera);
      const r = this.canvas.getBoundingClientRect();
      const cx = ((center.x + 1) / 2) * r.width + r.left;
      const cy = ((1 - center.y) / 2) * r.height + r.top;
      this.drag = { id: t.id, dx: cx - e.clientX, dy: cy - e.clientY, moved: false };
      e.stopPropagation(); // la caméra ne tourne pas pendant le déplacement
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.classList.add('is-dragging');
    }
  }

  _move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      this.app.updateSelected({
        width: Math.max(0.1, this.pinch.width * (dist / this.pinch.dist)),
        rotation: this.pinch.rotation - ((angle - this.pinch.angle) * 180) / Math.PI,
      }, false);
      return;
    }
    if (this.placing) {
      const h = this.hit(e.clientX, e.clientY);
      this.app.setGhost(h ? { image: this.placing.image, anchor: h } : null);
      return;
    }
    if (this.drag) {
      const h = this.hit(e.clientX + this.drag.dx, e.clientY + this.drag.dy);
      if (!h) return;
      this.drag.moved = true;
      this.app.updateSelected({ center: h.p.toArray(), normal: h.n.toArray(), region: h.region, face: h.face, bary: h.bary }, false);
      return;
    }
    // survol : curseur « main » au-dessus d'un motif
    if (e.pointerType === 'mouse' && !e.buttons) {
      const h = this.hit(e.clientX, e.clientY);
      this.canvas.classList.toggle('is-over-tattoo', !!(h && this.app.tattooAt(h)));
    }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.app.commit();
      }
      return;
    }
    const wasClick = this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5;
    if (this.placing && wasClick) {
      const h = this.hit(e.clientX, e.clientY);
      if (h) {
        const { image, name } = this.placing;
        this.cancelPlacing();
        this.app.placeTattoo(image, h, name);
      }
      this.downAt = null;
      return;
    }
    if (this.drag) {
      this.canvas.classList.remove('is-dragging');
      if (this.drag.moved) this.app.commit();
      this.drag = null;
    } else if (wasClick && !this.placing) {
      // clic dans le vide ou sur la peau sans motif : désélection
      this.app.select(null);
    }
    this.downAt = null;
  }

  _wheel(e) {
    const t = this.app.selected;
    if (!t) return;
    const h = this.hit(e.clientX, e.clientY);
    if (!h || this.app.tattooAt(h)?.id !== t.id) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = Math.sign(e.deltaY);
    if (e.shiftKey || e.altKey) {
      this.app.updateSelected({ rotation: t.rotation - dir * 5 }, false);
    } else {
      this.app.updateSelected({ width: Math.max(0.1, Math.min(12, t.width * (dir > 0 ? 0.93 : 1.075))) }, false);
    }
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => this.app.commit(), 400);
  }
}

// GROGNON
