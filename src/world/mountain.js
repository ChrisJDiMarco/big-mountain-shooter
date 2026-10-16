/**
 * The mountain: one deterministic height function for the whole landscape (the ski mountain,
 * the valley below it and the jagged ranges around it) plus a fine 4 m heightfield over the
 * playable domain with groomed runs cut through it.
 *
 * Pure JS — no three — so it also runs under node (`.studio/mapPreview.mjs`) for map previews.
 *
 * Axes: x east, z south (+z is downhill toward the base and the valley), y up. Metres.
 */
import { makeSimplex, fbm, ridged, smoothstep, clamp, lerp } from "../core/noise.js";

export const MAP = {
  seed: 7311,
  minX: -1024,
  maxX: 1024,
  minZ: -1536,
  maxZ: 1536,
  cell: 4,
  summit: { x: 0, z: -1260 },
  baseZ: 1120,
  topElev: 860,
  /** Riders outside this box (or below the base line) are out of bounds. */
  bounds: { minX: -820, maxX: 820, minZ: -1330, maxZ: 1260 },
};

/**
 * Runs, summit to base. Each point is [x, z, halfWidth]. They are smoothed into splines, given a
 * monotonic downhill profile and cut into the terrain as groomed corridors.
 */
export const TRAILS = [
  {
    id: "champagne",
    name: "Champagne",
    groomed: true,
    color: "#3a7bd5",
    pts: [
      [0, -1236, 26], [10, -1150, 34], [40, -1020, 40], [30, -880, 44], [-20, -740, 46], [-40, -600, 46],
      [-10, -460, 44], [30, -330, 46], [40, -200, 50], [10, -60, 56], [0, 60, 60], [0, 200, 60],
      [-10, 330, 54], [-50, 460, 48], [-60, 600, 48], [-20, 740, 50], [20, 880, 56], [10, 1010, 70],
      [0, 1120, 90],
    ],
  },
  {
    id: "storm-bowl",
    name: "Storm Bowl",
    groomed: false,
    color: "#1a1a1a",
    pts: [
      [-40, -1232, 30], [-150, -1140, 60], [-290, -1030, 90], [-400, -900, 100], [-460, -760, 80],
      [-480, -620, 60], [-450, -480, 46], [-400, -340, 40], [-360, -200, 38], [-330, -60, 38],
      [-300, 80, 40], [-260, 220, 40], [-220, 360, 40], [-190, 500, 40], [-170, 640, 42],
      [-150, 780, 44], [-110, 920, 50], [-50, 1040, 60], [0, 1120, 90],
    ],
  },
  {
    id: "ridge-runner",
    name: "Ridge Runner",
    groomed: true,
    color: "#3a7bd5",
    pts: [
      [40, -1232, 26], [150, -1150, 34], [280, -1050, 38], [400, -930, 40], [480, -790, 40],
      [520, -640, 40], [520, -490, 38], [490, -340, 38], [450, -190, 38], [420, -40, 38],
      [390, 110, 38], [350, 260, 38], [310, 410, 38], [270, 560, 40], [230, 700, 40], [180, 840, 44],
      [110, 970, 50], [40, 1060, 60], [0, 1120, 90],
    ],
  },
  {
    id: "aspen-cat",
    name: "Aspen Cat Track",
    groomed: true,
    color: "#2e9d4a",
    pts: [
      [-470, -560, 18], [-380, -520, 16], [-270, -470, 16], [-150, -430, 16], [-40, -400, 18],
    ],
  },
  {
    id: "east-traverse",
    name: "East Traverse",
    groomed: true,
    color: "#2e9d4a",
    pts: [
      [430, 120, 18], [330, 150, 16], [220, 170, 16], [110, 175, 16], [20, 170, 18],
    ],
  },
];

/** Terrain park: a widened stretch of Champagne where the kickers and rails live (z range). */
export const PARK = { trail: "champagne", z0: -60, z1: 300 };

const SIMPLEX = {
  a: makeSimplex(MAP.seed),
  b: makeSimplex(MAP.seed + 101),
  c: makeSimplex(MAP.seed + 202),
  d: makeSimplex(MAP.seed + 303),
  e: makeSimplex(MAP.seed + 404),
};

/** Elevation of the mountain's fall-line profile at z (summit → base → valley). */
function profile(z) {
  const { summit, baseZ, topElev } = MAP;
  if (z <= summit.z) {
    // Backside: a steep north face falling into a back valley, then flat.
    const d = summit.z - z;
    return topElev - 760 * smoothstep(0, 1500, d) - 120 * smoothstep(0, 220, d);
  }
  if (z <= baseZ) {
    const t = (z - summit.z) / (baseZ - summit.z);
    // Steep upper headwall, long mid-mountain, flattening runout.
    const p = Math.pow(1 - t, 1.32);
    return 30 + (topElev - 30) * p;
  }
  // The base plaza stays flat for a while, then the land drops to the valley floor.
  const d = z - baseZ;
  const fall = 250 * smoothstep(120, 1900, d) + 35 * smoothstep(110, 330, d);
  return 30 - 4 * smoothstep(0, 120, d) - fall;
}

/**
 * Global height G(x, z): the whole landscape at coarse detail. The fine heightfield adds
 * detail and runs on top of this inside the playable domain; the far terrain samples it as is.
 */
export function landscapeHeight(x, z) {
  const { a, b, c } = SIMPLEX;
  const ax = Math.abs(x);
  const along = clamp((z - MAP.summit.z) / (MAP.baseZ - MAP.summit.z), 0, 1);
  // Cross-section: a gentle bowl between two side ridges that frame the ski area, then the
  // land falls away into side valleys.
  const crestX = lerp(560, 860, smoothstep(0.0, 0.5, along));
  const crest = lerp(30, 85, smoothstep(0.0, 0.35, along)) * (1 - 0.65 * smoothstep(0.55, 1.0, along));
  const ridgeBump = crest * Math.exp(-Math.pow((ax - crestX) / 190, 2));
  const inside = 1 - smoothstep(crestX - 60, crestX + 40, ax);
  const bowl = 26 * Math.pow(Math.min(ax, crestX) / 800, 2);
  let massif = profile(z) + ridgeBump + bowl * inside;
  // Outside the crests the flanks drop into side valleys.
  const flank = smoothstep(crestX + 60, crestX + 1700, ax);
  // Summit peak and the upper bowl.
  const sx = x - MAP.summit.x;
  const sz = z - (MAP.summit.z - 90);
  massif += 75 * Math.exp(-(sx * sx + sz * sz) / (125 * 125));
  massif -= 38 * Math.exp(-(Math.pow((x + 380) / 260, 2) + Math.pow((z + 860) / 320, 2)));
  // Spurs and gullies running down the fall line, and big gentle undulations.
  massif += 11 * Math.sin(x / 85 + 1.7 * Math.sin(z / 340)) * smoothstep(0.1, 0.35, along) * (1 - along * 0.7) * inside;
  massif += 34 * fbm(a, x / 900, z / 900, 3);

  const valleyFloor = -230 + 25 * fbm(b, x / 1500, z / 1500, 3);
  const mountainLand = lerp(massif, valleyFloor, flank);

  // The ranges all around: jagged alpine peaks, kept off the ski area. A wide east-west valley
  // runs in front of (south of) the mountain, with a big range on its far side.
  const ex = x / 1500;
  const ez = (z + 150) / 1950;
  const ellipse = Math.sqrt(ex * ex + ez * ez);
  const rangeMask = smoothstep(1.2, 2.1, ellipse);
  if (rangeMask <= 0) return mountainLand;
  const valleyAxis = 4700 + 1400 * Math.sin(x / 7000 + 0.6);
  const valleyHalf = 2300 + 500 * fbm(b, x / 6000, 3.7, 2);
  const valley = 1 - smoothstep(valleyHalf, valleyHalf + 1500, Math.abs(z - valleyAxis));
  const wx = x + 1100 * fbm(b, x / 8000, z / 8000, 2);
  const wz = z + 1100 * fbm(a, x / 8000 + 5, z / 8000, 2);
  // Big massifs (smooth, kilometres wide) carved by sharp ridgelines and couloirs.
  const massifN = Math.max(0, 0.5 + 0.5 * fbm(a, wx / 7500 + 3.1, wz / 7500 - 1.7, 3));
  const r = ridged(c, wx / 3800, wz / 3800, 6, 0.5);
  const far = Math.sqrt(x * x + z * z);
  const southRange = smoothstep(valleyAxis + valleyHalf, valleyAxis + valleyHalf + 3000, z);
  const body = Math.pow(massifN, 1.25) * (0.55 + 0.45 * r) + 0.18 * r * r;
  const peakH = (250 + 3000 * body) * (1 + 0.35 * southRange) * (0.85 + 0.3 * smoothstep(4000, 14000, far));
  const peaks = peakH * rangeMask * (1 - valley);
  const distantLift = 0;
  return Math.max(mountainLand, valleyFloor + peaks + distantLift);
}

/** Fine detail added to the landscape off-piste (bumps, rolls, rock steps). */
function detailHeight(x, z) {
  const { d, e } = SIMPLEX;
  const medium = 6 * fbm(d, x / 140, z / 140, 3);
  const small = 1.4 * fbm(e, x / 34, z / 34, 3);
  return medium + small;
}

/** Catmull-Rom resample of a trail's control points every `step` metres. */
function resampleTrail(trail, step = 4) {
  const pts = trail.pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a0, a1, a2, a3) =>
        0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
      out.push({
        x: cr(p0[0], p1[0], p2[0], p3[0]),
        z: cr(p0[1], p1[1], p2[1], p3[1]),
        w: lerp(p1[2], p2[2], t),
      });
    }
  }
  const last = pts[pts.length - 1];
  out.push({ x: last[0], z: last[1], w: last[2] });
  // Arc length + tangent.
  let s = 0;
  for (let i = 0; i < out.length; i++) {
    if (i > 0) s += Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
    out[i].s = s;
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out[i].tx = (b.x - a.x) / len;
    out[i].tz = (b.z - a.z) / len;
  }
  return out;
}

/** In-place separable box blur of a grid (radius r cells), `passes` times ≈ a Gaussian. */
function blurGrid(src, nx, nz, r, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + clamp(k, 0, nx - 1)];
      for (let i = 0; i < nx; i++) {
        b[row + i] = sum / win;
        sum += a[row + clamp(i + r + 1, 0, nx - 1)] - a[row + clamp(i - r, 0, nx - 1)];
      }
    }
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[clamp(k, 0, nz - 1) * nx + i];
      for (let j = 0; j < nz; j++) {
        a[j * nx + i] = sum / win;
        sum += b[clamp(j + r + 1, 0, nz - 1) * nx + i] - b[clamp(j - r, 0, nz - 1) * nx + i];
      }
    }
  }
  return a;
}

/**
 * Build the playable heightfield. Returns typed arrays over an (nx × nz) vertex grid plus the
 * resampled trails (with their smoothed centreline heights) for bots, props and the minimap.
 */
export function buildMountain() {
  const { minX, maxX, minZ, maxZ, cell } = MAP;
  const nx = Math.round((maxX - minX) / cell) + 1;
  const nz = Math.round((maxZ - minZ) / cell) + 1;
  const count = nx * nz;
  const full = new Float32Array(count);
  const trailW = new Float32Array(count); // 0..1 how much this vertex is "run"
  const trailDist = new Float32Array(count).fill(1e9);
  const groomDirX = new Float32Array(count);
  const groomDirZ = new Float32Array(count);
  const trailIndex = new Int8Array(count).fill(-1);
  const trailTarget = new Float32Array(count);

  for (let j = 0; j < nz; j++) {
    const z = minZ + j * cell;
    const fz = Math.min(j, nz - 1 - j) * cell;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell;
      const fx = Math.min(i, nx - 1 - i) * cell;
      const fade = smoothstep(0, 140, Math.min(fx, fz));
      full[j * nx + i] = landscapeHeight(x, z) + detailHeight(x, z) * fade;
    }
  }
  // A smoothed copy of the terrain: what a groomer would leave behind.
  const smoothH = blurGrid(full, nx, nz, 3, 3);
  const height = Float32Array.from(full);

  const sampleGrid = (arr, x, z) => {
    const fi = clamp((x - minX) / cell, 0, nx - 1.001);
    const fj = clamp((z - minZ) / cell, 0, nz - 1.001);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const k = j * nx + i;
    return lerp(lerp(arr[k], arr[k + 1], u), lerp(arr[k + nx], arr[k + nx + 1], u), v);
  };

  // Trails: follow the smoothed terrain, with a downhill guarantee along the centreline.
  const trails = TRAILS.map((def) => {
    const path = resampleTrail(def);
    const natural = path.map((p) => sampleGrid(smoothH, p.x, p.z));
    const forced = natural.slice();
    // Never uphill: at least a 5% grade so nobody gets stuck (cuts through bumps).
    for (let i = 1; i < forced.length; i++) {
      const ds = path[i].s - path[i - 1].s;
      forced[i] = Math.min(forced[i], forced[i - 1] - ds * 0.05);
    }
    // The correction (≤ 0) is smoothed along the run so a cut ramps in and out.
    const corr = forced.map((f, i) => f - natural[i]);
    const win = 8;
    const corrSmooth = corr.map((_, i) => {
      let m = 0;
      for (let k = -win; k <= win; k++) m = Math.min(m, corr[clamp(i + k, 0, corr.length - 1)] * (1 - Math.abs(k) / (win + 1)));
      return m;
    });
    path.forEach((p, i) => {
      // Gentle rollers along the groomers: pop opportunities.
      const roll = def.groomed ? 0.6 * Math.sin(p.s / 23) * Math.sin(p.s / 61 + 1.3) : 0;
      p.corr = corrSmooth[i] + roll;
      p.hc = natural[i];
      p.h = natural[i] + corrSmooth[i] + roll;
    });
    return { ...def, path, length: path[path.length - 1].s };
  });

  trails.forEach((trail, ti) => {
    const edge = trail.groomed ? 16 : 24;
    for (let pi = 0; pi < trail.path.length - 1; pi++) {
      const p = trail.path[pi];
      const q = trail.path[pi + 1];
      const reach = Math.max(p.w, q.w) + edge + 8;
      const i0 = Math.max(0, Math.floor((Math.min(p.x, q.x) - reach - minX) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(p.x, q.x) + reach - minX) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(p.z, q.z) - reach - minZ) / cell));
      const j1 = Math.min(nz - 1, Math.ceil((Math.max(p.z, q.z) + reach - minZ) / cell));
      const sx = q.x - p.x;
      const sz = q.z - p.z;
      const len2 = sx * sx + sz * sz || 1;
      for (let j = j0; j <= j1; j++) {
        const z = minZ + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * cell;
          const t = clamp(((x - p.x) * sx + (z - p.z) * sz) / len2, 0, 1);
          const cx = p.x + sx * t;
          const cz = p.z + sz * t;
          const d = Math.hypot(x - cx, z - cz);
          const k = j * nx + i;
          const hw = lerp(p.w, q.w, t);
          const nd = d - hw;
          if (nd >= trailDist[k]) continue;
          trailDist[k] = nd;
          trailIndex[k] = ti;
          const w = 1 - smoothstep(0, edge, nd);
          // Half-way between the smoothed slope and the centreline height: a mild bench.
          const hc = lerp(p.hc, q.hc, t);
          const surface = lerp(smoothH[k], hc, 0.45) + lerp(p.corr, q.corr, t);
          const across = d / Math.max(1, hw);
          const crown = -0.35 * across * across;
          trailTarget[k] = surface + crown;
          trailW[k] = Math.max(trailW[k], w);
          groomDirX[k] = lerp(p.tx, q.tx, t);
          groomDirZ[k] = lerp(p.tz, q.tz, t);
        }
      }
    }
  });
  for (let k = 0; k < count; k++) {
    if (trailIndex[k] < 0) continue;
    const w = 1 - smoothstep(0, trails[trailIndex[k]].groomed ? 16 : 24, trailDist[k]);
    height[k] = lerp(full[k], trailTarget[k], w);
  }

  // Normals (central differences on the final grid).
  const normals = new Float32Array(count * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const hl = height[j * nx + Math.max(0, i - 1)];
      const hr = height[j * nx + Math.min(nx - 1, i + 1)];
      const hd = height[Math.max(0, j - 1) * nx + i];
      const hu = height[Math.min(nz - 1, j + 1) * nx + i];
      const dx = (hr - hl) / (2 * cell);
      const dz = (hu - hd) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      normals[k * 3] = -dx * inv;
      normals[k * 3 + 1] = inv;
      normals[k * 3 + 2] = -dz * inv;
    }
  }

  const park = trails.find((t) => t.id === PARK.trail);
  return {
    nx,
    nz,
    cell,
    minX,
    minZ,
    maxX,
    maxZ,
    height,
    normals,
    trailW,
    trailDist,
    trailIndex,
    groomDirX,
    groomDirZ,
    trails,
    park,
  };
}

/**
 * Height + normal queries over a built mountain. Height is exact on the rendered triangles
 * (same diagonal split as the terrain mesh); the normal is smoothly interpolated so physics
 * doesn't jitter across facets.
 */
export function makeSampler(m) {
  const { nx, nz, cell, minX, minZ, height, normals } = m;
  function heightAt(x, z) {
    const fi = (x - minX) / cell;
    const fj = (z - minZ) / cell;
    if (fi < 0 || fj < 0 || fi >= nx - 1 || fj >= nz - 1) return landscapeHeight(x, z);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const k = j * nx + i;
    const h00 = height[k];
    const h10 = height[k + 1];
    const h01 = height[k + nx];
    const h11 = height[k + nx + 1];
    // Triangles split along the (0,0)-(1,1) diagonal, matching the mesh index order.
    if (u >= v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
    return h00 + (h11 - h01) * u + (h01 - h00) * v;
  }
  function normalAt(x, z, out) {
    const fi = clamp((x - minX) / cell, 0, nx - 1.001);
    const fj = clamp((z - minZ) / cell, 0, nz - 1.001);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const k = (j * nx + i) * 3;
    const k1 = k + 3;
    const k2 = k + nx * 3;
    const k3 = k2 + 3;
    const w0 = (1 - u) * (1 - v);
    const w1 = u * (1 - v);
    const w2 = (1 - u) * v;
    const w3 = u * v;
    let ox = normals[k] * w0 + normals[k1] * w1 + normals[k2] * w2 + normals[k3] * w3;
    let oy = normals[k + 1] * w0 + normals[k1 + 1] * w1 + normals[k2 + 1] * w2 + normals[k3 + 1] * w3;
    let oz = normals[k + 2] * w0 + normals[k1 + 2] * w1 + normals[k2 + 2] * w2 + normals[k3 + 2] * w3;
    const inv = 1 / Math.hypot(ox, oy, oz);
    out.x = ox * inv;
    out.y = oy * inv;
    out.z = oz * inv;
    return out;
  }
  /** Bilinear lookup of any per-vertex field (trailW, trailDist …). */
  function field(arr, x, z) {
    const fi = clamp((x - minX) / cell, 0, nx - 1.001);
    const fj = clamp((z - minZ) / cell, 0, nz - 1.001);
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const k = j * nx + i;
    return lerp(lerp(arr[k], arr[k + 1], u), lerp(arr[k + nx], arr[k + nx + 1], u), v);
  }
  return { heightAt, normalAt, field };
}
