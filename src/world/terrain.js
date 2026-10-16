/**
 * Terrain rendering: the 4 m heightfield cut into 64-cell chunks, each with 3 LODs and skirts,
 * drawn with the snow shader (world-space detail normals at two scales, corduroy on groomed
 * runs, exposed rock on steep faces, sun glitter, baked ridge/tree shadows).
 */
import * as THREE from "three";
import { patch, applySunVis, SUNVIS } from "./shading.js";
import { makeSnowTextures, makeRockTexture } from "./textures.js";

const CHUNK = 64; // cells per chunk side
const LOD_STEPS = [1, 2, 4];
const LOD_DIST = [420, 1100];

const SNOW_PARS = /* glsl */ `
uniform sampler2D snowAlbedo;
uniform sampler2D snowNormalMap;
uniform sampler2D rockMap;
uniform vec3 sunDirW;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec3 vGroom;
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 sHash3(vec3 p) { return vec3(sHash(p), sHash(p + 17.31), sHash(p + 41.7)); }
`;

/** The snow material, shared by the terrain chunks and the park features. */
export function makeSnowMaterial() {
  const tex = makeSnowTextures();
  const rock = makeRockTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0,
    map: tex.albedo, // also satisfies "every surface has a map"; sampled in world space below
    envMapIntensity: 1.0,
  });
  mat.userData.baked = "snow";
  mat.userData.triplanar = true;
  patch(mat, "snow", (shader) => {
    shader.uniforms.snowAlbedo = { value: tex.albedo };
    shader.uniforms.snowNormalMap = { value: tex.normal };
    shader.uniforms.rockMap = { value: rock };
    shader.uniforms.sunDirW = SUNVIS.sunDirW;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec3 aGroom;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec3 vGroom;`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);
        vGroom = aGroom;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SNOW_PARS}`)
      .replace(
        "#include <map_fragment>",
        `
        vec3 wn = normalize(vWNrm);
        float camDist = length(cameraPosition - vWPos);
        float groom = clamp(vGroom.x, 0.0, 1.0);
        vec2 wuv = vWPos.xz;
        vec3 sd1 = texture2D(snowAlbedo, wuv * 0.07).rgb;
        vec3 sd2 = texture2D(snowAlbedo, wuv * 0.009 + 0.37).rgb;
        vec3 snowAlb = vec3(0.92, 0.94, 0.98) * mix(sd1, vec3(1.0), 0.35) * mix(sd2, vec3(1.0), 0.15);
        snowAlb *= mix(1.0, 1.02, groom);
        // Rock on steep faces (snow can't hold past ~45°), broken up by large-scale noise.
        vec3 tw = abs(wn); tw /= (tw.x + tw.y + tw.z);
        vec3 rk = texture2D(rockMap, vWPos.zy * 0.06).rgb * tw.x + texture2D(rockMap, vWPos.xz * 0.06).rgb * tw.y + texture2D(rockMap, vWPos.xy * 0.06).rgb * tw.z;
        float slope = 1.0 - wn.y;
        float rockMask = smoothstep(0.27, 0.37, slope + (sd2.r - 0.97) * 3.0) * (1.0 - groom);
        // Snow clings to ledges: upward-facing bits of rock stay white.
        diffuseColor.rgb = mix(snowAlb, rk, rockMask);
        `,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `
        {
          float fade = 1.0 - smoothstep(60.0, 260.0, camDist);
          vec3 nA = texture2D(snowNormalMap, wuv * 0.11).xyz * 2.0 - 1.0;
          vec3 nB = texture2D(snowNormalMap, wuv * 0.023 + 0.5).xyz * 2.0 - 1.0;
          float strength = mix(0.55, 0.22, groom) * (0.35 + 0.65 * fade);
          vec2 pert = (nA.xy * 0.6 * fade + nB.xy * 0.7) * strength;
          // Corduroy: fine ridges across the groomer's direction.
          vec2 gdir = vGroom.yz;
          float gl = length(gdir);
          if (gl > 0.01 && groom > 0.02) {
            gdir /= gl;
            vec2 across = vec2(-gdir.y, gdir.x);
            float ph = dot(vWPos.xz, across) * (6.2831853 / 0.22);
            float aa = 1.0 - smoothstep(0.5, 2.2, fwidth(ph));
            pert += across * sin(ph) * 0.3 * aa * groom;
          }
          pert *= (1.0 - rockMask * 0.6);
          vec3 wnP = normalize(vec3(wn.x - pert.x, wn.y, wn.z - pert.y));
          normal = normalize((viewMatrix * vec4(wnP, 0.0)).xyz);
        }
        `,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = mix(mix(0.86, 0.6, groom), 0.9, rockMask);`,
      )
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          // Sun glitter: sparse micro-facets that catch the sun close to the camera.
          float near = 1.0 - smoothstep(4.0, 34.0, camDist);
          if (near > 0.0) {
            vec3 cellP = floor(vWPos * 26.0);
            float rnd = sHash(cellP);
            if (rnd > 0.93) {
              vec3 V = normalize(cameraPosition - vWPos);
              vec3 gnrm = normalize(wn + (sHash3(cellP) - 0.5) * 0.9);
              float g = pow(max(dot(reflect(-sunDirW, gnrm), V), 0.0), 260.0);
              float lit = smoothstep(0.03, 0.25, dot(reflectedLight.directDiffuse, vec3(0.333)));
              reflectedLight.directSpecular += vec3(1.0, 0.9, 0.75) * g * 14.0 * near * lit * (1.0 - rockMask);
            }
          }
        }`,
      );
  });
  applySunVis(mat, { trees: true });
  return mat;
}

function buildChunkGeometry(m, ci, cj, step) {
  const { nx, nz, cell, minX, minZ, height, normals, trailW, groomDirX, groomDirZ } = m;
  const i0 = ci * CHUNK;
  const j0 = cj * CHUNK;
  const i1 = Math.min(nx - 1, i0 + CHUNK);
  const j1 = Math.min(nz - 1, j0 + CHUNK);
  const cols = Math.floor((i1 - i0) / step) + 1;
  const rows = Math.floor((j1 - j0) / step) + 1;
  const ring = 2 * (cols + rows) - 4; // edge vertices (for the skirt)
  const vcount = cols * rows + ring;
  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const groom = new Float32Array(vcount * 3);
  const put = (v, k, dropY) => {
    const i = k % nx;
    const j = (k / nx) | 0;
    pos[v * 3] = minX + i * cell;
    pos[v * 3 + 1] = height[k] - dropY;
    pos[v * 3 + 2] = minZ + j * cell;
    nrm[v * 3] = normals[k * 3];
    nrm[v * 3 + 1] = normals[k * 3 + 1];
    nrm[v * 3 + 2] = normals[k * 3 + 2];
    uv[v * 2] = pos[v * 3] / 8;
    uv[v * 2 + 1] = pos[v * 3 + 2] / 8;
    groom[v * 3] = trailW[k] * (m.trails[m.trailIndex[k]]?.groomed ? 1 : 0.15);
    groom[v * 3 + 1] = groomDirX[k];
    groom[v * 3 + 2] = groomDirZ[k];
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) put(r * cols + c, (j0 + r * step) * nx + (i0 + c * step), 0);
  const idx = [];
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, e, a, e, b);
    }
  // Skirt: duplicate the border ring lowered, stitched to the border.
  const border = [];
  for (let c = 0; c < cols; c++) border.push(c);
  for (let r = 1; r < rows; r++) border.push(r * cols + cols - 1);
  for (let c = cols - 2; c >= 0; c--) border.push((rows - 1) * cols + c);
  for (let r = rows - 2; r >= 1; r--) border.push(r * cols);
  const drop = 6 * step;
  border.forEach((bv, n) => {
    const v = cols * rows + n;
    const k = Math.round((pos[bv * 3 + 2] - minZ) / cell) * nx + Math.round((pos[bv * 3] - minX) / cell);
    put(v, k, drop);
  });
  for (let n = 0; n < border.length; n++) {
    const a = border[n];
    const b = border[(n + 1) % border.length];
    const a2 = cols * rows + n;
    const b2 = cols * rows + ((n + 1) % border.length);
    idx.push(a, b, b2, a, b2, a2);
    idx.push(a, b2, b, a, a2, b2); // both windings: skirts seen from either side
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("aGroom", new THREE.BufferAttribute(groom, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export function createTerrain(scene, mountain) {
  const material = makeSnowMaterial();
  const group = new THREE.Group();
  group.userData.tag = "terrain";
  const chunksX = Math.ceil((mountain.nx - 1) / CHUNK);
  const chunksZ = Math.ceil((mountain.nz - 1) / CHUNK);
  const chunks = [];
  for (let cj = 0; cj < chunksZ; cj++)
    for (let ci = 0; ci < chunksX; ci++) {
      const lods = LOD_STEPS.map((s) => buildChunkGeometry(mountain, ci, cj, s));
      const mesh = new THREE.Mesh(lods[0], material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.tag = "terrain";
      mesh.matrixAutoUpdate = false;
      const center = lods[0].boundingSphere.center.clone();
      chunks.push({ mesh, lods, center, level: 0 });
      group.add(mesh);
    }
  scene.add(group);
  return {
    group,
    material,
    chunks,
    /** Pick each chunk's LOD from its distance to the camera. */
    update(camera) {
      for (const ch of chunks) {
        const d = ch.center.distanceTo(camera.position);
        const level = d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : 2;
        if (level !== ch.level) {
          ch.level = level;
          ch.mesh.geometry = ch.lods[level];
        }
      }
    },
    stats() {
      const levels = [0, 0, 0];
      for (const ch of chunks) levels[ch.level]++;
      return { chunks: chunks.length, levels };
    },
  };
}
