import * as THREE from 'three';

/** Texture de normales procédurale (grain de peau), répétée sur le corps. */
function makePoreNormalMap(size = 512) {
  const h = new Float32Array(size * size);
  // bruit de valeur sur plusieurs octaves, périodique
  const rnd = (x, y, p) => {
    x = ((x % p) + p) % p;
    y = ((y % p) + p) % p;
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = (x, y, p) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = rnd(xi, yi, p);
    const b = rnd(xi + 1, yi, p);
    const c = rnd(xi, yi + 1, p);
    const d = rnd(xi + 1, yi + 1, p);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 1;
      let f = 64;
      for (let o = 0; o < 3; o++) {
        v += noise((x / size) * f, (y / size) * f, f) * amp;
        amp *= 0.5;
        f *= 2;
      }
      // pores : petits creux
      const pore = noise((x / size) * 180, (y / size) * 180, 180);
      v -= Math.max(0, pore - 0.72) * 2.2;
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const t = h[((y - 1 + size) % size) * size + x];
      const b = h[((y + 1) % size) * size + x];
      const n = new THREE.Vector3((l - r) * 1.5, (t - b) * 1.5, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Matériau de la peau : teint, lèvres, sourcils, aréoles, cuir chevelu,
 * puis les tatouages (texture cuite dans l'espace UV) et le contour de sélection.
 */
export function createSkinMaterial({ tattooMap, overlayMap }) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#c99a7c'),
    roughness: 0.52,
    metalness: 0,
    sheen: 0.2,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#ffc9b8'),
    specularIntensity: 0.55,
    normalMap: makePoreNormalMap(),
    normalScale: new THREE.Vector2(0.18, 0.18),
  });

  const uniforms = {
    uTattoo: { value: tattooMap },
    uOverlay: { value: overlayMap },
    uLip: { value: new THREE.Color('#a8545a') },
    uBrow: { value: new THREE.Color('#2a1d16') },
    uHair: { value: new THREE.Color('#2a1d16') },
    uScalp: { value: 0.0 },
    uOverlayColor: { value: new THREE.Color('#6b45ff') },
    uInk: { value: 0.94 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `attribute vec4 features;
varying vec4 vFeatures;
varying vec2 vSkinUv;
void main() {
  vFeatures = features;
  vSkinUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform sampler2D uTattoo;
uniform sampler2D uOverlay;
uniform vec3 uLip;
uniform vec3 uBrow;
uniform vec3 uHair;
uniform float uScalp;
uniform vec3 uOverlayColor;
uniform float uInk;
varying vec4 vFeatures;
varying vec2 vSkinUv;
float cqHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cqNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cqHash(i), cqHash(i + vec2(1, 0)), u.x), mix(cqHash(i + vec2(0, 1)), cqHash(i + vec2(1, 1)), u.x), u.y);
}
vec3 cqSrgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 skin = diffuseColor.rgb;
  // légères variations de teint
  float n1 = cqNoise(vSkinUv * 38.0);
  float n2 = cqNoise(vSkinUv * 160.0);
  skin *= 0.95 + 0.07 * n1 + 0.03 * n2;
  skin = mix(skin, skin * vec3(1.02, 0.93, 0.92), 0.25 * smoothstep(0.55, 0.9, n1));
  // lèvres, aréoles
  skin = mix(skin, uLip * (skin / max(dot(skin, vec3(0.333)), 0.05)) * 0.55 + uLip * 0.45, vFeatures.r * 0.8);
  skin = mix(skin, skin * vec3(0.7, 0.54, 0.5), vFeatures.b * 0.75);
  // sourcils : brins orientés
  float strand = smoothstep(0.35, 0.95, cqNoise(vec2(vSkinUv.x * 2600.0, vSkinUv.y * 300.0)));
  skin = mix(skin, uBrow, vFeatures.g * (0.5 + 0.45 * strand));
  // cuir chevelu (cheveux très courts / racines)
  float stubble = 0.65 + 0.35 * cqNoise(vSkinUv * 2200.0);
  skin = mix(skin, uHair * stubble, vFeatures.a * uScalp);
  // tatouages : stockés en sRGB prémultiplié dans la texture cuite
  vec4 ink = texture2D(uTattoo, vSkinUv);
  if (ink.a > 0.002) {
    vec3 c = cqSrgbToLinear(clamp(ink.rgb / ink.a, 0.0, 1.0));
    // l'encre est sous l'épiderme : elle prend un peu la teinte de la peau
    vec3 tint = skin / max(dot(skin, vec3(0.333)), 0.05);
    c = mix(c, c * tint, 0.3) * 0.92 + skin * 0.04;
    skin = mix(skin, c, ink.a * uInk);
  }
  diffuseColor.rgb = skin;
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec4 ov = texture2D(uOverlay, vSkinUv);
  totalEmissiveRadiance += uOverlayColor * ov.a * 0.85;
  diffuseColor.rgb = mix(diffuseColor.rgb, uOverlayColor, ov.a * 0.6);
}`,
      );
  };
  return mat;
}

// GROGNON
