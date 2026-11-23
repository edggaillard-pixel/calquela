import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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
    this.scene.environmentIntensity = 0.45;

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    this.camera.position.set(0, 1.0, 4.6);

    // Éclairage de studio : lumière principale douce + contre-jour
    const key = new THREE.DirectionalLight(0xfff6ee, 2.7);
    key.position.set(2.7, 3.4, 2.1);
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
    const rim = new THREE.DirectionalLight(0xdfe6ff, 1.5);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(rim);
    const fill = new THREE.HemisphereLight(0xf4f1ff, 0x8a7d72, 0.35);
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
    this._setupPostprocessing();
    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  /**
   * Ombres de contact (occlusion ambiante GTAO) : creuse les orbites, les plis,
   * le dessous des muscles. Désactivé sur téléphone pour garder de la fluidité.
   */
  _setupPostprocessing() {
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    this.useComposer = !mobile && this.renderer.capabilities.isWebGL2;
    if (!this.useComposer) return;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.aoPass = new GTAOPass(this.scene, this.camera, 1, 1);
    this.aoPass.output = GTAOPass.OUTPUT.Default;
    this.aoPass.blendIntensity = 0.85;
    this.aoPass.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.5, thickness: 0.6, scale: 1.4, samples: 16, distanceFallOff: 1 });
    this.aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
    // les cheveux, cils et sourcils (textures transparentes) ne doivent pas projeter d'occlusion
    const hide = this.aoPass._overrideVisibility.bind(this.aoPass);
    this.aoPass._overrideVisibility = () => {
      hide();
      this.scene.traverse((o) => {
        if (o.userData.noAO && o.visible) {
          o.visible = false;
          this.aoPass._visibilityCache.push(o);
        }
      });
    };
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.aoPass);
    this.composer.addPass(new OutputPass());
  }

  _render(camera = this.camera) {
    if (this.useComposer) {
      this.renderPass.camera = camera;
      this.aoPass.camera = camera;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, camera);
    }
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
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
    this._render();
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
    if (this.composer) {
      this.composer.setPixelRatio(1);
      this.composer.setSize(width, height);
    }
    const view = camera.view && camera.view.enabled ? { ...camera.view } : null;
    if (view) camera.clearViewOffset();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const fn of this.beforeRender) fn();
    this._render(camera);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    this.renderer.setPixelRatio(oldRatio);
    this.renderer.setSize(oldSize.x, oldSize.y, false);
    if (this.composer) {
      this.composer.setPixelRatio(oldRatio);
      this.composer.setSize(oldSize.x, oldSize.y);
    }
    camera.aspect = oldAspect;
    if (view) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height);
    camera.updateProjectionMatrix();
    return out;
  }
}

// GROGNON
