/**
 * The material library — harness-owned, served like `studio.js`, never a facet's file
 * (HARNESS-FIX-PLAN.md WP10a). The contract forbids downloaded assets; it does NOT forbid
 * materials. A mesh with a flat `MeshStandardMaterial` and no map reads as an untextured box
 * from every camera, and a whole run shipped exactly that. Everything here bakes on a canvas
 * from a seed, so two builds on one seed produce the same pixels.
 *
 *   import { bakeTexture, triplanar, weather, variant, normalFromHeight } from "./materials.js";
 *   const { map, roughnessMap, bumpMap } = bakeTexture({ kind: "masonry", seed: 7, palette: [0x6b5a48, 0x8a7a66] });
 *   wall.material = new THREE.MeshStandardMaterial({ map, roughnessMap, bumpMap, bumpScale: 0.6 });
 *
 * Every map is mean-normalised: attaching it does not change a surface's average brightness,
 * so a pixel check tuned on flat colour keeps passing once the texture lands.
 */
import * as THREE from "three";

export const KINDS = ["wood", "masonry", "plaster", "thatch", "stone", "moss", "chitin", "cloth", "dirt", "metal"];

/** Deterministic 32-bit generator (mulberry32) — the same seed bakes the same texture. */
export function makeRng(seed) {
  let a = Number(seed) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a size×size grid, octaves summed; 0–1. */
export function valueNoise(size, seed, { octaves = 4, base = 4, persistence = 0.5 } = {}) {
  const rng = makeRng(seed);
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  let cells = base;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * cells;
      const y0 = Math.floor(gy);
      const ty = smooth(gy - y0);
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const x0 = Math.floor(gx);
        const tx = smooth(gx - x0);
        const a = grid[(y0 % cells) * cells + (x0 % cells)];
        const b = grid[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = grid[((y0 + 1) % cells) * cells + (x0 % cells)];
        const d = grid[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        out[y * size + x] += amplitude * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
      }
    }
    total += amplitude;
    amplitude *= persistence;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function hexToRgb(hex) {
  const n = typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Courses of blocks: `rows` courses, `cols` blocks each, offset by half a block every other course. */
function courses(rows, cols) {
  return (u, v, n, f) => {
    const rowV = v * rows;
    const row = Math.floor(rowV);
    const offset = (row % 2) * 0.5;
    const colU = u * cols + offset;
    const mortarV = rowV % 1 < 0.08 ? 0 : 1;
    const mortarU = colU % 1 < 0.06 ? 0 : 1;
    const mortar = mortarV * mortarU;
    return mortar ? [0.55 + 0.4 * n * (0.6 + 0.4 * f), n] : [0.15, 0.05];
  };
}

/**
 * Each kind's height (0–1) and palette blend at one texel, from its place `u, v` (0–1), the
 * coarse noise `n` and the fine noise `f` there. Each kind is a different structure — planks,
 * courses, fibres, plates — not noise with a tint.
 */
const FIELDS = {
  wood: (u, v, n, f) => {
    const grain = Math.sin((u * 6 + n * 1.5) * Math.PI * 2) * 0.5 + 0.5;
    const plank = (v * 4) % 1 < 0.04 ? 0.15 : 1;
    return [(0.55 + 0.35 * grain * f) * plank, grain * 0.7 + n * 0.3];
  },
  masonry: courses(8, 4),
  stone: courses(5, 3),
  plaster: (u, v, n, f) => [0.5 + 0.25 * (n - 0.5) + 0.15 * (f - 0.5), 0.5 + (n - 0.5) * 0.4],
  thatch: (u, v, n, f) => {
    const fibre = Math.sin((v * 90 + n * 6) * Math.PI) * 0.5 + 0.5;
    const bundle = (u * 12 + n) % 1 < 0.1 ? 0.6 : 1;
    return [(0.4 + 0.5 * fibre) * bundle, fibre * 0.6 + f * 0.4];
  },
  moss: (u, v, n, f) => [0.5 + 0.35 * f * n, Math.pow(n, 1.5)],
  chitin: (u, v, n, f) => {
    const plates = Math.abs(Math.sin((v * 5 + u * 0.5) * Math.PI));
    return [0.35 + 0.5 * plates + 0.1 * f, plates * 0.8 + n * 0.2];
  },
  cloth: (u, v, n, f, size) => {
    const weave = Math.sin(u * size * 0.5 * Math.PI) * Math.sin(v * size * 0.5 * Math.PI) * 0.5 + 0.5;
    return [0.45 + 0.2 * weave + 0.1 * (n - 0.5), 0.5 + (n - 0.5) * 0.5];
  },
  dirt: (u, v, n, f) => [0.45 + 0.4 * n * f, n],
  metal: (u, v, n, f, size) => {
    const brush = Math.sin(u * size * 0.9 * Math.PI + f * 3) * 0.5 + 0.5;
    return [0.5 + 0.08 * brush + 0.05 * (n - 0.5), 0.5 + (f - 0.5) * 0.25];
  },
};

/** A kind the table does not know is plain noise. */
const plainField = (u, v, n) => [n, n];

/** Per-kind height/colour fields, 0–1 height + a colour per texel from the palette (see FIELDS). */
function fieldFor(kind, size, seed, rng) {
  const n = valueNoise(size, seed, { octaves: 5, base: 6 });
  const fine = valueNoise(size, seed + 101, { octaves: 3, base: 32, persistence: 0.6 });
  const field = Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : plainField;
  const height = new Float32Array(size * size);
  const blend = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const [h, t] = field(x / size, y / size, n[i], fine[i], size);
      height[i] = Math.max(0, Math.min(1, h + (rng() - 0.5) * 0.02));
      blend[i] = Math.max(0, Math.min(1, t));
    }
  }
  return { height, blend };
}

/**
 * Bake `{ map, roughnessMap, bumpMap }` for one material kind. `palette` is 2–4 colours
 * (hex numbers or strings), dark to light. The colour map's mean is normalised to the mean of
 * the palette so attaching it is brightness-neutral. All three textures repeat.
 */
export function bakeTexture({
  kind = "stone",
  seed = 1,
  size = 512,
  palette = null,
  repeat = 1,
  roughness = [0.55, 0.95],
} = {}) {
  const rng = makeRng(seed * 7919 + KINDS.indexOf(kind) + 1);
  const colours = (palette && palette.length ? palette : defaultPalette(kind)).map(hexToRgb);
  const { height, blend } = fieldFor(kind, size, seed, rng);
  const colourCanvas = document.createElement("canvas");
  colourCanvas.width = size;
  colourCanvas.height = size;
  const cctx = colourCanvas.getContext("2d");
  const img = cctx.createImageData(size, size);
  const rough = document.createElement("canvas");
  rough.width = size;
  rough.height = size;
  const rctx = rough.getContext("2d");
  const rimg = rctx.createImageData(size, size);
  const bump = document.createElement("canvas");
  bump.width = size;
  bump.height = size;
  const bctx = bump.getContext("2d");
  const bimg = bctx.createImageData(size, size);
  const target = colours.reduce(
    (acc, c) => [acc[0] + c[0] / colours.length, acc[1] + c[1] / colours.length, acc[2] + c[2] / colours.length],
    [0, 0, 0],
  );
  const texels = [];
  const mean = [0, 0, 0];
  for (let i = 0; i < size * size; i++) {
    const t = blend[i] * (colours.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(colours.length - 1, lo + 1);
    const c = mix(colours[lo], colours[hi], t - lo);
    const shade = 0.85 + 0.3 * (height[i] - 0.5);
    const texel = [c[0] * shade, c[1] * shade, c[2] * shade];
    texels.push(texel);
    mean[0] += texel[0] / (size * size);
    mean[1] += texel[1] / (size * size);
    mean[2] += texel[2] / (size * size);
  }
  const gain = [target[0] / Math.max(1, mean[0]), target[1] / Math.max(1, mean[1]), target[2] / Math.max(1, mean[2])];
  for (let i = 0; i < size * size; i++) {
    const t = texels[i];
    img.data[i * 4] = Math.max(0, Math.min(255, t[0] * gain[0]));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, t[1] * gain[1]));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, t[2] * gain[2]));
    img.data[i * 4 + 3] = 255;
    const r = (roughness[0] + (roughness[1] - roughness[0]) * (1 - height[i])) * 255;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = r;
    rimg.data[i * 4 + 3] = 255;
    const h = height[i] * 255;
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = h;
    bimg.data[i * 4 + 3] = 255;
  }
  cctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  const wrap = (canvas, srgb) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    if (srgb && "colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    tex.userData = { baked: kind, seed };
    return tex;
  };
  return {
    map: wrap(colourCanvas, true),
    roughnessMap: wrap(rough, false),
    bumpMap: wrap(bump, false),
    heightCanvas: bump,
  };
}

export function defaultPalette(kind) {
  switch (kind) {
    case "wood":
      return [0x4a3621, 0x7a5a3a, 0x9c7a52];
    case "masonry":
      return [0x5c5248, 0x8a7d6c, 0xa89a86];
    case "plaster":
      return [0xb8a98e, 0xd6c8ad, 0xe6dbc4];
    case "thatch":
      return [0x6e5a2e, 0xa58a45, 0xc7ab63];
    case "stone":
      return [0x4b4a47, 0x6f6c66, 0x8e8a82];
    case "moss":
      return [0x2f4a22, 0x4f6f30, 0x7a9448];
    case "chitin":
      return [0x2a2620, 0x4d4236, 0x776750];
    case "cloth":
      return [0x5a3f3a, 0x8c6259, 0xb08a7d];
    case "dirt":
      return [0x3d3125, 0x5f4d3a, 0x7d6a52];
    case "metal":
      return [0x3a3d42, 0x6a6f76, 0x9aa0a8];
    default:
      return [0x555555, 0x888888, 0xbbbbbb];
  }
}

/** A tangent-space normal map from a height canvas (Sobel), for materials that want `normalMap`. */
export function normalFromHeight(canvas, strength = 2) {
  const size = canvas.width;
  const src = canvas.getContext("2d").getImageData(0, 0, size, canvas.height).data;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = canvas.height;
  const octx = out.getContext("2d");
  const img = octx.createImageData(size, canvas.height);
  const h = (x, y) => src[(((y + canvas.height) % canvas.height) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Triplanar projection for terrain and rocks: the material's `map` is sampled along the three
 * world axes and blended by the normal, so a stretched UV never smears. Call on a
 * MeshStandardMaterial that has a `map`; returns the same material.
 */
export function triplanar(material, { scale = 0.25 } = {}) {
  material.userData.triplanar = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.triScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTriNormal = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;\nuniform float triScale;",
      )
      .replace(
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "vec3 triW = abs(normalize(vTriNormal)); triW = triW / (triW.x + triW.y + triW.z);",
          "vec4 triX = texture2D(map, vTriPos.zy * triScale);",
          "vec4 triY = texture2D(map, vTriPos.xz * triScale);",
          "vec4 triZ = texture2D(map, vTriPos.xy * triScale);",
          "vec4 sampledDiffuseColor = triX * triW.x + triY * triW.y + triZ * triW.z;",
          "diffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].join("\n"),
      );
  };
  material.needsUpdate = true;
  return material;
}

/**
 * Weathering on top of a baked map: a dirt gradient from the bottom, moss on upward faces,
 * edge wear on the brightest height. Modifies the material's `map` canvas in place — call
 * once, after `bakeTexture`.
 */
export function weather(material, { dirt = 0.3, moss = 0, edgeWear = 0.2, seed = 3 } = {}) {
  const tex = material.map;
  const canvas = tex?.image;
  if (!canvas || typeof canvas.getContext !== "function") return material;
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const noise = valueNoise(width, seed, { octaves: 3, base: 8 });
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = noise[(y % width) * width + (x % width)];
      const grime = dirt * Math.max(0, v - 0.55) * 2.2 * (0.6 + 0.4 * n);
      const green = moss * Math.max(0, 0.45 - v) * 2.2 * n;
      const wear = edgeWear * Math.max(0, n - 0.7) * 3;
      img.data[i] = img.data[i] * (1 - grime * 0.6) * (1 - green * 0.5) + wear * 40;
      img.data[i + 1] = img.data[i + 1] * (1 - grime * 0.6) * (1 - green * 0.2) + green * 40 + wear * 40;
      img.data[i + 2] = img.data[i + 2] * (1 - grime * 0.7) * (1 - green * 0.6) + wear * 30;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.needsUpdate = true;
  material.userData.weathered = true;
  return material;
}

/**
 * A per-instance tone of a base colour: lightness shifted by up to ±`spread` (0–1) from a
 * seeded draw, so twenty houses are twenty tones instead of noise-as-texture or one flat wall.
 */
export function variant(baseColor, seed, spread = 0.08) {
  const rng = makeRng(seed);
  const color = new THREE.Color(baseColor);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const l = Math.max(0, Math.min(1, hsl.l + (rng() - 0.5) * 2 * spread));
  const s = Math.max(0, Math.min(1, hsl.s + (rng() - 0.5) * spread));
  return new THREE.Color().setHSL(hsl.h, s, l);
}

/**
 * The common case in one call: a standard material with a baked map, roughness and bump for
 * a kind, tagged in userData so `materials(tag).every(m => m.map)` can see it.
 */
export function standardMaterial({
  kind = "stone",
  seed = 1,
  palette = null,
  repeat = 1,
  bumpScale = 0.5,
  ...rest
} = {}) {
  const baked = bakeTexture({ kind, seed, palette, repeat });
  const material = new THREE.MeshStandardMaterial({
    map: baked.map,
    roughnessMap: baked.roughnessMap,
    bumpMap: baked.bumpMap,
    bumpScale,
    ...rest,
  });
  material.userData.baked = kind;
  return material;
}
