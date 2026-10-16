/**
 * Shared shading plumbing:
 *  - `patch(material, key, fn)`: chain onBeforeCompile patches on built-in materials.
 *  - the baked SUN-VISIBILITY map: the mountain's own shadow (ridges at a low golden-hour sun)
 *    and the long soft shadows of distant trees, baked once from the heightfield. Inside the
 *    realtime shadow frustum the realtime map takes over for trees; the baked ridge shadow
 *    applies everywhere.
 */
import * as THREE from "three";
import { SUN_DIR } from "./sky.js";

/** Shared uniforms every sun-vis material reads (updated once per frame). */
export const SUNVIS = {
  sunVisMap: { value: null },
  sunVisRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  rtShadowCenter: { value: new THREE.Vector3() },
  rtShadowRight: { value: new THREE.Vector3(1, 0, 0) },
  rtShadowUp: { value: new THREE.Vector3(0, 1, 0) },
  rtShadowExtent: { value: 80 },
  sunDirW: { value: SUN_DIR.clone() },
  uTime: { value: 0 },
};

/**
 * Add a patch to a material's onBeforeCompile chain. `key` keeps program caching correct
 * (materials with the same keys share programs).
 */
export function patch(material, key, fn) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => "";
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    fn(shader, renderer);
  };
  material.customProgramCacheKey = () => `${prevKey()}|${key}`;
  material.needsUpdate = true;
  return material;
}

/** GLSL declarations for the sun-vis lookup (fragment). */
export const SUNVIS_PARS = /* glsl */ `
uniform sampler2D sunVisMap;
uniform vec4 sunVisRect;
uniform vec3 rtShadowCenter;
uniform vec3 rtShadowRight;
uniform vec3 rtShadowUp;
uniform float rtShadowExtent;
varying vec3 vSvWorld;
float bakedSunVis(vec3 wp, float useTrees) {
  vec2 uv = (wp.xz - sunVisRect.xy) * sunVisRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  vec2 v = texture2D(sunVisMap, uv).rg;
  vec3 d = wp - rtShadowCenter;
  float m = max(abs(dot(d, rtShadowRight)), abs(dot(d, rtShadowUp)));
  float inside = 1.0 - smoothstep(rtShadowExtent * 0.72, rtShadowExtent * 0.94, m);
  float trees = mix(v.g, 1.0, max(inside, 1.0 - useTrees));
  return v.r * trees;
}
`;

/**
 * Make a built-in lit material (standard/physical/lambert) darken its sun light by the baked
 * visibility map. `trees`: also apply baked distant-tree shadows (terrain does, trees don't).
 */
export function applySunVis(material, { trees = false } = {}) {
  return patch(material, `sunvis${trees ? "T" : ""}`, (shader) => {
    shader.uniforms.sunVisMap = SUNVIS.sunVisMap;
    shader.uniforms.sunVisRect = SUNVIS.sunVisRect;
    shader.uniforms.rtShadowCenter = SUNVIS.rtShadowCenter;
    shader.uniforms.rtShadowRight = SUNVIS.rtShadowRight;
    shader.uniforms.rtShadowUp = SUNVIS.rtShadowUp;
    shader.uniforms.rtShadowExtent = SUNVIS.rtShadowExtent;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSvWorld;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        {
          vec4 svw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            svw = instanceMatrix * svw;
          #endif
          vSvWorld = (modelMatrix * svw).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SUNVIS_PARS}`)
      .replace(
        "getDirectionalLightInfo( directionalLight, directLight );",
        `getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= bakedSunVis(vSvWorld, ${trees ? "1.0" : "0.0"});`,
      );
  });
}

/**
 * Bake the visibility map over the playable heightfield: R = sun visible past the terrain
 * (soft ridge shadows), G = sun visible past distant trees. `heightAt` covers outside points.
 */
export function bakeSunVisibility(mountain, heightAt, trees) {
  const { nx, nz, cell, minX, minZ, height } = mountain;
  const step = 2; // bake every 2nd vertex, upsampled by the texture filter
  const w = Math.floor((nx - 1) / step) + 1;
  const h = Math.floor((nz - 1) / step) + 1;
  const data = new Uint8Array(w * h * 4);
  const flat = Math.hypot(SUN_DIR.x, SUN_DIR.z);
  const dx = SUN_DIR.x / flat;
  const dz = SUN_DIR.z / flat;
  const tanE = SUN_DIR.y / flat;
  // Coarse 64 m grid around the domain (biased toward the sun) for rays that leave it.
  const CS = 64;
  const cMinX = minX - 3200;
  const cMinZ = minZ - 1200;
  const cMaxX = mountain.maxX + 1200;
  const cMaxZ = mountain.maxZ + 3200;
  const cnx = Math.ceil((cMaxX - cMinX) / CS) + 1;
  const cnz = Math.ceil((cMaxZ - cMinZ) / CS) + 1;
  const coarse = new Float32Array(cnx * cnz);
  for (let j = 0; j < cnz; j++) for (let i = 0; i < cnx; i++) coarse[j * cnx + i] = heightAt(cMinX + i * CS, cMinZ + j * CS);
  const sampleCoarse = (x, z) => {
    const fi = Math.min(cnx - 1.001, Math.max(0, (x - cMinX) / CS));
    const fj = Math.min(cnz - 1.001, Math.max(0, (z - cMinZ) / CS));
    const i = fi | 0;
    const j = fj | 0;
    const u = fi - i;
    const v = fj - j;
    const k = j * cnx + i;
    const a = coarse[k] + (coarse[k + 1] - coarse[k]) * u;
    const b = coarse[k + cnx] + (coarse[k + cnx + 1] - coarse[k + cnx]) * u;
    return a + (b - a) * v;
  };
  const sample = (x, z) => {
    const fi = (x - minX) / cell;
    const fj = (z - minZ) / cell;
    if (fi < 0 || fj < 0 || fi >= nx - 1 || fj >= nz - 1) return sampleCoarse(x, z);
    const i = fi | 0;
    const j = fj | 0;
    const u = fi - i;
    const v = fj - j;
    const k = j * nx + i;
    const a = height[k] + (height[k + 1] - height[k]) * u;
    const b = height[k + nx] + (height[k + nx + 1] - height[k + nx]) * u;
    return a + (b - a) * v;
  };
  for (let j = 0; j < h; j++) {
    const z0 = minZ + j * step * cell;
    for (let i = 0; i < w; i++) {
      const x0 = minX + i * step * cell;
      const h0 = height[j * step * nx + i * step] + 1.2;
      let worst = -1;
      // March toward the sun; distance grows so near detail and far ridges are both seen.
      let t = 6;
      while (t < 2600) {
        const hy = sample(x0 + dx * t, z0 + dz * t);
        const ang = (hy - (h0 + t * tanE)) / t;
        if (ang > worst) worst = ang;
        if (worst > 0.03) break;
        t += t < 200 ? 6 : t < 800 ? 14 : 30;
      }
      const vis = 1 - smoothstep(-0.012, 0.018, worst);
      const o = (j * w + i) * 4;
      data[o] = Math.round(vis * 255);
      data[o + 1] = 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  // Distant tree shadows: each tree darkens a long streak away from the sun.
  if (trees) {
    const tree = new Float32Array(w * h).fill(1);
    const res = step * cell;
    for (let n = 0; n < trees.count; n++) {
      const tx = trees.x[n];
      const tz = trees.z[n];
      const th = trees.h[n];
      const tr = trees.r[n];
      const len = (th * 0.85) / tanE;
      for (let s = 0; s < len; s += res * 0.6) {
        // Shadow of a cone: wide near the base of the canopy, narrowing to the tip's shadow.
        const f = s / len;
        const width = tr * (1 - f * 0.85) + 0.5;
        const px = tx - dx * s;
        const pz = tz - dz * s;
        const ci = Math.round((px - minX) / res);
        const cj = Math.round((pz - minZ) / res);
        const rad = Math.ceil(width / res);
        for (let b = -rad; b <= rad; b++)
          for (let a = -rad; a <= rad; a++) {
            const ii = ci + a;
            const jj = cj + b;
            if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
            const ddx = minX + ii * res - px;
            const ddz = minZ + jj * res - pz;
            const d = Math.hypot(ddx, ddz);
            const cover = 1 - smoothstep(width * 0.5, width + res * 0.5, d);
            const k = jj * w + ii;
            tree[k] = Math.min(tree[k], 1 - 0.85 * cover);
          }
      }
    }
    for (let k = 0; k < w * h; k++) data[k * 4 + 1] = Math.round(tree[k] * 255);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  SUNVIS.sunVisMap.value = tex;
  SUNVIS.sunVisRect.value.set(minX, minZ, 1 / ((w - 1) * step * cell), 1 / ((h - 1) * step * cell));
  // Texel centres: shift by half a texel so vertex (i,j) maps exactly to texel (i,j).
  const tw = (w - 1) * step * cell;
  const th2 = (h - 1) * step * cell;
  SUNVIS.sunVisRect.value.set(minX - (step * cell) / 2, minZ - (step * cell) / 2, 1 / (tw + step * cell), 1 / (th2 + step * cell));
  return { texture: tex, width: w, height: h, data };
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
