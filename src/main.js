/**
 * Big Mountain Shooter — boot: renderer, world, game, views, studio contract.
 *
 * Timing: the simulation runs at a fixed 120 Hz (`update`); everything visual (cameras, the
 * viewmodel, riders, particles, HUD, audio) runs once per rendered frame (`render`) with the
 * simulated time that frame advanced, fed by a queue of the events the steps produced. That
 * keeps motion silky on 120 Hz displays and costs nothing extra at 60.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { installStudio } from "./studio.js";
import { buildWorld } from "./world/world.js";
import { createPark } from "./world/park.js";
import { createProps } from "./world/props.js";
import { installAtmosphereFog, createPipeline } from "./fx/post.js";
import { createEffects } from "./fx/effects.js";
import { createAtmosphere } from "./fx/atmosphere.js";
import { createTracks } from "./fx/tracks.js";
import { makeGround } from "./game/ground.js";
import { createGame, LIFT_TIME, RESPAWN_TIME } from "./game/game.js";
import { KIND } from "./game/rider.js";
import { createFirstPersonCamera } from "./game/camera.js";
import { createRiderViews } from "./game/riderView.js";
import { createViewmodel, fallbackGun, fallbackArms } from "./game/viewmodel.js";
import { rayRiders, eyeOf, lineOfSight } from "./game/combat.js";
import { activeWeapon, PRIMARIES, makeLoadout, WEAPONS } from "./game/weapons.js";
import { createAudio } from "./audio/audio.js";
import { renderMinimap } from "./ui/minimap.js";
import { createGameHud } from "./ui/gamehud.js";
import { ASSETS } from "./assetManifest.js";
import { clamp, damp, smoothstep } from "./core/noise.js";
import { MAP } from "./world/mountain.js";
import { SUN_DIR } from "./world/sky.js";

// ── FACET WIRING ──
// (facet imports and initialization go here)
// ── END FACET WIRING ──

const STEP = 1000 / 120;

installAtmosphereFog();

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, 1, 0.2, 32000);
camera.rotation.order = "YXZ";
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(54, 1, 0.01, 10);

const world = buildWorld(scene, renderer);
viewScene.environment = scene.environment;
viewScene.environmentIntensity = 0.75;
const park = createPark(scene, world, world.terrain.material);
const ground = makeGround(world, park);
const props = createProps(scene, world, ground);
const game = createGame({ world, ground, park });
game.physicsWorld.obstacles = props.obstacles;
const fx = createEffects(scene);
const atmosphere = createAtmosphere(scene);
const tracks = createTracks(scene, ground);
const riders = createRiderViews(scene, null, (x, z) => ground.ground(x, z));
// Far voices pan with cheap equal-power instead of HRTF (keeps big firefights smooth).
const audio = createAudio({ hrtfMaxDistance: 150 });
const newAudio = typeof audio.loadSample === "function";
const viewmodel = createViewmodel(viewScene, viewCamera, {
  onCue(name, id) {
    if (name === "equip") audio.equip?.(id);
    else if (newAudio) audio.reload?.(id, name);
    else audio.reload?.(WEAPONS[id]?.sound);
  },
});
for (const id of [...PRIMARIES, "pistol"]) viewmodel.addGun(id, fallbackGun(id));
viewmodel.setArms({ ...fallbackArms(), pole: null });
const fpCam = createFirstPersonCamera(camera);
const minimap = renderMinimap(world.mountain, world.sampler, world.forest);
const pipeline = createPipeline(renderer, scene, camera, viewScene, viewCamera);
const gameHud = createGameHud(() => window.__studio?.hud, () => renderer.domElement, minimap);

function resize() {
  const width = Math.max(1, innerWidth);
  const height = Math.max(1, innerHeight);
  renderer.setSize(width, height, false);
  pipeline.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  viewCamera.aspect = width / height;
  viewCamera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ── Blender assets (guns, rider parts, gear) ──
const loader = new GLTFLoader();
const assetsLoaded = { guns: 0, body: false, gear: false, gunshot: false };
const normName = (s) => String(s).replace(/[^a-z0-9]/gi, "").toLowerCase();
async function loadAssets() {
  const load = (url) =>
    loader
      .loadAsync(url)
      .then((g) => g.scene)
      .catch((err) => {
        console.warn("asset failed", url, err);
        return null;
      });
  const gunModels = {};
  await Promise.all(
    Object.entries(ASSETS.guns ?? {}).map(async ([id, url]) => {
      const root = await load(url);
      if (!root) return;
      gunModels[id] = root;
      viewmodel.addGun(id, root.clone(true));
      assetsLoaded.guns++;
    }),
  );
  let bodyNodes = null;
  let gearLists = null;
  if (ASSETS.body) {
    const body = await load(ASSETS.body);
    if (body) {
      bodyNodes = new Map();
      for (const o of [...body.children]) {
        o.position.set(0, 0, 0);
        bodyNodes.set(normName(o.name), o);
      }
      assetsLoaded.body = true;
    }
  }
  if (ASSETS.gear) {
    const gear = await load(ASSETS.gear);
    if (gear) {
      const byName = new Map();
      for (const o of [...gear.children]) byName.set(normName(o.name), o);
      const meshList = (node) => {
        const out = [];
        node?.traverse((m) => {
          if (m.isMesh) out.push([m.geometry, m.material?.name || "Gear", m.material]);
        });
        return out.length ? out : null;
      };
      gearLists = { ski: meshList(byName.get("ski")), board: meshList(byName.get("snowboard")) };
      // First-person sleeves wear the player's team colour (the file's Jacket is white).
      const sleeve = new THREE.MeshStandardMaterial({ color: 0x1f6fe0, roughness: 0.72, metalness: 0 });
      const fp = (name) => {
        const n = byName.get(name);
        if (!n) return null;
        const c = n.clone(true);
        c.position.set(0, 0, 0);
        c.traverse((m) => {
          if (m.isMesh && m.material?.name === "Jacket") m.material = sleeve;
        });
        return c;
      };
      // The pole rides in the left fist: same origin as FP_ArmL.
      const left = new THREE.Group();
      const armL = fp("fparml");
      const pole = fp("pole");
      if (armL) left.add(armL);
      if (pole) left.add(pole);
      viewmodel.setArms({ R: fp("fparmr"), L: left.children.length ? left : null, LS: fp("fparmlsupport") });
      assetsLoaded.gear = true;
    }
  }
  if (bodyNodes || gearLists || Object.keys(gunModels).length) riders.setParts(bodyNodes ?? new Map(), gearLists, gunModels);
}
await loadAssets();

/** Compile every shader up front (including normally-hidden flashes) so the first shot never hitches. */
function precompile() {
  const hidden = [];
  for (const root of [scene, viewScene]) {
    root.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
  }
  try {
    renderer.compile(scene, camera);
    renderer.compile(viewScene, viewCamera);
  } catch (err) {
    console.warn("precompile", err);
  }
  for (const o of hidden) o.visible = false;
}
precompile();

// ── view state the HUD reads ──
const view = {
  fov: 74,
  hitT: -9,
  hitKill: false,
  hitPart: "body",
  spotted: new Map(),
  aimAgent: null,
  tab: false,
  warning: "",
  fade: 0,
  hurt: 0,
  scoped: false,
};
let titleT = 0;
let mutePrev = false;
const tmpV = new THREE.Vector3();
const tmpW = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const eyeTmp = {};
let simTime = 0;
let visTime = 0;
/** Events produced by the 120 Hz steps, consumed once per rendered frame. */
const pending = [];
/** Mouse movement accumulated since the last rendered frame (viewmodel sway). */
const lookAccum = { x: 0, y: 0 };
let tabHeld = false;
/** A named studio camera holds the view (re-applied each frame) until reset/begin/input. */
let cameraOverride = null;
let lastDemo = null;
let forceAds = false;
/** First-person photo views keep the player's body hidden, like real play. */
let fpPhoto = false;
let hudHiddenForPhoto = false;
let hudClock = 0;
let lastAlive = true;
/** Audio state tracked per frame: music by phase, countdown beeps, ADS foley, the lift's wind. */
const audioTrack = { phase: "", count: -1, ads: false, flightPrev: new THREE.Vector3(), flightOn: false };
let audioStarted = false;

function titleCamera(dt) {
  titleT += dt;
  // Slow drift down the mountain, looking out across the valley toward the low sun.
  const t = titleT * 0.02;
  const x = -120 + Math.sin(t) * 180;
  const z = -760 + titleT * 3.5;
  const y = world.sampler.heightAt(x, z) + 55 + Math.sin(t * 1.3) * 10;
  camera.position.set(x, y, z);
  camera.rotation.set(-0.08, Math.PI - 0.35 + Math.sin(t * 0.7) * 0.12, 0);
  if (camera.fov !== 70) {
    camera.fov = 70;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

function panOf(x, z) {
  const dx = x - camera.position.x;
  const dz = z - camera.position.z;
  tmpR.set(1, 0, 0).applyQuaternion(camera.quaternion);
  const d = Math.hypot(dx, dz) || 1;
  return clamp((dx * tmpR.x + dz * tmpR.z) / d, -1, 1) * 0.8;
}

/** Gunshot sound through whichever audio engine is loaded (the new spatial one or the old). */
function shotSound(def, ag, isMe) {
  if (newAudio) {
    // Bots: `id` lets the mixer cap each rider's overlapping reports.
    audio.shot(def.id, isMe ? null : { x: ag.rider.p.x, y: ag.rider.p.y + 1.4, z: ag.rider.p.z }, isMe ? {} : { id: ag.id });
  } else {
    const d = isMe ? 0 : Math.hypot(ag.rider.p.x - camera.position.x, ag.rider.p.z - camera.position.z);
    audio.shot(def.sound, d, isMe ? 0 : panOf(ag.rider.p.x, ag.rider.p.z));
  }
}

const GUN_PUNCH = {
  ar: [0.006, 0.6],
  smg: [0.004, 0.4],
  shotgun: [0.022, 2.2],
  sniper: [0.03, 3.0],
  pistol: [0.009, 0.8],
};

/** Phase music, the 3-2-1 beeps, ADS foley and the wind on the lift flight. */
function trackAudio(p, playing, dt) {
  const t = audioTrack;
  if (game.phase !== t.phase) {
    t.phase = game.phase;
    audio.music?.(game.phase === "results" ? "results" : playing ? "match" : "menu");
  }
  if (game.phase === "countdown") {
    const n = 3 - Math.floor(game.phaseT);
    if (n !== t.count && n > 0) audio.countdown?.(n);
    t.count = n;
  } else t.count = -1;
  const ads = p.alive && p.loadout.ads > (t.ads ? 0.35 : 0.6);
  if (ads !== t.ads && playing && !cameraOverride) {
    if (ads) audio.adsIn?.();
    else audio.adsOut?.();
  }
  t.ads = ads;
  // Riding the lift: the drone flight's rush of wind (the motion bed driven by the camera's speed).
  const flying = playing && !p.alive && p.liftT > 0 && liftFlight.active;
  if (flying && newAudio && dt > 0) {
    const v = t.flightOn ? camera.position.distanceTo(t.flightPrev) / dt : 0;
    audio.motion?.({ speed: Math.min(45, v / 8), grounded: false, edge: 0, skid: 0, kind: p.rider.kind, air: 1, powder: 0, grinding: false }, dt);
  }
  t.flightOn = flying;
  t.flightPrev.copy(camera.position);
}

/** Snow hits the goggles (it melts / blows off over a second or two). */
function splatLens(amount) {
  const f = pipeline.final.uniforms;
  if (f.lensSnow.value < 0.2) f.lensSeed.value = (simTime * 7.31) % 50;
  view.lensSnow = Math.min(1, Math.max(view.lensSnow ?? 0, amount));
}

function handleEvents(events) {
  const p = game.player;
  for (const ev of events) {
    switch (ev.type) {
      case "shot": {
        const ag = ev.agent;
        const isMe = ag === p;
        if (isMe) {
          viewmodel.muzzleWorld(camera, tmpV);
          const [kp, kf] = GUN_PUNCH[ev.def.id] ?? GUN_PUNCH.ar;
          const side = Math.sin(simTime * 97.3);
          fpCam.kick(kp * 22, side * kp * 6, side * kp * 10, kf * 12);
        } else {
          if (!riders.muzzleOf(ag, tmpV)) {
            eyeOf(ag, eyeTmp);
            const cp = Math.cos(ag.lookPitch);
            tmpV.set(eyeTmp.x - Math.sin(ag.lookYaw) * cp * 0.9, eyeTmp.y - 0.15 + Math.sin(ag.lookPitch) * 0.9, eyeTmp.z - Math.cos(ag.lookYaw) * cp * 0.9);
          }
          fx.muzzle(tmpV.x, tmpV.y, tmpV.z, ev.def.id === "shotgun" ? 0.9 : ev.def.id === "sniper" ? 1.0 : 0.6);
          fx.smoke(tmpV.x, tmpV.y, tmpV.z);
          view.spotted.set(ag, game.time);
        }
        for (const tr of ev.res.tracers) fx.tracer(tmpV.x, tmpV.y, tmpV.z, tr.x1, tr.y1, tr.z1);
        for (const im of ev.res.impacts) {
          fx.impact(im.x, im.y, im.z, im.kind);
          if (newAudio && (isMe || Math.hypot(im.x - camera.position.x, im.z - camera.position.z) < 60)) audio.impact?.(im.kind === "flesh" ? "body" : im.kind === "helmet" ? "metal" : im.kind, im);
        }
        shotSound(ev.def, ag, isMe);
        break;
      }
      case "hit":
        if (ev.attacker === p) {
          view.hitT = game.time;
          view.hitKill = ev.kill;
          view.hitPart = ev.part;
          ev.victim.taggedT = simTime;
          if (newAudio) audio.hitmarker?.(ev.kill ? "kill" : ev.part === "head" ? "head" : "body");
          else audio.tick?.(ev.kill);
        }
        if (ev.victim === p) {
          view.hurt = Math.min(1, view.hurt + ev.amount / 60);
          fpCam.shake(Math.min(0.5, ev.amount / 90));
          fpCam.kick(0.02 + ev.amount * 0.0008, (Math.sin(simTime * 51) * ev.amount) / 3000, (Math.sin(simTime * 37) * ev.amount) / 2500, 0);
          audio.hurt?.(ev.amount);
        }
        break;
      case "whiz":
        audio.whiz?.({ x: ev.x, y: ev.y, z: ev.z });
        fpCam.shake(0.12 + (2.6 - ev.miss) * 0.05);
        // Suppression: rounds snapping past close the view in a little.
        view.suppress = Math.min(1, (view.suppress ?? 0) + 0.18 + (2.6 - ev.miss) * 0.08);
        break;
      case "land":
        if (ev.agent.rider.speed > 5 && (ev.air ?? 0) > 0.5) fx.burst(ev.agent.rider.p.x, ev.agent.rider.p.y, ev.agent.rider.p.z, Math.min(1.5, (ev.impact ?? 2) / 5));
        if (ev.agent === p) {
          audio.land?.(ev.impact ?? 2);
          // A big landing in deep powder throws snow up onto the goggles.
          if ((ev.agent.rider.powder ?? 0) > 0.45 && (ev.impact ?? 0) > 5) splatLens(Math.min(0.8, (ev.impact - 3) / 10));
        }
        break;
      case "sketchy":
        if (ev.agent === p) {
          game.popups.push({ text: "SKETCHY", points: 0, t: game.time, trick: true });
          fpCam.shake(0.35);
        }
        break;
      case "pop":
        if (ev.agent === p) {
          game.popups.push({ text: "PERFECT POP", points: 50, t: game.time, trick: true });
          ev.agent.stats.score += 50;
          audio.medal?.();
        }
        break;
      case "crash":
      case "tree":
        fx.burst(ev.agent.rider.p.x, ev.agent.rider.p.y, ev.agent.rider.p.z, 1.6);
        if (ev.agent === p) {
          splatLens(ev.type === "tree" ? 0.8 : 1);
          fpCam.shake(0.8);
          if (ev.type === "tree") audio.treeHit?.();
          audio.crash?.();
        }
        break;
      case "collide":
        fx.burst((ev.a.rider.p.x + ev.b.rider.p.x) / 2, ev.a.rider.p.y, (ev.a.rider.p.z + ev.b.rider.p.z) / 2, 1.2);
        if (ev.a === p || ev.b === p) {
          splatLens(0.7);
          fpCam.shake(0.6);
          audio.crash?.();
        }
        break;
      case "kill":
        if (ev.victim === p) {
          view.hurt = 1;
          audio.death?.();
        } else if (ev.killer === p) audio.killConfirm?.();
        fx.burst(ev.victim.rider.p.x, ev.victim.rider.p.y, ev.victim.rider.p.z, 1.1);
        break;
      case "medal":
        audio.medal?.();
        if (ev.medals.some((m) => m.icon === "streak" || m.icon === "multi")) audio.streak?.();
        break;
      case "trick":
        if (ev.agent === p) audio.medal?.();
        break;
      case "grindStart":
        if (ev.agent === p) {
          fpCam.kick(0.012, 0, 0.01, 0);
          fpCam.shake(ev.fromAir ? 0.25 : 0.12);
          audio.grind?.(true, ev.rail);
        }
        if (!ev.rail) fx.burst(ev.agent.rider.p.x, ev.agent.rider.p.y, ev.agent.rider.p.z, 0.35);
        break;
      case "grindEnd":
        if (ev.agent === p) audio.grind?.(false);
        break;
      case "spawn":
        if (ev.agent === p) {
          view.lensSnow = 0;
          fpCam.snap();
          audio.respawn?.();
        }
        break;
      case "go":
        audio.go?.();
        break;
      case "dry":
        audio.dryFire?.();
        break;
      default:
        break;
    }
  }
}

let spotI = 0;
function updateSpotting() {
  const p = game.player;
  if (!p.alive) {
    view.aimAgent = null;
    return;
  }
  eyeOf(p, eyeTmp);
  const fwd = tmpV.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const enemies = game.agents.filter((a) => a.team !== p.team && a.alive);
  if (enemies.length) {
    // One sight-line check per frame, round robin.
    const a = enemies[spotI++ % enemies.length];
    const dx = a.rider.p.x - eyeTmp.x;
    const dy = a.rider.p.y + 1 - eyeTmp.y;
    const dz = a.rider.p.z - eyeTmp.z;
    const d = Math.hypot(dx, dy, dz);
    const cone = Math.cos(((camera.fov * Math.PI) / 180) * 0.75);
    if (d < 320 && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d > cone) {
      if (lineOfSight(eyeTmp.x, eyeTmp.y, eyeTmp.z, a.rider.p.x, a.rider.p.y + 1, a.rider.p.z, ground, world.forest)) view.spotted.set(a, game.time);
    }
  }
  // What's under the crosshair — only if nothing (snow, trees) is in the way.
  const hit = rayRiders(game.agents, camera.position.x, camera.position.y, camera.position.z, fwd.x, fwd.y, fwd.z, 400, p);
  if (hit) {
    const o = camera.position;
    const blocked = ground.raycast(o.x, o.y, o.z, fwd.x, fwd.y, fwd.z, hit.t) < hit.t || world.forest.raycast(o.x, o.y, o.z, fwd.x, fwd.y, fwd.z, hit.t) < hit.t;
    view.aimAgent = blocked ? null : hit.agent;
  } else view.aimAgent = null;
}

/**
 * Riding the lift: a drone-style flight from wherever you were up the mountain, swooping in
 * behind your spawn spot and settling exactly on your eyes (no cut into first person).
 */
const liftFlight = {
  active: false,
  p0: new THREE.Vector3(),
  p1: new THREE.Vector3(),
  p2: new THREE.Vector3(),
  p3: new THREE.Vector3(),
  qEnd: new THREE.Quaternion(),
  q: new THREE.Quaternion(),
  m: new THREE.Matrix4(),
  ahead: new THREE.Vector3(),
};
function bezier(f, t, out) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return out.set(
    f.p0.x * a + f.p1.x * b + f.p2.x * c + f.p3.x * d,
    f.p0.y * a + f.p1.y * b + f.p2.y * c + f.p3.y * d,
    f.p0.z * a + f.p1.z * b + f.p2.z * c + f.p3.z * d,
  );
}
function liftCamera(p) {
  const f = liftFlight;
  if (!f.active && p.liftSpot) {
    f.active = true;
    const s = p.liftSpot;
    const fx = -Math.sin(s.heading);
    const fz = -Math.cos(s.heading);
    f.p0.copy(camera.position);
    f.p3.set(s.x, ground.ground(s.x, s.z) + KIND[p.rider.kind].eye, s.z);
    // Climb out steeply, then come in from high behind the spawn, dropping onto the rider.
    f.p1.set(f.p0.x + (f.p3.x - f.p0.x) * 0.2, Math.max(f.p0.y, f.p3.y) + 140, f.p0.z + (f.p3.z - f.p0.z) * 0.2);
    f.p2.set(f.p3.x - fx * 90, f.p3.y + 70, f.p3.z - fz * 90);
    f.qEnd.setFromEuler(new THREE.Euler(-0.12, s.heading, 0, "YXZ"));
  }
  if (!f.active) return deathCamera(p);
  const t = clamp(1 - p.liftT / LIFT_TIME, 0, 1);
  // Ease in fast, settle slowly: most of the distance goes by in the middle of the flight.
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  bezier(f, e, camera.position);
  // Look mostly at the destination (the mountain fills the frame) with a lean into the path,
  // handing over to the spawn heading for the last part.
  bezier(f, Math.min(1, e + 0.08), f.ahead);
  f.ahead.lerp(f.p3, 0.65);
  if (f.ahead.distanceToSquared(camera.position) > 1) {
    f.m.lookAt(camera.position, f.ahead, camera.up);
    f.q.setFromRotationMatrix(f.m);
  } else f.q.copy(f.qEnd);
  f.q.slerp(f.qEnd, smoothstep(0.55, 0.97, t));
  camera.quaternion.copy(f.q);
  const fov = 74 + Math.sin(Math.PI * e) * 14;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

/**
 * Death camera: rise off the body, whip round to whoever got you and zoom in on them (their
 * nameplate shows), so you always know where the shot came from.
 */
const deathCam = { active: false, p0: new THREE.Vector3(), q0: new THREE.Quaternion(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), at: new THREE.Vector3() };
function killerOf(p) {
  return p.killedBy && p.killedBy !== p && p.killedBy.alive ? p.killedBy : null;
}
function deathCamera(p) {
  const c = deathCam;
  if (!c.active) {
    c.active = true;
    c.p0.copy(camera.position);
    c.q0.copy(camera.quaternion);
  }
  const since = RESPAWN_TIME - Math.max(0, p.respawnT);
  const r = p.rider;
  const v = riders.viewOf(p);
  const bx = v?.corpse ? v.corpse.x : r.p.x;
  const by = v?.corpse ? v.corpse.y : r.p.y;
  const bz = v?.corpse ? v.corpse.z : r.p.z;
  const rise = smoothstep(0, 1.1, since);
  camera.position.set(bx + 1.2, by + 3.4, bz + 1.2);
  camera.position.lerpVectors(c.p0, camera.position, rise);
  const killer = killerOf(p);
  let fov = 74;
  if (killer) {
    const k = killer.rider.p;
    c.at.set(k.x, k.y + 1.1, k.z);
    // Zoom so the killer stands out (about a fifth of the screen tall), after a beat.
    const dist = camera.position.distanceTo(c.at);
    const want = clamp((2 * Math.atan(5.5 / Math.max(dist, 1)) * 180) / Math.PI, 16, 74);
    fov = 74 + (want - 74) * smoothstep(0.55, 1.5, since);
  } else c.at.set(bx, by + 0.4, bz);
  c.m.lookAt(camera.position, c.at, camera.up);
  c.q.setFromRotationMatrix(c.m);
  camera.quaternion.slerpQuaternions(c.q0, c.q, smoothstep(0.05, 0.6, since));
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

/** Everything visual for one rendered frame, `dt` = simulated time since the last frame. */
function visualFrame(dt) {
  const p = game.player;
  const playing = game.phase === "playing" || game.phase === "countdown";
  if (cameraOverride === "hold") {
    // A one-shot photo camera: leave the view exactly where it was put.
  } else if (cameraOverride) {
    studioCameras[cameraOverride]?.();
  } else if (!playing) {
    titleCamera(dt);
    audio.silenceMotion?.();
  } else {
    const w = activeWeapon(p.loadout);
    const zoom = 1 + (w.def.zoom - 1) * p.loadout.ads;
    // Recoil and scope sway show in the view (the sim's aim already includes them).
    const yaw = p.lookYaw;
    const pitch = p.lookPitch;
    p.lookYaw += p.loadout.recoilYaw + (p.loadout.swayYaw ?? 0);
    p.lookPitch += p.loadout.recoilPitch + (p.loadout.swayPitch ?? 0);
    if (p.alive) {
      fpCam.update(p, dt, zoom, game.settings.fov ?? 74);
      liftFlight.active = false;
      deathCam.active = false;
    } else if (p.liftT > 0) liftCamera(p);
    else deathCamera(p);
    p.lookYaw = yaw;
    p.lookPitch = pitch;
    if (p.alive) {
      const r = p.rider;
      if (newAudio) audio.motion?.({ speed: r.speed, grounded: r.grounded, edge: r.edge, skid: r.skid, kind: r.kind, air: r.air, powder: r.powder ?? 0, grinding: r.grinding, grindRail: r.grind?.f.type === "rail" }, dt);
      else audio.motion?.(r, dt);
    } else if (!(newAudio && p.liftT > 0 && liftFlight.active)) audio.silenceMotion?.();
  }
  if (p.alive !== lastAlive) {
    lastAlive = p.alive;
    if (p.alive) fpCam.snap();
  }
  audio.setListener?.(camera);
  view.fov = camera.fov;
  const killCam = playing && !p.alive && p.liftT <= 0;
  riders.sync(game.agents, dt, simTime, camera, !cameraOverride || fpPhoto, { team: p.team, aim: killCam ? killerOf(p) : view.aimAgent, only: killCam ? killerOf(p) : null, hidden: !playing || (Boolean(cameraOverride) && cameraOverride !== "hold") });
  for (const ag of game.agents) if (ag.alive) fx.spray(ag.rider, dt);
  if (dt > 0) tracks.update(game.agents, simTime);
  // Events from the steps since the last frame (only recent ones if the sim ran far ahead).
  const events = pending.splice(0, pending.length).filter((e) => simTime - e.at < 0.5);
  handleEvents(events);
  fx.update(dt, camera);
  updateSpotting();
  if (cameraOverride !== "hold") forceAds = false;
  if (forceAds) p.loadout.ads = 1;
  view.scoped = viewmodel.update(p, dt, camera, lookAccum) && playing && (!cameraOverride || forceAds);
  lookAccum.x = 0;
  lookAccum.y = 0;
  // Dead / on the lift flight: no first-person gun (it raises back in on respawn).
  viewScene.visible = (!cameraOverride || forceAds || fpPhoto) && playing && p.alive;
  view.tab = tabHeld;
  // Bounds warning.
  const b = MAP.bounds;
  const pp = p.rider.p;
  const edge = Math.min(pp.x - b.minX, b.maxX - pp.x, pp.z - b.minZ);
  view.warning = p.alive && playing && edge < 60 ? "OUT OF BOUNDS AHEAD — TURN BACK" : "";
  // Post effects.
  const f = pipeline.final.uniforms;
  view.hurt = Math.max(0, view.hurt - dt * 0.8);
  const lowHp = p.alive ? clamp(1 - p.health / 100, 0, 1) : 0.6;
  f.damage.value = playing ? Math.max(view.hurt * 0.8, lowHp * 0.55) : 0;
  // Dead: the world drains of colour (the killer's nameplate stays bright).
  f.lowHealth.value = playing && p.alive ? smoothstep(0.45, 0.85, lowHp) : killCam ? 0.85 : 0;
  const flying = playing && !p.alive && p.liftT > 0 && liftFlight.active;
  f.speedBlur.value = playing && p.alive ? clamp((p.rider.speed - 14) / 26, 0, 1) * 0.9 * (1 - p.loadout.ads) : flying ? Math.sin(Math.PI * clamp(1 - p.liftT / LIFT_TIME, 0, 1)) * 0.75 : 0;
  f.scope.value = view.scoped ? 1 : 0;
  view.suppress = playing && p.alive ? Math.max(0, (view.suppress ?? 0) - dt * 0.7) : 0;
  f.vignette.value = 0.28 + view.suppress * 0.3;
  view.lensSnow = playing && p.alive ? Math.max(0, (view.lensSnow ?? 0) - dt * (0.45 + Math.min(1, p.rider.speed / 30) * 0.5)) : 0;
  f.lensSnow.value = view.lensSnow;
  f.time.value = simTime;
  const sun = atmosphere.update(camera, simTime, dt, (o, d) => {
    if (ground.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 3000) < 3000) return true;
    return world.forest.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 120) < 120;
  });
  f.sunUv.value.set(sun.u, sun.v);
  f.sunVis.value = sun.vis * (view.scoped ? 0 : 1);
  // Light shafts when looking roughly toward the sun.
  camera.getWorldDirection(tmpW);
  const facing = tmpW.dot(SUN_DIR);
  pipeline.setSun(sun.u, sun.v, view.scoped ? 0 : smoothstep(0.15, 0.7, facing) * 0.55);
  // The lift flight ends on the rider's eyes, so nothing to fade (a fallback if it never started).
  const fadeTarget = playing && !p.alive && p.liftT > 0 && !liftFlight.active ? 1 : 0;
  view.fade = damp(view.fade, fadeTarget, 5, dt);
  f.exposure.value = 0.62 * (1 - view.fade * 0.85);
  audio.heartbeat?.(playing && p.alive && p.health < 35);
  trackAudio(p, playing, dt);
  // HUD redraws re-upload a full-screen canvas: ~20 Hz, but hits/kills draw at once.
  hudClock += dt;
  const urgent = events.some((e) => e.type === "hit" || e.type === "kill" || e.type === "trick" || e.type === "medal" || e.type === "go");
  if (hudClock >= 0.05 || urgent || dt === 0 || !playing) {
    hudClock = 0;
    gameHud.update(game, view);
  }
}

function lookFrom(x, z, yaw, pitch, h = 1.7) {
  camera.position.set(x, ground.ground(x, z) + h, z);
  camera.rotation.set(pitch, yaw, 0);
  if (camera.fov !== 70) {
    camera.fov = 70;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

function settleViewmodel(p, zoom = 1, frames = 90) {
  fpCam.update(p, 0, zoom);
  for (let i = 0; i < frames; i++) viewmodel.update(p, 1 / 60, camera, { x: 0, y: 0 });
}

/** Photo setups that pose the live player start from a fresh, living player in a match. */
function ensureAlive() {
  if (game.phase !== "playing" || !game.player.alive) {
    game.reset(7);
    game.begin();
    fpCam.snap();
  }
}

const studioCameras = {
  title() {
    titleT = 0;
    titleCamera(0);
  },
  summit() {
    lookFrom(10, -1150, Math.PI, -0.12);
  },
  run() {
    lookFrom(-30, -560, Math.PI + 0.15, -0.1);
  },
  park() {
    const k = park.features.find((f) => f.name === "park-m");
    lookFrom(k.x - k.tx * 30 + 8, k.z - k.tz * 30, Math.atan2(-k.tx, -k.tz) + 0.2, -0.1, 2.2);
  },
  overview() {
    camera.position.set(900, 1250, 2900);
    camera.lookAt(0, 380, -250);
    camera.updateMatrixWorld();
  },
  valley() {
    lookFrom(40, 860, Math.PI - 0.3, 0.02);
  },
  lift() {
    lookFrom(40, -420, Math.PI - 0.35, -0.06, 2.0);
  },
  /** One photo per weapon at the hip (sets the player's loadout). */
  ...Object.fromEntries(
    ["smg", "shotgun", "sniper", "pistol"].map((id) => [
      `jumpgun-${id}`,
      () => {
        ensureAlive();
        const p = game.player;
        p.loadout = makeLoadout(id === "pistol" ? "ar" : id);
        if (id === "pistol") p.loadout.active = 1;
        settleViewmodel(p);
        gameHud.update(game, view);
      },
    ]),
  ),
  /** Runs the 360 trick demo and shows the landing with its popup. */
  jumptrick() {
    demos.trick();
    settleViewmodel(game.player, 1, 30);
    gameHud.update(game, view);
  },
  /** Aiming down the sights (photo): the optic must sit on the screen centre. */
  jumpads() {
    ensureAlive();
    forceAds = true;
    const p = game.player;
    p.loadout.ads = 1;
    settleViewmodel(p, activeWeapon(p.loadout).def.zoom);
    gameHud.update(game, view);
  },
  /** Mid-reload (photo): the mag out and the left glove coming in. */
  jumpreload() {
    ensureAlive();
    const p = game.player;
    const w = activeWeapon(p.loadout);
    w.mag = 3;
    w.reloading = true;
    w.reloadT = w.def.reload * 0.62;
    settleViewmodel(p, 1, 30);
    gameHud.update(game, view);
  },
  /** Runs the jump demo, then frames the player mid-air from the side (photo of a kicker launch). */
  jumpside() {
    demos.jump();
    const r = game.player.rider;
    const rx = Math.cos(r.heading);
    const rz = -Math.sin(r.heading);
    camera.position.set(r.p.x + rx * 14 - Math.sin(r.heading) * 4, r.p.y + 1.5, r.p.z + rz * 14 - Math.cos(r.heading) * 4);
    camera.lookAt(r.p.x, r.p.y + 0.5, r.p.z);
    camera.updateMatrixWorld();
  },
  /** First-person view without the HUD (to check gloves, pole and gun framing). */
  jumpfpclean() {
    ensureAlive();
    window.__studio?.hud?.enable(false);
    hudHiddenForPhoto = true;
    settleViewmodel(game.player);
  },
  /** Runs the jump demo and shows the player's own view mid-air. */
  jumpfp() {
    demos.jump();
    settleViewmodel(game.player, 1, 20);
  },
  /** A firefight: the photo is taken from the player's eyes right after a kill. */
  jumpfight() {
    demos.fight();
    settleViewmodel(game.player, 1, 10);
    gameHud.update(game, view);
  },
  /** Snow on the goggles right after a wipe-out (photo). */
  jumpsplat() {
    ensureAlive();
    settleViewmodel(game.player);
    pipeline.final.uniforms.lensSeed.value = 11.3;
    view.lensSnow = 0.85;
    pipeline.final.uniforms.lensSnow.value = 0.85;
    gameHud.update(game, view);
  },
  /** Mid-grind on the park rail, from the rider's eyes. */
  jumpgrind() {
    demos.grind();
    settleViewmodel(game.player, 1, 20);
    gameHud.update(game, view);
  },
  /** Mid-grind, seen from the side (third person). */
  jumpgrindside() {
    demos.grind();
    const r = game.player.rider;
    const f = r.grind?.f;
    const tx = f ? f.tx : -Math.sin(r.heading);
    const tz = f ? f.tz : -Math.cos(r.heading);
    camera.position.set(r.p.x + tz * 5 + tx * 2.5, r.p.y + 1.4, r.p.z - tx * 5 + tz * 2.5);
    camera.lookAt(r.p.x, r.p.y + 0.6, r.p.z);
    camera.updateMatrixWorld();
  },
  /** A snowboarder on the rail, seen from the side. */
  jumpgrindboard() {
    const prev = game.choice.kind;
    game.choice.kind = "board";
    demos.grind();
    game.choice.kind = prev;
    const r = game.player.rider;
    const f = r.grind?.f;
    const tx = f ? f.tx : -Math.sin(r.heading);
    const tz = f ? f.tz : -Math.cos(r.heading);
    camera.position.set(r.p.x + tz * 4.5 + tx * 2, r.p.y + 1.3, r.p.z - tx * 4.5 + tz * 2);
    camera.lookAt(r.p.x, r.p.y + 0.7, r.p.z);
    camera.updateMatrixWorld();
  },
  /** Riding the lift back up: the drone flight part-way up the mountain. */
  jumplift() {
    demos.lift(0.45);
    liftCamera(game.player);
    gameHud.update(game, view);
  },
  /** Just killed by an enemy: the death camera and the killer/weapon/distance card. */
  jumpdeath() {
    demos.death();
    deathCamera(game.player);
    gameHud.update(game, view);
  },
  /** The front-end screens (for photos): title and loadout over the flyover. */
  menu() {
    if (game.phase !== "title") {
      game.phase = "title";
      game.phaseT = 0;
    }
    titleCamera(0);
    gameHud.update(game, view);
  },
  results() {
    if (game.phase !== "results") {
      game.scores = { blue: 50, red: 43 };
      game.agents.forEach((a, i) => {
        a.stats.kills = (i * 7) % 11;
        a.stats.deaths = (i * 5) % 9;
        a.stats.score = a.stats.kills * 100 + ((i * 37) % 300);
        a.stats.tricks = ((i * 53) % 9) * 250;
        a.stats.best = Math.max(1, (i * 3) % 6);
        a.stats.medals = (i * 5) % 12;
      });
      game.winner = "blue";
      game.phase = "results";
      game.phaseT = 2;
    }
    titleCamera(0);
    gameHud.update(game, view);
  },
  loadout() {
    if (game.phase !== "loadout") {
      game.phase = "loadout";
      game.phaseT = 0;
    }
    titleCamera(0);
    gameHud.update(game, view);
  },
  trees() {
    lookFrom(-90, -470, -0.9, 0.02);
  },
  fp() {
    settleViewmodel(game.player);
  },
  chase() {
    const r = game.player.rider;
    camera.position.set(r.p.x + Math.sin(r.heading) * 5, r.p.y + 2.4, r.p.z + Math.cos(r.heading) * 5);
    camera.lookAt(r.p.x, r.p.y + 1, r.p.z);
    camera.updateMatrixWorld();
  },
  boarder() {
    const p = game.player.rider.p;
    const bots = game.agents.filter((a) => !a.isPlayer && a.alive && a.rider.kind === "board");
    bots.sort((a, b) => Math.hypot(a.rider.p.x - p.x, a.rider.p.z - p.z) - Math.hypot(b.rider.p.x - p.x, b.rider.p.z - p.z));
    const b = bots[0];
    if (!b) return;
    const r = b.rider;
    const fx2 = -Math.sin(r.heading);
    const fz2 = -Math.cos(r.heading);
    camera.position.set(r.p.x + fx2 * 3.4 + Math.cos(r.heading) * 2.2, r.p.y + 1.4, r.p.z + fz2 * 3.4 - Math.sin(r.heading) * 2.2);
    camera.lookAt(r.p.x, r.p.y + 0.9, r.p.z);
    camera.updateMatrixWorld();
  },
  bot() {
    // The nearest living bot, seen from in front and to the side.
    const p = game.player.rider.p;
    const bots = game.agents.filter((a) => !a.isPlayer && a.alive);
    bots.sort((a, b) => Math.hypot(a.rider.p.x - p.x, a.rider.p.z - p.z) - Math.hypot(b.rider.p.x - p.x, b.rider.p.z - p.z));
    const b = bots[0];
    if (!b) return;
    const r = b.rider;
    const fx2 = -Math.sin(r.heading);
    const fz2 = -Math.cos(r.heading);
    camera.position.set(r.p.x + fx2 * 3.2 + Math.cos(r.heading) * 1.6, r.p.y + 1.5, r.p.z + fz2 * 3.2 - Math.sin(r.heading) * 1.6);
    camera.lookAt(r.p.x, r.p.y + 1.0, r.p.z);
    camera.updateMatrixWorld();
  },
};

function syncForCapture() {
  props.update(simTime);
  const p = game.player;
  const playing = game.phase === "playing" || game.phase === "countdown";
  const killCam = playing && !p.alive && p.liftT <= 0;
  riders.sync(game.agents, 0, simTime, camera, !cameraOverride || fpPhoto, { team: p.team, aim: killCam ? killerOf(p) : view.aimAgent, only: killCam ? killerOf(p) : null, hidden: !playing || (Boolean(cameraOverride) && cameraOverride !== "hold") });
  world.update(camera, simTime);
  world.forest.fill(camera, true);
}

// ── simulation step (shared by the studio loop and the demos) ──
function simStep(dtS, ctx) {
  game.update(dtS, ctx);
  simTime += dtS;
  for (const ev of game.events) {
    ev.at = simTime;
    pending.push(ev);
  }
  if (pending.length > 400) pending.splice(0, pending.length - 400);
}

// ── demos: deterministic showcases of mechanics the generic walk won't reach ──
function runSteps(n, keys = [], look = null) {
  for (let i = 0; i < n; i++) {
    const ctx = { synthetic: true, keys: new Set(keys), look: look ?? { x: 0, y: 0 }, wheel: { x: 0, y: 0 }, rng: game.rng, pointer: { x: 0.5, y: 0.5, locked: true } };
    simStep(STEP / 1000, ctx);
  }
}

/** After a demo: one visual frame so the photo shows the end state (particles, HUD, poses). */
function demoFrame() {
  visTime = simTime;
  visualFrame(1 / 60);
}

function placePlayerBeforeKicker(name, speed) {
  game.reset(7);
  game.begin();
  const k = park.features.find((f) => f.name === name);
  const p = game.player;
  const sx = k.x - k.tx * 40;
  const sz = k.z - k.tz * 40;
  const heading = Math.atan2(-k.tx, -k.tz);
  p.rider.p.x = sx;
  p.rider.p.z = sz;
  p.rider.p.y = ground.ground(sx, sz);
  p.rider.heading = heading;
  p.rider.v.x = k.tx * speed;
  p.rider.v.z = k.tz * speed;
  p.lookYaw = heading;
  p.lookPitch = -0.15;
  fpCam.snap();
  return { k, p };
}

function placePlayerBeforeJib(name, speed) {
  game.reset(7);
  game.begin();
  const k = park.features.find((f) => f.name === name);
  const p = game.player;
  const back = k.length / 2 + k.ramp + 14;
  const sx = k.x - k.tx * back;
  const sz = k.z - k.tz * back;
  const heading = Math.atan2(-k.tx, -k.tz);
  p.rider.p.x = sx;
  p.rider.p.z = sz;
  p.rider.p.y = ground.ground(sx, sz);
  p.rider.heading = heading;
  p.rider.v.x = k.tx * speed;
  p.rider.v.z = k.tz * speed;
  p.lookYaw = heading;
  p.lookPitch = -0.2;
  fpCam.snap();
  return { k, p };
}

const demos = {
  jump() {
    const { k, p } = placePlayerBeforeKicker("park-l", 19);
    const trace = [];
    for (let i = 0; i < 600; i++) {
      runSteps(1, ["KeyW"]);
      const dx = p.rider.p.x - k.x;
      const dz = p.rider.p.z - k.z;
      const u = dx * k.tx + dz * k.tz;
      if (i % 20 === 0) trace.push([Math.round(u * 10) / 10, Math.round(park.heightAt(p.rider.p.x, p.rider.p.z) * 100) / 100, p.rider.grounded ? 1 : 0, Math.round(p.rider.speed * 10) / 10]);
      if (!p.rider.grounded && p.rider.air > 0.55) break;
    }
    demoFrame();
    syncForCapture();
    lastDemo = { airborne: !p.rider.grounded, air: p.rider.air, height: p.rider.airHeight, speed: p.rider.speed, trace };
    return lastDemo;
  },
  /** Off the big kicker with a 360: release the keys in the air, press D for the spin, land it. */
  trick() {
    const { p } = placePlayerBeforeKicker("park-l", 19);
    let phase = 0;
    let landed = null;
    for (let i = 0; i < 1200; i++) {
      const r = p.rider;
      let keys = ["KeyW"];
      if (!r.grounded) {
        if (phase === 0) phase = 1;
        keys = r.air > 0.08 && Math.abs(r.spin) < Math.PI * 2 - 0.25 ? ["KeyD"] : [];
      } else if (phase === 1) {
        phase = 2;
        landed = i;
      }
      runSteps(1, phase === 2 ? [] : keys);
      if (phase === 2 && i - landed > 50) break;
    }
    demoFrame();
    syncForCapture();
    lastDemo = { phase, popups: game.popups.map((q) => `${q.text} +${q.points}`), crash: p.rider.crash > 0, tricks: p.stats.tricks };
    return lastDemo;
  },
  carve() {
    game.reset(3);
    game.begin();
    for (let i = 0; i < 720; i++) runSteps(1, [Math.floor(i / 140) % 2 ? "KeyA" : "KeyD"]);
    demoFrame();
    syncForCapture();
    return { speed: game.player.rider.speed, z: game.player.rider.p.z };
  },
  /** Face the nearest enemy bot at close range and fire until it drops (hits, medals, kill feed). */
  fight() {
    game.reset(5);
    game.begin();
    const p = game.player;
    const foe = game.agents.find((a) => a.team !== p.team);
    // Put the foe 22 m ahead of the player, both stationary on the summit flat.
    const h = p.rider.heading;
    foe.rider.p.x = p.rider.p.x - Math.sin(h) * 22;
    foe.rider.p.z = p.rider.p.z - Math.cos(h) * 22;
    foe.rider.p.y = ground.ground(foe.rider.p.x, foe.rider.p.z);
    foe.invuln = 0;
    p.invuln = 0;
    let shots = 0;
    for (let i = 0; i < 480 && foe.alive; i++) {
      eyeOf(p, eyeTmp);
      const tx = foe.rider.p.x - eyeTmp.x;
      const ty = foe.rider.p.y + 1.25 - eyeTmp.y;
      const tz = foe.rider.p.z - eyeTmp.z;
      p.lookYaw = Math.atan2(-tx, -tz);
      p.lookPitch = Math.atan2(ty, Math.hypot(tx, tz));
      p.rider.v.x = 0;
      p.rider.v.z = 0;
      foe.rider.v.x = 0;
      foe.rider.v.z = 0;
      const before = p.loadout.fired;
      runSteps(1, ["Mouse1", "Mouse2"]);
      shots += p.loadout.fired - before;
    }
    runSteps(12);
    demoFrame();
    syncForCapture();
    lastDemo = { killed: !foe.alive, shots, medals: game.medals.map((m) => m.name), feed: game.feed.slice(0, 1).map((f) => `${f.killer} > ${f.victim}`) };
    return lastDemo;
  },
  /** Ride up the rail's feed ramp and grind it (photo stops mid-grind unless `full`). */
  grind(full = false) {
    const { k, p } = placePlayerBeforeJib("rail-1", 11);
    let started = -1;
    const trace = [];
    for (let i = 0; i < 900; i++) {
      runSteps(1);
      const r = p.rider;
      if (r.grind && started < 0) started = i;
      if (i % 15 === 0) trace.push([Math.round(r.p.y * 100) / 100, r.grind ? 1 : 0, Math.round(r.speed * 10) / 10]);
      if (!full && started >= 0 && i - started > 50) break;
      if (full && started >= 0 && !r.grind && r.grounded && i - started > 60) break;
    }
    demoFrame();
    syncForCapture();
    lastDemo = { grinding: Boolean(p.rider.grind), name: p.rider.grind?.name ?? null, started, popups: game.popups.map((q) => `${q.text} +${q.points}`), trace: trace.slice(0, 30), jib: k.name };
    return lastDemo;
  },
  /** Coast to a stop at the bottom: the lift takes over and flies you back up (stops part-way). */
  lift(frac = 0.42) {
    game.reset(7);
    game.begin();
    const p = game.player;
    const x = 40;
    const z = MAP.baseZ - 30;
    p.rider.p.x = x;
    p.rider.p.z = z;
    p.rider.p.y = ground.ground(x, z);
    p.rider.v.x = 0;
    p.rider.v.z = 0;
    p.rider.heading = Math.PI;
    p.lookYaw = Math.PI;
    p.lookPitch = -0.05;
    fpCam.snap();
    fpCam.update(p, 0, 1);
    liftFlight.active = false;
    runSteps(1);
    liftCamera(p);
    runSteps(Math.round(LIFT_TIME * frac * 120));
    demoFrame();
    if (!p.alive && p.liftT > 0) liftCamera(p);
    syncForCapture();
    lastDemo = { riding: !p.alive && p.liftT > 0, liftT: Number(p.liftT.toFixed(2)), camY: Math.round(camera.position.y), spot: p.liftSpot };
    return lastDemo;
  },
  /** An enemy takes the player out (the death screen: who, with what, from how far). */
  death() {
    game.reset(5);
    game.begin();
    const p = game.player;
    const foe = game.agents.find((a) => a.team !== p.team);
    const h = p.rider.heading;
    foe.rider.p.x = p.rider.p.x - Math.sin(h) * 34;
    foe.rider.p.z = p.rider.p.z - Math.cos(h) * 34;
    foe.rider.p.y = ground.ground(foe.rider.p.x, foe.rider.p.z);
    p.invuln = 0;
    game.damage(p, 60, foe, foe.loadout.slots[0].def.name, "body", foe.rider.p.x, foe.rider.p.z, 34);
    runSteps(30);
    game.damage(p, 80, foe, foe.loadout.slots[0].def.name, "head", foe.rider.p.x, foe.rider.p.z, 34);
    // Let the camera rise, find the killer and zoom (about 1.4 s after the kill).
    for (let i = 0; i < 6; i++) {
      runSteps(28);
      demoFrame();
    }
    demoFrame();
    syncForCapture();
    lastDemo = { alive: p.alive, killInfo: p.killInfo ? { ...p.killInfo } : null };
    return lastDemo;
  },
  firefight() {
    game.reset(11);
    game.begin();
    for (let i = 0; i < 20; i++) runSteps(120);
    demoFrame();
    syncForCapture();
    return { scores: { ...game.scores }, feed: game.feed.length };
  },
};

installStudio({
  canvas: renderer.domElement,
  scene,
  renderer,
  camera,
  fixedStepMs: STEP,
  input: { pointerLock: true },
  player: () => {
    const r = game.player.rider;
    return { x: r.p.x, y: r.p.y, z: r.p.z, yaw: game.player.lookYaw, pitch: game.player.lookPitch };
  },
  reset(seed) {
    cameraOverride = null;
    fpPhoto = false;
    if (hudHiddenForPhoto) {
      window.__studio?.hud?.enable(true);
      hudHiddenForPhoto = false;
    }
    game.reset(seed);
    fx.reset(seed);
    tracks.reset();
    pending.length = 0;
    simTime = 0;
    visTime = 0;
    titleT = 0;
    fpCam.snap();
    titleCamera(0);
    visualFrame(0);
  },
  flow: () => game.flowPhase(),
  begin() {
    cameraOverride = null;
    game.begin();
    fpCam.snap();
    visualFrame(0);
  },
  update(dt, ctx) {
    if (ctx.keys.size > 0 && !audioStarted) {
      audioStarted = true;
      audio.start();
      if (newAudio && ASSETS.audio?.rifle) audio.loadSample("rifle", ASSETS.audio.rifle).then((ok) => (assetsLoaded.gunshot = Boolean(ok)));
      audio.ambience?.(true);
    }
    const m = ctx.keys.has("KeyM");
    if (m && !mutePrev) audio.toggleMute();
    mutePrev = m;
    if (!ctx.synthetic && cameraOverride && (ctx.keys.size > 0 || ctx.look.x !== 0 || ctx.look.y !== 0)) cameraOverride = null;
    lookAccum.x += ctx.look.x;
    lookAccum.y += ctx.look.y;
    tabHeld = ctx.keys.has("Tab");
    // Menu sounds.
    if (game.phase === "title" || game.phase === "loadout") {
      for (const k of ["KeyA", "KeyD", "KeyW", "KeyS", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Digit1", "Digit2"]) {
        if (ctx.keys.has(k) && !game.keysPrev.has(k)) audio.ui?.("move");
      }
      if ((ctx.keys.has("Enter") || ctx.keys.has("Space")) && !game.keysPrev.has("Enter") && !game.keysPrev.has("Space")) audio.ui?.("select");
    }
    simStep(dt, ctx);
  },
  render() {
    const dt = Math.min(0.1, simTime - visTime);
    visTime = simTime;
    visualFrame(dt);
    world.update(camera, simTime);
    props.update(simTime);
    pipeline.render(dt);
  },
  audio: () => audio.analyser(),
  probes() {
    const p = game.player;
    const w = activeWeapon(p.loadout);
    return {
      phase: game.phase,
      player: {
        kind: p.rider.kind,
        speedKmh: Math.round(p.rider.speed * 3.6),
        grounded: p.rider.grounded,
        airTime: Number(p.rider.air.toFixed(2)),
        health: Math.round(p.health),
        alive: p.alive,
        weapon: w.def.id,
        mag: w.mag,
        reserve: w.reserve,
        ads: Number(p.loadout.ads.toFixed(2)),
        raise: Number((p.loadout.raise ?? 1).toFixed(2)),
        kills: p.stats.kills,
        deaths: p.stats.deaths,
        trickPoints: p.stats.tricks,
        medals: game.medals.map((m) => m.name),
      },
      match: {
        blue: game.scores.blue,
        red: game.scores.red,
        clock: Math.round(game.clock),
        alive: game.agents.filter((a) => a.alive).length,
        feed: game.feed.slice(0, 3).map((f) => `${f.killer ?? "-"} > ${f.victim} (${f.weapon})`),
      },
      render: { drawCalls: pipeline.stats.calls, triangles: pipeline.stats.triangles, trees: world.treeCount, treeLods: world.forest.counts(), particles: fx.activeCount() },
      assets: assetsLoaded,
      // Mixer health: live voices, drops/steals, errors, music state (new engine only).
      audio: (() => {
        try {
          return audio.stats?.() ?? null;
        } catch {
          return null;
        }
      })(),
      lastDemo,
      bootMs: world.timings,
    };
  },
  cameras: {
    default() {
      cameraOverride = null;
      visualFrame(0);
      syncForCapture();
    },
    ...Object.fromEntries(
      Object.entries(studioCameras).map(([name, fn]) => [
        name,
        () => {
          forceAds = false;
          view.lensSnow = 0;
          pipeline.final.uniforms.lensSnow.value = 0;
          cameraOverride = name === "fp" ? null : /^jump/.test(name) ? "hold" : name;
          fpPhoto = /^jump(fp|ads|gun|trick|reload|fight|grind$|splat)/.test(name);
          if (hudHiddenForPhoto && name !== "jumpfpclean") {
            window.__studio?.hud?.enable(true);
            hudHiddenForPhoto = false;
          }
          fn();
          syncForCapture();
        },
      ]),
    ),
  },
  demos: Object.fromEntries(
    Object.entries(demos).map(([k, fn]) => [
      k,
      () => {
        cameraOverride = null;
        return fn();
      },
    ]),
  ),
});
