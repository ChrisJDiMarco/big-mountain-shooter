/**
 * Distant forest beyond the playable domain: tens of thousands of camera-facing billboard
 * spruces (2 triangles each) scattered where the far terrain is forested, so the valley and the
 * neighbouring slopes show tree silhouettes instead of a flat painted texture.
 */
import * as THREE from "three";
import { landscapeHeight, MAP } from "./mountain.js";
import { makeRng } from "../core/noise.js";

/** Same hash noise as the far-terrain shader (close enough in JS). */
function fh(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function fn2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = fh(ix, iy);
  const b = fh(ix + 1, iy);
  const c = fh(ix, iy + 1);
  const d = fh(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function spruceSprite() {
  const W = 128;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const rng = makeRng(404);
  g.clearRect(0, 0, W, H);
  // Trunk.
  g.fillStyle = "#3a2c22";
  g.fillRect(W / 2 - 4, H - 30, 8, 30);
  // Tiers from the bottom up: dark needles, then a snow cap along each tier's top edge.
  const tiers = 9;
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    const yBase = H - 24 - f * (H - 34);
    const half = (W / 2 - 6) * Math.pow(1 - f, 0.9) + 6;
    const hgt = (H - 34) / tiers + 14;
    g.fillStyle = t % 2 ? "#1d3424" : "#223c29";
    g.beginPath();
    g.moveTo(W / 2 - half, yBase);
    for (let k = 0; k <= 8; k++) {
      const x = W / 2 - half + (k / 8) * half * 2;
      g.lineTo(x, yBase + (k % 2 ? 6 : 0) + rng() * 4);
    }
    g.lineTo(W / 2 + half * 0.15, yBase - hgt);
    g.lineTo(W / 2 - half * 0.15, yBase - hgt);
    g.closePath();
    g.fill();
    // Snow lying on the tier.
    g.fillStyle = "rgba(236,242,250,0.95)";
    g.beginPath();
    g.moveTo(W / 2 - half * 0.85, yBase - 3);
    g.quadraticCurveTo(W / 2, yBase - hgt * 0.75, W / 2 + half * 0.85, yBase - 3);
    g.quadraticCurveTo(W / 2, yBase - hgt * 0.35, W / 2 - half * 0.85, yBase - 3);
    g.fill();
  }
  g.fillStyle = "#e8eef6";
  g.beginPath();
  g.moveTo(W / 2, 4);
  g.lineTo(W / 2 + 7, 22);
  g.lineTo(W / 2 - 7, 22);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function createFarTrees(scene) {
  const rng = makeRng(2024);
  const R = 4800;
  const spacing = 26;
  const pos = [];
  const margin = 20;
  // Height grid once (30 m), then bilinear lookups for the jittered candidates.
  const G = 30;
  const gx0 = -R;
  const gz0 = -R;
  const gnx = Math.ceil((2 * R) / G) + 2;
  const gnz = Math.ceil((2 * R + 1600) / G) + 2;
  const hg = new Float32Array(gnx * gnz);
  for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) hg[j * gnx + i] = landscapeHeight(gx0 + i * G, gz0 + j * G);
  const hAt = (x, z) => {
    const fi = Math.min(gnx - 1.001, Math.max(0, (x - gx0) / G));
    const fj = Math.min(gnz - 1.001, Math.max(0, (z - gz0) / G));
    const i = fi | 0;
    const j = fj | 0;
    const u = fi - i;
    const v = fj - j;
    const k = j * gnx + i;
    const a = hg[k] + (hg[k + 1] - hg[k]) * u;
    const b = hg[k + gnx] + (hg[k + gnx + 1] - hg[k + gnx]) * u;
    return a + (b - a) * v;
  };
  for (let z = -R; z < R + 1600; z += spacing) {
    for (let x = -R; x < R; x += spacing) {
      const jx = x + (rng() - 0.5) * spacing * 0.9;
      const jz = z + (rng() - 0.5) * spacing * 0.9;
      if (jx > MAP.minX - margin && jx < MAP.maxX + margin && jz > MAP.minZ - margin && jz < MAP.maxZ + margin) continue;
      if (Math.hypot(jx, jz * 0.8) > R) continue;
      const e = hAt(jx, jz);
      const treeline = 470 + 200 * fn2(jx / 900, jz / 900) + 60 * fn2(jx / 300, jz / 300);
      if (e > treeline + 10) continue;
      const ex = hAt(jx + 15, jz) - e;
      const ez = hAt(jx, jz + 15) - e;
      const slope = 1 - 1 / Math.sqrt(1 + (ex * ex + ez * ez) / 225);
      if (slope > 0.4) continue;
      const n1 = fn2(jx / 140, jz / 140) * 0.55 + fn2(jx / 41, jz / 41) * 0.3 + fn2(jx / 13, jz / 13) * 0.15;
      const below = 1 - Math.min(1, Math.max(0, (e - (treeline - 160)) / 180));
      if (n1 + below * 0.25 < 0.36 + rng() * 0.1) continue;
      const h = 11 + rng() * 11;
      pos.push(jx, e - 1.2, jz, h);
    }
  }
  const count = pos.length / 4;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);
  const offsets = new Float32Array(count * 4);
  offsets.set(pos);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = geo.index;
  inst.attributes.position = geo.attributes.position;
  inst.attributes.uv = geo.attributes.uv;
  inst.setAttribute("aTree", new THREE.InstancedBufferAttribute(offsets, 4));
  inst.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: spruceSprite() }, uLight: { value: new THREE.Color(1.55, 1.42, 1.32) } }]),
    vertexShader: /* glsl */ `
      attribute vec4 aTree;
      varying vec2 vUv;
      varying float vShade;
      #include <fog_pars_vertex>
      void main() {
        vec3 base = aTree.xyz;
        float h = aTree.w;
        vec3 toCam = cameraPosition - base;
        toCam.y = 0.0;
        toCam = normalize(toCam);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x);
        vec3 world = base + right * position.x * h * 0.55 + vec3(0.0, position.y * h, 0.0);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vUv = uv;
        vShade = 0.85 + 0.15 * fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 uLight;
      varying vec2 vUv;
      varying float vShade;
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.5) discard;
        // sRGB texture is decoded to linear by three; light it like a sunlit tree at a distance.
        gl_FragColor = vec4(t.rgb * uLight * vShade, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(inst, mat);
  mesh.frustumCulled = false;
  mesh.userData.tag = "tree";
  mesh.userData.far = true;
  scene.add(mesh);
  return { mesh, count };
}
