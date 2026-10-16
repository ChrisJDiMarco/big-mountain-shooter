/**
 * The forest: tens of thousands of snow-loaded spruces. Each tree is a trunk plus stacked
 * drooping "skirts" of alpha-tested branch cards (jagged needle fringe, snow clumps on top),
 * instanced in three LODs that are refilled by cell as the camera moves. Also the collision
 * grid riders and bullets test against.
 */
import * as THREE from "three";
import { hash2, makeSimplex, fbm, smoothstep, clamp } from "../core/noise.js";
import { MAP } from "./mountain.js";
import { patch, applySunVis, SUNVIS } from "./shading.js";
import { makeConiferTexture, makeBarkTexture } from "./textures.js";

const CELL = 128; // LOD/culling cells
const GRID = 8; // collision grid
const LODS = [
  { tiers: 10, segs: 11, rings: 2, dist: 150 },
  { tiers: 6, segs: 8, rings: 1, dist: 560 },
  { tiers: 2, segs: 5, rings: 1, dist: 2300 },
];

/** A canonical spruce of height 1 and canopy radius 1 (scaled per instance). */
function spruceGeometry({ tiers, segs, rings }) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const baseY = 0.1; // lowest branches at 10% of the height
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers; // 0 bottom … 1 top
    const topY = baseY + (1 - baseY) * ((t + 1) / tiers) * 0.97;
    const radius = 1.0 * Math.pow(1 - f, 0.92) * (0.9 + 0.1 * Math.sin(t * 2.3)) + 0.06;
    const droop = radius * (0.46 + 0.12 * (1 - f));
    const twist = t * 1.7;
    const base = pos.length / 3;
    const ringCount = rings + 1;
    for (let rI = 0; rI < ringCount; rI++) {
      const v = rI / rings; // 0 at trunk, 1 at tips
      // Branches arc: droop accelerates toward the tips.
      const rr = 0.03 + (radius - 0.03) * v;
      const yy = topY - droop * Math.pow(v, 1.35);
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2 + twist;
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        pos.push(x, yy, z);
        // Volumetric normal: outward from the tree axis, tilted up.
        const out = new THREE.Vector3(Math.cos(a), 0.55 + 0.35 * (1 - v), Math.sin(a)).normalize();
        nrm.push(out.x, out.y, out.z);
        uv.push((s / segs) * 2.0, v * 0.98 + 0.01);
      }
    }
    for (let rI = 0; rI < rings; rI++)
      for (let s = 0; s < segs; s++) {
        const a = base + rI * (segs + 1) + s;
        const b = a + 1;
        const c = a + segs + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
  }
  // Spire on top.
  const spBase = pos.length / 3;
  const sy = baseY + (1 - baseY) * 0.9;
  for (let s = 0; s <= 6; s++) {
    const a = (s / 6) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.09, sy, Math.sin(a) * 0.09);
    nrm.push(Math.cos(a), 0.4, Math.sin(a));
    uv.push(s / 6, 0.6);
  }
  pos.push(0, 1.0, 0);
  nrm.push(0, 1, 0);
  uv.push(0.5, 0.0);
  const tip = pos.length / 3 - 1;
  for (let s = 0; s < 6; s++) idx.push(spBase + s, tip, spBase + s + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function trunkGeometry() {
  const g = new THREE.CylinderGeometry(0.008, 0.032, 0.9, 7, 1, true);
  g.translate(0, 0.45, 0);
  // Radius relative to unit canopy radius is scaled by the instance's x/z scale; trunks are
  // ~0.25-0.4 m for a 3-4 m canopy, good enough.
  return g;
}

function makeFoliageMaterial(tex) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.92,
    metalness: 0,
  });
  mat.userData.foliage = "spruce";
  patch(mat, "spruce", (shader) => {
    shader.uniforms.uTime = SUNVIS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aSnow;
        varying float vSnow;
        varying float vTreeV;
        varying float vTreeY;
        uniform float uTime;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vSnow = aSnow;
        vTreeV = uv.y;
        vTreeY = position.y;
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.13 + instanceMatrix[3][2] * 0.07;
          float sway = sin(uTime * 1.3 + ph) * 0.012 + sin(uTime * 2.9 + ph * 1.7) * 0.004;
          transformed.x += sway * position.y * position.y;
          transformed.z += sway * 0.6 * position.y * position.y;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vSnow;
        varying float vTreeV;
        varying float vTreeY;`,
      )
      .replace(
        "#include <map_fragment>",
        `
        vec4 tx = texture2D(map, vMapUv);
        float shadeN = tx.r;
        float snowM = tx.g;
        // Inner/lower foliage is darker (self-occlusion).
        float ao = mix(0.42, 1.0, smoothstep(0.0, 0.9, vTreeV)) * mix(0.75, 1.0, smoothstep(0.0, 0.6, vTreeY));
        #if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
          vec3 tint = vColor.rgb;
        #else
          vec3 tint = vec3(0.05, 0.1, 0.06);
        #endif
        vec3 needle = tint * mix(0.55, 1.0, shadeN) * ao;
        float top = gl_FrontFacing ? 1.0 : 0.18;
        float s = clamp(snowM * vSnow * top * 1.35, 0.0, 1.0);
        diffuseColor.rgb = mix(needle, vec3(0.9, 0.92, 0.96) * mix(0.8, 1.0, ao), s);
        diffuseColor.a = tx.a;
        `,
      )
      .replace("#include <color_fragment>", "");
  });
  applySunVis(mat, { trees: false });
  return mat;
}

/**
 * Scatter trees over the mountain. Density follows elevation (treeline), clears runs, the lift
 * line and cliffs, and clumps by noise so there are glades and thick stands.
 */
export function scatterTrees(mountain, sampler, { liftLine } = {}) {
  const noise = makeSimplex(MAP.seed + 909);
  const spacing = 6.2;
  const xs = [];
  const zs = [];
  const ys = [];
  const hs = [];
  const rs = [];
  const snow = [];
  const tint = [];
  const rot = [];
  const nrm = { x: 0, y: 1, z: 0 };
  const { minX, maxX, minZ, maxZ } = MAP;
  const ci = Math.floor((maxX - minX) / spacing);
  const cj = Math.floor((maxZ - minZ) / spacing);
  for (let j = 0; j < cj; j++) {
    for (let i = 0; i < ci; i++) {
      const r1 = hash2(i, j, 11);
      const r2 = hash2(i, j, 23);
      const x = minX + (i + 0.5 + (r1 - 0.5) * 0.95) * spacing;
      const z = minZ + (j + 0.5 + (r2 - 0.5) * 0.95) * spacing;
      if (x < minX + 12 || x > maxX - 12 || z < minZ + 12 || z > maxZ - 12) continue;
      const e = sampler.heightAt(x, z);
      const n = fbm(noise, x / 160, z / 160, 3);
      const treeline = 610 + 70 * n;
      let d = 1 - smoothstep(treeline - 110, treeline, e);
      if (d <= 0) continue;
      const td = sampler.field(mountain.trailDist, x, z);
      const clear = 2.5 + hash2(i, j, 31) * 7;
      d *= smoothstep(clear, clear + 6, td);
      if (d <= 0) continue;
      if (liftLine) {
        const ld = liftLine.distance(x, z);
        d *= smoothstep(9, 15, ld);
        if (d <= 0) continue;
      }
      sampler.normalAt(x, z, nrm);
      d *= 1 - smoothstep(0.66, 0.74, 1 - nrm.y + 0.5); // no trees on cliffs (> ~40°)
      // Base area plaza kept clear.
      if (z > 980 && Math.abs(x) < 300) d *= smoothstep(1220, 1300, z) + smoothstep(240, 300, Math.abs(x));
      // Clumps and glades.
      d *= smoothstep(-0.42, 0.18, n + 0.25 * fbm(noise, x / 45, z / 45, 2));
      if (hash2(i, j, 47) > d * 0.8) continue;
      const lowFactor = clamp((700 - e) / 600, 0, 1);
      const h = (8 + 12 * hash2(i, j, 53) + 8 * lowFactor) * (0.75 + 0.25 * d);
      xs.push(x);
      zs.push(z);
      ys.push(e - 0.3);
      hs.push(h);
      rs.push(h * (0.2 + 0.07 * hash2(i, j, 59)));
      snow.push(0.55 + 0.45 * hash2(i, j, 61));
      tint.push(hash2(i, j, 67));
      rot.push(hash2(i, j, 71) * Math.PI * 2);
    }
  }
  return {
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    h: Float32Array.from(hs),
    r: Float32Array.from(rs),
    snow: Float32Array.from(snow),
    tint: Float32Array.from(tint),
    rot: Float32Array.from(rot),
  };
}

export function createForest(scene, trees) {
  const tex = makeConiferTexture(5);
  const foliage = makeFoliageMaterial(tex);
  const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeBarkTexture(), roughness: 0.95 });
  applySunVis(bark, { trees: false });
  const N = trees.count;
  // Sort trees by LOD cell so each cell's instances are one contiguous block.
  const cellsX = Math.ceil((MAP.maxX - MAP.minX) / CELL);
  const cellsZ = Math.ceil((MAP.maxZ - MAP.minZ) / CELL);
  const cellOf = (n) =>
    Math.floor((trees.z[n] - MAP.minZ) / CELL) * cellsX + Math.floor((trees.x[n] - MAP.minX) / CELL);
  const order = Array.from({ length: N }, (_, n) => n).sort((a, b) => cellOf(a) - cellOf(b));
  const matrices = new Float32Array(N * 16);
  const colors = new Float32Array(N * 3);
  const snows = new Float32Array(N);
  const cells = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const green = [new THREE.Color(0x2b4a33), new THREE.Color(0x335238), new THREE.Color(0x24402c), new THREE.Color(0x3a5a40)];
  let current = -1;
  order.forEach((n, slot) => {
    const c = cellOf(n);
    if (c !== current) {
      cells.push({ id: c, start: slot, count: 0, min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) });
      current = c;
    }
    const cell = cells[cells.length - 1];
    cell.count++;
    p.set(trees.x[n], trees.y[n], trees.z[n]);
    q.setFromAxisAngle(up, trees.rot[n]);
    s.set(trees.r[n], trees.h[n], trees.r[n]);
    m.compose(p, q, s);
    m.toArray(matrices, slot * 16);
    const g = green[Math.floor(trees.tint[n] * 4) % 4];
    colors[slot * 3] = g.r;
    colors[slot * 3 + 1] = g.g;
    colors[slot * 3 + 2] = g.b;
    snows[slot] = trees.snow[n];
    cell.min.min(p);
    cell.max.max(p.clone().add(new THREE.Vector3(0, trees.h[n], 0)));
  });
  for (const cell of cells) {
    cell.min.x -= 6;
    cell.min.z -= 6;
    cell.max.x += 6;
    cell.max.z += 6;
    cell.box = new THREE.Box3(cell.min, cell.max);
    cell.center = cell.box.getCenter(new THREE.Vector3());
  }

  const group = new THREE.Group();
  group.userData.tag = "forest";
  const lodMeshes = LODS.map((lod, li) => {
    const geo = spruceGeometry(lod);
    const snowAttr = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    geo.setAttribute("aSnow", snowAttr);
    const mesh = new THREE.InstancedMesh(geo, foliage, N);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = li === 0;
    mesh.receiveShadow = li < 2;
    mesh.userData.tag = "tree";
    mesh.userData.lod = li;
    group.add(mesh);
    return mesh;
  });
  const trunkMesh = new THREE.InstancedMesh(trunkGeometry(), bark, N);
  trunkMesh.count = 0;
  trunkMesh.frustumCulled = false;
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;
  trunkMesh.userData.tag = "tree";
  group.add(trunkMesh);
  scene.add(group);

  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  // Culling uses a wider lens than the real camera so quick turns between refills never show
  // bare edges.
  const cullCam = new THREE.PerspectiveCamera();
  const lastPos = new THREE.Vector3(1e9, 0, 0);
  const lastDir = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let counts = [0, 0, 0];

  function fill(camera, force = false) {
    camera.getWorldDirection(dir);
    if (!force && lastPos.distanceToSquared(camera.position) < 36 && lastDir.dot(dir) > 0.985) return false;
    lastPos.copy(camera.position);
    lastDir.copy(dir);
    cullCam.fov = Math.min(150, camera.fov + 34);
    cullCam.aspect = camera.aspect * 1.25;
    cullCam.near = 0.5;
    cullCam.far = 3000;
    cullCam.updateProjectionMatrix();
    projView.multiplyMatrices(cullCam.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    counts = [0, 0, 0];
    let trunks = 0;
    for (const cell of cells) {
      // Slightly enlarged test so shadow casters just off-screen stay in.
      const d = cell.center.distanceTo(camera.position);
      const near = d < 90;
      if (!near && !frustum.intersectsBox(cell.box)) continue;
      if (d > LODS[2].dist) continue;
      const li = d < LODS[0].dist ? 0 : d < LODS[1].dist ? 1 : 2;
      const mesh = lodMeshes[li];
      const o = counts[li];
      mesh.instanceMatrix.array.set(matrices.subarray(cell.start * 16, (cell.start + cell.count) * 16), o * 16);
      mesh.instanceColor.array.set(colors.subarray(cell.start * 3, (cell.start + cell.count) * 3), o * 3);
      mesh.geometry.attributes.aSnow.array.set(snows.subarray(cell.start, cell.start + cell.count), o);
      counts[li] += cell.count;
      if (li === 0) {
        trunkMesh.instanceMatrix.array.set(matrices.subarray(cell.start * 16, (cell.start + cell.count) * 16), trunks * 16);
        trunks += cell.count;
      }
    }
    lodMeshes.forEach((mesh, li) => {
      mesh.count = counts[li];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, counts[li] * 16);
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, counts[li] * 3);
      const a = mesh.geometry.attributes.aSnow;
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, counts[li]);
    });
    trunkMesh.count = trunks;
    trunkMesh.instanceMatrix.needsUpdate = true;
    trunkMesh.instanceMatrix.clearUpdateRanges();
    trunkMesh.instanceMatrix.addUpdateRange(0, trunks * 16);
    return true;
  }

  // ── collision grid (8 m cells, counting sort) ──
  const gx = Math.ceil((MAP.maxX - MAP.minX) / GRID);
  const gz = Math.ceil((MAP.maxZ - MAP.minZ) / GRID);
  const cellStart = new Int32Array(gx * gz + 1);
  const gcell = new Int32Array(N);
  for (let n = 0; n < N; n++) {
    const ix = clamp(Math.floor((trees.x[n] - MAP.minX) / GRID), 0, gx - 1);
    const iz = clamp(Math.floor((trees.z[n] - MAP.minZ) / GRID), 0, gz - 1);
    gcell[n] = iz * gx + ix;
    cellStart[gcell[n] + 1]++;
  }
  for (let c = 0; c < gx * gz; c++) cellStart[c + 1] += cellStart[c];
  const fillPtr = cellStart.slice(0, gx * gz);
  const sorted = new Int32Array(N);
  for (let n = 0; n < N; n++) sorted[fillPtr[gcell[n]]++] = n;

  /** Trees whose trunk circle (plus `radius`) contains (x, z): calls fn(index, dist). */
  function near(x, z, radius, fn) {
    const i0 = clamp(Math.floor((x - radius - 2 - MAP.minX) / GRID), 0, gx - 1);
    const i1 = clamp(Math.floor((x + radius + 2 - MAP.minX) / GRID), 0, gx - 1);
    const j0 = clamp(Math.floor((z - radius - 2 - MAP.minZ) / GRID), 0, gz - 1);
    const j1 = clamp(Math.floor((z + radius + 2 - MAP.minZ) / GRID), 0, gz - 1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * gx + i;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const n = sorted[k];
          const d = Math.hypot(trees.x[n] - x, trees.z[n] - z);
          if (d < radius) fn(n, d);
        }
      }
  }

  /**
   * Ray vs tree trunks + canopies (cones). Returns the nearest hit distance along the ray
   * within maxDist, or Infinity. Marches the 8 m grid.
   */
  function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = Infinity;
    const flat = Math.hypot(dx, dz);
    const stepLen = GRID * 0.5;
    const seen = new Set();
    for (let t = 0; t <= maxDist && t < best; t += stepLen) {
      const px = ox + dx * t;
      const pz = oz + dz * t;
      const ix = Math.floor((px - MAP.minX) / GRID);
      const iz = Math.floor((pz - MAP.minZ) / GRID);
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) {
          const ii = ix + a;
          const jj = iz + b;
          if (ii < 0 || jj < 0 || ii >= gx || jj >= gz) continue;
          const c = jj * gx + ii;
          if (seen.has(c)) continue;
          seen.add(c);
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const n = sorted[k];
            const hit = rayTree(n, ox, oy, oz, dx, dy, dz, flat);
            if (hit < best && hit <= maxDist) best = hit;
          }
        }
    }
    return best;
  }

  /** Ray vs one tree: a vertical cylinder of the canopy's inner core + the trunk. */
  function rayTree(n, ox, oy, oz, dx, dy, dz, flat) {
    const cx = trees.x[n];
    const cz = trees.z[n];
    const by = trees.y[n];
    const h = trees.h[n];
    // Core radius: dense inner foliage ~45% of the canopy radius (bullets pass the fringe).
    const rad = Math.max(0.35, trees.r[n] * 0.45);
    if (flat < 1e-6) return Infinity;
    // Closest approach in xz.
    const fx = ox - cx;
    const fz = oz - cz;
    const a = dx * dx + dz * dz;
    const bq = 2 * (fx * dx + fz * dz);
    const cq = fx * fx + fz * fz - rad * rad;
    const disc = bq * bq - 4 * a * cq;
    if (disc < 0) return Infinity;
    const sq = Math.sqrt(disc);
    const t0 = (-bq - sq) / (2 * a);
    const t1 = (-bq + sq) / (2 * a);
    for (const t of [t0, t1]) {
      if (t < 0) continue;
      const y = oy + dy * t;
      // The canopy narrows with height: accept if within the cone's radius at that height.
      const rel = (y - by) / h;
      if (rel < 0 || rel > 0.95) continue;
      const coneR = Math.max(0.3, trees.r[n] * (1 - rel) * 0.55);
      const px = ox + dx * t - cx;
      const pz = oz + dz * t - cz;
      if (Math.hypot(px, pz) <= coneR + 0.05) return t;
    }
    return Infinity;
  }

  return {
    group,
    lodMeshes,
    trunkMesh,
    trees,
    fill,
    near,
    raycast,
    counts: () => counts.slice(),
  };
}
