/**
 * First-person viewmodel — the part of the game you look at most, built like a AAA FPS:
 *
 *  - Everything moves on damped SPRINGS: recoil kicks (back, up, a random twist) that snap back
 *    with a little overshoot; look sway that lags the mouse; body-motion lag (the gun swings out
 *    in a hard carve, slams down on a landing); idle breathing.
 *  - Per-weapon recoil character, a 3D MUZZLE FLASH (flame cards along the barrel + a front star
 *    + a light flash) and barrel SMOKE after bursts; BRASS (or red shotgun hulls) ejected from
 *    the gun's Eject port, tumbling out of view.
 *  - Choreographed RELOADS: tilt, mag out, new mag up, slap, charge the bolt when empty (pump /
 *    per-shell loading for the shotgun, bolt for the sniper, slide release for the pistol), with
 *    the left glove (and its ski pole) coming in to help. Sound cues fire on each beat.
 *  - LOW READY while tucking: the gun pulls in and down; firing raises it first.
 *  - ADS eases the gun onto its own Sight marker; the gun view zooms with the optic.
 *
 * Drawn in its own scene after the world (depth cleared) so it never clips into snow or trees.
 */
import * as THREE from "three";
import { clamp } from "../core/noise.js";
import { Spring, Spring3, ease, window4 } from "../core/spring.js";
import { SUN_DIR, SUN_COLOR } from "../world/sky.js";

/** Per-weapon hip pose (camera space), recoil character and reload timeline. */
const GUNS = {
  ar: { hip: [0.235, -0.165, -0.43], yaw: 0.17, roll: -0.13, kick: [0.034, 0.05, 0.012, 0.025], flash: 0.3, shell: "rifle", reload: "mag" },
  smg: { hip: [0.215, -0.16, -0.38], yaw: 0.16, roll: -0.12, kick: [0.024, 0.032, 0.014, 0.035], flash: 0.24, shell: "pistol", reload: "mag" },
  shotgun: { hip: [0.24, -0.175, -0.46], yaw: 0.16, roll: -0.12, kick: [0.075, 0.13, 0.02, 0.04], flash: 0.48, shell: "shotgun", reload: "shell" },
  sniper: { hip: [0.25, -0.18, -0.5], yaw: 0.15, roll: -0.1, kick: [0.085, 0.16, 0.015, 0.03], flash: 0.55, shell: "rifle", reload: "bolt" },
  pistol: { hip: [0.14, -0.135, -0.34], yaw: 0.1, roll: -0.06, kick: [0.03, 0.11, 0.01, 0.03], flash: 0.2, shell: "pistol", reload: "pistol" },
};

function flameTexture(kind) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = kind === "side" ? 256 : 128;
  const g = c.getContext("2d");
  if (kind === "side") {
    // A flame tongue along +v (out of the muzzle), hot white core.
    const grad = g.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, "rgba(255,250,230,1)");
    grad.addColorStop(0.25, "rgba(255,200,90,0.95)");
    grad.addColorStop(0.65, "rgba(255,120,30,0.5)");
    grad.addColorStop(1, "rgba(255,80,10,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(64, 256);
    g.bezierCurveTo(10, 200, 30, 60, 64, 0);
    g.bezierCurveTo(98, 60, 118, 200, 64, 256);
    g.fill();
  } else {
    const grad = g.createRadialGradient(64, 64, 1, 64, 64, 62);
    grad.addColorStop(0, "rgba(255,255,240,1)");
    grad.addColorStop(0.18, "rgba(255,215,120,0.95)");
    grad.addColorStop(0.5, "rgba(255,140,40,0.4)");
    grad.addColorStop(1, "rgba(255,90,10,0)");
    g.fillStyle = grad;
    g.translate(64, 64);
    for (let i = 0; i < 4; i++) {
      g.rotate(Math.PI / 2);
      g.beginPath();
      g.moveTo(-7, 0);
      g.lineTo(0, -62);
      g.lineTo(7, 0);
      g.fill();
    }
    g.beginPath();
    g.arc(0, 0, 24, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function smokeTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createViewmodel(viewScene, viewCamera, { onCue = () => {} } = {}) {
  viewScene.userData.tag = "viewmodel";
  const sun = new THREE.DirectionalLight(SUN_COLOR, 2.4);
  sun.position.copy(SUN_DIR).multiplyScalar(10);
  viewScene.add(sun);
  viewScene.add(sun.target);
  const fill = new THREE.HemisphereLight(0x9cb8ff, 0x8a8a90, 0.35);
  viewScene.add(fill);
  viewScene.add(viewCamera);

  const rig = new THREE.Group(); // camera space
  rig.userData.tag = "weapon";
  viewCamera.add(rig);
  const gunPivot = new THREE.Group();
  rig.add(gunPivot);
  const leftPivot = new THREE.Group();
  rig.add(leftPivot);

  const guns = {};
  const arms = { R: null, L: null, LS: null, pole: null };
  let current = null;

  // ── muzzle flash: front star + two crossed flame cards + light ──
  const flash = new THREE.Group();
  flash.visible = false;
  flash.userData.tag = "muzzle";
  const flashMat = (map, scale) =>
    new THREE.MeshBasicMaterial({ map, color: new THREE.Color(scale, scale * 0.78, scale * 0.55), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, toneMapped: false });
  const star = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flashMat(flameTexture("star"), 5));
  const sideMap = flameTexture("side");
  const cardGeo = new THREE.PlaneGeometry(0.5, 1);
  cardGeo.translate(0, 0.5, 0);
  cardGeo.rotateX(-Math.PI / 2); // flame points along −Z (out of the barrel)
  const card1 = new THREE.Mesh(cardGeo, flashMat(sideMap, 4));
  const card2 = new THREE.Mesh(cardGeo, flashMat(sideMap, 4));
  card2.rotation.z = Math.PI / 2;
  flash.add(star, card1, card2);
  gunPivot.add(flash);
  const flashLight = new THREE.PointLight(0xffb060, 0, 3.5, 2);
  gunPivot.add(flashLight);

  // ── barrel smoke puffs ──
  const smokeMap = smokeTexture();
  const smoke = [];
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeMap, color: 0xdfe4ea, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    s.userData.tag = "muzzle-smoke";
    rig.add(s);
    smoke.push({ s, t: 0, life: 1, v: new THREE.Vector3() });
  }
  let smokeHead = 0;

  // ── ejected shells (camera space; they leave the view in a fraction of a second) ──
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24c, metalness: 1, roughness: 0.32 });
  const hullRed = new THREE.MeshStandardMaterial({ color: 0xb3241f, roughness: 0.5 });
  const shellGeo = {
    rifle: new THREE.CylinderGeometry(0.0045, 0.0048, 0.045, 8).rotateX(Math.PI / 2),
    pistol: new THREE.CylinderGeometry(0.0048, 0.0048, 0.02, 8).rotateX(Math.PI / 2),
    shotgun: new THREE.CylinderGeometry(0.0105, 0.0105, 0.065, 10).rotateX(Math.PI / 2),
  };
  const shells = [];
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(shellGeo.rifle, brass);
    m.visible = false;
    m.userData.tag = "shell";
    rig.add(m);
    shells.push({ m, t: 0, v: new THREE.Vector3(), w: new THREE.Vector3() });
  }
  let shellHead = 0;

  function addGun(id, model) {
    const root = model;
    root.userData.tag = "weapon";
    const info = {
      root,
      sight: new THREE.Vector3(0, 0.08, -0.05),
      muzzle: new THREE.Vector3(0, 0.03, -0.6),
      gripL: new THREE.Vector3(0, -0.02, -0.3),
      eject: new THREE.Vector3(0.015, 0.04, -0.1),
      parts: {},
    };
    root.traverse((o) => {
      const n = String(o.name).replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (n === "sight") info.sight.copy(o.position);
      if (n === "muzzle") info.muzzle.copy(o.position);
      if (n === "gripl") info.gripL.copy(o.position);
      if (n === "eject") info.eject.copy(o.position);
      if (["sight", "muzzle", "gripl", "eject"].includes(n) || (o.material && /marker/i.test(o.material.name))) o.visible = false;
      if (["mag", "pump", "bolt", "slide", "charginghandle"].includes(n)) info.parts[n] = { node: o, rest: o.position.clone(), restRot: o.rotation.clone() };
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
        if (!o.userData.tag) o.userData.tag = "weapon";
        if (o.material && /lens/i.test(o.material.name)) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.07;
          o.material.depthWrite = false;
          o.material.color = new THREE.Color(0.25, 0.55, 0.6);
          o.userData.tag = "sight";
        }
      }
    });
    root.visible = false;
    if (guns[id]) guns[id].root.removeFromParent();
    gunPivot.add(root);
    guns[id] = info;
  }

  /** Replace any of the arm meshes (keys given as null/undefined keep what is there). */
  function setArms(next) {
    for (const k of ["R", "L", "LS", "pole"]) {
      if (!next[k]) continue;
      if (arms[k]) arms[k].removeFromParent();
      arms[k] = next[k];
      next[k].traverse((m) => {
        if (m.isMesh) {
          m.frustumCulled = false;
          m.userData.tag = k === "pole" ? "pole" : "hands";
        }
      });
      if (k === "R" || k === "LS") gunPivot.add(next[k]);
      else leftPivot.add(next[k]);
    }
  }

  // ── springs ──
  const kickPos = new Spring3(260, 20); // recoil translation (camera space)
  const kickRot = new Spring3(240, 17); // recoil rotation (pitch, yaw, roll)
  const sway = new Spring3(90, 13); // mouse-look lag
  const body = new Spring3(70, 11); // body acceleration lag
  const slap = new Spring(300, 16); // mag-slap / pump jolts (pitch)
  const lower = new Spring(150, 2 * Math.sqrt(150)); // 1 = lowered (swap / death / spawn)
  lower.set(1);
  const ready = new Spring(110, 2 * Math.sqrt(110)); // 1 = raised, 0 = low-ready tuck
  ready.set(1);
  const st = {
    t: 0,
    gunId: null,
    fired: 0,
    flash: 0,
    flashScale: 1,
    bobPhase: 0,
    plant: 0,
    lastEdgeSign: 0,
    prevV: new THREE.Vector3(),
    prevGrounded: true,
    reloadSeen: false,
    reloadCues: new Set(),
    lastShellReload: 0,
    smokeHeat: 0,
    smokeT: 0,
    deadFrames: 0,
  };
  const qCam = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const accel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const e = new THREE.Euler(0, 0, 0, "YXZ");
  const muzzleCam = new THREE.Vector3();
  const muzzleNdc = new THREE.Vector3();

  function cue(name, w) {
    if (st.reloadCues.has(name)) return;
    st.reloadCues.add(name);
    onCue(name, w.def.id);
  }

  function ejectShell(kind) {
    if (!current) return;
    const s = shells[shellHead];
    shellHead = (shellHead + 1) % shells.length;
    s.m.geometry = shellGeo[kind] ?? shellGeo.rifle;
    s.m.material = kind === "shotgun" ? hullRed : brass;
    // Eject port in camera space.
    tmp.copy(current.eject);
    gunPivot.updateMatrix();
    tmp.applyMatrix4(gunPivot.matrix);
    s.m.position.copy(tmp);
    // Out to the right, up and a little back, with a tumble.
    const r = Math.sin(st.t * 91.7) * 0.5 + 0.5;
    s.v.set(1.4 + r * 0.8, 1.6 + r * 0.6, 0.5 + r * 0.4).applyQuaternion(gunPivot.quaternion);
    s.w.set(18 + r * 10, 6, 14 - r * 8);
    s.t = 0.0001;
    s.m.visible = true;
  }

  function puff(at, strength) {
    const p = smoke[smokeHead];
    smokeHead = (smokeHead + 1) % smoke.length;
    p.s.position.copy(at);
    p.t = 0.0001;
    p.life = 0.7 + strength * 0.6;
    p.s.scale.setScalar(0.04 + strength * 0.03);
    p.v.set(0.02 + strength * 0.03, 0.06 + strength * 0.05, -0.03);
    p.s.visible = true;
  }

  /** Where the muzzle appears on screen, as a world point the MAIN camera sees at the same spot. */
  function muzzleWorld(mainCamera, out) {
    if (!current) return out.copy(mainCamera.position);
    gunPivot.updateMatrix();
    muzzleCam.copy(current.muzzle).applyMatrix4(gunPivot.matrix);
    muzzleNdc.copy(muzzleCam).applyMatrix4(viewCamera.projectionMatrix);
    // Unproject with the main camera at the same view depth.
    const depth = -muzzleCam.z;
    const tanY = Math.tan((mainCamera.fov * Math.PI) / 360);
    tmp2.set(muzzleNdc.x * tanY * mainCamera.aspect * depth, muzzleNdc.y * tanY * depth, -depth);
    return out.copy(tmp2).applyQuaternion(mainCamera.quaternion).add(mainCamera.position);
  }

  return {
    addGun,
    setArms,
    guns,
    muzzleWorld,
    /**
     * Per rendered frame. `look` = mouse pixels since the last frame. Returns true while the
     * sniper scope overlay should show.
     */
    update(p, dt, camera, look) {
      st.t += dt;
      viewCamera.position.copy(camera.position);
      viewCamera.quaternion.copy(camera.quaternion);
      viewCamera.updateMatrixWorld();
      const l = p.loadout;
      const w = l.slots[l.active];
      const id = w.def.id;
      const G = GUNS[id] ?? GUNS.ar;
      if (st.gunId !== id) {
        if (current) current.root.visible = false;
        current = guns[id] ?? null;
        st.gunId = id;
        lower.set(1);
        st.fired = l.fired;
        onCue("equip", id);
      }
      if (!current) return false;
      const r = p.rider;
      const board = r.kind === "board";
      const adsE = ease(l.ads);
      const still = 1 - adsE * 0.78; // ADS calms most motion

      // ── shots this frame ──
      const shots = l.fired - st.fired;
      st.fired = l.fired;
      if (shots > 0 && p.alive) {
        const [kz, kp, ky, kr] = G.kick;
        const rnd = Math.sin(st.t * 123.4 + l.fired * 7.7);
        const k = 1 - adsE * 0.55;
        kickPos.impulse(rnd * 0.004 * k * 30, kp * 0.12 * k * 30, kz * k * 30);
        kickRot.impulse(kp * k * 22, ky * rnd * k * 22, kr * rnd * k * 22);
        st.flash = 0.034;
        st.flashScale = G.flash * (0.85 + 0.3 * (rnd * 0.5 + 0.5));
        st.smokeHeat = Math.min(1.5, st.smokeHeat + (id === "shotgun" || id === "sniper" ? 0.9 : 0.25));
        if (id !== "shotgun" && id !== "sniper") ejectShell(G.shell);
      }
      // Pump / bolt cycles eject their shells mid-cycle.
      if (w.cooldown > 0 && (id === "shotgun" || id === "sniper")) {
        const t = 1 - clamp(w.cooldown / (60 / w.def.rpm), 0, 1);
        if (t > 0.42 && !st.cycleEjected) {
          st.cycleEjected = true;
          ejectShell(G.shell);
          onCue(id === "shotgun" ? "pump" : "bolt", id);
        }
      } else st.cycleEjected = false;

      // ── springs: sway (mouse), body (acceleration), landing ──
      // Sway follows mouse VELOCITY so it feels the same at any frame rate.
      const inv = 1 / Math.max(dt, 1 / 240);
      sway.target(clamp(-look.x * inv * 0.0000075, -0.05, 0.05) * still, clamp(look.y * inv * 0.0000075, -0.05, 0.05) * still, 0);
      // Body acceleration in camera space (the gun lags behind the body).
      if (dt > 0) {
        accel.set((r.v.x - st.prevV.x) / dt, (r.v.y - st.prevV.y) / dt, (r.v.z - st.prevV.z) / dt);
        st.prevV.set(r.v.x, r.v.y, r.v.z);
        qCam.copy(camera.quaternion);
        qInv.copy(qCam).invert();
        accel.applyQuaternion(qInv);
        accel.clampLength(0, 40);
        body.target(-accel.x * 0.0009 * still, -accel.y * 0.0007 * still, accel.z * 0.0006 * still);
      }
      if (r.grounded && !st.prevGrounded) body.y.impulse(-Math.min(1.5, r.impact * 0.09) * still);
      st.prevGrounded = r.grounded;
      kickPos.step(dt);
      kickRot.step(dt);
      sway.step(dt);
      body.step(dt);
      slap.step(dt);

      // Lowered (swap / dead), low ready (tuck), reloading.
      lower.target = !p.alive || l.switchT > 0.22 ? 1 : 0;
      lower.step(dt);
      ready.target = l.raise ?? 1;
      ready.step(dt);
      const lowReady = (1 - clamp(ready.x, 0, 1)) * (1 - adsE);

      // ── reload choreography ──
      const dur = w.def.perShell ? w.def.reload * 1.3 : w.def.reload;
      let rt = w.reloading ? 1 - clamp(w.reloadT / dur, 0, 1) : 0;
      if (!w.reloading && st.reloadSeen) {
        st.reloadSeen = false;
        st.reloadCues.clear();
      }
      if (w.reloading && !st.reloadSeen) {
        st.reloadSeen = true;
        st.reloadCues.clear();
        st.emptyReload = w.mag === 0;
      }
      let tilt = 0; // roll toward the shooter (mag well up)
      let dip = 0;
      let magOut = 0; // 0 seated … 1 gone below
      let leftToMag = 0;
      let charge = 0;
      if (w.reloading) {
        if (G.reload === "shell") {
          // Per shell: the cycle restarts each time a shell goes in.
          const cyc = 1 - clamp(w.reloadT / w.def.reload, 0, 1);
          tilt = 0.55;
          dip = 0.03;
          leftToMag = window4(cyc, 0.05, 0.35, 0.6, 0.95);
          if (cyc > 0.55 && st.lastShellReload !== w.mag) {
            st.lastShellReload = w.mag;
            slap.impulse(1.2);
            onCue("shell", id);
          }
        } else {
          tilt = window4(rt, 0.0, 0.15, 0.8, 0.98) * (G.reload === "pistol" ? 0.35 : 0.6);
          dip = window4(rt, 0.0, 0.12, 0.85, 1.0) * 0.04;
          magOut = rt < 0.32 ? ease((rt - 0.12) / 0.2) : rt < 0.58 ? 1 - ease((rt - 0.32) / 0.26) : 0;
          leftToMag = window4(rt, 0.1, 0.25, 0.6, 0.75);
          if (rt > 0.16) cue("magOut", w);
          if (rt > 0.58) {
            if (!st.reloadCues.has("magIn")) slap.impulse(2.2);
            cue("magIn", w);
          }
          if (st.emptyReload) {
            charge = window4(rt, 0.66, 0.74, 0.78, 0.86);
            if (rt > 0.72) cue(G.reload === "bolt" ? "bolt" : G.reload === "pistol" ? "slide" : "chamber", w);
          }
        }
      }

      // ── base pose: hip ↔ ADS ──
      const eyeRelief = w.def.scope ? 0.075 : 0.095;
      tmp.set(-current.sight.x, -current.sight.y, -eyeRelief - current.sight.z);
      pos.set(G.hip[0], G.hip[1], G.hip[2]).lerp(tmp, adsE);
      // Bob with speed and carving.
      st.bobPhase += dt * (3.5 + r.speed * 0.22);
      const bobAmt = (r.grounded ? clamp(r.speed / 25, 0, 1) * 0.005 + r.edge * 0.003 : 0.001) * still;
      const breathe = Math.sin(st.t * 1.4) * 0.0015 * still;
      pos.x += sway.x.x + body.x.x + kickPos.x.x + Math.sin(st.bobPhase) * bobAmt;
      pos.y += sway.y.x + body.y.x + kickPos.y.x * 0.2 + Math.abs(Math.cos(st.bobPhase)) * bobAmt + breathe - dip;
      pos.z += body.z.x + kickPos.z.x;
      // Low ready: pulled in, down and across the chest.
      pos.x += lowReady * -0.04;
      pos.y += lowReady * -0.07;
      pos.z += lowReady * 0.07;
      pos.y -= lower.x * 0.38;
      gunPivot.position.copy(pos);
      e.set(
        kickRot.x.x + sway.y.x * 0.8 + slap.x * 0.05 + lower.x * 0.7 + lowReady * -0.25 + dip * 2,
        sway.x.x * 1.4 + G.yaw * (1 - adsE) + kickRot.y.x + lowReady * 0.35,
        -r.lean * 0.15 * still + G.roll * (1 - adsE) + kickRot.z.x - tilt * 0.9 + lowReady * -0.45 + Math.sin(st.bobPhase * 0.5) * bobAmt * 2,
        "YXZ",
      );
      gunPivot.quaternion.setFromEuler(e);
      gunPivot.updateMatrix();
      current.root.visible = !(w.def.scope && l.ads > 0.92);

      // ── moving parts ──
      const mag = current.parts.mag;
      if (mag) {
        if (G.reload === "shell") {
          // The loose shell rides up into the loading port on each insert.
          const cyc = w.reloading ? 1 - clamp(w.reloadT / w.def.reload, 0, 1) : 1;
          const rise = w.reloading ? window4(cyc, 0.05, 0.45, 0.55, 0.6) : 0;
          mag.node.visible = w.reloading && cyc < 0.6;
          mag.node.position.copy(mag.rest).add(tmp.set(-0.02 * (1 - rise), -0.09 * (1 - rise), 0));
        } else {
          mag.node.visible = magOut < 0.98;
          mag.node.position.copy(mag.rest).add(tmp.set(0.01 * magOut, -0.24 * magOut, 0.03 * magOut));
          mag.node.rotation.set(mag.restRot.x - magOut * 0.4, mag.restRot.y, mag.restRot.z + magOut * 0.2);
        }
      }
      const pump = current.parts.pump;
      if (pump) {
        const cyc = w.cooldown > 0 ? clamp(w.cooldown / (60 / w.def.rpm), 0, 1) : 0;
        pump.node.position.copy(pump.rest).add(tmp.set(0, 0, Math.sin(cyc * Math.PI) * 0.085));
      }
      const slide = current.parts.slide;
      if (slide) slide.node.position.copy(slide.rest).add(tmp.set(0, 0, Math.max(clamp(kickPos.z.x * 1.4, 0, 0.04), charge * 0.04)));
      const ch = current.parts.charginghandle;
      if (ch) ch.node.position.copy(ch.rest).add(tmp.set(0, 0, charge * 0.05));
      const bolt = current.parts.bolt;
      if (bolt) {
        let lift = 0;
        let back = 0;
        const t = w.cooldown > 0 ? 1 - clamp(w.cooldown / (60 / w.def.rpm), 0, 1) : -1;
        if (t >= 0) {
          lift = window4(t, 0.15, 0.3, 0.62, 0.77);
          back = window4(t, 0.3, 0.46, 0.46, 0.62);
        }
        lift = Math.max(lift, charge);
        back = Math.max(back, charge);
        bolt.node.rotation.set(bolt.restRot.x, bolt.restRot.y, bolt.restRot.z + lift * 1.0);
        bolt.node.position.copy(bolt.rest).add(tmp.set(0, 0, back * 0.095));
      }

      // ── muzzle flash + light ──
      st.flash -= dt;
      const flashing = st.flash > 0 && current.root.visible;
      flash.visible = flashing;
      if (flashing) {
        flash.position.copy(current.muzzle);
        const fs = st.flashScale * (0.6 + 0.4 * (st.flash / 0.034));
        star.scale.setScalar(fs);
        star.rotation.z = st.t * 61.3;
        card1.scale.set(fs * 0.55, fs * 1.4, fs);
        card2.scale.set(fs * 0.55, fs * 1.4, fs);
        flash.rotation.z = st.t * 37.1;
      }
      flashLight.position.copy(current.muzzle);
      flashLight.intensity = flashing ? 9 * st.flashScale : 0;

      // ── smoke after bursts ──
      st.smokeHeat = Math.max(0, st.smokeHeat - dt * 0.6);
      st.smokeT -= dt;
      if (st.smokeHeat > 0.2 && st.smokeT <= 0 && current.root.visible) {
        st.smokeT = 0.09;
        tmp.copy(current.muzzle).applyMatrix4(gunPivot.matrix);
        puff(tmp, st.smokeHeat);
      }
      for (const sp of smoke) {
        if (sp.t <= 0) continue;
        sp.t += dt;
        const f = sp.t / sp.life;
        if (f >= 1) {
          sp.t = 0;
          sp.s.visible = false;
          continue;
        }
        sp.s.position.addScaledVector(sp.v, dt);
        sp.s.scale.multiplyScalar(1 + dt * 1.2);
        sp.s.material.opacity = 0.32 * (1 - f) * Math.min(1, f * 8);
      }

      // ── shells ──
      qInv.copy(camera.quaternion).invert();
      tmp2.set(0, -9.8, 0).applyQuaternion(qInv); // world gravity in camera space
      for (const s of shells) {
        if (s.t <= 0) continue;
        s.t += dt;
        if (s.t > 0.7) {
          s.t = 0;
          s.m.visible = false;
          continue;
        }
        s.v.addScaledVector(tmp2, dt);
        s.m.position.addScaledVector(s.v, dt);
        s.m.rotation.x += s.w.x * dt;
        s.m.rotation.y += s.w.y * dt;
        s.m.rotation.z += s.w.z * dt;
      }

      // ── arms ──
      if (arms.R) arms.R.visible = current.root.visible;
      if (arms.LS) {
        arms.LS.visible = board && current.root.visible;
        // The support hand leaves the handguard to work the mag.
        arms.LS.position.copy(current.gripL).lerp(tmp.copy(current.parts.mag?.rest ?? current.gripL).add(tmp2.set(-0.03, -0.05, 0.02)), leftToMag);
      }
      if (arms.L) {
        arms.L.visible = !board && p.alive;
        const edgeSign = Math.sign(Math.round(r.lean * 4));
        if (edgeSign !== 0 && edgeSign !== st.lastEdgeSign && r.grounded && r.speed > 6) st.plant = 1;
        if (edgeSign !== 0) st.lastEdgeSign = edgeSign;
        st.plant = Math.max(0, st.plant - dt * 2.2);
        const plant = Math.sin(st.plant * Math.PI);
        // Fist in the lower-left corner, pole forward to the snow. To help a reload it sweeps
        // low and right to the magwell, mostly below the frame (the pole trails behind it).
        const help = leftToMag;
        leftPivot.position.set(
          -0.215 + sway.x.x * 0.6 + body.x.x - r.lean * 0.03 + help * 0.3,
          -0.158 - lower.x * 0.2 + body.y.x + Math.abs(Math.cos(st.bobPhase)) * bobAmt - plant * 0.015 - adsE * 0.05 - help * 0.14,
          -0.33 - plant * 0.04 + body.z.x - help * 0.1,
        );
        e.set(1.365 + plant * 0.12 - r.crouch * 0.05 - help * 0.85, 0.31 - r.lean * 0.05 - help * 0.2, -help * 0.15, "YXZ");
        leftPivot.quaternion.setFromEuler(e);
      }
      return Boolean(w.def.scope && l.ads > 0.92);
    },
  };
}

/** Simple stand-in gun until the Blender models load (several parts, not a box). */
export function fallbackGun(id) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.4, metalness: 0.7 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.65 });
  const len = id === "sniper" ? 1.1 : id === "shotgun" ? 0.95 : id === "pistol" ? 0.19 : id === "smg" ? 0.55 : 0.8;
  const add = (geo, mat, x, y, z, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (name) m.name = name;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.045, 0.07, len * 0.38), metal, 0, 0.035, -len * 0.12);
  add(new THREE.CylinderGeometry(0.011, 0.011, len * 0.45, 10).rotateX(Math.PI / 2), metal, 0, 0.045, -len * 0.5);
  add(new THREE.BoxGeometry(0.035, 0.11, 0.045).rotateX(0.35), poly, 0, -0.045, 0.015);
  if (id !== "pistol") add(new THREE.BoxGeometry(0.04, 0.06, 0.24), poly, 0, 0.02, 0.18);
  add(new THREE.BoxGeometry(0.03, 0.13, 0.05), poly, 0, -0.06, -0.09, "Mag");
  const sight = add(new THREE.BoxGeometry(0.004, 0.004, 0.004), metal, 0, 0.1, -0.05, "Sight");
  sight.visible = false;
  add(new THREE.BoxGeometry(0.004, 0.004, 0.004), metal, 0, 0.045, -len * 0.73, "Muzzle").visible = false;
  add(new THREE.BoxGeometry(0.004, 0.004, 0.004), metal, 0, 0.0, -len * 0.4, "GripL").visible = false;
  return g;
}

/**
 * Procedural first-person arms (used until the Blender gloves arrive): a quilted jacket sleeve
 * and an insulated glove. R grips the pistol grip at the gun's origin; L makes a fist around a
 * ski pole (pole included); LS cups the handguard (snowboarders).
 */
export function fallbackArms(jacketColor = 0x1f6fe0) {
  const glove = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.75, metalness: 0 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.6 });
  const sleeve = new THREE.MeshStandardMaterial({ color: jacketColor, roughness: 0.7 });
  // Quilting stripes on the sleeve.
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#c9ced6";
  for (let y = 0; y < 64; y += 16) g.fillRect(0, y, 64, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  sleeve.map = t;
  glove.map = t;
  const seg = (a, b, r0, r1, mat) => {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const geo = new THREE.CylinderGeometry(r1, r0, len, 14, 1);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    return m;
  };
  const blob = (p, s, mat) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
    m.position.set(...p);
    m.scale.set(...s);
    return m;
  };
  // Right hand: palm wraps the grip (which hangs below the origin, bottom tilted forward).
  const R = new THREE.Group();
  R.add(blob([0.006, -0.05, 0.012], [0.042, 0.06, 0.05], glove)); // palm + back of hand
  for (let i = 0; i < 3; i++) R.add(blob([-0.006, -0.03 - i * 0.026, -0.03 + i * 0.006], [0.036, 0.013, 0.02], glove)); // fingers wrapped round the front
  R.add(blob([0.0, 0.008, -0.045], [0.011, 0.011, 0.03], glove)); // index finger along the frame
  R.add(blob([-0.024, -0.008, 0.012], [0.012, 0.012, 0.03], glove)); // thumb
  R.add(seg([0.01, -0.07, 0.05], [0.03, -0.1, 0.1], 0.042, 0.048, cuffMat)); // glove cuff
  R.add(seg([0.03, -0.1, 0.1], [0.085, -0.19, 0.38], 0.055, 0.068, sleeve)); // forearm sleeve
  // Left fist around a ski pole (pole runs down from the origin).
  const L = new THREE.Group();
  L.add(blob([0, 0, 0.01], [0.045, 0.055, 0.05], glove));
  L.add(seg([0, -0.02, 0.05], [-0.02, -0.06, 0.1], 0.04, 0.046, cuffMat));
  L.add(seg([-0.02, -0.06, 0.1], [-0.07, -0.16, 0.38], 0.055, 0.068, sleeve));
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.9, roughness: 0.3 });
  L.add(seg([0, 0.07, 0], [0, -1.15, 0], 0.009, 0.006, poleMat));
  L.add(seg([0, 0.08, 0], [0, -0.06, 0], 0.017, 0.017, cuffMat)); // grip
  const basket = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.006, 6, 18), cuffMat);
  basket.rotation.x = Math.PI / 2;
  basket.position.y = -1.03;
  L.add(basket);
  // Left support hand (boarders): cups the handguard from below.
  const LS = new THREE.Group();
  LS.add(blob([-0.012, -0.028, 0], [0.04, 0.03, 0.055], glove));
  LS.add(seg([-0.02, -0.04, 0.04], [-0.05, -0.07, 0.09], 0.04, 0.046, cuffMat));
  LS.add(seg([-0.05, -0.07, 0.09], [-0.13, -0.15, 0.36], 0.055, 0.068, sleeve));
  for (const grp of [R, L, LS]) grp.traverse((o) => {
    if (o.isMesh) o.userData.tag = "hands";
  });
  return { R, L, LS };
}
