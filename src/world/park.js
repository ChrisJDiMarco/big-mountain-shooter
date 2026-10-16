/**
 * Park features: kickers (ramp → lip → table → knuckle → landing), boxes and rails. Each is an
 * analytic height bump on top of the terrain in its own (u along the run, v across) frame, so
 * the mesh and the physics are the same surface.
 */
import * as THREE from "three";
import { clamp, smoothstep } from "../core/noise.js";
import { makeBannerTexture } from "./textures.js";

/** Place a feature on a trail at the path sample nearest to z, offset across by `off` metres. */
function onTrail(trail, z, off = 0) {
  let best = trail.path[0];
  for (const p of trail.path) if (Math.abs(p.z - z) < Math.abs(best.z - z)) best = p;
  return { x: best.x + -best.tz * off, z: best.z + best.tx * off, tx: best.tx, tz: best.tz };
}

function kicker({ lr, theta, table, phi, width }) {
  const R = lr / Math.sin(theta);
  const H = R * (1 - Math.cos(theta));
  const deck = H - 0.2;
  const knuckle = lr + 0.6 + table;
  const landLen = deck / Math.tan(phi);
  const end = knuckle + landLen;
  const side = 1.3;
  return {
    type: "kicker",
    lr,
    theta,
    H,
    width,
    length: end,
    reach: Math.hypot(end + 4, width / 2 + H * side + 2),
    lipU: lr,
    /** Height above the terrain at local (u, v). */
    rel(u, v) {
      let h;
      if (u <= 0 || u >= end) return 0;
      if (u <= lr) h = R - Math.sqrt(Math.max(0, R * R - u * u));
      else if (u <= lr + 0.6) h = H - 0.2 * ((u - lr) / 0.6);
      else if (u <= knuckle) h = deck;
      else {
        const t = (u - knuckle) / landLen;
        // Rounded knuckle, then a straight landing that blends into the run.
        h = deck * (1 - t) - deck * 0.08 * Math.sin(Math.PI * Math.min(1, t * 3)) * (1 - t);
        h = Math.max(0, h);
      }
      const half = width / 2;
      const av = Math.abs(v);
      if (av <= half) return h;
      const fall = (av - half) / (Math.max(h, 0.01) * side);
      return fall >= 1 ? 0 : h * (1 - fall * fall * (3 - 2 * fall));
    },
  };
}

/**
 * A jib (box or rail) centred on its placement point, with a packed-snow feed ramp leading up to
 * it (wider than the jib, so you can ride on without an ollie).
 */
function box({ length, height, width, rail }) {
  const ramp = rail ? 2.4 : 1.8;
  const rampW = rail ? 1.5 : Math.max(width + 0.6, 1.4);
  return {
    type: rail ? "rail" : "box",
    length,
    height,
    width,
    ramp,
    rampW,
    topOff: rail ? 0.05 : 0.04, // the rail's radius / half the box's top plate
    reach: Math.hypot(length + ramp + 2, rampW + 2),
    rel(u, v) {
      const half = length / 2;
      if (u > half || u < -half - ramp) return 0;
      const av = Math.abs(v);
      if (u >= -half) return av <= width / 2 ? height + this.topOff : 0;
      if (av > rampW / 2) return 0;
      return (height - 0.04) * ((u + half + ramp) / ramp);
    },
  };
}

export function createPark(scene, world, snowMaterial) {
  const { mountain, sampler } = world;
  const T = Object.fromEntries(mountain.trails.map((t) => [t.id, t]));
  const defs = [
    // Main park line down the middle of Champagne: small → medium → big.
    { at: onTrail(T.champagne, -10, -6), f: kicker({ lr: 5.5, theta: 0.47, table: 5, phi: 0.42, width: 8 }), name: "park-s" },
    { at: onTrail(T.champagne, 95, -6), f: kicker({ lr: 7.5, theta: 0.54, table: 8, phi: 0.46, width: 9 }), name: "park-m" },
    { at: onTrail(T.champagne, 205, -6), f: kicker({ lr: 9.5, theta: 0.6, table: 12, phi: 0.5, width: 10 }), name: "park-l" },
    // Jib line beside it.
    { at: onTrail(T.champagne, 20, 26), f: box({ length: 10, height: 0.55, width: 0.7 }), name: "box-1", color: 0xd8262c },
    { at: onTrail(T.champagne, 120, 26), f: box({ length: 12, height: 0.75, width: 0.42, rail: true }), name: "rail-1", color: 0xd8262c },
    { at: onTrail(T.champagne, 230, 26), f: box({ length: 10, height: 0.6, width: 0.7 }), name: "box-2", color: 0x1f6fd6 },
    // Hits scattered on the other runs.
    { at: onTrail(T.champagne, -700, 8), f: kicker({ lr: 6.5, theta: 0.5, table: 6, phi: 0.44, width: 9 }), name: "upper-kicker" },
    { at: onTrail(T["ridge-runner"], -320, 0), f: kicker({ lr: 7, theta: 0.5, table: 7, phi: 0.45, width: 9 }), name: "ridge-kicker" },
    { at: onTrail(T["storm-bowl"], 160, 0), f: kicker({ lr: 7.5, theta: 0.55, table: 8, phi: 0.48, width: 10 }), name: "storm-kicker" },
    { at: onTrail(T["ridge-runner"], 520, -10), f: kicker({ lr: 6, theta: 0.48, table: 5, phi: 0.42, width: 8 }), name: "lower-kicker" },
  ];
  const features = defs.map((d) => {
    const { at, f } = d;
    // Ramp starts here; the feature runs down the trail direction.
    return {
      ...f,
      name: d.name,
      color: d.color,
      x: at.x,
      z: at.z,
      tx: at.tx,
      tz: at.tz,
      // Bounding centre a bit down the run.
      cx: at.x + at.tx * (f.length ? f.length / 2 : 0),
      cz: at.z + at.tz * (f.length ? f.length / 2 : 0),
    };
  });
  // Jibs are straight: their top runs in a line between the ends (the mesh and the physics
  // share it), whatever the snow does underneath.
  for (const f of features) {
    if (f.type !== "box" && f.type !== "rail") continue;
    const half = f.length / 2;
    f.y0 = sampler.heightAt(f.x - f.tx * half, f.z - f.tz * half) + f.height + f.topOff;
    f.y1 = sampler.heightAt(f.x + f.tx * half, f.z + f.tz * half) + f.height + f.topOff;
    f.slope = (f.y1 - f.y0) / f.length;
    f.topAt = (u) => f.y0 + (u + half) * f.slope;
  }
  const local = (f, x, z) => {
    const dx = x - f.x;
    const dz = z - f.z;
    return [dx * f.tx + dz * f.tz, dx * -f.tz + dz * f.tx];
  };
  function featureAt(x, z) {
    for (const f of features) {
      if (Math.abs(x - f.cx) > f.reach || Math.abs(z - f.cz) > f.reach) continue;
      const [u, v] = local(f, x, z);
      if (f.rel(u, v) > 0) return f;
    }
    return null;
  }
  const api = {
    features,
    near(x, z) {
      for (const f of features) if (Math.abs(x - f.cx) < f.reach && Math.abs(z - f.cz) < f.reach) return true;
      return false;
    },
    /** Height of the features above the terrain at (x, z); `base` = the terrain height there. */
    heightAt(x, z, base) {
      let h = 0;
      for (const f of features) {
        if (Math.abs(x - f.cx) > f.reach || Math.abs(z - f.cz) > f.reach) continue;
        const [u, v] = local(f, x, z);
        if (f.topAt && base !== undefined && Math.abs(u) <= f.length / 2 && Math.abs(v) <= f.width / 2) h = Math.max(h, f.topAt(u) - base);
        else h = Math.max(h, f.rel(u, v));
      }
      return h;
    },
    featureAt,
    /**
     * The box or rail under (x, z), widened by `slack` metres either side (the grind magnet):
     * { f, u (along, 0 = centre), v (across), half }.
     */
    jibAt(x, z, slack = 0) {
      for (const f of features) {
        if (f.type !== "box" && f.type !== "rail") continue;
        if (Math.abs(x - f.cx) > f.reach || Math.abs(z - f.cz) > f.reach) continue;
        const [u, v] = local(f, x, z);
        const half = f.length / 2;
        if (u < -half || u > half || Math.abs(v) > f.width / 2 + slack) continue;
        return { f, u, v, half };
      }
      return null;
    },
    /** Distance (m) before a kicker's lip when the rider is on its ramp, else Infinity. */
    kickerLip(x, z) {
      for (const f of features) {
        if (f.type !== "kicker") continue;
        if (Math.abs(x - f.cx) > f.reach || Math.abs(z - f.cz) > f.reach) continue;
        const [u, v] = local(f, x, z);
        if (Math.abs(v) > f.width / 2 + 0.5 || u < 0 || u > f.lipU + 0.8) continue;
        return f.lipU - u;
      }
      return Infinity;
    },
  };

  // ── meshes ──
  const group = new THREE.Group();
  group.userData.tag = "park";
  const parkSnow = snowMaterial.clone();
  parkSnow.onBeforeCompile = snowMaterial.onBeforeCompile;
  parkSnow.customProgramCacheKey = snowMaterial.customProgramCacheKey;
  parkSnow.polygonOffset = true;
  parkSnow.polygonOffsetFactor = -2;
  parkSnow.polygonOffsetUnits = -2;
  const dye = new THREE.MeshStandardMaterial({ color: 0x1b5fd0, roughness: 0.7 });
  const banner = makeBannerTexture("BIG MOUNTAIN", { sub: "TERRAIN PARK", bg: "#f4f6fa", fg: "#0d2d55", accent: "#ff6a10" });
  const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.6, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.9, roughness: 0.35, map: makeStripeTexture() });
  for (const f of features) {
    if (f.type === "kicker") group.add(kickerMesh(f, sampler, parkSnow, dye, bannerMat));
    else group.add(jibMesh(f, sampler, metal, parkSnow));
  }
  scene.add(group);
  return { ...api, group };
}

function makeStripeTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#cfd5dc";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#b9c0c8";
  for (let i = 0; i < 64; i += 4) g.fillRect(0, i, 64, 1);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function kickerMesh(f, sampler, snowMat, dyeMat, bannerMat) {
  const g = new THREE.Group();
  g.userData.tag = "kicker";
  const side = f.H * 1.3 + 0.6;
  const u0 = -1;
  const u1 = f.length + 1;
  const v0 = -(f.width / 2 + side);
  const v1 = -v0;
  const du = 0.45;
  const dv = 0.45;
  const cols = Math.ceil((v1 - v0) / dv) + 1;
  const rows = Math.ceil((u1 - u0) / du) + 1;
  const pos = new Float32Array(cols * rows * 3);
  const groom = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const world = (u, v) => [f.x + f.tx * u - f.tz * v, f.z + f.tz * u + f.tx * v];
  for (let r = 0; r < rows; r++) {
    const u = u0 + r * du;
    for (let c = 0; c < cols; c++) {
      const v = v0 + c * dv;
      const [x, z] = world(u, v);
      const h = sampler.heightAt(x, z) + f.rel(u, v);
      const k = r * cols + c;
      pos[k * 3] = x;
      pos[k * 3 + 1] = h + 0.015;
      pos[k * 3 + 2] = z;
      groom[k * 3] = 0.8;
      groom[k * 3 + 1] = f.tx;
      groom[k * 3 + 2] = f.tz;
      uvs[k * 2] = x / 8;
      uvs[k * 2 + 1] = z / 8;
    }
  }
  const idx = [];
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, b, e, a, e, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aGroom", new THREE.BufferAttribute(groom, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Winding check: normals must point up.
  const n = geo.attributes.normal;
  let up = 0;
  for (let i = 0; i < n.count; i++) up += n.getY(i);
  if (up < 0) {
    const ix = geo.index.array;
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
    geo.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(geo, snowMat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.tag = "kicker";
  g.add(mesh);
  // Blue dye line across the lip.
  const lipW = f.width;
  const [lx, lz] = world(f.lr - 0.15, 0);
  const lipY = sampler.heightAt(lx, lz) + f.rel(f.lr - 0.15, 0) + 0.03;
  const line = new THREE.Mesh(new THREE.BoxGeometry(lipW, 0.03, 0.35), dyeMat);
  line.position.set(lx, lipY, lz);
  line.rotation.y = Math.atan2(f.tx, f.tz);
  line.rotation.x = -f.theta * 0.95;
  line.userData.tag = "kicker-dye";
  g.add(line);
  // Branded banner on both side walls of the table.
  for (const s of [-1, 1]) {
    const um = f.lr + 3;
    const [bx, bz] = world(um, s * (f.width / 2 + f.H * 0.55));
    const by = sampler.heightAt(bx, bz) + f.H * 0.5;
    const b = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(8, f.length * 0.35), f.H * 0.55), bannerMat);
    b.position.set(bx, by, bz);
    b.rotation.y = Math.atan2(f.tx, f.tz) + (s > 0 ? -Math.PI / 2 : Math.PI / 2);
    b.rotation.x = 0;
    b.userData.tag = "kicker-banner";
    g.add(b);
  }
  return g;
}

/**
 * The packed-snow feed ramp in front of a jib, in world space: it rises from the snow to just
 * under the jib's start, its sides dropping into the snow (matches `rel` of the ramp).
 */
function feedRampGeometry(f, sampler) {
  const half = f.length / 2;
  const w = f.rampW / 2;
  const at = (u, v) => [f.x + f.tx * u - f.tz * v, f.z + f.tz * u + f.tx * v];
  const vert = (u, v, rel) => {
    const [x, z] = at(u, v);
    return [x, sampler.heightAt(x, z) + rel, z];
  };
  const u0 = -half - f.ramp;
  const u1 = -half;
  const top = f.height - 0.04;
  const P = {
    bl: vert(u0, -w, 0), br: vert(u0, w, 0),
    tl: vert(u1, -w, top), tr: vert(u1, w, top),
    bl2: vert(u0, -w, -0.5), br2: vert(u0, w, -0.5),
    fl: vert(u1, -w, -0.5), fr: vert(u1, w, -0.5),
  };
  const tris = [
    ["bl", "tr", "tl"], ["bl", "br", "tr"],
    ["bl2", "tl", "fl"], ["bl2", "bl", "tl"],
    ["br2", "tr", "br"], ["br2", "fr", "tr"],
    ["fl", "tr", "fr"], ["fl", "tl", "tr"],
  ];
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((k, j) => pos.set(P[k], i * 9 + j * 3)));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const n = pos.length / 3;
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const groom = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) groom[i * 3] = 1; // packed, groomed snow
  g.setAttribute("aGroom", new THREE.BufferAttribute(groom, 3));
  g.computeVertexNormals();
  // Face the slope up (winding check: the ramp top must point skyward).
  const nrm = g.getAttribute("normal");
  if (nrm.getY(0) < 0) {
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = pos[i + 3 + k];
        pos[i + 3 + k] = pos[i + 6 + k];
        pos[i + 6 + k] = t;
      }
    }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

/** A box or rail built along its straight top line (shared with the physics), legs into the snow. */
function jibMesh(f, sampler, metal, snowMat) {
  const g = new THREE.Group();
  g.userData.tag = f.type;
  const paint = new THREE.MeshStandardMaterial({ color: f.color ?? 0xd8262c, roughness: 0.45, metalness: 0.2, map: metal.map });
  const half = f.length / 2;
  const len3 = Math.hypot(f.length, f.y1 - f.y0);
  const pitch = Math.atan2(f.y0 - f.y1, f.length);
  // Frame at the centre of the top line: local z along the run, y up (pitched with the line).
  const holder = new THREE.Group();
  holder.position.set(f.x, (f.y0 + f.y1) / 2, f.z);
  holder.rotation.order = "YXZ";
  holder.rotation.y = Math.atan2(f.tx, f.tz);
  holder.rotation.x = pitch;
  if (f.type === "box") {
    const top = new THREE.Mesh(new THREE.BoxGeometry(f.width, 0.08, len3), new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.35, map: metal.map }));
    top.position.y = -0.04;
    const bodyH = f.height + 0.6;
    const body = new THREE.Mesh(new THREE.BoxGeometry(f.width * 0.92, bodyH, len3 * 0.98), paint);
    body.position.y = -0.08 - bodyH / 2;
    for (const m of [top, body]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.tag = "box";
      holder.add(m);
    }
  } else {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len3, 12), metal);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = -0.05;
    rail.castShadow = true;
    rail.userData.tag = "rail";
    holder.add(rail);
    // Legs: straight down from the rail into the snow.
    for (const s of [-0.42, 0, 0.42]) {
      const u = s * f.length;
      const x = f.x + f.tx * u;
      const z = f.z + f.tz * u;
      const topY = f.topAt(u) - 0.08;
      const botY = sampler.heightAt(x, z) - 0.3;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, topY - botY, 8), paint);
      leg.position.set(x, (topY + botY) / 2, z);
      leg.castShadow = true;
      leg.userData.tag = "rail";
      g.add(leg);
    }
  }
  g.add(holder);
  const ramp = new THREE.Mesh(feedRampGeometry(f, sampler), snowMat);
  ramp.receiveShadow = true;
  ramp.castShadow = true;
  ramp.userData.tag = "feed-ramp";
  g.add(ramp);
  return g;
}
