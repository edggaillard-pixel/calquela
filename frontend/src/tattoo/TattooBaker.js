import * as THREE from 'three';

/**
 * « Cuisson » des tatouages dans l'espace UV du corps.
 *
 * Chaque triangle du corps est dessiné à sa place dans la texture (position
 * = coordonnées UV). Pour chaque pixel, on connaît le point correspondant du
 * corps neutre (attribut `canon`) : on le projette dans le repère du tatouage
 * (projection plane ou cylindrique) pour lire la bonne couleur.
 * Résultat : une texture que la peau affiche, qui suit donc la morphologie
 * et la pose sans aucun calcul supplémentaire.
 */

const bakeVertex = /* glsl */ `
in vec3 canon;
in vec3 canonNormal;
in float region;
out vec3 vP;
out vec3 vN;
flat out int vRegion;
void main() {
  vP = canon;
  vN = canonNormal;
  vRegion = int(region + 0.5);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const bakeFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uMap;
uniform int uMode;          // 0 plan, 1 enroulé
uniform vec3 uCenter;
uniform vec3 uT;
uniform vec3 uB;
uniform vec3 uN;
uniform vec2 uSize;
uniform float uDepth;
uniform vec3 uAxisO;
uniform vec3 uAxisD;
uniform vec3 uAxisE1;
uniform float uRadius;
uniform float uA0;
uniform float uRot;
uniform float uMirror;
uniform int uRegionMask;
uniform float uOpacity;
uniform int uOutline;       // 0 motif, 1 contour de sélection
in vec3 vP;
in vec3 vN;
flat in int vRegion;
out vec4 outColor;

void main() {
  vec2 uv;
  float weight = 1.0;
  if (uMode == 0) {
    vec3 d = vP - uCenter;
    float depth = dot(d, uN);
    if (abs(depth) > uDepth) discard;
    float facing = dot(normalize(vN), uN);
    weight = smoothstep(-0.05, 0.25, facing);
    uv = vec2(dot(d, uT) / uSize.x, dot(d, uB) / uSize.y) + 0.5;
  } else {
    if (((uRegionMask >> vRegion) & 1) == 0) discard;
    vec3 d = vP - uAxisO;
    float along = dot(d, uAxisD);
    vec3 radial = d - along * uAxisD;
    float rl = length(radial);
    if (rl < uRadius * 0.3 || rl > uRadius * 2.2) discard;
    vec3 e2 = cross(uAxisD, uAxisE1);
    float ang = atan(dot(radial, e2), dot(radial, uAxisE1));
    float s = ang * uRadius;
    float a = along - uA0;
    float c = cos(uRot);
    float sn = sin(uRot);
    vec2 q = vec2(c * s + sn * a, -sn * s + c * a);
    uv = vec2(q.x * uMirror / uSize.x, q.y / uSize.y) + 0.5;
  }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  if (uOutline == 1) {
    // contour pointillé violet, comme un tracé de stencil
    vec2 px = fwidth(uv);
    vec2 edge = min(uv, 1.0 - uv) / max(px, vec2(1e-5));
    float line = 1.0 - smoothstep(4.0, 6.0, min(edge.x, edge.y));
    float along = (edge.x < edge.y) ? uv.y / max(px.y, 1e-5) : uv.x / max(px.x, 1e-5);
    float dash = step(0.4, fract(along / 22.0));
    float a = line * dash * weight;
    outColor = vec4(vec3(a), a);
    return;
  }
  vec4 c = texture(uMap, uv); // texture chargée avec flipY : v = 1 en haut de l'image
  float a = uOpacity * weight;
  outColor = c * a; // texture déjà prémultipliée
}`;

const dilateFragment = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 c = texture(uSrc, vUv);
  if (c.a > 0.004) { outColor = c; return; }
  vec4 best = vec4(0.0);
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec4 s = texture(uSrc, vUv + vec2(float(x), float(y)) * uTexel);
      if (s.a > best.a) best = s;
    }
  }
  outColor = best;
}`;

const quadVertex = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export class TattooBaker {
  constructor(renderer) {
    this.renderer = renderer;
    const max = renderer.capabilities.maxTextureSize;
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    this.size = max >= 4096 && !mobile ? 4096 : 2048;

    const rtOpts = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtBake = new THREE.WebGLRenderTarget(this.size, this.size, { ...rtOpts, generateMipmaps: false, minFilter: THREE.LinearFilter });
    this.rtFinal = new THREE.WebGLRenderTarget(this.size, this.size, rtOpts);
    this.rtOverlay = new THREE.WebGLRenderTarget(2048, 2048, { ...rtOpts, generateMipmaps: false, minFilter: THREE.LinearFilter });
    this.rtFinal.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    for (const rt of [this.rtBake, this.rtFinal, this.rtOverlay]) rt.texture.colorSpace = THREE.NoColorSpace;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: bakeVertex,
      fragmentShader: bakeFragment,
      uniforms: {
        uMap: { value: null },
        uMode: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uT: { value: new THREE.Vector3() },
        uB: { value: new THREE.Vector3() },
        uN: { value: new THREE.Vector3() },
        uSize: { value: new THREE.Vector2(1, 1) },
        uDepth: { value: 1 },
        uAxisO: { value: new THREE.Vector3() },
        uAxisD: { value: new THREE.Vector3(0, 1, 0) },
        uAxisE1: { value: new THREE.Vector3(0, 0, 1) },
        uRadius: { value: 1 },
        uA0: { value: 0 },
        uRot: { value: 0 },
        uMirror: { value: 1 },
        uRegionMask: { value: 1 },
        uOpacity: { value: 1 },
        uOutline: { value: 0 },
      },
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.scene = new THREE.Scene();
    this.mesh = null;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.dilate = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVertex,
      fragmentShader: dilateFragment,
      uniforms: { uSrc: { value: null }, uTexel: { value: new THREE.Vector2(1 / this.size, 1 / this.size) } },
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.dilate);
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    this.clear(this.rtFinal);
    this.clear(this.rtOverlay);
  }

  get texture() {
    return this.rtFinal.texture;
  }

  get overlayTexture() {
    return this.rtOverlay.texture;
  }

  setGeometry(geometry) {
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  clear(rt) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prev);
    r.setClearColor(prevColor, prevAlpha);
  }

  _setUniforms(frame, outline) {
    const u = this.material.uniforms;
    u.uMode.value = frame.mode === 'wrap' ? 1 : 0;
    u.uCenter.value.copy(frame.center);
    u.uT.value.copy(frame.T);
    u.uB.value.copy(frame.B);
    u.uN.value.copy(frame.N);
    u.uSize.value.set(frame.width, frame.height);
    u.uDepth.value = frame.depth;
    if (frame.mode === 'wrap') {
      u.uAxisO.value.copy(frame.axisO);
      u.uAxisD.value.copy(frame.axisD);
      u.uAxisE1.value.copy(frame.axisE1);
      u.uRadius.value = frame.radius;
      u.uA0.value = frame.a0;
      u.uRot.value = frame.rotation;
      u.uMirror.value = frame.mirror ? -1 : 1;
      u.uRegionMask.value = frame.regionMask;
    }
    u.uOpacity.value = frame.opacity;
    u.uOutline.value = outline ? 1 : 0;
  }

  /** Recalcule la texture des tatouages. `frames` : liste ordonnée (du dessous au dessus). */
  bake(frames) {
    if (!this.mesh) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    this.clear(this.rtBake);
    r.setRenderTarget(this.rtBake);
    for (const f of frames) {
      if (!f.texture) continue;
      this.material.uniforms.uMap.value = f.texture;
      this._setUniforms(f, false);
      r.render(this.scene, this.camera);
    }
    // dilatation : comble les coutures entre îlots UV
    this.dilate.uniforms.uSrc.value = this.rtBake.texture;
    r.setRenderTarget(this.rtFinal);
    r.render(this.quadScene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
  }

  /** Contour du tatouage sélectionné (calque séparé, jamais exporté dans le projet). */
  bakeOutline(frame) {
    this.clear(this.rtOverlay);
    if (!frame || !this.mesh) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.rtOverlay);
    this._setUniforms(frame, true);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
  }
}

// GROGNON
