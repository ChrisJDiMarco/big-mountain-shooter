/**
 * Big Mountain Shooter — audio. Public API (see README.md in this folder).
 *
 *   const audio = createAudio();
 *   audio.start();                 // from a user gesture (creates the AudioContext; repeat calls are cheap)
 *   audio.setListener(camera);     // EVERY frame (also runs the internal scheduler)
 *   audio.motion(rider, dt);       // every frame while riding; silenceMotion() otherwise
 *   audio.shot("ar", null);        // your gun · audio.shot("smg", {x,y,z}, { id }) another rider
 *
 * Every method is a safe no-op before start() and never throws (errors are counted, not raised).
 * One-shots are offline-rendered, normalised buffers (sounds.js) played through a budgeted voice
 * manager (engine.js); continuous beds and music live in loops.js.
 */
import { Engine, LOOK, SPEED_OF_SOUND, VERB_RETURN, validPos, dryGain, wetGain } from "./engine.js";
import { createLoops } from "./loops.js";
import { GUNS, WEAPON_ALIAS, VARIANTS, shotPlan } from "./sounds.js";
import { clamp, dbToGain } from "./dsp.js";

/** Peak levels in dBFS at the master input (bus trims 0 dB). Own AR shot = −6 (GUNS.ar.ownDb). */
export const LV = {
  whiz: -9,
  imp: { snow: -18, tree: -15, body: -13, metal: -15 },
  hit: { body: -12, head: -10.5, kill: -9 },
  confirm: -15,
  medal: -13,
  streak: -10,
  ui: { move: -22, select: -18, back: -20 },
  beepLo: -15,
  beepHi: -13,
  go: -10,
  fol: { magOut: -17, magIn: -14, bolt: -14, charge: -14, slide: -14, pump: -12, shell: -17, chamber: -16, dry: -16, adsIn: -25, adsOut: -27 },
  equip: -16,
  land: [-22, -7],
  clatter: -13,
  crash: -7,
  tree: -7,
  hurt: [-18, -8],
  death: -9,
  respawn: -15,
};
/** Reverb sends (the valley convolver). Remote sends also scale with wetGain(distance). */
export const OWN_SEND = 0.3;
export const REMOTE_SEND = 0.22;
export const IMPACT_SEND = { snow: 0.08, tree: 0.16, body: 0.06, metal: 0.24 };
const IMPACT_ALIAS = { snow: "snow", powder: "snow", ground: "snow", tree: "tree", wood: "tree", body: "body", flesh: "body", rider: "body", metal: "metal", rail: "metal", steel: "metal", rock: "metal", lift: "metal" };
const FOLEY_RATE = { ar: 1, smg: 1.05, pistol: 1.1, shotgun: 0.93, sniper: 0.96 };

export function createAudio(opts = {}) {
  const E = new Engine(opts);
  const loops = createLoops(E);
  let lastHit = { t: -1, rank: 0 };
  const recentImpacts = [];

  const weapon = (id) => WEAPON_ALIAS[id] ?? (GUNS[id] ? id : "ar");
  const variant = (prefix, kind) => `${prefix}/${E.pick(VARIANTS[kind] ?? 1)}`;

  /** A non-spatial one-shot from the bank. o: cat, prio, rate, pan, delay, filter, group, send. */
  function oneShot(name, db, o = {}) {
    const b = E.buf(name);
    if (!b) return null;
    const rate = o.rate ?? 1;
    const t0 = E.now() + LOOK + (o.delay ?? 0);
    const v = E.voice({
      cat: o.cat ?? "ui",
      prio: o.prio ?? 2,
      t0,
      dur: b.duration / rate,
      level: dbToGain(db),
      protect: o.protect ?? true,
      pan: o.pan,
      send: o.send,
      group: o.group,
      groupMax: o.groupMax,
    });
    if (!v) return null;
    v.play(b, t0, { rate, filter: o.filter });
    return v.commit();
  }

  /** Your own gun: full close-up layered report, mechanical action and a stereo-wide tail. */
  function ownShot(w, o) {
    const G = GUNS[w];
    const S = E.samples.get("rifle");
    const scale = E.shotScale(w, !!S) * (o.gain ?? 1);
    const t0 = E.now() + LOOK;
    const rate = E.jitter(0.03); // ±3 % per shot
    // Dry punch and tail are separate voices so automatic fire keeps at most 2 tails alive.
    const dry = E.voice({ cat: "weapons", prio: 4, t0, dur: 0.5, level: scale, group: "own", groupMax: 6, send: G.echo * OWN_SEND });
    const tail = E.voice({ cat: "weapons", prio: 1.5, t0, dur: 1.4, level: scale, group: "ownTail", groupMax: 2 });
    for (const l of shotPlan(w, !!S, 0)) {
      const v = l.tail ? tail : dry;
      if (!v) continue;
      if (l.part === "sample") v.play(S.buffer, t0 + l.at, { gain: l.gain * S.norm, rate: G.sample.rate * rate, offset: S.offset, dur: G.sample.maxDur, fade: 0.12, filter: G.sample.filter });
      else v.play(E.buf(variant(`gun/${w}/${l.part}`, l.part)), t0 + l.at, { gain: l.gain, rate: l.part === "mech" ? E.jitter(0.02) : rate, pan: l.pan });
    }
    dry?.commit();
    tail?.commit();
    // Your shots punch through the beds.
    E.duck("motion", -5, 0.004, 0.05, 0.3);
    E.duck("ambience", -6, 0.004, 0.05, 0.4);
    E.duck("music", -8, 0.004, 0.08, 0.6);
  }

  /** Another rider: spatialised, air-filtered, delayed by distance/343, more echo the farther. */
  function remoteShot(w, pos, o) {
    if (!validPos(pos)) return;
    const G = GUNS[w];
    const gain = o.gain ?? 1;
    const d0 = E.distTo(pos);
    const prio = Math.max(G.remote * dryGain(d0), G.echo * REMOTE_SEND * VERB_RETURN * wetGain(d0) * 0.5) * gain;
    if (prio < 0.002) return;
    const p = { x: pos.x, y: pos.y, z: pos.z }; // copy: callers reuse vectors
    const rate = E.jitter(0.03);
    const group = o.id != null ? `rider:${o.id}` : null;
    E.at(E.now() + LOOK + d0 / SPEED_OF_SOUND, prio, (t0) => {
      const S = E.samples.get("rifle");
      const d = E.distTo(p);
      const v = E.voice({ cat: "weapons", prio, t0, dur: 0.6, level: E.shotScale(w, !!S) * G.remote * gain, pos: p, dist: d, send: G.echo * REMOTE_SEND, group, groupMax: 3 });
      if (!v) return;
      for (const l of shotPlan(w, !!S, Math.max(1, d))) {
        if (l.part === "sample") v.play(S.buffer, t0 + l.at, { gain: l.gain * S.norm, rate: G.sample.rate * rate, offset: S.offset, dur: Math.min(G.sample.maxDur, 0.6), fade: 0.12, filter: G.sample.filter });
        else v.play(E.buf(variant(`gun/${w}/${l.part}`, l.part)), t0 + l.at, { gain: l.gain, rate });
      }
      v.commit();
    });
  }

  const api = {
    start() {
      if (E.start()) loops.onStart();
    },
    get ctx() {
      return E.ctx;
    },
    analyser() {
      return E.analyser;
    },
    toggleMute() {
      return E.toggleMute();
    },
    get muted() {
      return E.muted;
    },
    setVolume(v) {
      E.setVolume(v);
    },
    loadSample(name, url) {
      return E.loadSample(name, url);
    },
    setListener(camera) {
      E.setListener(camera);
      E.tick();
    },
    motion(state, dt) {
      loops.motion(state, dt);
    },
    silenceMotion() {
      loops.silenceMotion();
    },
    shot(weaponId, pos = null, o = {}) {
      if (!E.ctx) return;
      const w = weapon(weaponId);
      if (typeof pos === "number") {
        // Legacy shot(kind, distance, pan): rebuild a point around the listener.
        if (!(pos > 0)) return ownShot(w, {});
        const pan = clamp(Number(o) || 0, -1, 1);
        const L = E.L;
        const fwd = Math.sqrt(1 - pan * pan);
        pos = { x: L.x + (L.rx * pan + L.fx * fwd) * pos, y: L.y, z: L.z + (L.rz * pan + L.fz * fwd) * pos };
        o = {};
      }
      if (pos == null) ownShot(w, o || {});
      else remoteShot(w, pos, o || {});
    },
    whiz(pos) {
      if (!E.ctx || !validPos(pos)) return;
      const t0 = E.now() + LOOK;
      const p = { x: pos.x, y: pos.y, z: pos.z };
      const v = E.voice({ cat: "weapons", prio: 1.2, t0, dur: 0.32, level: dbToGain(LV.whiz), pos: p, dist: E.distTo(p), send: 0.12, group: "whiz", groupMax: 3 });
      if (!v) return;
      v.play(E.buf(variant("whiz", "whiz")), t0, { rate: E.jitter(0.06) });
      v.commit();
    },
    impact(kind, pos) {
      if (!E.ctx) return;
      if (pos != null && !validPos(pos)) return;
      const k = IMPACT_ALIAS[kind] ?? "snow";
      const now = E.now();
      if (pos) {
        // Shotgun pellets: one sound per cluster (same kind within 50 ms and 2.5 m).
        for (let i = recentImpacts.length - 1; i >= 0; i--) if (now - recentImpacts[i].t > 0.05) recentImpacts.splice(i, 1);
        for (const r of recentImpacts) if (r.k === k && Math.hypot(r.x - pos.x, r.y - pos.y, r.z - pos.z) < 2.5) return;
        if (recentImpacts.length < 32) recentImpacts.push({ t: now, k, x: pos.x, y: pos.y, z: pos.z });
      }
      const base = dbToGain(LV.imp[k]);
      const d0 = pos ? E.distTo(pos) : 0;
      const prio = base * (pos ? dryGain(d0) : 1);
      if (prio < 0.0015) return;
      const p = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
      const rate = E.jitter(0.06);
      E.at(now + LOOK + d0 / SPEED_OF_SOUND, prio, (t0) => {
        const v = E.voice({ cat: "impacts", prio, t0, dur: 0.75, level: base, pos: p, dist: p ? E.distTo(p) : 0, send: IMPACT_SEND[k], group: "impact", groupMax: 10 });
        if (!v) return;
        v.play(E.buf(variant(`imp/${k}`, "imp")), t0, { rate });
        v.commit();
      });
    },
    hitmarker(kind = "body") {
      if (!E.ctx) return;
      const k = kind === "head" || kind === "kill" ? kind : "body";
      const rank = k === "kill" ? 3 : k === "head" ? 2 : 1;
      const now = E.now();
      if (now - lastHit.t < 0.03 && rank <= lastHit.rank) return; // 9 pellets → one tick
      lastHit = { t: now, rank };
      oneShot(variant(`hit/${k}`, "hit"), LV.hit[k], { cat: "ui", prio: 5 });
      E.duck("weapons", -5, 0.003, 0.05, 0.14); // let the tick through the gunfire
    },
    killConfirm() {
      if (E.ctx) oneShot("ui/confirm", LV.confirm, { delay: 0.02 });
    },
    medal() {
      if (E.ctx) oneShot("ui/medal", LV.medal);
    },
    streak() {
      if (!E.ctx) return;
      oneShot("ui/streak", LV.streak);
      E.duck("music", -8, 0.01, 0.6, 0.8);
    },
    land(impactSpeed) {
      if (!E.ctx) return;
      const s = Number(impactSpeed);
      const k = clamp(((Number.isFinite(s) ? s : 3) - 1.5) / 11, 0, 1);
      const db = LV.land[0] + (LV.land[1] - LV.land[0]) * Math.sqrt(k);
      oneShot(variant("pl/land", "pl"), db, { cat: "impacts", prio: 2, rate: 1.08 - 0.16 * k, filter: ["lowpass", 1400 + 9000 * k, -3], group: "land", groupMax: 2 });
      if (k > 0.45) oneShot(variant("pl/clatter", "pl"), LV.clatter + 20 * Math.log10(0.15 + (0.85 * (k - 0.45)) / 0.55), { cat: "impacts", delay: 0.006, group: "clatter", groupMax: 2 });
      if (k > 0.1) E.duck("motion", -4 * k, 0.01, 0.05, 0.25);
    },
    crash() {
      if (!E.ctx) return;
      oneShot(variant("pl/crash", "pl"), LV.crash, { cat: "impacts", prio: 3, group: "crash", groupMax: 1 });
      E.duck("motion", -6, 0.01, 0.3, 0.6);
      E.hitMuffle(0.5);
    },
    treeHit() {
      if (!E.ctx) return;
      oneShot(variant("pl/tree", "pl"), LV.tree, { cat: "impacts", prio: 3, group: "crash", groupMax: 1 });
      E.duck("motion", -6, 0.01, 0.3, 0.6);
      E.hitMuffle(0.7);
    },
    reload(weaponId, phase) {
      if (!E.ctx) return;
      const w = weapon(weaponId);
      let name = phase;
      if (phase === "bolt") name = w === "sniper" ? "bolt" : "charge";
      else if (phase === "chamber") name = w === "pistol" ? "slide" : w === "sniper" ? "bolt" : w === "shotgun" ? "pump" : "charge";
      else if (!(phase in LV.fol) || phase === "dry" || phase === "adsIn" || phase === "adsOut") name = "chamber";
      oneShot(variant(`fol/${name}`, "fol"), LV.fol[name], { cat: "weapons", prio: 2.5, rate: FOLEY_RATE[w] * E.jitter(0.03), pan: 0.22, group: "foley", groupMax: 4 });
    },
    dryFire() {
      if (E.ctx) oneShot(variant("fol/dry", "fol"), LV.fol.dry, { cat: "weapons", rate: E.jitter(0.03), pan: 0.2, group: "dry", groupMax: 2 });
    },
    equip(weaponId) {
      if (E.ctx) oneShot(`fol/equip/${weapon(weaponId)}`, LV.equip, { cat: "weapons", rate: E.jitter(0.03), pan: 0.15, group: "foley", groupMax: 4 });
    },
    adsIn() {
      if (E.ctx) oneShot(variant("fol/adsIn", "fol"), LV.fol.adsIn, { cat: "weapons", rate: E.jitter(0.04), group: "ads", groupMax: 2 });
    },
    adsOut() {
      if (E.ctx) oneShot(variant("fol/adsOut", "fol"), LV.fol.adsOut, { cat: "weapons", rate: E.jitter(0.04), group: "ads", groupMax: 2 });
    },
    hurt(amount) {
      if (!E.ctx) return;
      const a = Number(amount);
      const k = clamp((Number.isFinite(a) ? a : 20) / 40, 0.2, 1.5);
      const kk = Math.min(1, k);
      oneShot(variant("pl/hurt", "pl"), LV.hurt[0] + (LV.hurt[1] - LV.hurt[0]) * kk, { cat: "player", prio: 3, rate: 1.05 - 0.1 * kk, group: "hurt", groupMax: 2 });
      E.hitMuffle(k);
      E.duck("weapons", -3 * kk, 0.005, 0.05, 0.2);
    },
    heartbeat(on) {
      loops.heartbeat(on);
    },
    death() {
      if (!E.ctx) return;
      loops.heartbeat(false);
      oneShot("pl/death/0", LV.death, { cat: "player", prio: 4 });
      E.setDead(true);
    },
    respawn() {
      if (!E.ctx) return;
      E.setDead(false);
      oneShot("pl/respawn/0", LV.respawn, { cat: "player", prio: 3 });
    },
    ui(kind = "move") {
      if (!E.ctx) return;
      const k = kind === "select" || kind === "back" ? kind : "move";
      oneShot(`ui/${k}`, LV.ui[k], { cat: "ui", group: "uiNav", groupMax: 3 });
    },
    countdown(n) {
      if (!E.ctx) return;
      const last = !(Number(n) > 1);
      oneShot(last ? "ui/beepHi" : "ui/beepLo", last ? LV.beepHi : LV.beepLo, { cat: "ui" });
    },
    go() {
      if (!E.ctx) return;
      E.setDead(false);
      oneShot("ui/go", LV.go, { cat: "ui", prio: 4 });
    },
    liftHum(on) {
      loops.liftHum(on);
    },
    ambience(on) {
      loops.ambience(on);
    },
    music(mode) {
      if (E.ctx && mode !== "match") E.setDead(false);
      loops.music(mode);
    },
    /** Debug/probe snapshot: voices, queue, drops, steals, live loop sources, music state. */
    stats() {
      return { ...E.info(), ...loops.info() };
    },
    /** @deprecated old API (src/main.js before integration): hitmarker tick. */
    tick(kill = false) {
      api.hitmarker(kill ? "kill" : "body");
    },
    /** @deprecated old API: countdown beep. */
    beep() {
      api.countdown(2);
    },
  };

  // Debug handle for probes/tests (non-enumerable, not part of the game-facing API).
  Object.defineProperty(api, "engine", { value: E, enumerable: false });

  // Audio must never take the game down: every method is guarded (errors are counted in stats()).
  for (const key of Object.keys(api)) {
    const desc = Object.getOwnPropertyDescriptor(api, key);
    if (typeof desc.value !== "function") continue;
    const fn = desc.value;
    api[key] = function guarded(...args) {
      try {
        return fn.apply(api, args);
      } catch (e) {
        E.err(e);
        if (key === "toggleMute") return E.muted;
        if (key === "loadSample") return Promise.resolve(false);
        return key === "analyser" ? E.analyser : undefined;
      }
    };
  }
  return api;
}
