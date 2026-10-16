/**
 * Resort props: the chairlift (towers, sagging cables, moving 4-seat chairs, terminals), orange
 * safety netting and bamboo markers along run edges, trail signs, the team start gates at the
 * summit and the timber base lodge. Everything is instanced or merged to keep draw calls low.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { standardMaterial } from "../materials.js";
import { makeNetTexture, makeBannerTexture } from "./textures.js";
import { applySunVis } from "./shading.js";
import { LIFT } from "./world.js";

const TOWER_SPACING = 88;
const CABLE_HALF = 2.7; // up/down lines either side of the centreline
const CHAIR_GAP = 34;
const LIFT_SPEED = 4.2; // m/s along the cable

function lit(mat, trees = true) {
  applySunVis(mat, { trees });
  return mat;
}

export function createProps(scene, world, ground) {
  const group = new THREE.Group();
  group.userData.tag = "props";
  scene.add(group);
  const steel = lit(standardMaterial({ kind: "metal", seed: 4, palette: [0x2f3439, 0x41474e, 0x555c64], roughness: 0.55, metalness: 0.6 }));
  const yellow = lit(standardMaterial({ kind: "metal", seed: 9, palette: [0xc79a14, 0xe0b31f, 0xf0c63a], roughness: 0.5, metalness: 0.3 }));
  const lift = buildLift(group, ground, steel, yellow);
  buildEdges(group, world, ground);
  buildSigns(group, world, ground);
  buildGates(group, world, ground);
  const lodgeAt = { x: LIFT.base.x - 150, z: LIFT.base.z + 40 };
  buildLodge(group, ground, lodgeAt.x, lodgeAt.z);
  const obstacles = lift.towers.map((t) => ({ x: t.x, z: t.z, r: 0.55, top: t.gy + t.h }));
  for (let i = -3; i <= 3; i++) {
    obstacles.push({ x: lodgeAt.x + i * 5 * Math.cos(0.15), z: lodgeAt.z - i * 5 * Math.sin(0.15), r: 9, top: ground.ground(lodgeAt.x, lodgeAt.z) + 18 });
  }
  return {
    group,
    obstacles,
    lift,
    update(time) {
      lift.update(time);
    },
  };
}

// ── chairlift ──
function buildLift(group, ground, steel, yellow) {
  const a = LIFT.base;
  const b = LIFT.top;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const dir = new THREE.Vector2((b.x - a.x) / len, (b.z - a.z) / len);
  const side = new THREE.Vector2(-dir.y, dir.x);
  const yaw = Math.atan2(dir.x, dir.y);
  // Towers: evenly spaced, tall enough that the cable clears the snow by ≥ 9 m.
  const n = Math.round(len / TOWER_SPACING);
  const towers = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * len;
    const x = a.x + dir.x * s;
    const z = a.z + dir.y * s;
    const gy = ground.ground(x, z);
    towers.push({ s, x, z, gy, h: 11 });
  }
  // Raise towers where the span between them would scrape the hill.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < towers.length - 1; i++) {
      const t0 = towers[i];
      const t1 = towers[i + 1];
      for (let k = 1; k < 10; k++) {
        const f = k / 10;
        const x = t0.x + (t1.x - t0.x) * f;
        const z = t0.z + (t1.z - t0.z) * f;
        const cable = cableHeight(t0, t1, f) - 2.8; // chair bottom below the cable
        const clear = cable - ground.ground(x, z);
        if (clear < 6) {
          t0.h += (6 - clear) * 0.6;
          t1.h += (6 - clear) * 0.6;
        }
      }
    }
  }
  function cableHeight(t0, t1, f) {
    const y0 = t0.gy + t0.h;
    const y1 = t1.gy + t1.h;
    const span = Math.hypot(t1.x - t0.x, t1.z - t0.z);
    return y0 + (y1 - y0) * f - 4 * (span * 0.012) * f * (1 - f);
  }
  /** Cable point at distance s along the line (0 = base). */
  function cableAt(s) {
    const i = Math.min(towers.length - 2, Math.max(0, Math.floor((s / len) * n)));
    const t0 = towers[i];
    const t1 = towers[i + 1];
    const f = (s - t0.s) / (t1.s - t0.s);
    return { x: a.x + dir.x * s, z: a.z + dir.y * s, y: cableHeight(t0, t1, Math.min(1, Math.max(0, f))) };
  }

  // Tower geometry (unit height 1 for the pole; crossarm and sheaves added at the top).
  const towerParts = [];
  for (const t of towers) {
    const pole = new THREE.CylinderGeometry(0.28, 0.42, t.h, 10, 1);
    pole.translate(0, t.h / 2, 0);
    const arm = new THREE.BoxGeometry(CABLE_HALF * 2 + 1.4, 0.45, 0.5);
    arm.translate(0, t.h + 0.2, 0);
    const parts = [pole, arm];
    for (const sx of [-CABLE_HALF, CABLE_HALF]) {
      const beam = new THREE.BoxGeometry(0.25, 0.3, 3.2);
      beam.translate(sx, t.h - 0.25, 0);
      parts.push(beam);
      for (const sz of [-1.2, -0.4, 0.4, 1.2]) {
        const wheel = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12);
        wheel.rotateZ(Math.PI / 2);
        wheel.translate(sx, t.h - 0.45, sz);
        parts.push(wheel);
      }
    }
    // Ladder rails.
    const rail = new THREE.BoxGeometry(0.05, t.h - 1, 0.05);
    rail.translate(0.48, t.h / 2, 0.15);
    parts.push(rail);
    const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
    g.rotateY(yaw);
    g.translate(t.x, t.gy - 0.6, t.z);
    towerParts.push(g);
  }
  const towerMesh = new THREE.Mesh(mergeGeometries(towerParts), steel);
  towerMesh.castShadow = true;
  towerMesh.receiveShadow = true;
  towerMesh.userData.tag = "lift-tower";
  group.add(towerMesh);

  // Cables: each span as a thin sagging tube, both lines.
  const cableGeos = [];
  for (const sgn of [-1, 1]) {
    const pts = [];
    for (let i = 0; i < towers.length - 1; i++) {
      for (let k = 0; k < 12; k++) {
        const f = k / 12;
        const t0 = towers[i];
        const t1 = towers[i + 1];
        const x = t0.x + (t1.x - t0.x) * f + side.x * CABLE_HALF * sgn;
        const z = t0.z + (t1.z - t0.z) * f + side.y * CABLE_HALF * sgn;
        pts.push(new THREE.Vector3(x, cableHeight(t0, t1, f) - 0.25, z));
      }
    }
    const last = towers[towers.length - 1];
    pts.push(new THREE.Vector3(last.x + side.x * CABLE_HALF * sgn, last.gy + last.h - 0.25, last.z + side.y * CABLE_HALF * sgn));
    const curve = new THREE.CatmullRomCurve3(pts);
    cableGeos.push(new THREE.TubeGeometry(curve, pts.length * 2, 0.035, 5, false));
  }
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.4, metalness: 0.8, map: steel.map });
  const cables = new THREE.Mesh(mergeGeometries(cableGeos), cableMat);
  cables.userData.tag = "lift-cable";
  group.add(cables);

  // Chairs: one merged chair geometry, instanced along both lines.
  const chairParts = [];
  const hanger = new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6);
  hanger.translate(0, -1.2, 0);
  chairParts.push(hanger);
  const grip = new THREE.BoxGeometry(0.18, 0.22, 0.45);
  chairParts.push(grip);
  const yoke = new THREE.BoxGeometry(2.1, 0.07, 0.07);
  yoke.translate(0, -2.4, 0);
  chairParts.push(yoke);
  for (const sx of [-1.02, 1.02]) {
    const arm = new THREE.BoxGeometry(0.06, 0.6, 0.06);
    arm.translate(sx, -2.65, 0.2);
    chairParts.push(arm);
  }
  const seat = new THREE.BoxGeometry(2.1, 0.09, 0.55);
  seat.translate(0, -2.95, 0.3);
  const back = new THREE.BoxGeometry(2.1, 0.55, 0.08);
  back.translate(0, -2.62, 0.58);
  const bar = new THREE.BoxGeometry(2.0, 0.05, 0.05);
  bar.translate(0, -2.45, -0.25);
  const foot = new THREE.BoxGeometry(1.8, 0.05, 0.25);
  foot.translate(0, -3.45, -0.1);
  chairParts.push(bar, foot);
  const frameGeo = mergeGeometries(chairParts.map((p) => p.toNonIndexed()));
  const padGeo = mergeGeometries([seat.toNonIndexed(), back.toNonIndexed()]);
  const count = Math.floor((len * 2) / CHAIR_GAP);
  const chairFrame = new THREE.InstancedMesh(frameGeo, steel, count);
  const pad = lit(standardMaterial({ kind: "cloth", seed: 12, palette: [0x0d2a5a, 0x173a74, 0x22488a], roughness: 0.7 }));
  const chairPad = new THREE.InstancedMesh(padGeo, pad, count);
  for (const m of [chairFrame, chairPad]) {
    m.castShadow = true;
    m.userData.tag = "lift-chair";
    m.frustumCulled = false;
    group.add(m);
  }
  // Terminals: housings at both ends.
  for (const [end, t] of [["base", towers[0]], ["top", towers[towers.length - 1]]]) {
    const house = new THREE.Group();
    house.userData.tag = "lift-terminal";
    const body = new THREE.Mesh(new THREE.BoxGeometry(CABLE_HALF * 2 + 3, 3.2, 9), yellow);
    body.position.y = t.h - 1.2;
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(CABLE_HALF + 0.3, CABLE_HALF + 0.3, 0.5, 28), steel);
    wheel.position.set(0, t.h - 0.3, end === "base" ? -3.2 : 3.2);
    const col = new THREE.Mesh(new THREE.BoxGeometry(1.2, t.h - 2.8, 1.2), steel);
    col.position.y = (t.h - 2.8) / 2;
    const roofSnow = new THREE.Mesh(new THREE.BoxGeometry(CABLE_HALF * 2 + 3.3, 0.35, 9.3), new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 0.85, map: steel.map }));
    roofSnow.position.y = t.h + 0.55;
    for (const m of [body, wheel, col, roofSnow]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.tag = "lift-terminal";
      house.add(m);
    }
    house.position.set(t.x, t.gy - 0.5, t.z);
    house.rotation.y = yaw;
    group.add(house);
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  const loop = len * 2;
  return {
    towers,
    length: len,
    cableAt,
    update(time) {
      // Chairs ride up the right-hand line and down the left, wrapping round the bullwheels.
      for (let i = 0; i < count; i++) {
        const u = (((i * CHAIR_GAP + time * LIFT_SPEED) % loop) + loop) % loop;
        const up = u < len;
        const s = up ? u : loop - u;
        const c = cableAt(s);
        const sg = up ? 1 : -1;
        pos.set(c.x + side.x * CABLE_HALF * sg, c.y - 0.25, c.z + side.y * CABLE_HALF * sg);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + (up ? Math.PI : 0));
        m4.compose(pos, q, one);
        chairFrame.setMatrixAt(i, m4);
        chairPad.setMatrixAt(i, m4);
      }
      chairFrame.instanceMatrix.needsUpdate = true;
      chairPad.instanceMatrix.needsUpdate = true;
    },
  };
}

// ── run edges: orange netting where it matters, bamboo markers elsewhere ──
function buildEdges(group, world, ground) {
  const netTex = makeNetTexture();
  const netMat = new THREE.MeshStandardMaterial({ map: netTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 });
  lit(netMat);
  const postGeo = new THREE.CylinderGeometry(0.035, 0.04, 1.7, 6);
  postGeo.translate(0, 0.85, 0);
  const posts = [];
  const netPos = [];
  const netUv = [];
  const netIdx = [];
  const bamboo = [];
  const park = world.mountain.trails.find((t) => t.id === "champagne");
  const netRanges = [
    { trail: "champagne", z0: -120, z1: 330 },
    { trail: "champagne", z0: -760, z1: -620 },
    { trail: "ridge-runner", z0: -420, z1: -250 },
    { trail: "storm-bowl", z0: 80, z1: 240 },
    { trail: "ridge-runner", z0: 440, z1: 600 },
  ];
  for (const trail of world.mountain.trails) {
    if (trail.path.length < 200) continue;
    for (const sideSign of [-1, 1]) {
      let run = null;
      for (let i = 0; i < trail.path.length; i += 1) {
        const p = trail.path[i];
        const netted = netRanges.some((r) => r.trail === trail.id && p.z > r.z0 && p.z < r.z1);
        const off = p.w + 2.5;
        const x = p.x - p.tz * off * sideSign;
        const z = p.z + p.tx * off * sideSign;
        if (netted) {
          if (!run) run = [];
          if (i % 1 === 0) run.push([x, z]);
        } else {
          if (run && run.length > 2) addNet(run);
          run = null;
          // Bamboo poles every ~24 m on the groomers' edges.
          if (trail.groomed && i % 6 === 0) bamboo.push([x, z]);
        }
      }
      if (run && run.length > 2) addNet(run);
    }
  }
  function addNet(run) {
    // Posts every ~3 posts of 4 m path step; the net ribbon follows the snow.
    let u = 0;
    for (let k = 0; k < run.length; k++) {
      const [x, z] = run[k];
      const y = ground.ground(x, z);
      if (k > 0) u += Math.hypot(x - run[k - 1][0], z - run[k - 1][1]);
      const base = netPos.length / 3;
      netPos.push(x, y + 0.15, z, x, y + 1.55, z);
      netUv.push(u / 4, 0, u / 4, 1);
      if (k > 0) netIdx.push(base - 2, base, base + 1, base - 2, base + 1, base - 1);
      if (k % 1 === 0) posts.push([x, y, z]);
    }
  }
  if (netPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(netPos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(netUv, 2));
    g.setIndex(netIdx);
    g.computeVertexNormals();
    const net = new THREE.Mesh(g, netMat);
    net.castShadow = true;
    net.receiveShadow = true;
    net.userData.tag = "safety-net";
    group.add(net);
  }
  const postMat = lit(standardMaterial({ kind: "metal", seed: 21, palette: [0x2c2c2c, 0x3a3a3a, 0x4a4a4a], roughness: 0.6 }));
  const postMesh = new THREE.InstancedMesh(postGeo, postMat, Math.max(1, posts.length));
  const m4 = new THREE.Matrix4();
  posts.forEach(([x, y, z], i) => {
    m4.makeTranslation(x, y - 0.1, z);
    postMesh.setMatrixAt(i, m4);
  });
  postMesh.count = posts.length;
  postMesh.castShadow = true;
  postMesh.userData.tag = "safety-net";
  group.add(postMesh);
  // Bamboo: orange-and-black tipped poles.
  const bambooGeo = new THREE.CylinderGeometry(0.03, 0.035, 2.2, 6);
  bambooGeo.translate(0, 0.9, 0);
  const bc = document.createElement("canvas");
  bc.width = 8;
  bc.height = 64;
  const bg = bc.getContext("2d");
  bg.fillStyle = "#e0b977";
  bg.fillRect(0, 0, 8, 64);
  bg.fillStyle = "#ff5a00";
  bg.fillRect(0, 0, 8, 10);
  bg.fillStyle = "#111";
  bg.fillRect(0, 10, 8, 6);
  const bt = new THREE.CanvasTexture(bc);
  bt.colorSpace = THREE.SRGBColorSpace;
  const bambooMat = lit(new THREE.MeshStandardMaterial({ map: bt, roughness: 0.7 }));
  const bambooMesh = new THREE.InstancedMesh(bambooGeo, bambooMat, Math.max(1, bamboo.length));
  bamboo.forEach(([x, z], i) => {
    const y = ground.ground(x, z);
    m4.makeRotationZ(((i * 37) % 11 - 5) * 0.012).setPosition(x, y - 0.3, z);
    bambooMesh.setMatrixAt(i, m4);
  });
  bambooMesh.count = bamboo.length;
  bambooMesh.castShadow = true;
  bambooMesh.userData.tag = "trail-marker";
  group.add(bambooMesh);
  return { posts: posts.length, bamboo: bamboo.length, park };
}

// ── trail signs at the top of each run ──
function signTexture(name, symbol) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 160;
  const g = c.getContext("2d");
  g.fillStyle = "#f4f1e8";
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = "#20242a";
  g.lineWidth = 10;
  g.strokeRect(5, 5, 502, 150);
  g.fillStyle = "#14181d";
  g.font = "900 64px Arial, sans-serif";
  g.textBaseline = "middle";
  g.fillText(name.toUpperCase(), 150, 82);
  if (symbol === "black") {
    g.fillStyle = "#111";
    g.beginPath();
    g.moveTo(80, 30);
    g.lineTo(125, 80);
    g.lineTo(80, 130);
    g.lineTo(35, 80);
    g.closePath();
    g.fill();
  } else if (symbol === "blue") {
    g.fillStyle = "#1a5fd1";
    g.fillRect(40, 38, 84, 84);
  } else {
    g.fillStyle = "#1f9a43";
    g.beginPath();
    g.arc(82, 80, 44, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildSigns(group, world, ground) {
  const wood = lit(standardMaterial({ kind: "wood", seed: 31, palette: [0x4a3621, 0x6a4d31, 0x8a6a46], roughness: 0.9 }));
  for (const trail of world.mountain.trails) {
    const p = trail.path[Math.min(trail.path.length - 1, 8)];
    const off = p.w + 4;
    const x = p.x + -p.tz * off;
    const z = p.z + p.tx * off;
    const y = ground.ground(x, z);
    const symbol = trail.groomed ? (trail.path.length < 200 ? "green" : "blue") : "black";
    const sign = new THREE.Group();
    sign.userData.tag = "trail-sign";
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), wood);
    post.position.y = 1.3;
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 0.06), [wood, wood, wood, wood, lit(new THREE.MeshStandardMaterial({ map: signTexture(trail.name, symbol), roughness: 0.6 })), wood]);
    board.position.set(0, 2.25, 0.08);
    for (const m of [post, board]) {
      m.castShadow = true;
      m.userData.tag = "trail-sign";
      sign.add(m);
    }
    sign.position.set(x, y - 0.3, z);
    // Face uphill (toward riders coming down).
    sign.rotation.y = Math.atan2(-p.tx, -p.tz);
    group.add(sign);
  }
}

// ── start gates at the summit (blue team west, red team east) ──
function buildGates(group, world, ground) {
  const trails = world.mountain.trails;
  const defs = [
    { trail: trails.find((t) => t.id === "storm-bowl"), color: "#1f6fe0", text: "BLUE TEAM" },
    { trail: trails.find((t) => t.id === "ridge-runner"), color: "#d92b2b", text: "RED TEAM" },
  ];
  for (const d of defs) {
    const p = d.trail.path[3];
    const banner = makeBannerTexture("DROP IN", { bg: d.color, fg: "#ffffff", accent: "#ffd35a", sub: d.text });
    const bannerMat = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.7, side: THREE.DoubleSide });
    lit(bannerMat);
    const tubeMat = lit(new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.45, map: banner }));
    const gate = new THREE.Group();
    gate.userData.tag = "start-gate";
    const width = 14;
    // Inflatable arch: a torus segment.
    const arch = new THREE.Mesh(new THREE.TorusGeometry(width / 2, 0.55, 12, 40, Math.PI), tubeMat);
    arch.castShadow = true;
    arch.userData.tag = "start-gate";
    gate.add(arch);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 1.9), bannerMat);
    sign.position.set(0, width / 2 - 0.2, 0.6);
    sign.userData.tag = "start-gate";
    gate.add(sign);
    const y = ground.ground(p.x, p.z);
    gate.position.set(p.x, y - 0.3, p.z);
    gate.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;
    group.add(gate);
  }
}

// ── base lodge ──
function buildLodge(group, ground, x, z) {
  const lodge = new THREE.Group();
  lodge.userData.tag = "lodge";
  const timber = lit(standardMaterial({ kind: "wood", seed: 44, palette: [0x3e2a18, 0x5a3e24, 0x7a5636], roughness: 0.85 }));
  const stone = lit(standardMaterial({ kind: "stone", seed: 45, palette: [0x55524c, 0x75716a, 0x96918a], roughness: 0.9 }));
  const snowRoof = lit(new THREE.MeshStandardMaterial({ color: 0xf3f6fb, roughness: 0.82, map: timber.map }));
  const glass = new THREE.MeshStandardMaterial({ color: 0x2a2014, emissive: 0xffa040, emissiveIntensity: 1.3, roughness: 0.2, map: timber.map });
  const W = 34;
  const D = 18;
  const H = 8;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, 2.2, D), stone);
  base.position.y = 1.1;
  const walls = new THREE.Mesh(new THREE.BoxGeometry(W - 1, H, D - 1), timber);
  walls.position.y = 2.2 + H / 2;
  lodge.add(base, walls);
  // Gabled roof with a thick snow load.
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-D / 2 - 2, 0);
  roofShape.lineTo(0, 7);
  roofShape.lineTo(D / 2 + 2, 0);
  roofShape.lineTo(-D / 2 - 2, 0);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: W + 3, bevelEnabled: false });
  roofGeo.translate(0, 0, -(W + 3) / 2);
  roofGeo.rotateY(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, snowRoof);
  roof.position.y = 2.2 + H;
  lodge.add(roof);
  // Rows of warm windows on both long sides.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.6, 0.2), glass);
      win.position.set(-W / 2 + 3.5 + i * 4.5, 5.2, s * (D / 2 - 0.4));
      lodge.add(win);
    }
  }
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.6, 6, 1.6), stone);
  chimney.position.set(W / 4, 2.2 + H + 4, 0);
  lodge.add(chimney);
  lodge.traverse((m) => {
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.tag = "lodge";
    }
  });
  lodge.position.set(x, ground.ground(x, z) - 0.6, z);
  lodge.rotation.y = 0.15;
  group.add(lodge);
}
