/**
 * Procedural textures baked once at boot on canvases (deterministic: fixed seeds).
 * Snow detail + snow normal, rock, the conifer "skirt" card, bark, orange safety net, etc.
 */
import * as THREE from "three";
import { valueNoise, makeRng, normalFromHeight } from "../materials.js";

function canvas(size, h = size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = h;
  return c;
}

function toTexture(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Snow: subtle albedo variation + a normal map with soft bumps, wind ripples and grains. */
export function makeSnowTextures() {
  const size = 512;
  const broad = valueNoise(size, 11, { octaves: 5, base: 4 });
  const ripBase = valueNoise(size, 23, { octaves: 3, base: 8, persistence: 0.55 });
  const grains = valueNoise(size, 37, { octaves: 2, base: 128 });
  const mid = valueNoise(size, 41, { octaves: 4, base: 16 });
  const hc = canvas(size);
  const hctx = hc.getContext("2d");
  const himg = hctx.createImageData(size, size);
  const ac = canvas(size);
  const actx = ac.getContext("2d");
  const aimg = actx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const ripple = Math.sin((u * 14 + y / size * 3 + ripBase[i] * 2.2) * Math.PI * 2) * 0.5 + 0.5;
      const h = 0.45 * broad[i] + 0.28 * ripple * mid[i] + 0.17 * mid[i] + 0.1 * grains[i];
      const hv = Math.round(Math.max(0, Math.min(1, h)) * 255);
      himg.data[i * 4] = himg.data[i * 4 + 1] = himg.data[i * 4 + 2] = hv;
      himg.data[i * 4 + 3] = 255;
      // Albedo: almost white, faint cool patches, sparse darker specks (wind-blown debris).
      const cool = 0.955 + 0.045 * broad[i];
      const speck = grains[i] > 0.86 ? 0.93 : 1;
      aimg.data[i * 4] = Math.round(255 * cool * speck * 0.985);
      aimg.data[i * 4 + 1] = Math.round(255 * cool * speck * 0.99);
      aimg.data[i * 4 + 2] = Math.round(255 * Math.min(1, cool * speck * 1.0));
      aimg.data[i * 4 + 3] = 255;
    }
  }
  hctx.putImageData(himg, 0, 0);
  actx.putImageData(aimg, 0, 0);
  const normal = normalFromHeight(hc, 3.2);
  normal.anisotropy = 8;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  return { albedo: toTexture(ac), normal };
}

/** Rock: fractured grey-brown granite, tileable. */
export function makeRockTexture() {
  const size = 512;
  const n = valueNoise(size, 71, { octaves: 6, base: 6, persistence: 0.55 });
  const crack = valueNoise(size, 73, { octaves: 4, base: 12 });
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const cr = Math.abs(crack[i] - 0.5) < 0.025 ? 0.55 : 1;
    const v = 0.65 + 0.5 * n[i];
    const warm = n[i] > 0.62 ? 1.06 : 1;
    img.data[i * 4] = Math.min(255, 92 * v * cr * warm);
    img.data[i * 4 + 1] = Math.min(255, 88 * v * cr);
    img.data[i * 4 + 2] = Math.min(255, 84 * v * cr * (2 - warm));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/**
 * Conifer branch-skirt card. u runs around the tier, v from the trunk (0) out to the branch
 * tips (1). RGBA = (needle shade, snow mask, unused, alpha). Branch tips make a jagged, gappy
 * fringe so the silhouette breaks up; snow clumps sit along the upper side of each branch.
 */
export function makeConiferTexture(seed = 5) {
  const W = 512;
  const H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  const rng = makeRng(seed);
  // RGBA = (needle shade, snow mask, 0, alpha); row 0 is the trunk side (flipY off).
  const shade = new Float32Array(W * H).fill(0.6);
  const snow = new Float32Array(W * H);
  const alpha = new Float32Array(W * H);
  const branches = 12;
  const stamp = (cx, cy, r, field, value) => {
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(H - 1, Math.ceil(cy + r));
    const rr = Math.ceil(r);
    for (let yy = y0; yy <= y1; yy++) {
      for (let dx = -rr; dx <= rr; dx++) {
        const xx = (((Math.round(cx) + dx) % W) + W) % W;
        const d = Math.hypot(dx, yy - cy) / r;
        if (d > 1) continue;
        const k = yy * W + xx;
        field[k] = Math.max(field[k], value * (1 - d * d * d));
      }
    }
  };
  // Dense foliage near the trunk.
  for (let y = 0; y < H * 0.6; y++) for (let x = 0; x < W; x++) alpha[y * W + x] = 1;
  for (let b = 0; b < branches; b++) {
    const bx = ((b + 0.5) / branches) * W + (rng() - 0.5) * 10;
    const reach = H * (0.84 + rng() * 0.14);
    const curve = (rng() - 0.5) * 16;
    for (let t = 0; t < 1; t += 0.008) {
      const y = t * reach;
      const x = bx + curve * t * t;
      const width = 30 * (1 - t * 0.7) + 5;
      for (let k = 0; k < 4; k++) {
        const off = (rng() * 2 - 1) * width;
        stamp(x + off, y + (rng() - 0.5) * 8, 4 + rng() * 5, alpha, 1);
        stamp(x + off, y, 3 + rng() * 4, shade, 0.45 + rng() * 0.55);
      }
      // Snow loads the upper side of every branch.
      if (rng() < 0.45) stamp(x + (rng() - 0.5) * width * 1.1, y, 6 + rng() * 10 * (1 - t * 0.5), snow, 0.85 + rng() * 0.15);
    }
  }
  // Snow lies as a broken layer over the top of each tier: heavy over the middle of the skirt,
  // thinning toward the trunk and the branch tips, with organic holes (no round stamps).
  const n1 = valueNoise(W, seed + 300, { octaves: 5, base: 8, persistence: 0.55 });
  const n2 = valueNoise(W, seed + 301, { octaves: 3, base: 32 });
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const base = 0.78 - 1.5 * Math.max(0, v - 0.66) - 2.2 * Math.max(0, 0.12 - v);
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      // Sample the square noise with v stretched so patches elongate along the branches.
      const nk = ((Math.floor(y * 0.5) % W) * W + x) % (W * W);
      const s2 = base + (n1[nk] - 0.5) * 1.3 + (n2[nk] - 0.5) * 0.5;
      const layer = Math.min(1, Math.max(0, (s2 - 0.42) / 0.18));
      snow[k] = Math.max(snow[k] * 0.6, layer * (alpha[k] > 0.5 ? 1 : 0));
    }
  }
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = Math.round(Math.max(0.25, Math.min(1, shade[i])) * 255);
    img.data[i * 4 + 1] = Math.round(Math.min(1, snow[i]) * 255);
    img.data[i * 4 + 2] = 0;
    img.data[i * 4 + 3] = alpha[i] > 0.5 ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(c, { srgb: false, aniso: 4 });
  tex.flipY = false;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Bark: vertical furrows, dark brown-grey. */
export function makeBarkTexture() {
  const size = 256;
  const n = valueNoise(size, 91, { octaves: 5, base: 8 });
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const furrow = Math.sin((x / size) * Math.PI * 2 * 9 + n[i] * 5) * 0.5 + 0.5;
      const v = 0.55 + 0.45 * furrow * n[i];
      img.data[i * 4] = 78 * v;
      img.data[i * 4 + 1] = 62 * v;
      img.data[i * 4 + 2] = 52 * v;
      img.data[i * 4 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Orange plastic safety net (alpha-tested mesh). */
export function makeNetTexture() {
  const W = 256;
  const H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#ff6a10";
  ctx.lineWidth = 5;
  for (let x = -H; x < W + H; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + H * 0.5, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + H * 0.5, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  ctx.fillStyle = "#ff7a1a";
  ctx.fillRect(0, 0, W, 8);
  ctx.fillRect(0, H - 8, W, 8);
  const t = toTexture(c);
  return t;
}

/** Painted banner (text on colour) for kickers, start gates and signs. */
export function makeBannerTexture(text, { bg = "#0b2a4a", fg = "#ffffff", accent = "#ff6a10", w = 1024, h = 256, sub = "" } = {}) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(0, h - h * 0.12, w, h * 0.12);
  // Mountain logo
  ctx.fillStyle = fg;
  ctx.beginPath();
  const lx = h * 0.18;
  const ly = h * 0.75;
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx + h * 0.22, ly - h * 0.42);
  ctx.lineTo(lx + h * 0.32, ly - h * 0.27);
  ctx.lineTo(lx + h * 0.4, ly - h * 0.36);
  ctx.lineTo(lx + h * 0.62, ly);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(lx + h * 0.22, ly - h * 0.42);
  ctx.lineTo(lx + h * 0.3, ly - h * 0.3);
  ctx.lineTo(lx + h * 0.14, ly - h * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = `italic 900 ${Math.round(h * 0.42)}px "Arial Black", Impact, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, h * 0.9, h * (sub ? 0.4 : 0.47));
  if (sub) {
    ctx.font = `700 ${Math.round(h * 0.16)}px Arial, sans-serif`;
    ctx.fillText(sub, h * 0.92, h * 0.74);
  }
  return toTexture(c, { repeat: false });
}

/**
 * A tiled patch of forest seen from above: ~250 snowy spruce crowns over 80 m, lit from the
 * south-west, shadowed to the north-east. Mipmaps average it to the right mid-dark tone far away.
 */
export function makeCanopyTexture() {
  const size = 512;
  const c = canvas(size);
  const ctx = c.getContext("2d");
  const rng = makeRng(77);
  ctx.fillStyle = "#9aa6b6";
  ctx.fillRect(0, 0, size, size);
  const crowns = [];
  for (let i = 0; i < 420; i++) crowns.push([rng() * size, rng() * size, 9 + rng() * 10]);
  // Shadows first (offset toward +x, -z → canvas right/up since +z is down here).
  for (const [x, y, r] of crowns) {
    for (const dx of [-size, 0, size])
      for (const dy of [-size, 0, size]) {
        ctx.fillStyle = "rgba(60,75,105,0.55)";
        ctx.beginPath();
        ctx.ellipse(x + dx + r * 1.2, y + dy - r * 0.9, r * 1.5, r * 0.9, -0.6, 0, Math.PI * 2);
        ctx.fill();
      }
  }
  for (const [x, y, r] of crowns) {
    for (const dx of [-size, 0, size])
      for (const dy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + dx - r * 0.35, y + dy + r * 0.3, r * 0.1, x + dx, y + dy, r);
        g.addColorStop(0, "#d6dde4");
        g.addColorStop(0.28, "#7b9283");
        g.addColorStop(0.62, "#31503a");
        g.addColorStop(1, "#1c3022");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
  }
  const t = toTexture(c);
  t.flipY = false;
  return t;
}
