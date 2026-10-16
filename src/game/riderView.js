/**
 * Third-person riders. Bodies are RIGID PARTS (the Blender exporter can't carry skeletons), each
 * placed every frame from a procedural pose: legs and arms by two-bone IK, the torso twisting
 * toward the aim, the head following it, the gun held out along the aim with both hands on it.
 * Skis/board follow the heading and the slope; flips and spins rotate the whole body.
 *
 * Parts come from the Blender GLBs when loaded (`setParts`), else from simple fallback shapes.
 */
import * as THREE from "three";
import { clamp } from "../core/noise.js";
import { applySunVis, patch } from "../world/shading.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { bakeTexture } from "../materials.js";

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Merge [geometry, material, matrix?] pieces into ONE geometry that carries each piece's colour
 * and roughness/metalness per vertex — a rider becomes ~20 draw calls instead of ~55.
 */
function mergeColored(list) {
  const geos = [];
  for (const [geo, mat, matrix] of list) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", g.attributes.position);
    if (g.attributes.normal) ng.setAttribute("normal", g.attributes.normal);
    else ng.computeVertexNormals();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const pbr = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    const c = mat?.color ?? WHITE;
    const r = mat?.roughness ?? 0.7;
    const m = mat?.metalness ?? 0;
    const pos = g.attributes.position;
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      pbr[i * 2] = r;
      pbr[i * 2 + 1] = m;
      // Box-ish projection for a subtle fabric grain.
      uv[i * 2] = (pos.getX(i) + pos.getZ(i)) * 3.5;
      uv[i * 2 + 1] = pos.getY(i) * 3.5;
    }
    ng.setAttribute("color", new THREE.BufferAttribute(col, 3));
    ng.setAttribute("aPbr", new THREE.BufferAttribute(pbr, 2));
    ng.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geos.push(ng);
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos);
  merged.computeBoundingSphere();
  return merged;
}

let GRAIN = null;
/** Vertex-coloured PBR material (roughness/metalness from the aPbr attribute). */
function vertexPbrMaterial(key) {
  GRAIN = GRAIN ?? bakeTexture({ kind: "cloth", seed: 17, size: 128, palette: [0xe4e4e4, 0xf2f2f2, 0xffffff], repeat: 1 }).map;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, map: GRAIN });
  m.userData.baked = "cloth";
  patch(m, "vpbr", (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aPbr;\nvarying vec2 vPbr;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPbr = aPbr;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vPbr;")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vPbr.x;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vPbr.y;");
  });
  applySunVis(m, { trees: true });
  m.name = key;
  return m;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Joint layout of the rest pose (metres, matching the Blender rider spec). */
export const BODY = {
  hip: 0.95,
  waist: 1.02,
  neck: 1.5,
  shoulderX: 0.2,
  shoulderY: 1.42,
  thigh: 0.42,
  shin: 0.4,
  upperArm: 0.29,
  forearm: 0.25,
  hipX: 0.1,
  ankle: 0.1,
};

const TEAM_COLORS = {
  blue: [0x1f6fe0, 0x2a9df4, 0x0f4fa8, 0x39b4ff, 0x2456c8, 0x6a8cff],
  red: [0xe03a1e, 0xff7a12, 0xc81e2e, 0xff4f2e, 0xe8661a, 0xd02a5a],
};
const PANTS = [0x22262e, 0x2d3a4f, 0x1c1c22, 0x4a4f58, 0x3b2f2a, 0x283848];
const HELMETS = [0x111418, 0xf2f4f7, 0x1d2430, 0x8a929c];

/**
 * Team rim light + hit flash: a fresnel edge in the team colour keeps riders readable against
 * bright snow (a standard AAA readability trick); `hit` flashes the body when it takes a round.
 */
function applyRim(mat, rimColor, hit, shield = { value: 0 }) {
  return patch(mat, "rim", (shader) => {
    shader.uniforms.uRim = { value: rimColor };
    shader.uniforms.uHit = hit;
    shader.uniforms.uShield = shield;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;\nuniform float uHit;\nuniform float uShield;")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
          // Team rim, the red hit flash, and a cool shimmer on the silhouette while spawn-protected.
          totalEmissiveRadiance += uRim * fres * 0.55 + vec3(1.0, 0.3, 0.22) * uHit * 0.9 + vec3(0.55, 0.8, 1.0) * (0.25 + fres * 1.6) * uShield;
        }`,
      );
  });
}

/** A floating name tag (scene sprite): team colour, dark outline, chevron under it. */
function nameplate(name, color) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d");
  g.font = '700 64px "DIN Condensed", "DIN Alternate", "Avenir Next Condensed", "Arial Narrow", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 10;
  g.strokeStyle = "rgba(0,0,0,0.75)";
  g.strokeText(name, 256, 48);
  g.fillStyle = color;
  g.fillText(name, 256, 48);
  g.beginPath();
  g.moveTo(240, 96);
  g.lineTo(272, 96);
  g.lineTo(256, 116);
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, fog: false }));
  s.scale.set(0.16, 0.04, 1);
  s.renderOrder = 20;
  s.userData.tag = "nameplate";
  return s;
}

/** Fallback part shapes (used until/unless the Blender parts arrive). */
function fallbackParts() {
  const cap = (r, len) => {
    const g = new THREE.CapsuleGeometry(r, len, 4, 10);
    g.translate(0, -len / 2, 0);
    return g;
  };
  const torso = new THREE.CapsuleGeometry(0.2, 0.32, 6, 12);
  torso.translate(0, 0.26, 0);
  torso.scale(1.1, 1, 0.8);
  const pelvis = new THREE.SphereGeometry(0.19, 12, 8);
  pelvis.scale(1.1, 0.7, 0.85);
  const head = new THREE.SphereGeometry(0.15, 16, 12);
  head.translate(0, 0.14, 0);
  const goggle = new THREE.SphereGeometry(0.152, 16, 8, -0.9, 1.8, 1.1, 0.5);
  goggle.rotateY(Math.PI);
  goggle.translate(0, 0.15, 0);
  const pack = new THREE.BoxGeometry(0.28, 0.36, 0.12);
  pack.translate(0, 0.3, 0.2);
  const boot = new THREE.BoxGeometry(0.12, 0.2, 0.3);
  boot.translate(0, -0.02, -0.04);
  const hand = new THREE.SphereGeometry(0.055, 10, 8);
  hand.translate(0, -0.04, 0);
  return {
    Pelvis: [[pelvis, "Pants"]],
    Torso: [[torso, "Jacket"]],
    Head: [[head, "Helmet"], [goggle, "GoggleLens"]],
    Backpack: [[pack, "Backpack"]],
    UpperArmL: [[cap(0.065, 0.24), "Jacket"]],
    UpperArmR: [[cap(0.065, 0.24), "Jacket"]],
    ForearmL: [[cap(0.055, 0.2), "Jacket"]],
    ForearmR: [[cap(0.055, 0.2), "Jacket"]],
    HandL: [[hand, "Glove"]],
    HandR: [[hand, "Glove"]],
    ThighL: [[cap(0.085, 0.34), "Pants"]],
    ThighR: [[cap(0.085, 0.34), "Pants"]],
    ShinL: [[cap(0.075, 0.32), "Pants"]],
    ShinR: [[cap(0.075, 0.32), "Pants"]],
    BootL: [[boot, "Boot"]],
    BootR: [[boot, "Boot"]],
  };
}

const PART_NAMES = [
  "Pelvis", "Torso", "Head", "Backpack", "UpperArmL", "UpperArmR", "ForearmL", "ForearmR",
  "HandL", "HandR", "ThighL", "ThighR", "ShinL", "ShinR", "BootL", "BootR",
];

const norm = (s) => String(s).replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Shared materials per slot name; team colours are applied per rider by cloning the tintables. */
function baseMaterials() {
  const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0 });
  const mats = {
    Jacket: cloth,
    JacketTrim: new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7 }),
    Pants: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.82 }),
    Helmet: new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.32, metalness: 0.1 }),
    GoggleFrame: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.5 }),
    GoggleLens: new THREE.MeshStandardMaterial({ color: 0xff9a2a, roughness: 0.05, metalness: 1 }),
    Gaiter: new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95 }),
    Glove: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.72 }),
    Boot: new THREE.MeshStandardMaterial({ color: 0xc9cdd3, roughness: 0.38 }),
    Buckle: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 1 }),
    Backpack: new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.85 }),
  };
  for (const m of Object.values(mats)) applySunVis(m, { trees: true });
  return mats;
}

export function createRiderViews(scene, clothTexture, ground = null) {
  const mats = baseMaterials();
  if (clothTexture) {
    for (const k of ["Jacket", "Pants", "Backpack", "Gaiter", "Glove"]) {
      mats[k].map = clothTexture;
      mats[k].needsUpdate = true;
    }
  }
  let partGeo = null; // name → [[geometry, slot], ...]
  const mergedGear = {};
  const mergedGuns = {};
  let gearMat = null;
  const sharedGearMat = () => (gearMat = gearMat ?? vertexPbrMaterial("rider-gear"));
  let gearGeo = null; // { ski: [[g, slot]], board: [[g, slot]], pole }
  const gearMats = {};
  const views = new Map();
  const group = new THREE.Group();
  group.userData.tag = "riders";
  scene.add(group);

  /** Accept Blender parts: a map of normalised node name → THREE.Mesh (or Group of meshes). */
  function setParts(bodyNodes, gearNodes, gunModels) {
    const out = {};
    for (const name of PART_NAMES) {
      const node = bodyNodes.get(norm(name));
      if (!node) continue;
      const list = [];
      node.traverse((o) => {
        if (o.isMesh) list.push([o.geometry, o.material?.name || "Jacket", o.material]);
      });
      if (list.length) out[name] = list;
    }
    if (Object.keys(out).length >= 12) partGeo = out;
    if (gearNodes) gearGeo = gearNodes;
    if (gunModels) views.gunModels = gunModels;
    // Rebuild existing views with the new parts.
    for (const [ag, v] of views) {
      group.remove(v.root);
      if (v.tag) group.remove(v.tag);
      views.delete(ag);
    }
  }

  function materialFor(slot, fileMat, tint) {
    const key = slot.replace(/[^A-Za-z]/g, "");
    if (tint[key]) return tint[key];
    if (mats[key]) return mats[key];
    if (fileMat) {
      if (!fileMat.userData.sunvis) {
        applySunVis(fileMat, { trees: true });
        fileMat.userData.sunvis = true;
      }
      return fileMat;
    }
    return mats.Jacket;
  }

  function build(ag) {
    const seed = ag.id * 7 + (ag.team === "red" ? 3 : 0);
    const jacket = mats.Jacket.clone();
    jacket.color.setHex(TEAM_COLORS[ag.team][ag.id % 6]);
    jacket.onBeforeCompile = mats.Jacket.onBeforeCompile;
    jacket.customProgramCacheKey = mats.Jacket.customProgramCacheKey;
    const pants = mats.Pants.clone();
    pants.color.setHex(PANTS[seed % PANTS.length]);
    pants.onBeforeCompile = mats.Pants.onBeforeCompile;
    pants.customProgramCacheKey = mats.Pants.customProgramCacheKey;
    const helmet = mats.Helmet.clone();
    helmet.color.setHex(HELMETS[seed % HELMETS.length]);
    helmet.onBeforeCompile = mats.Helmet.onBeforeCompile;
    helmet.customProgramCacheKey = mats.Helmet.customProgramCacheKey;
    const lens = mats.GoggleLens.clone();
    lens.color.setHSL(((seed * 0.13) % 1 + 1) % 1, 0.9, 0.5);
    lens.onBeforeCompile = mats.GoggleLens.onBeforeCompile;
    lens.customProgramCacheKey = mats.GoggleLens.customProgramCacheKey;
    const hit = { value: 0 };
    const shield = { value: 0 };
    const rim = new THREE.Color(ag.team === "blue" ? 0x4aa8ff : 0xff5a3a);
    applyRim(jacket, rim, hit, shield);
    applyRim(pants, rim, hit, shield);
    applyRim(helmet, rim, hit, shield);
    const tint = { Jacket: jacket, Pants: pants, Helmet: helmet, GoggleLens: lens };
    const root = new THREE.Group();
    root.userData.tag = ag.isPlayer ? "player-body" : "enemy";
    root.userData.agent = ag.name;
    const parts = {};
    const src = partGeo ?? fallbackParts();
    const bodyMat = vertexPbrMaterial("rider-body");
    applyRim(bodyMat, rim, hit, shield);
    const tagName = ag.isPlayer ? "player-body" : ag.team === "red" ? "enemy" : "npc";
    for (const name of PART_NAMES) {
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      const pieces = [];
      for (const [geo, slot, fileMat] of src[name] ?? []) {
        const mat = materialFor(slot, fileMat, tint);
        if (/GoggleLens/.test(slot)) {
          const lensMesh = new THREE.Mesh(geo, mat);
          lensMesh.userData.tag = tagName;
          holder.add(lensMesh);
        } else pieces.push([geo, mat]);
      }
      const merged = mergeColored(pieces);
      if (merged) {
        const m = new THREE.Mesh(merged, bodyMat);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.tag = tagName;
        holder.add(m);
      }
      root.add(holder);
      parts[name] = holder;
    }
    // Skis / board.
    const gear = [];
    const makeGear = (key, fallback) => {
      const h = new THREE.Group();
      h.matrixAutoUpdate = false;
      const list = gearGeo?.[key];
      if (list) {
        if (!mergedGear[key]) mergedGear[key] = mergeColored(list.map(([geo, slot, fileMat]) => [geo, fileMat ?? materialFor(slot, null, {})]));
        const mesh = new THREE.Mesh(mergedGear[key], sharedGearMat());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.tag = ag.isPlayer ? "player-skis" : "npc-gear";
        h.add(mesh);
      } else {
        const mesh = new THREE.Mesh(fallback, new THREE.MeshStandardMaterial({ color: ag.team === "blue" ? 0x0d2148 : 0x4a0d0d, roughness: 0.35 }));
        mesh.castShadow = true;
        mesh.userData.tag = ag.isPlayer ? "player-skis" : "npc-gear";
        h.add(mesh);
      }
      root.add(h);
      gear.push(h);
      return h;
    };
    const skiGeo = new THREE.BoxGeometry(0.09, 0.025, 1.7);
    const boardGeo = new THREE.BoxGeometry(0.26, 0.02, 1.5);
    const skiL = makeGear("ski", skiGeo);
    const skiR = makeGear("ski", skiGeo);
    const board = makeGear("board", boardGeo);
    // Gun.
    const gunHolder = new THREE.Group();
    gunHolder.matrixAutoUpdate = false;
    root.add(gunHolder);
    group.add(root);
    const tag = ag.isPlayer ? null : nameplate(ag.name, ag.team === "blue" ? "#7cc0ff" : "#ff6b5a");
    if (tag) group.add(tag);
    const v = { root, parts, skiL, skiR, board, gunHolder, gunId: null, deadT: 0, lastAlive: true, corpse: null, hit, shield, tag, tagAlpha: 0 };
    v.all = [...Object.values(parts), gunHolder, skiL, skiR, board];
    views.set(ag, v);
    return v;
  }

  function setGun(v, id) {
    if (v.gunId === id) return;
    v.gunId = id;
    v.gunHolder.clear();
    const model = views.gunModels?.[id];
    v.gripL = new THREE.Vector3(0, -0.02, -0.3);
    v.muzzle = new THREE.Vector3(0, 0.04, -0.6);
    if (model) {
      if (!mergedGuns[id]) {
        model.updateMatrixWorld(true);
        const pieces = [];
        const info = { gripL: new THREE.Vector3(0, -0.02, -0.3), muzzle: new THREE.Vector3(0, 0.04, -0.6) };
        model.traverse((o) => {
          const n = String(o.name).replace(/[^a-z0-9]/gi, "").toLowerCase();
          if (n === "gripl") info.gripL.copy(o.position);
          if (n === "muzzle") info.muzzle.copy(o.position);
          if (!o.isMesh) return;
          if (["sight", "muzzle", "gripl", "eject"].includes(n) || /marker/i.test(o.material?.name ?? "")) return;
          pieces.push([o.geometry, o.material, o.matrixWorld]);
        });
        mergedGuns[id] = { geo: mergeColored(pieces), ...info };
      }
      const mg = mergedGuns[id];
      v.gripL.copy(mg.gripL);
      v.muzzle.copy(mg.muzzle);
      const g = new THREE.Mesh(mg.geo, sharedGearMat());
      g.castShadow = true;
      g.userData.tag = "npc-gun";
      v.gunHolder.add(g);
    } else {
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.75), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.6 }));
      g.position.z = -0.25;
      g.userData.tag = "npc-gun";
      v.gunHolder.add(g);
    }
  }

  // ── pose solving ──
  const m4 = new THREE.Matrix4();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const tmpBack = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();

  /** Place a part: origin at `at`, its local +Y along `up`, its local -Z toward `fwd`. */
  function place(holder, at, up, fwd) {
    tmpBack.copy(fwd).multiplyScalar(-1);
    tmpBack.addScaledVector(up, -tmpBack.dot(up));
    if (tmpBack.lengthSq() < 1e-6) tmpBack.set(0, 0, 1).addScaledVector(up, -up.z);
    tmpBack.normalize();
    tmpRight.crossVectors(up, tmpBack).normalize();
    m4.makeBasis(tmpRight, up, tmpBack).setPosition(at);
    holder.matrix.copy(m4);
    holder.matrixWorldNeedsUpdate = true;
  }

  /** Two-bone IK: joint between a (root) and c (end) with lengths l1, l2, bending toward `pole`. */
  function solveJoint(a, c, l1, l2, pole, out) {
    vA.subVectors(c, a);
    let d = vA.length();
    d = clamp(d, 0.05, l1 + l2 - 0.002);
    vA.normalize();
    const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    vB.copy(pole).addScaledVector(vA, -pole.dot(vA)).normalize();
    out.copy(a).addScaledVector(vA, x).addScaledVector(vB, y);
    return out;
  }

  const P = {};
  for (const k of ["hipC", "hipL", "hipR", "ankL", "ankR", "kneeL", "kneeR", "waist", "neck", "shL", "shR", "elL", "elR", "wrL", "wrR", "F", "R", "U", "BF", "BR", "aim", "tUp", "tF", "tR", "tmp", "pole", "gripR", "gripL", "skiF"]) P[k] = new THREE.Vector3();
  const qFlip = new THREE.Quaternion();
  const center = new THREE.Vector3();
  const m4b = new THREE.Matrix4();
  const gunUp = new THREE.Vector3();
  const corpseBase = { x: 0, y: 0, z: 0 };

  function pose(ag, v, dt, time) {
    const r = ag.rider;
    const board = r.kind === "board";
    const crash = r.crash > 0;
    const dead = !ag.alive;
    // Frame: forward along the skis, leaning into the turn.
    P.F.set(-Math.sin(r.heading), 0, -Math.cos(r.heading));
    P.R.set(Math.cos(r.heading), 0, -Math.sin(r.heading));
    const lean = crash || dead ? 0 : r.lean;
    P.U.copy(UP).multiplyScalar(Math.cos(lean)).addScaledVector(P.R, Math.sin(lean));
    P.R.multiplyScalar(Math.cos(lean)).addScaledVector(UP, -Math.sin(lean));
    // Body facing: skiers face down the skis; boarders stand side-on (regular stance → face right).
    if (board) {
      P.BF.copy(P.R);
      P.BR.copy(P.F).multiplyScalar(-1);
    } else {
      P.BF.copy(P.F);
      P.BR.copy(P.R);
    }
    const base = !ag.alive && v.corpse ? corpseBase : r.p;
    if (base === corpseBase) {
      corpseBase.x = v.corpse.x;
      corpseBase.y = v.corpse.y;
      corpseBase.z = v.corpse.z;
    }
    let crouch = r.crouch;
    if (dead) crouch = 1;
    const hipH = BODY.hip - crouch * 0.4;
    P.hipC.set(base.x, base.y, base.z).addScaledVector(P.U, hipH).addScaledVector(P.BF, -0.08 * crouch);
    // Feet.
    if (board) {
      P.ankL.set(base.x, base.y, base.z).addScaledVector(P.U, BODY.ankle).addScaledVector(P.F, 0.27);
      P.ankR.set(base.x, base.y, base.z).addScaledVector(P.U, BODY.ankle).addScaledVector(P.F, -0.27);
    } else {
      // On a rail the skis come together on top of it.
      const spread = r.grind?.f.type === "rail" ? 0.055 : 0.12 + crouch * 0.03;
      P.ankL.set(base.x, base.y, base.z).addScaledVector(P.U, BODY.ankle).addScaledVector(P.R, -spread);
      P.ankR.set(base.x, base.y, base.z).addScaledVector(P.U, BODY.ankle).addScaledVector(P.R, spread);
    }
    P.hipL.copy(P.hipC).addScaledVector(P.BR, -BODY.hipX);
    P.hipR.copy(P.hipC).addScaledVector(P.BR, BODY.hipX);
    // Knees bend forward (toe side for boarders).
    P.pole.copy(P.BF).addScaledVector(P.U, 0.1);
    solveJoint(P.hipL, P.ankL, BODY.thigh, BODY.shin, P.pole, P.kneeL);
    solveJoint(P.hipR, P.ankR, BODY.thigh, BODY.shin, P.pole, P.kneeR);
    // Torso: bends forward with the crouch, twists toward the aim.
    const aimYaw = ag.lookYaw;
    const aimPitch = ag.lookPitch;
    P.aim.set(-Math.sin(aimYaw) * Math.cos(aimPitch), Math.sin(aimPitch), -Math.cos(aimYaw) * Math.cos(aimPitch));
    P.tF.set(P.aim.x, 0, P.aim.z).normalize();
    // Limit the twist relative to the hips.
    const hipYaw = Math.atan2(-P.BF.x, -P.BF.z);
    let twist = Math.atan2(-P.tF.x, -P.tF.z) - hipYaw;
    twist = Math.atan2(Math.sin(twist), Math.cos(twist));
    twist = clamp(twist, board ? -1.6 : -1.2, board ? 1.6 : 1.2);
    const ty = hipYaw + twist * 0.85;
    P.tF.set(-Math.sin(ty), 0, -Math.cos(ty));
    P.tR.set(Math.cos(ty), 0, -Math.sin(ty));
    // A round landing snaps the torso back for a moment.
    const flinch = ag.hitFlash > 0 ? (ag.hitFlash / 0.12) * 0.6 : 0;
    P.tUp.copy(P.U).addScaledVector(P.tF, 0.35 + crouch * 0.45 - flinch).normalize();
    P.waist.copy(P.hipC).addScaledVector(P.U, BODY.waist - BODY.hip);
    P.neck.copy(P.waist).addScaledVector(P.tUp, BODY.neck - BODY.waist);
    P.tF.addScaledVector(P.tUp, -P.tF.dot(P.tUp)).normalize();
    P.tR.crossVectors(P.tF, P.tUp).normalize();
    // Gun: held out along the aim, stock near the right shoulder.
    P.shL.copy(P.neck).addScaledVector(P.tUp, BODY.shoulderY - BODY.neck).addScaledVector(P.tR, -BODY.shoulderX);
    P.shR.copy(P.neck).addScaledVector(P.tUp, BODY.shoulderY - BODY.neck).addScaledVector(P.tR, BODY.shoulderX);
    P.gripR.copy(P.shR).addScaledVector(P.aim, 0.32).addScaledVector(P.tR, -0.06).addScaledVector(P.tUp, -0.1);
    // Left hand on the gun's own support point (its GripL marker), in the gun's frame.
    const gl = v.gripL ?? { y: -0.02, z: -0.3 };
    P.gripL.copy(P.gripR).addScaledVector(P.aim, -gl.z).addScaledVector(P.tUp, gl.y).addScaledVector(P.tR, -0.035);
    P.wrR.copy(P.gripR);
    P.wrL.copy(P.gripL);
    P.pole.copy(P.tUp).multiplyScalar(-1).addScaledVector(P.tR, 0.6);
    solveJoint(P.shR, P.wrR, BODY.upperArm, BODY.forearm, P.pole, P.elR);
    P.pole.copy(P.tUp).multiplyScalar(-1).addScaledVector(P.tR, -0.6);
    solveJoint(P.shL, P.wrL, BODY.upperArm, BODY.forearm, P.pole, P.elL);

    // ── place parts ──
    const parts = v.parts;
    place(parts.Pelvis, P.hipC, P.U, P.BF);
    place(parts.Torso, P.waist, P.tUp, P.tF);
    place(parts.Backpack, P.waist, P.tUp, P.tF);
    // Head looks along the aim (pitch limited).
    P.tmp.copy(P.tUp).addScaledVector(P.aim, -0.25 * Math.sin(aimPitch)).normalize();
    place(parts.Head, P.neck, P.tmp, P.aim);
    const limb = (holder, a, b, fwd) => {
      P.tmp.subVectors(a, b).normalize();
      place(holder, a, P.tmp, fwd);
    };
    limb(parts.ThighL, P.hipL, P.kneeL, P.BF);
    limb(parts.ThighR, P.hipR, P.kneeR, P.BF);
    limb(parts.ShinL, P.kneeL, P.ankL, P.BF);
    limb(parts.ShinR, P.kneeR, P.ankR, P.BF);
    place(parts.BootL, P.ankL, P.U, board ? P.BF : P.F);
    place(parts.BootR, P.ankR, P.U, board ? P.BF : P.F);
    limb(parts.UpperArmL, P.shL, P.elL, P.tF);
    limb(parts.UpperArmR, P.shR, P.elR, P.tF);
    limb(parts.ForearmL, P.elL, P.wrL, P.aim);
    limb(parts.ForearmR, P.elR, P.wrR, P.aim);
    P.tmp.subVectors(P.elL, P.wrL).normalize();
    place(parts.HandL, P.wrL, P.tmp, P.aim);
    P.tmp.subVectors(P.elR, P.wrR).normalize();
    place(parts.HandR, P.wrR, P.tmp, P.aim);
    // Gun along the aim, origin at the right hand's grip.
    gunUp.copy(P.tUp).addScaledVector(P.aim, -P.tUp.dot(P.aim)).normalize();
    place(v.gunHolder, P.gripR, gunUp, P.aim);
    // Skis / board under the feet, pitched to the slope when grounded.
    const n = r.n;
    P.U.copy(r.grounded ? P.tmp.set(n.x, n.y, n.z) : P.U);
    P.skiF.copy(P.F).addScaledVector(P.U, -P.F.dot(P.U)).normalize();
    v.board.visible = board;
    v.skiL.visible = !board;
    v.skiR.visible = !board;
    if (board) {
      P.tmp.set(base.x, base.y, base.z).addScaledVector(P.U, 0.02);
      place(v.board, P.tmp, P.U, P.skiF);
    } else {
      P.tmp.copy(P.ankL).addScaledVector(P.U, -BODY.ankle + 0.025);
      place(v.skiL, P.tmp, P.U, P.skiF);
      P.tmp.copy(P.ankR).addScaledVector(P.U, -BODY.ankle + 0.025);
      place(v.skiR, P.tmp, P.U, P.skiF);
    }
    // Air flips: rotate everything about the rider's centre (pitch about the ski's right axis).
    // Wipe-outs and deaths: the body tips over.
    let tip = 0;
    if (!r.grounded && Math.abs(r.flip) > 0.01) tip = r.flip;
    if (crash) tip = Math.sin(time * 9) * 0.6 + 1.0;
    if (dead && v.corpse) tip = v.corpse.angle;
    if (tip !== 0) {
      center.set(base.x, base.y + 0.9, base.z);
      qFlip.setFromAxisAngle(P.R.set(Math.cos(r.heading), 0, -Math.sin(r.heading)), -tip);
      m4.compose(center, qFlip, vC.set(1, 1, 1));
      m4b.makeTranslation(-center.x, -center.y, -center.z);
      m4.multiply(m4b);
      for (const h of v.all) h.matrix.premultiply(m4);
    }
    if (dead) {
      // Settle into the snow once the body has come to rest.
      const drop = 0.55 * Math.min(1, Math.max(0, v.deadT - 0.6) * 0.8);
      m4b.makeTranslation(0, -drop, 0);
      for (const h of v.all) h.matrix.premultiply(m4b);
    }
  }

  /** Bodies keep their momentum: slide, tumble and settle on the slope. */
  function stepCorpse(ag, v, dt) {
    const r = ag.rider;
    if (!v.corpse) {
      v.corpse = { x: r.p.x, y: r.p.y, z: r.p.z, vx: r.v.x * 0.8, vy: Math.max(r.v.y, 0) + 2.2, vz: r.v.z * 0.8, angle: 0.25, w: 3.2 + Math.min(4, r.speed * 0.12) };
    }
    const c = v.corpse;
    c.vy -= 9.81 * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.z += c.vz * dt;
    const gy = ground ? ground(c.x, c.z) : r.p.y;
    if (c.y <= gy) {
      c.y = gy;
      if (c.vy < 0) c.vy = -c.vy * 0.25;
      const k = Math.exp(-2.6 * dt);
      c.vx *= k;
      c.vz *= k;
    }
    // Tumble toward lying flat, with a little bounce in the angle.
    c.w += (1.45 - c.angle) * 18 * dt;
    c.w *= Math.exp(-3.5 * dt);
    c.angle += c.w * dt;
  }

  return {
    group,
    setParts,
    /** Sync all riders. `hidePlayerUpper`: first person shows only the player's skis/boots/shins. */
    sync(agents, dt, time, camera, firstPerson = true, labels = null) {
      const seen = new Set();
      // Tags are screen-sized sprites, which the projection still scales with FOV: undo that so a
      // scope or the kill-cam zoom doesn't blow them up.
      const tagScale = Math.tan((camera.fov * Math.PI) / 360) / Math.tan((74 * Math.PI) / 360);
      for (const ag of agents) {
        let v = views.get(ag);
        if (!v) v = build(ag);
        seen.add(ag);
        const visibleBody = ag.alive || (v.deadT < 4 && ag.liftT <= 0);
        if (ag.alive) {
          v.deadT = 0;
          v.corpse = null;
        } else {
          v.deadT += dt;
          if (visibleBody && dt > 0) stepCorpse(ag, v, dt);
        }
        // Hit flash; a cool shimmer while spawn protection lasts (so you know not to waste rounds).
        v.hit.value = ag.hitFlash > 0 ? ag.hitFlash / 0.12 : 0;
        if (v.shield) v.shield.value = ag.alive && ag.invuln > 0 ? (0.2 + 0.14 * Math.sin(time * 11)) * Math.min(1, ag.invuln * 2) : 0;
        // Name tags: teammates within range; enemies only when aimed at or just hit.
        if (v.tag) {
          const dx = ag.rider.p.x - camera.position.x;
          const dz = ag.rider.p.z - camera.position.z;
          const d = Math.hypot(dx, dz);
          const friend = labels && ag.team === labels.team;
          const show = ag.alive && labels && !labels.hidden && (labels.only ? labels.only === ag : friend ? d < 260 : labels.aim === ag || time - (ag.taggedT ?? -99) < 1.6);
          v.tagAlpha += ((show ? 1 : 0) - v.tagAlpha) * Math.min(1, dt * 10);
          v.tag.visible = v.tagAlpha > 0.02;
          if (v.tag.visible) {
            v.tag.material.opacity = v.tagAlpha * (friend ? 0.85 : 1);
            v.tag.position.set(ag.rider.p.x, ag.rider.p.y + 2.25, ag.rider.p.z);
            const big = labels?.only === ag ? 1.8 : 1; // the kill cam singles out whoever got you
            v.tag.scale.set(0.16 * tagScale * big, 0.04 * tagScale * big, 1);
          }
        }
        v.root.visible = visibleBody;
        if (!visibleBody) continue;
        // Distance cull for far riders (cheap; they still show on the minimap).
        const dx = ag.rider.p.x - camera.position.x;
        const dz = ag.rider.p.z - camera.position.z;
        if (!ag.isPlayer && dx * dx + dz * dz > 700 * 700) {
          v.root.visible = false;
          continue;
        }
        setGun(v, ag.loadout.slots[ag.loadout.active].def.id);
        pose(ag, v, dt, time);
        if (ag.isPlayer) {
          // First person: keep the legs/skis, hide the rest (the viewmodel shows arms + gun).
          for (const [name, h] of Object.entries(v.parts)) h.visible = !firstPerson || /Shin|Boot/.test(name);
          v.gunHolder.visible = !firstPerson;
        }
      }
      for (const [ag, v] of views) {
        if (!seen.has(ag)) {
          group.remove(v.root);
          if (v.tag) group.remove(v.tag);
          views.delete(ag);
        }
      }
    },
    viewOf: (ag) => views.get(ag),
    /** World position of a rider's muzzle (for tracers and flashes); false if not posed. */
    muzzleOf(ag, out) {
      const v = views.get(ag);
      if (!v || !v.muzzle || !v.root.visible) return false;
      out.copy(v.muzzle).applyMatrix4(v.gunHolder.matrix);
      return true;
    },
    count: () => views.size,
  };
}
