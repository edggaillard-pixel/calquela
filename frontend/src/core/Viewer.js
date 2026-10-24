import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const VIEWS = {
  face: { azimuth: 0, elevation: 0.04 },
  dos: { azimuth: Math.PI, elevation: 0.04 },
  gauche: { azimuth: Math.PI / 2, elevation: 0.04 },
  droite: { azimuth: -Math.PI / 2, elevation: 0.04 },
};

/** Moteur de rendu, caméra, lumières et boucle d'affichage. */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    this.camera.position.set(0, 1.0, 4.6);

    // Éclairage de studio : lumière principale douce + contre-jour
    const key = new THREE.DirectionalLight(0xfffaf5, 2.2);
    key.position.set(2.2, 3.6, 3.0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.2;
    key.shadow.camera.right = 1.2;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.2;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 10;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe6ff, 1.1);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(rim);
    const fill = new THREE.HemisphereLight(0xffffff, 0x9a948e, 0.45);
    this.scene.add(fill);
    this.keyLight = key;

    // Ombre portée au sol
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64), new THREE.ShadowMaterial({ opacity: 0.18 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 7;
    this.controls.zoomSpeed = 0.9;
    this.controls.rotateSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    this.tween = null;
    this.insets = { left: 0, right: 0 };
    this.beforeRender = new Set();
    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // garder tout le corps visible sur un écran étroit
    this.camera.fov = w / h < 0.75 ? 38 : 28;
    // décale l'image pour que l'avatar reste centré dans la zone non couverte par les panneaux
    const shift = w > 760 ? (this.insets.left - this.insets.right) / 2 : 0;
    if (shift) this.camera.setViewOffset(w, h, -shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Largeur (px) masquée par les panneaux à gauche et à droite. */
  setInsets(left, right) {
    this.insets = { left, right };
    this._resize();
  }

  _frame() {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
      if (t >= 1) this.tween = null;
    }
    this.controls.update();
    for (const fn of this.beforeRender) fn();
    this.renderer.render(this.scene, this.camera);
  }

  /** Déplace la caméra en douceur. */
  moveCamera(toPos, toTarget, duration = 520) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this.camera.position.copy(toPos);
      this.controls.target.copy(toTarget);
      return;
    }
    this.tween = {
      start: performance.now(),
      duration,
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: toTarget.clone(),
    };
  }

  /** Vue prédéfinie : face, dos, gauche, droite (côtés du personnage). */
  setView(name, heightM = 1.75) {
    const v = VIEWS[name];
    if (!v) return;
    const target = new THREE.Vector3(0, heightM * 0.53, 0);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const dist = (heightM * 0.62) / Math.tan(vFov / 2) / Math.min(1, this.camera.aspect * 1.2);
    const pos = new THREE.Vector3(
      Math.sin(v.azimuth) * Math.cos(v.elevation),
      Math.sin(v.elevation),
      Math.cos(v.azimuth) * Math.cos(v.elevation),
    ).multiplyScalar(dist).add(target);
    this.moveCamera(pos, target);
  }

  /** Cadre un point de la peau (ex. un tatouage) vu de face. */
  focusOn(point, normal, distance = 1.1) {
    const n = normal.clone().normalize();
    n.y *= 0.5;
    n.normalize();
    const pos = point.clone().addScaledVector(n, distance);
    this.moveCamera(pos, point.clone());
  }

  /** Rendu de l'image courante dans un canvas, à une taille donnée. */
  capture(width, height, camera = this.camera) {
    const oldSize = this.renderer.getSize(new THREE.Vector2());
    const oldRatio = this.renderer.getPixelRatio();
    const oldAspect = camera.aspect;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    const view = camera.view && camera.view.enabled ? { ...camera.view } : null;
    if (view) camera.clearViewOffset();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const fn of this.beforeRender) fn();
    this.renderer.render(this.scene, camera);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    this.renderer.setPixelRatio(oldRatio);
    this.renderer.setSize(oldSize.x, oldSize.y, false);
    camera.aspect = oldAspect;
    if (view) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height);
    camera.updateProjectionMatrix();
    return out;
  }
}

// GROGNON
