/**
 * The far landscape: a polar-grid mesh out to ~26 km sampling the same landscape function as
 * the playable heightfield, hidden under it inside the domain. Shaded with snow, rock and
 * forest by slope and elevation so the valley, its forests and the jagged ranges read at a
 * glance through the haze.
 */
import * as THREE from "three";
import { landscapeHeight, MAP } from "./mountain.js";
import { patch } from "./shading.js";
import { makeSnowTextures, makeRockTexture, makeCanopyTexture } from "./textures.js";

const FAR_PARS = /* glsl */ `
varying vec3 vFW;
varying vec3 vFN;
uniform sampler2D farRock;
uniform sampler2D farCanopy;
float fh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float fn2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fh(i), fh(i + vec2(1, 0)), u.x), mix(fh(i + vec2(0, 1)), fh(i + vec2(1, 1)), u.x), u.y);
}
`;

export function createFarTerrain(scene) {
  const rings = 150;
  const segs = 512;
  const r0 = 500;
  const R = 26000;
  const q = Math.pow(R / r0, 1 / (rings - 1));
  const vcount = rings * segs + 1;
  const pos = new Float32Array(vcount * 3);
  const shrink = 24;
  const inDomain = (x, z) =>
    x > MAP.minX + shrink && x < MAP.maxX - shrink && z > MAP.minZ + shrink && z < MAP.maxZ - shrink;
  // centre vertex
  pos[0] = 0;
  pos[1] = landscapeHeight(0, 0) - 60;
  pos[2] = 0;
  for (let k = 0; k < rings; k++) {
    const r = r0 * Math.pow(q, k);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const v = 1 + k * segs + s;
      let y = landscapeHeight(x, z);
      if (inDomain(x, z)) y -= 45;
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = z;
    }
  }
  const idx = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let k = 0; k < rings - 1; k++)
    for (let s = 0; s < segs; s++) {
      const a = 1 + k * segs + s;
      const b = 1 + k * segs + ((s + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, b, d, a, d, c);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Flip any downward normals (winding is consistent, but be safe).
  const n = geo.attributes.normal;
  let down = 0;
  for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) down++;
  if (down > n.count / 2) {
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  geo.computeBoundingSphere();
  const snowTex = makeSnowTextures();
  const rock = makeRockTexture();
  const canopy = makeCanopyTexture();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, map: snowTex.albedo });
  mat.userData.baked = "far-terrain";
  patch(mat, "far", (shader) => {
    shader.uniforms.farRock = { value: rock };
    shader.uniforms.farCanopy = { value: canopy };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFW;\nvarying vec3 vFN;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvFW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFN = normalize(objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FAR_PARS}`)
      .replace(
        "#include <map_fragment>",
        `
        // Surface relief the coarse mesh can't carry: gradient noise at two scales.
        vec2 q = vFW.xz;
        float e1 = 6.0;
        float hA = fn2(q / 70.0) * 0.6 + fn2(q / 23.0) * 0.4;
        float hX = fn2((q + vec2(e1, 0.0)) / 70.0) * 0.6 + fn2((q + vec2(e1, 0.0)) / 23.0) * 0.4;
        float hZ = fn2((q + vec2(0.0, e1)) / 70.0) * 0.6 + fn2((q + vec2(0.0, e1)) / 23.0) * 0.4;
        vec3 fn = normalize(normalize(vFN) + vec3(-(hX - hA), 0.0, -(hZ - hA)) * 1.1);
        float slope = 1.0 - fn.y;
        float e = vFW.y;
        float n2 = fn2(q / 900.0);
        float n1 = fn2(q / 140.0) * 0.55 + fn2(q / 41.0) * 0.3 + fn2(q / 13.0) * 0.15;
        vec3 snow = vec3(0.93, 0.95, 0.99) * (0.94 + 0.06 * hA);
        vec3 rockC = texture2D(farRock, q / 140.0).rgb * vec3(0.78, 0.8, 0.84);
        // Forest: continuous below a wavy treeline, thinning near it, never on steep faces.
        float treeline = 470.0 + 200.0 * n2 + 60.0 * fn2(q / 300.0);
        float below = 1.0 - smoothstep(treeline - 160.0, treeline + 20.0, e);
        float forest = below * (1.0 - smoothstep(0.3, 0.46, slope));
        forest *= smoothstep(0.25, 0.42, n1 + below * 0.25);
        vec3 forestC = texture2D(farCanopy, q / 70.0).rgb * vec3(1.0, 1.12, 1.0);
        float rockMask = smoothstep(0.5, 0.62, slope + (n1 - 0.5) * 0.3);
        vec3 col = mix(snow, forestC, forest);
        col = mix(col, rockC, rockMask);
        // Alpenglow: the high snowfields blush pink-gold in the low sun.
        col *= mix(vec3(1.0), vec3(1.07, 0.93, 0.95), smoothstep(700.0, 2400.0, e) * (1.0 - rockMask));
        diffuseColor.rgb = col;
        `,
      )
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
        {
          vec2 q2 = vFW.xz;
          float e2 = 6.0;
          float a0 = fn2(q2 / 70.0) * 0.6 + fn2(q2 / 23.0) * 0.4;
          float ax = fn2((q2 + vec2(e2, 0.0)) / 70.0) * 0.6 + fn2((q2 + vec2(e2, 0.0)) / 23.0) * 0.4;
          float az = fn2((q2 + vec2(0.0, e2)) / 70.0) * 0.6 + fn2((q2 + vec2(0.0, e2)) / 23.0) * 0.4;
          vec3 wn2 = normalize(normalize(vFN) + vec3(-(ax - a0), 0.0, -(az - a0)) * 1.1);
          normal = normalize((viewMatrix * vec4(wn2, 0.0)).xyz);
        }`,
      )
      .replace("#include <normal_fragment_maps>", "")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = 0.9;");
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.tag = "far-terrain";
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  scene.add(mesh);
  return { mesh };
}
