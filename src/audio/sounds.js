/**
 * The sound bank: every one-shot (and the loop/impulse-response buffers) as an offline render.
 *
 * generate(name, sampleRate) → Float32Array[] (1 or 2 channels), peak-normalised to 1, starting
 * at 0 and faded to exactly 0, so playback needs no gain envelope and can never click. The
 * engine renders lazily on first use and pre-warms the bank in the background after start().
 * Each asset seeds its own LCG from its name, so a render is identical in any order.
 *
 * Names: gun/<weapon>/<part>/<variant> · whiz/<v> · imp/<kind>/<v> · hit/<kind>/<v> · ui/<name>
 *        fol/<name>/<v> · fol/equip/<weapon> · pl/<name>/<v> · amb/<name>/<v> · mus/<name>
 *        loop/<name> · ir/valley
 */
import {
  TAU, makeRng, hashStr, clamp, buf, envAD, envAHR, glide, sweep, svf, biquad, dcBlock, white, pink,
  addTone, addModes, addNWave, addFriedlander, addNoise, grainEnv, normalize, saturate, fadeOut,
  mixInto, loopify, finish, peakOf,
} from "./dsp.js";

/** The one constant every random stream derives from. */
export const SEED = 0x51ed5eed;

export const WEAPON_IDS = ["ar", "smg", "pistol", "shotgun", "sniper"];
/** Accepts the game's legacy sound ids too ("rifle" → ar). */
export const WEAPON_ALIAS = { ar: "ar", rifle: "ar", smg: "smg", pistol: "pistol", sidearm: "pistol", shotgun: "shotgun", sniper: "sniper" };
export const VARIANTS = { crack: 3, body: 3, thump: 2, mech: 2, tail: 2, whiz: 3, imp: 3, hit: 2, fol: 2, pl: 2, raven: 3 };

/**
 * Render (and AudioBuffer) sample rate per entry: band-limited material is rendered at a lower
 * rate — the BufferSource resamples on playback — which cuts CPU and memory 2–6×.
 */
export function rateFor(name, sr) {
  if (name === "loop/flutter") return 8000; // a sub-20 Hz control signal
  if (/^gun\/\w+\/(thump|boom)\//.test(name) || name === "pl/heart/0") return Math.min(sr, 16000);
  if (/^gun\/\w+\/(tail|roll)\//.test(name) || /^(amb\/raven|pl\/death|pl\/hurt)/.test(name)) return Math.min(sr, 24000);
  if (/^(mus\/|ui\/streak|ui\/go|pl\/crash|pl\/tree|pl\/respawn|fol\/|imp\/)/.test(name)) return Math.min(sr, 32000);
  return sr;
}

/**
 * Weapon character. crack = supersonic N-wave + muzzle blast + gas sizzle + muzzle-device ring;
 * body = the band-passed "bark" + low blast, saturated; thump = pitch-dropping low punch;
 * tail = close stereo bloom (snow/tree reflections); mech = per-shot action noise.
 * mix/smix = own-shot layer gains (synth-only / with the recorded "rifle" sample as the core);
 * ownDb = own-shot peak at the master input; remote = level of another rider at 8 m vs your own;
 * echo = environment-reverb send; sample = per-weapon treatment of the recorded rifle.
 */
export const GUNS = {
  ar: {
    crack: { T: 0.00065, blast: 0.0006, hp: 2400, tau: 0.0032, ring: [3150, 5050, 7450], ringTau: 0.007, ringAmp: 0.22 },
    body: { f0: 1600, f1: 430, sweep: 0.028, q: 1.05, att: 0.0011, tau: 0.032, lowF: 750, lowTau: 0.05, lowAmp: 0.65, snapF: 2800, snapTau: 0.01, snapAmp: 0.9, drive: 2.4, len: 0.34 },
    thump: { f0: 170, f1: 68, glide: 0.01, att: 0.0012, tau: 0.036, drive: 1.6, len: 0.34 },
    tail: { len: 0.95, tau: 0.19, lp0: 2800, lp1: 480, refl: 6 },
    mech: "carrier",
    mechDelay: 0.028,
    mix: { crack: 0.7, body: 0.85, thump: 0.6, mech: 0.2, tail: 0.3 },
    smix: { sample: 1, crack: 0.5, thump: 0.5, mech: 0.2, tail: 0.16 },
    ownDb: -6,
    remote: 0.75,
    echo: 1,
    sample: { rate: 1, filter: ["highpass", 45, -3], maxDur: 0.9 },
  },
  smg: {
    crack: { T: 0.0005, blast: 0.00045, hp: 3000, tau: 0.0026, ring: [3600, 5800, 8200], ringTau: 0.005, ringAmp: 0.2 },
    body: { f0: 2000, f1: 620, sweep: 0.02, q: 1.15, att: 0.0009, tau: 0.022, lowF: 900, lowTau: 0.035, lowAmp: 0.5, snapF: 3300, snapTau: 0.008, snapAmp: 0.9, drive: 2.6, len: 0.26 },
    thump: { f0: 200, f1: 80, glide: 0.008, att: 0.001, tau: 0.026, drive: 1.5, len: 0.26 },
    tail: { len: 0.7, tau: 0.13, lp0: 3200, lp1: 600, refl: 5 },
    mech: "carrier",
    mechDelay: 0.022,
    mix: { crack: 0.7, body: 0.85, thump: 0.5, mech: 0.2, tail: 0.26 },
    smix: { sample: 1, crack: 0.5, thump: 0.42, mech: 0.2, tail: 0.14 },
    ownDb: -7.5,
    remote: 0.68,
    echo: 0.8,
    sample: { rate: 1.12, filter: ["highpass", 110, -3], maxDur: 0.65 },
  },
  pistol: {
    crack: { T: 0.00045, blast: 0.0004, hp: 3400, tau: 0.0022, ring: [3900, 6100, 8800], ringTau: 0.004, ringAmp: 0.18 },
    body: { f0: 2300, f1: 800, sweep: 0.016, q: 1.2, att: 0.0008, tau: 0.017, lowF: 1000, lowTau: 0.028, lowAmp: 0.45, snapF: 3600, snapTau: 0.007, snapAmp: 0.8, drive: 2.2, len: 0.2 },
    thump: { f0: 220, f1: 95, glide: 0.007, att: 0.001, tau: 0.02, drive: 1.4, len: 0.2 },
    tail: { len: 0.55, tau: 0.1, lp0: 3400, lp1: 700, refl: 4 },
    mech: "slide",
    mechDelay: 0.016,
    mix: { crack: 0.72, body: 0.85, thump: 0.42, mech: 0.24, tail: 0.24 },
    smix: { sample: 1, crack: 0.55, thump: 0.36, mech: 0.24, tail: 0.12 },
    ownDb: -8,
    remote: 0.62,
    echo: 0.7,
    sample: { rate: 1.22, filter: ["highpass", 170, -3], maxDur: 0.45 },
  },
  shotgun: {
    crack: { T: 0.0011, blast: 0.0011, hp: 1700, tau: 0.0045, ring: [2500, 4100], ringTau: 0.006, ringAmp: 0.15 },
    body: { f0: 1100, f1: 260, sweep: 0.045, q: 0.75, att: 0.0016, tau: 0.06, lowF: 520, lowTau: 0.09, lowAmp: 0.85, snapF: 2200, snapTau: 0.014, snapAmp: 0.7, drive: 3, len: 0.55 },
    thump: { f0: 130, f1: 48, glide: 0.016, att: 0.0018, tau: 0.065, drive: 1.9, len: 0.5 },
    tail: { len: 1.3, tau: 0.3, lp0: 2000, lp1: 340, refl: 7 },
    mech: "receiver",
    mechDelay: 0.004,
    boom: true,
    mix: { crack: 0.6, body: 0.9, thump: 0.8, mech: 0.16, tail: 0.36 },
    smix: { sample: 1, crack: 0.42, thump: 0.62, boom: 0.6, mech: 0.16, tail: 0.2 },
    ownDb: -4.5,
    remote: 0.9,
    echo: 1.3,
    sample: { rate: 0.82, filter: ["lowshelf", 160, 0, 4], maxDur: 1.1 },
  },
  sniper: {
    crack: { T: 0.0014, blast: 0.001, hp: 2000, tau: 0.006, ring: [2900, 4700, 6900], ringTau: 0.009, ringAmp: 0.25 },
    body: { f0: 1300, f1: 300, sweep: 0.04, q: 0.85, att: 0.0014, tau: 0.055, lowF: 620, lowTau: 0.085, lowAmp: 0.8, snapF: 2600, snapTau: 0.016, snapAmp: 0.9, drive: 3.2, len: 0.5 },
    thump: { f0: 120, f1: 44, glide: 0.018, att: 0.0016, tau: 0.075, drive: 2, len: 0.55 },
    tail: { len: 1.4, tau: 0.32, lp0: 2400, lp1: 380, refl: 8 },
    mech: "bolt",
    mechDelay: 0.003,
    roll: true,
    mix: { crack: 0.9, body: 0.9, thump: 0.8, mech: 0.18, tail: 0.32, roll: 0.3 },
    smix: { sample: 1, crack: 0.65, thump: 0.62, mech: 0.18, tail: 0.18, roll: 0.3 },
    ownDb: -4,
    remote: 1.05,
    echo: 2,
    sample: { rate: 0.74, filter: ["lowshelf", 120, 0, 3], maxDur: 1.6 },
  },
};

/**
 * The layers of a shot, shared by playback and by the level calibration (so the calibrated peak
 * is the peak that actually plays). part = bank part name or "sample".
 * own (pos = null): everything; remote: core layer + crack/thump only when close.
 */
export function shotPlan(w, useSample, dist = 0) {
  const G = GUNS[w];
  const m = useSample ? G.smix : G.mix;
  const own = dist <= 0;
  const L = [];
  if (useSample) L.push({ part: "sample", gain: m.sample, at: 0 });
  else L.push({ part: "body", gain: m.body, at: 0 });
  const nearCrack = own ? 1 : clamp(1 - dist / 90, 0, 1);
  if (nearCrack > 0) L.push({ part: "crack", gain: m.crack * nearCrack, at: 0 });
  const nearThump = own ? 1 : clamp(1 - dist / 40, 0, 1);
  if (nearThump > 0) L.push({ part: "thump", gain: m.thump * nearThump, at: 0 });
  if (m.boom && (own || dist < 150)) L.push({ part: "boom", gain: m.boom * (own ? 1 : 0.8), at: 0 });
  if (own) {
    L.push({ part: "mech", gain: m.mech, at: G.mechDelay, pan: 0.32 });
    L.push({ part: "tail", gain: m.tail, at: 0.004, tail: true });
    if (m.roll) L.push({ part: "roll", gain: m.roll, at: 0.03, tail: true });
  } else if (m.roll) L.push({ part: "roll", gain: m.roll * 1.4, at: 0.02, tail: true });
  else if (w === "shotgun") L.push({ part: "tail", gain: m.tail * 0.8, at: 0.004, tail: true });
  return L;
}

/**
 * Peak of a layer mix: layers = [{ data: Float32Array[], gain, at, rate?, pan?, offset?, sr? }].
 * Mono layers up-mix to both channels (as WebAudio does) or pan equal-power like StereoPanner.
 */
export function mixPeak(layers, sr, len = 0.35) {
  const n = Math.round(len * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const l of layers) {
    const srcL = l.data[0];
    const srcR = l.data[1] ?? l.data[0];
    let gl = 1;
    let gr = 1;
    if (l.data.length === 1 && l.pan) {
      const x = ((clamp(l.pan, -1, 1) + 1) / 2) * (Math.PI / 2);
      gl = Math.cos(x);
      gr = Math.sin(x);
    }
    const srate = l.sr ?? sr;
    const step = ((l.rate ?? 1) * srate) / sr;
    const off = (l.offset ?? 0) * srate;
    const i0 = Math.round(l.at * sr);
    for (let i = 0; i0 + i < n; i++) {
      const p = off + i * step;
      const k = Math.floor(p);
      if (k + 1 >= srcL.length) break;
      const f = p - k;
      L[i0 + i] += (srcL[k] * (1 - f) + srcL[k + 1] * f) * l.gain * gl;
      R[i0 + i] += (srcR[k] * (1 - f) + srcR[k + 1] * f) * l.gain * gr;
    }
  }
  return Math.max(peakOf(L), peakOf(R));
}

// ───────────────────────────── foley primitives ─────────────────────────────

const jit = (rand, amt = 0.04) => 1 - amt + 2 * amt * rand();

/** Small hard click (catch, button, sear): high partials + a noise tick. */
function click(x, sr, rand, at, f, amp = 1) {
  addModes(x, sr, at, [[f * jit(rand), 0.005, 1], [f * 1.73 * jit(rand), 0.0035, 0.7], [f * 2.91 * jit(rand), 0.0025, 0.45], [f * 4.37 * jit(rand), 0.0018, 0.3]], 0.00025, amp);
  addNoise(x, sr, rand, at, 0.012, [0.0002, 0.0009], [["hp", 2500, 0.7]], amp * 0.55);
}

/** Metal-on-metal impact: lower partials with a ring of `ring` s, a noise strike and a body knock. */
function clack(x, sr, rand, at, f, amp = 1, ring = 0.014) {
  const j = jit(rand, 0.03);
  addModes(x, sr, at, [[f * j, ring, 1], [f * 1.51 * j, ring * 0.75, 0.7], [f * 2.37 * j, ring * 0.55, 0.5], [f * 3.62 * j, ring * 0.38, 0.32], [f * 5.1 * j, ring * 0.25, 0.2]], 0.0003, amp);
  addNoise(x, sr, rand, at, 0.02, [0.0003, 0.0025], [["bp", f * 1.8, 0.9]], amp * 0.8);
  addTone(x, sr, at, 0.06, f * 0.3, [0.0008, 0.009], amp * 0.35);
}

/** Polymer / palm knock: dull and short. */
function knock(x, sr, rand, at, f, amp = 1) {
  addNoise(x, sr, rand, at, 0.05, [0.0006, 0.007], [["lp", f * 4, 0.7]], amp * 0.7);
  addTone(x, sr, at, 0.08, glide(f * 1.3, f, 0.01), [0.001, 0.014], amp * 0.6);
}

/** Metal sliding on metal: band-passed noise with stick-slip grain, sweeping f0 → f1 over dur. */
function friction(x, sr, rand, at, dur, f0, f1, amp = 1, rate = 220) {
  const len = dur + 0.02;
  const g = grainEnv(Math.round(len * sr), sr, rand, rate, { jitter: 0.5, attack: 0.0003, decay: 0.0015, min: 0.2, floor: 0.35 });
  const a = Math.min(0.01, dur * 0.3);
  addNoise(x, sr, rand, at, len, ["ahr", a, Math.max(0, dur - a), 0.012], [["bp", (t) => f0 + (f1 - f0) * Math.min(1, t / dur), 1.6]], amp, g);
}

/** Cloth / gear swish. */
function swish(x, sr, rand, at, dur, f0, f1, amp = 1) {
  addNoise(x, sr, rand, at, dur, ["ahr", dur * 0.35, 0, dur * 0.65], [["bp", (t) => f0 + (f1 - f0) * (t / dur), 0.8]], amp);
}

/** Bell / chime partials for UI stings. */
function bell(x, sr, at, f, amp, decay = 0.35) {
  addModes(x, sr, at, [[f, decay, 1], [f * 2, decay * 0.5, 0.32], [f * 2.76, decay * 0.3, 0.18], [f * 5.4, decay * 0.12, 0.07]], 0.002, amp);
}

// ───────────────────────────── guns ─────────────────────────────

function gunCrack(sr, rand, G) {
  const c = G.crack;
  const x = buf(sr, 0.07);
  const at = 0.0002;
  addNWave(x, sr, at, c.T * jit(rand, 0.1), 0.8); // the bullet's supersonic crack
  addFriedlander(x, sr, at + 0.00008, c.blast * jit(rand, 0.08), 1); // muzzle blast pressure pulse
  addNoise(x, sr, rand, at, 0.06, [0.00025, c.tau], [["hp", c.hp, 0.7], ["lp", 13000, 0.7]], 0.6); // gas sizzle
  addModes(x, sr, at + 0.0004, c.ring.map((f, i) => [f * jit(rand, 0.03), c.ringTau * (1 - i * 0.2), c.ringAmp / (1 + i * 0.5)]), 0.0003);
  svf(x, sr, "lp", 15500, 0.6);
  return [finish(x, sr, { hp: 70, fade: 0.004 })];
}

function gunBody(sr, rand, G) {
  const b = G.body;
  const x = buf(sr, b.len);
  const j = jit(rand, 0.06);
  const env = [b.att, b.tau, b.att * 1.6, b.tau * 2.8, 0.28]; // fast bark + a slower body
  addNoise(x, sr, rand, 0, b.len, env, [["bp", glide(b.f0 * j, b.f1 * j, b.sweep), b.q]], 1);
  addNoise(x, sr, rand, 0, b.len, [b.att * 1.4, b.lowTau], [["lp", b.lowF * j, 0.8], ["lp", b.lowF * 1.5 * j, 0.6]], b.lowAmp * 1.6);
  addNoise(x, sr, rand, 0, 0.1, [b.att, b.snapTau], [["bp", b.snapF * j, 1.1]], b.snapAmp); // presence "snap": the bite
  addFriedlander(x, sr, 0, G.crack.blast * 1.6, 0.5); // gives the bark a defined front
  normalize(x);
  saturate(x, b.drive);
  biquad(x, sr, "peaking", b.f1 * 2.4, 0.8, 2);
  return [finish(x, sr, { hp: 35, fade: 0.012 })];
}

function gunThump(sr, rand, G) {
  const p = G.thump;
  const x = buf(sr, p.len);
  const j = jit(rand, 0.04);
  addTone(x, sr, 0, p.len, glide(p.f0 * j, p.f1 * j, p.glide), [p.att, p.tau], 1);
  addNoise(x, sr, rand, 0, 0.04, [0.0004, 0.005], [["lp", 1100, 0.7]], 0.3);
  normalize(x);
  saturate(x, p.drive);
  return [finish(x, sr, { hp: 24, fade: 0.012 })];
}

/** Close stereo bloom: diffuse snow/forest scatter + a few discrete early slaps per ear. */
function gunTail(sr, rand, G) {
  const p = G.tail;
  const n = Math.round(p.len * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const x of out) {
    addNoise(x, sr, rand, 0.003, p.len - 0.003, [0.01, p.tau], [["lp", glide(p.lp0, p.lp1, p.tau * 1.4), 0.7], ["hp", 110, 0.7]], 1);
    for (let k = 0; k < p.refl; k++) {
      const tk = 0.006 + 0.11 * Math.pow(rand(), 1.4);
      const a = (0.45 + 0.55 * rand()) * Math.exp(-tk / 0.07) * 1.4;
      const d = 0.006 + 0.01 * rand();
      addNoise(x, sr, rand, tk, 0.05, [0.0008, d], [["bp", 700 + 1800 * rand(), 0.9]], a);
    }
  }
  return finish(out, sr, { hp: 30, fade: 0.03 });
}

/** Sniper: the long rolling echo off the ridges (discrete, smeared, ever darker, alternating ears). */
function gunRoll(sr, rand) {
  const len = 2.8;
  const n = Math.round(len * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let k = 0; k < 11; k++) {
    const tk = 0.12 + 2.2 * Math.pow((k + 0.7 * rand()) / 11, 1.3);
    const a = 0.55 * Math.exp(-tk / 0.95) * (0.55 + 0.45 * rand());
    const sm = 0.025 + 0.06 * tk;
    const lpf = 2400 * Math.exp(-tk / 1.3) + 380;
    const side = k % 2;
    for (let c = 0; c < 2; c++) {
      addNoise(out[c], sr, rand, tk + c * 0.004, Math.min(sm * 9, len - tk - 0.01), [sm * 0.35, sm], [["lp", lpf, 0.7], ["hp", 130, 0.7]], a * (c === side ? 1 : 0.55));
    }
  }
  for (const x of out) addNoise(x, sr, rand, 0.2, len - 0.2, [0.25, 0.7], [["lp", glide(1400, 450, 0.9), 0.7], ["hp", 120, 0.7]], 0.12);
  return finish(out, sr, { hp: 30, fade: 0.08 });
}

/** Shotgun's extra low boom (layered under the recorded sample). */
function gunBoom(sr, rand) {
  const x = buf(sr, 0.8);
  addTone(x, sr, 0, 0.8, glide(88, 30, 0.035), [0.003, 0.16], 1);
  addNoise(x, sr, rand, 0, 0.6, [0.004, 0.12], [["lp", 160, 0.7], ["lp", 220, 0.6]], 0.8);
  normalize(x);
  saturate(x, 1.5);
  return [finish(x, sr, { hp: 18, fade: 0.02 })];
}

/** Per-shot action noise. (Manual cycles — sniper bolt, shotgun pump — are reload() cues.) */
function gunMech(sr, rand, kind) {
  const x = buf(sr, kind === "bolt" ? 0.42 : 0.22);
  if (kind === "carrier") {
    clack(x, sr, rand, 0, 1850 * jit(rand), 1, 0.012); // carrier slams into the buffer
    click(x, sr, rand, 0, 3300 * jit(rand), 0.6);
    clack(x, sr, rand, 0.032, 2300 * jit(rand), 0.45, 0.008); // back into battery
  } else if (kind === "slide") {
    friction(x, sr, rand, 0, 0.014, 2600, 3200, 0.35, 300);
    clack(x, sr, rand, 0.014, 1600 * jit(rand), 1, 0.012);
    click(x, sr, rand, 0.016, 3600 * jit(rand), 0.5);
  } else if (kind === "receiver") {
    clack(x, sr, rand, 0, 720 * jit(rand), 1, 0.03);
    knock(x, sr, rand, 0, 170, 0.7);
  } else {
    clack(x, sr, rand, 0, 950 * jit(rand), 1, 0.06); // the heavy action rings as it soaks the recoil
    addModes(x, sr, 0.001, [[1650 * jit(rand), 0.05, 0.5], [2730 * jit(rand), 0.035, 0.35], [4120 * jit(rand), 0.022, 0.25], [6230 * jit(rand), 0.012, 0.15]], 0.0005);
    knock(x, sr, rand, 0, 220, 0.6);
  }
  svf(x, sr, "lp", 12000, 0.7);
  return [finish(x, sr, { hp: 120, fade: 0.01 })];
}

function genGun(w, part, sr, rand) {
  const G = GUNS[w];
  if (!G) return null;
  switch (part) {
    case "crack":
      return gunCrack(sr, rand, G);
    case "body":
      return gunBody(sr, rand, G);
    case "thump":
      return gunThump(sr, rand, G);
    case "tail":
      return gunTail(sr, rand, G);
    case "mech":
      return gunMech(sr, rand, G.mech);
    case "boom":
      return gunBoom(sr, rand);
    case "roll":
      return gunRoll(sr, rand);
    default:
      return null;
  }
}

// ───────────────────────────── bullets & impacts ─────────────────────────────

/** Bullet passing close: a very short N-wave snap, a tearing hiss and a quick falling whistle. */
function genWhiz(sr, rand) {
  const x = buf(sr, 0.32);
  addNWave(x, sr, 0.0003, 0.00026 + 0.00014 * rand(), 1);
  addNoise(x, sr, rand, 0.0003, 0.03, [0.0002, 0.0022], [["hp", 3800, 0.7]], 0.45);
  const f0 = 2900 + 900 * rand();
  const f1 = 850 + 350 * rand();
  addTone(x, sr, 0.003, 0.3, glide(f0, f1, 0.055), [0.01, 0.045], 0.16);
  addNoise(x, sr, rand, 0.002, 0.25, [0.006, 0.04], [["bp", glide(f0 * 1.4, f1 * 1.5, 0.05), 3]], 0.35);
  svf(x, sr, "lp", 15000, 0.6);
  return [finish(x, sr, { hp: 80, fade: 0.01 })];
}

function genImpact(kind, sr, rand) {
  let x;
  if (kind === "snow") {
    x = buf(sr, 0.42);
    addNoise(x, sr, rand, 0, 0.3, [0.002, 0.035], [["lp", 380, 0.7], ["lp", 520, 0.7]], 1.6); // thud
    addTone(x, sr, 0, 0.2, glide(110, 55, 0.02), [0.002, 0.028], 0.45);
    const g = grainEnv(Math.round(0.2 * sr), sr, rand, 90, { decay: 0.004, floor: 0.2 });
    addNoise(x, sr, rand, 0.001, 0.2, [0.002, 0.04], [["bp", 2500, 0.8]], 0.3, g); // crunch
    addNoise(x, sr, rand, 0.004, 0.38, [0.008, 0.07], [["hp", 1400, 0.7], ["lp", 6500, 0.7]], 0.3); // powder puff
  } else if (kind === "tree") {
    x = buf(sr, 0.75);
    const j = jit(rand, 0.06);
    addModes(x, sr, 0, [[580 * j, 0.026, 1], [1130 * j, 0.016, 0.6], [1790 * j, 0.01, 0.4], [260 * j, 0.03, 0.5], [2600 * j, 0.006, 0.25]], 0.0006);
    addNoise(x, sr, rand, 0, 0.03, [0.0003, 0.004], [["bp", 1800, 1.2]], 0.5); // splinter crack
    const g = grainEnv(Math.round(0.45 * sr), sr, rand, 140, { decay: 0.002, min: 0.1, floor: 0.08 });
    addNoise(x, sr, rand, 0.008, 0.45, [0.015, 0.12], [["hp", 2800, 0.7], ["lp", 9000, 0.7]], 0.55, g); // needles
    addNoise(x, sr, rand, 0.03, 0.7, [0.05, 0.25], [["lp", 1800, 0.7]], 0.12); // snow sifts off
  } else if (kind === "body") {
    x = buf(sr, 0.36);
    addNoise(x, sr, rand, 0, 0.05, [0.0006, 0.009], [["bp", 1300, 0.9]], 0.8); // slap
    addTone(x, sr, 0, 0.25, glide(150, 78, 0.025), [0.0015, 0.04], 1); // meat
    addNoise(x, sr, rand, 0, 0.2, [0.001, 0.03], [["lp", 450, 0.7]], 0.9);
    const g = grainEnv(Math.round(0.2 * sr), sr, rand, 70, { decay: 0.006, floor: 0.3 });
    addNoise(x, sr, rand, 0.006, 0.2, [0.006, 0.05], [["bp", 3600, 0.8]], 0.3, g); // jacket nylon
    normalize(x);
    saturate(x, 1.5);
  } else {
    // metal: ping (+ a ricochet whine on most variants)
    x = buf(sr, 0.6);
    const j = jit(rand, 0.05);
    addModes(x, sr, 0, [[1480 * j, 0.12, 1], [3720 * j, 0.08, 0.6], [5180 * j, 0.06, 0.45], [7350 * j, 0.035, 0.3], [2410 * j, 0.09, 0.35]], 0.0003);
    addNoise(x, sr, rand, 0, 0.02, [0.0002, 0.0015], [["hp", 4000, 0.7]], 0.6);
    if (rand() < 0.67) {
      const f0 = 3800 + 900 * rand();
      const f1 = 1500 + 400 * rand();
      const ric = (t) => (f1 + (f0 - f1) * Math.exp(-t / 0.12)) * (1 + 0.025 * Math.sin(TAU * 28 * t));
      addTone(x, sr, 0.015, 0.5, ric, [0.006, 0.1], 0.32);
      addNoise(x, sr, rand, 0.015, 0.4, [0.006, 0.08], [["bp", ric, 6]], 0.25);
    }
  }
  svf(x, sr, "lp", 14000, 0.7);
  return [finish(x, sr, { hp: 40, fade: 0.02 })];
}

// ───────────────────────────── hitmarkers & UI ─────────────────────────────

function genHit(kind, sr, rand) {
  const j = jit(rand, 0.015);
  let x;
  if (kind === "body") {
    // crisp tick: a short 2.6 kHz partial pair + noise tick, low-passed so it's never harsh
    x = buf(sr, 0.08);
    addModes(x, sr, 0, [[2650 * j, 0.009, 1], [5300 * j, 0.005, 0.28], [3900 * j, 0.004, 0.15]], 0.0004);
    addNoise(x, sr, rand, 0, 0.01, [0.0002, 0.0012], [["hp", 3000, 0.7], ["lp", 9000, 0.7]], 0.35);
    svf(x, sr, "lp", 10000, 0.7);
  } else if (kind === "head") {
    // bright metallic tink with a short ring (helmet ping)
    x = buf(sr, 0.34);
    addModes(x, sr, 0, [[2650 * j, 0.008, 0.8]], 0.0004);
    addNoise(x, sr, rand, 0, 0.01, [0.0002, 0.0012], [["hp", 3000, 0.7]], 0.3);
    addModes(x, sr, 0.002, [[3180 * j, 0.075, 1], [4790 * j, 0.05, 0.55], [6930 * j, 0.03, 0.32], [2120 * j, 0.045, 0.3], [8470 * j, 0.018, 0.15]], 0.0005);
    svf(x, sr, "lp", 12000, 0.7);
  } else {
    // kill: deeper confirming thunk + a small chime
    x = buf(sr, 0.55);
    addTone(x, sr, 0, 0.3, glide(240, 105, 0.03), [0.002, 0.045], 1);
    addNoise(x, sr, rand, 0, 0.05, [0.001, 0.012], [["lp", 700, 0.7]], 0.4);
    addModes(x, sr, 0, [[2400 * j, 0.008, 0.45]], 0.0004);
    addModes(x, sr, 0.018, [[1318.5, 0.2, 0.55], [1975.5, 0.16, 0.4], [2637, 0.09, 0.15]], 0.002);
  }
  return [finish(x, sr, { hp: 60, fade: 0.01 })];
}

function genUi(name, sr, rand) {
  let x;
  switch (name) {
    case "move":
      x = buf(sr, 0.09);
      addModes(x, sr, 0, [[1650, 0.012, 1], [3300, 0.006, 0.2]], 0.001);
      break;
    case "select":
      x = buf(sr, 0.3);
      addModes(x, sr, 0, [[1320, 0.03, 1], [2640, 0.012, 0.15]], 0.002);
      addModes(x, sr, 0.055, [[1980, 0.05, 1], [3960, 0.02, 0.15]], 0.002);
      break;
    case "back":
      x = buf(sr, 0.25);
      addModes(x, sr, 0, [[1500, 0.025, 1]], 0.002);
      addModes(x, sr, 0.05, [[1000, 0.04, 1], [2000, 0.015, 0.12]], 0.002);
      break;
    case "beepLo":
    case "beepHi": {
      // race-start beeps: soft square-ish (odd harmonics, low-passed), last one higher and longer
      const hi = name === "beepHi";
      const f = hi ? 1174.66 : 783.99;
      const hold = hi ? 0.24 : 0.11;
      x = buf(sr, hold + 0.12);
      const env = ["ahr", 0.004, hold, 0.05];
      addTone(x, sr, 0, hold + 0.1, f, env, 1);
      addTone(x, sr, 0, hold + 0.1, f * 3, env, 0.18);
      addTone(x, sr, 0, hold + 0.1, f * 5, env, 0.06);
      break;
    }
    case "go": {
      // start horn: a brassy D-major stab (detuned saws, opening low-pass) over a low punch
      x = buf(sr, 1.15);
      const env = (t) => envAHR(t, 0.018, 0.55, 0.45) * (1 + 0.15 * Math.exp(-t / 0.08));
      for (const f of [146.83, 293.66, 369.99, 440, 587.33]) for (const c of [-5, 5]) addTone(x, sr, 0, 1.1, f * Math.pow(2, c / 1200), env, 0.16, "saw");
      svf(x, sr, "lp", (t) => 900 + 2600 * envAD(t, 0.05, 0.35), 1.1);
      addTone(x, sr, 0, 0.4, glide(140, 60, 0.06), [0.003, 0.1], 0.9);
      addNoise(x, sr, rand, 0, 0.3, [0.003, 0.05], [["bp", 2200, 0.8]], 0.25);
      break;
    }
    case "medal": {
      x = buf(sr, 1.1);
      bell(x, sr, 0, 659.25, 0.8, 0.38);
      bell(x, sr, 0.09, 987.77, 1, 0.45);
      for (const f of [659.25, 987.77]) addTone(x, sr, 0.03, 1, f, ["ahr", 0.07, 0.15, 0.6], 0.12, "tri");
      break;
    }
    case "streak":
      return genStreak(sr, rand);
    case "confirm": {
      // kill confirmed: a soft, round G5+D6 dyad (sits under the hitmarker's E6/B6 chime)
      x = buf(sr, 0.75);
      addTone(x, sr, 0, 0.06, glide(520, 780, 0.015), [0.003, 0.02], 0.35);
      bell(x, sr, 0.02, 783.99, 0.9, 0.3);
      bell(x, sr, 0.05, 1174.66, 0.7, 0.28);
      break;
    }
    default:
      return null;
  }
  svf(x, sr, "lp", 11000, 0.7);
  return [finish(x, sr, { hp: 50, fade: 0.01 })];
}

function genStreak(sr, rand) {
  const len = 1.7;
  const out = [buf(sr, len), buf(sr, len)];
  const notes = [587.33, 739.99, 880, 1174.66];
  notes.forEach((f, i) => {
    bell(out[i % 2], sr, i * 0.07, f, 1, 0.42);
    bell(out[(i + 1) % 2], sr, i * 0.07 + 0.004, f, 0.55, 0.42);
  });
  const pad = buf(sr, len);
  for (const f of [293.66, 440, 587.33, 739.99]) for (const c of [-6, 6]) addTone(pad, sr, 0.02, len - 0.05, f * Math.pow(2, c / 1200), ["ahr", 0.08, 0.35, 0.9], 0.07, "saw");
  svf(pad, sr, "lp", (t) => 900 + 1500 * envAD(t, 0.2, 0.5), 0.8);
  const sub = buf(sr, len);
  addTone(sub, sr, 0, 0.9, glide(90, 45, 0.08), [0.004, 0.25], 0.8);
  for (let c = 0; c < 2; c++) {
    mixInto(out[c], pad, sr, 0, 1);
    mixInto(out[c], sub, sr, 0, 1);
    addNoise(out[c], sr, rand, 0.05, len - 0.1, [0.08, 0.4], [["hp", 7000, 0.7]], 0.05); // shimmer
  }
  return finish(out, sr, { hp: 30, fade: 0.05 });
}

// ───────────────────────────── weapon handling foley ─────────────────────────────

function genFoley(name, sr, rand, w) {
  let x;
  switch (name) {
    case "magOut":
      x = buf(sr, 0.32);
      click(x, sr, rand, 0, 3100 * jit(rand), 0.7); // release button
      friction(x, sr, rand, 0.012, 0.1, 1700, 2500, 0.55, 180); // polymer mag slides out
      knock(x, sr, rand, 0.115, 900, 0.35); // clears the well
      break;
    case "magIn":
      x = buf(sr, 0.3);
      friction(x, sr, rand, 0, 0.075, 2300, 1500, 0.5, 200);
      clack(x, sr, rand, 0.078, 980 * jit(rand), 1, 0.016); // seats
      click(x, sr, rand, 0.08, 2900 * jit(rand), 0.7); // catch engages
      knock(x, sr, rand, 0.082, 300, 0.6); // palm slap
      click(x, sr, rand, 0.12, 3600, 0.15); // rattle
      break;
    case "bolt":
      // sniper bolt: lift, back (ejects), forward (chambers), lock down
      x = buf(sr, 0.62);
      click(x, sr, rand, 0, 2500 * jit(rand), 0.6);
      clack(x, sr, rand, 0.004, 1300 * jit(rand), 0.5, 0.012);
      friction(x, sr, rand, 0.03, 0.11, 1500, 2700, 0.55, 260);
      clack(x, sr, rand, 0.145, 1150 * jit(rand), 0.8, 0.014);
      click(x, sr, rand, 0.147, 3300, 0.4);
      addModes(x, sr, 0.16, [[5200 * jit(rand), 0.05, 0.12], [7900 * jit(rand), 0.03, 0.08]], 0.0005); // brass ting
      friction(x, sr, rand, 0.25, 0.09, 2600, 1600, 0.5, 240);
      clack(x, sr, rand, 0.345, 1050 * jit(rand), 0.9, 0.016);
      click(x, sr, rand, 0.35, 3000, 0.6);
      break;
    case "charge":
      // AR/SMG charging handle: pull against the spring, release, carrier slams home
      x = buf(sr, 0.42);
      click(x, sr, rand, 0, 2800, 0.4);
      friction(x, sr, rand, 0.008, 0.07, 1400, 2300, 0.5, 240);
      addModes(x, sr, 0.02, [[880 * jit(rand), 0.05, 0.18], [1780, 0.03, 0.07], [2730, 0.02, 0.04]], 0.002); // spring
      clack(x, sr, rand, 0.12, 1250 * jit(rand), 1, 0.015);
      click(x, sr, rand, 0.121, 3400, 0.7);
      knock(x, sr, rand, 0.122, 400, 0.3);
      break;
    case "slide":
      // pistol slide release: slams forward
      x = buf(sr, 0.3);
      click(x, sr, rand, 0, 3000, 0.4);
      friction(x, sr, rand, 0.006, 0.03, 2400, 2000, 0.35, 260);
      clack(x, sr, rand, 0.036, 1500 * jit(rand), 1, 0.012);
      click(x, sr, rand, 0.037, 3800, 0.6);
      break;
    case "pump":
      // shotgun: back (ejects the hull) + forward (chambers) — the satisfying chk-chk
      x = buf(sr, 0.45);
      friction(x, sr, rand, 0, 0.07, 1100, 1800, 0.55, 170);
      clack(x, sr, rand, 0.07, 760 * jit(rand), 0.9, 0.022);
      knock(x, sr, rand, 0.071, 220, 0.5);
      friction(x, sr, rand, 0.13, 0.06, 1800, 1100, 0.5, 170);
      clack(x, sr, rand, 0.19, 640 * jit(rand), 1, 0.024);
      click(x, sr, rand, 0.192, 2300, 0.5);
      knock(x, sr, rand, 0.192, 200, 0.6);
      break;
    case "shell":
      // thumbing a shell into the tube
      x = buf(sr, 0.22);
      knock(x, sr, rand, 0, 700, 0.4);
      friction(x, sr, rand, 0.01, 0.04, 1500, 1100, 0.35, 150);
      clack(x, sr, rand, 0.052, 1450 * jit(rand), 0.7, 0.01);
      click(x, sr, rand, 0.053, 2600, 0.4);
      break;
    case "chamber":
      x = buf(sr, 0.2);
      friction(x, sr, rand, 0, 0.04, 1800, 2400, 0.35, 230);
      clack(x, sr, rand, 0.045, 1700 * jit(rand), 0.8, 0.01);
      click(x, sr, rand, 0.046, 3500, 0.5);
      break;
    case "dry":
      // hammer falls on an empty chamber
      x = buf(sr, 0.1);
      click(x, sr, rand, 0, 2900 * jit(rand), 1);
      addModes(x, sr, 0.0005, [[4700, 0.004, 0.4], [7200, 0.003, 0.25]], 0.0003);
      knock(x, sr, rand, 0, 650, 0.35);
      break;
    case "equip": {
      // raise: cloth swish, sling/mag rattle, the grip settles (heavier guns lower and longer)
      const heavy = w === "sniper" || w === "shotgun" ? 1 : w === "pistol" ? -1 : 0;
      x = buf(sr, 0.5);
      swish(x, sr, rand, 0, 0.2, 700 - heavy * 150, 1500 - heavy * 200, 0.5);
      for (let i = 0; i < 4 + heavy; i++) click(x, sr, rand, 0.04 + 0.2 * rand(), (2600 + 1600 * rand()) * (1 - 0.1 * heavy), 0.18 + 0.1 * rand());
      clack(x, sr, rand, 0.24 + 0.03 * heavy, 1100 - 250 * heavy, 0.55, 0.012 + 0.006 * heavy);
      knock(x, sr, rand, 0.242 + 0.03 * heavy, 260, 0.5);
      break;
    }
    case "adsIn":
      x = buf(sr, 0.22);
      swish(x, sr, rand, 0, 0.13, 900, 1500, 1);
      click(x, sr, rand, 0.085, 2400, 0.12); // cheek weld / optic
      break;
    case "adsOut":
      x = buf(sr, 0.2);
      swish(x, sr, rand, 0, 0.12, 1300, 800, 1);
      break;
    default:
      return null;
  }
  svf(x, sr, "lp", 13000, 0.7);
  return [finish(x, sr, { hp: 70, fade: 0.012 })];
}

// ───────────────────────────── the rider ─────────────────────────────

function genPlayer(name, sr, rand) {
  let x;
  switch (name) {
    case "land": {
      x = buf(sr, 0.5);
      addTone(x, sr, 0, 0.4, glide(95, 48, 0.03), [0.003, 0.06], 1);
      addNoise(x, sr, rand, 0, 0.35, [0.003, 0.05], [["lp", 320, 0.7]], 1.3);
      const g = grainEnv(Math.round(0.3 * sr), sr, rand, 110, { decay: 0.004, floor: 0.25 });
      addNoise(x, sr, rand, 0.001, 0.3, [0.004, 0.07], [["bp", 1800, 0.7]], 0.45, g); // crunch
      addNoise(x, sr, rand, 0.01, 0.45, [0.02, 0.15], [["hp", 2500, 0.7], ["lp", 8000, 0.7]], 0.18); // spray
      break;
    }
    case "clatter":
      // skis / board slapping the snow and each other on a hard landing
      x = buf(sr, 0.3);
      addModes(x, sr, 0, [[650 * jit(rand), 0.02, 1], [1300 * jit(rand), 0.012, 0.6], [2300 * jit(rand), 0.008, 0.4]], 0.0005);
      addNoise(x, sr, rand, 0, 0.05, [0.0005, 0.008], [["bp", 1500, 0.8]], 0.7);
      clack(x, sr, rand, 0.024, 1400 * jit(rand), 0.5, 0.01);
      break;
    case "crash":
      return genCrash(sr, rand);
    case "tree":
      return genTreeHit(sr, rand);
    case "hurt":
      x = buf(sr, 0.4);
      addTone(x, sr, 0, 0.35, glide(80, 45, 0.03), [0.004, 0.08], 1);
      addNoise(x, sr, rand, 0, 0.3, [0.003, 0.05], [["lp", 260, 0.7]], 1.1);
      addNoise(x, sr, rand, 0, 0.05, [0.0008, 0.012], [["bp", 1400, 1]], 0.35);
      break;
    case "heart":
      x = buf(sr, 0.62);
      addTone(x, sr, 0, 0.4, glide(62, 40, 0.06), [0.012, 0.07], 1); // lub
      addNoise(x, sr, rand, 0, 0.3, [0.008, 0.04], [["lp", 150, 0.7]], 0.5);
      addTone(x, sr, 0.17, 0.4, glide(70, 45, 0.05), [0.01, 0.06], 0.7); // dub
      addNoise(x, sr, rand, 0.17, 0.3, [0.008, 0.035], [["lp", 160, 0.7]], 0.35);
      return [finish(x, sr, { hp: 22, fade: 0.03 })];
    case "death":
      return genDeath(sr, rand);
    case "respawn":
      return genRespawn(sr, rand);
    default:
      return null;
  }
  return [finish(x, sr, { hp: 28, fade: 0.02 })];
}

function genCrash(sr, rand) {
  const len = 1.7;
  const out = [buf(sr, len), buf(sr, len)];
  const thud = (at, a, pan) => {
    const x = buf(sr, 0.4);
    addTone(x, sr, 0, 0.35, glide(100, 42, 0.04), [0.003, 0.08], 1);
    addNoise(x, sr, rand, 0, 0.3, [0.003, 0.07], [["lp", 400, 0.7]], 1.2);
    const g = grainEnv(Math.round(0.25 * sr), sr, rand, 100, { decay: 0.004, floor: 0.3 });
    addNoise(x, sr, rand, 0.002, 0.25, [0.004, 0.08], [["bp", 1500, 0.8]], 0.5, g);
    mixInto(out[0], x, sr, at, a * (1 - pan * 0.5));
    mixInto(out[1], x, sr, at, a * (1 + pan * 0.5));
  };
  thud(0, 1, 0);
  let t = 0.16;
  for (let k = 0; k < 5; k++) {
    thud(t, 0.75 * Math.pow(0.72, k), (k % 2 ? 1 : -1) * (0.3 + 0.4 * rand()));
    t += 0.13 + 0.17 * rand();
  }
  for (let c = 0; c < 2; c++) addNoise(out[c], sr, rand, 0.02, 1.2, [0.03, 0.4], [["lp", 3000, 0.7], ["hp", 300, 0.7]], 0.22); // snow spray
  for (let k = 0; k < 6; k++) {
    // gear scatter: skis, poles, buckles
    const at = 0.1 + rand() * 1;
    const c = rand() < 0.5 ? 0 : 1;
    if (rand() < 0.5) clack(out[c], sr, rand, at, 900 + 1500 * rand(), 0.25 + 0.2 * rand(), 0.01);
    else knock(out[c], sr, rand, at, 400 + 500 * rand(), 0.3);
  }
  addModes(out[rand() < 0.5 ? 0 : 1], sr, 0.45 + 0.3 * rand(), [[2350, 0.12, 0.25], [5900, 0.05, 0.1]], 0.0005); // pole ting
  return finish(out, sr, { hp: 30, fade: 0.05 });
}

function genTreeHit(sr, rand) {
  const len = 1.8;
  const out = [buf(sr, len), buf(sr, len)];
  const hit = buf(sr, 0.6);
  addModes(hit, sr, 0, [[170, 0.06, 1], [320, 0.045, 0.7], [540, 0.03, 0.5], [890, 0.02, 0.3]], 0.0008);
  addTone(hit, sr, 0, 0.4, glide(90, 50, 0.04), [0.003, 0.07], 0.9);
  addNoise(hit, sr, rand, 0, 0.06, [0.0005, 0.015], [["bp", 900, 1]], 0.6); // wood crack
  for (let c = 0; c < 2; c++) {
    mixInto(out[c], hit, sr, 0, 1);
    const g = grainEnv(Math.round(0.9 * sr), sr, rand, 60 + 80 * rand(), { decay: 0.003, min: 0.1, floor: 0.1 });
    addNoise(out[c], sr, rand, 0.02, 0.9, [0.03, 0.35], [["hp", 1500, 0.7]], 0.35, g); // branches
    addNoise(out[c], sr, rand, 0.08, 1.6, [0.08, 0.45], [["lp", glide(1600, 700, 0.6), 0.7]], 0.4); // snow dump
    for (let k = 0; k < 3; k++) {
      const at = 0.25 + 0.45 * rand();
      addNoise(out[c], sr, rand, at, 0.25, [0.004, 0.05], [["lp", 300, 0.7]], 0.4); // clumps landing
    }
  }
  return finish(out, sr, { hp: 30, fade: 0.06 });
}

function genDeath(sr, rand) {
  const x = buf(sr, 2.5);
  addTone(x, sr, 0, 2, glide(110, 32, 0.12), [0.005, 0.35], 1); // deep, slow impact
  addNoise(x, sr, rand, 0, 1, [0.004, 0.2], [["lp", 300, 0.7]], 1);
  addNoise(x, sr, rand, 0.02, 2.2, [0.15, 0.5], [["bp", glide(2400, 300, 0.5), 1.2]], 0.5); // falling whoosh
  addTone(x, sr, 0.05, 2.3, 3150, [0.2, 0.9], 0.04); // faint ear ring
  return [finish(x, sr, { hp: 22, fade: 0.1 })];
}

function genRespawn(sr, rand) {
  const len = 1.5;
  const out = [buf(sr, len), buf(sr, len)];
  for (let c = 0; c < 2; c++) {
    const x = out[c];
    addNoise(x, sr, rand, 0, 0.9, ["ahr", 0.55, 0.02, 0.3], [["bp", sweep(350, 2600, 0.7), 1.3]], 0.8); // rising whoosh
    bell(x, sr, 0.55 + c * 0.006, c ? 1318.5 : 880, 0.45, 0.4);
  }
  return finish(out, sr, { hp: 60, fade: 0.05 });
}

// ───────────────────────────── ambience & music ─────────────────────────────

/** A distant raven: 2–4 harsh nasal "kraa" calls (rough saw through formants), low-passed by distance. */
function genRaven(sr, rand) {
  const calls = 2 + Math.floor(rand() * 3);
  const x = buf(sr, 0.35 + calls * 0.55);
  let t0 = 0.05;
  for (let k = 0; k < calls; k++) {
    const d = 0.2 + 0.12 * rand();
    const fA = (330 + 60 * rand()) * (1 - 0.05 * k);
    const call = buf(sr, d + 0.05);
    const pitch = (t) => fA * (1 + 0.22 * Math.sin(Math.PI * Math.min(1, t / d)) - 0.12 * (t / d));
    addTone(call, sr, 0, d, pitch, (t) => envAHR(t, 0.025, d - 0.085, 0.06) * (0.75 + 0.25 * Math.sin(TAU * 47 * t)), 0.6, "saw");
    addNoise(call, sr, rand, 0, d, ["ahr", 0.02, d - 0.07, 0.05], [["bp", 1700, 1.2]], 0.18);
    const f1 = svf(call.slice(), sr, "bp", 1150, 5);
    const f2 = svf(call.slice(), sr, "bp", 1800, 6);
    const f3 = svf(call.slice(), sr, "bp", 2650, 7);
    for (let i = 0; i < call.length; i++) call[i] = f1[i] + 0.7 * f2[i] + 0.35 * f3[i] + 0.06 * call[i];
    mixInto(x, call, sr, t0, 1);
    t0 += d + 0.2 + 0.18 * rand();
  }
  svf(x, sr, "lp", 3200, 0.7);
  return [finish(x, sr, { hp: 200, fade: 0.05 })];
}

/** Chair rolling over a lift tower's sheave train: da-dum da-dum da-dum, plus a hanger creak. */
function genSheave(sr, rand) {
  const x = buf(sr, 1.3);
  [0, 0.105, 0.24, 0.345, 0.48, 0.585].forEach((t, i) => {
    const a = (i % 2 ? 0.65 : 1) * (1 - i * 0.08);
    addTone(x, sr, t, 0.15, glide(150, 85, 0.02), [0.002, 0.028], a);
    addModes(x, sr, t, [[690 * jit(rand), 0.02, 0.3 * a], [1270 * jit(rand), 0.012, 0.18 * a], [2330, 0.008, 0.08 * a]], 0.0006);
    addNoise(x, sr, rand, t, 0.06, [0.001, 0.012], [["lp", 700, 0.7]], 0.35 * a);
  });
  const creak = buf(sr, 0.45);
  addTone(creak, sr, 0, 0.4, glide(210, 170, 0.2), (u) => envAHR(u, 0.08, 0.12, 0.15) * (0.6 + 0.4 * Math.sin(TAU * 31 * u)), 0.5, "saw");
  svf(creak, sr, "bp", 900, 3);
  mixInto(x, creak, sr, 0.68, 0.5);
  svf(x, sr, "lp", 3000, 0.7);
  return [finish(x, sr, { hp: 40, fade: 0.05 })];
}

/** End-of-match sting: rising D-major arpeggio of bells over a swelling Dmaj9, then it hands off to the pad. */
function genResults(sr, rand) {
  const len = 3.4;
  const out = [buf(sr, len), buf(sr, len)];
  const pad = [buf(sr, len), buf(sr, len)];
  [146.83, 220, 277.18, 329.63, 369.99].forEach((f, i) => {
    for (const c of [-6, 6]) addTone(pad[(i + (c > 0 ? 1 : 0)) % 2], sr, 0.05, len - 0.06, f * Math.pow(2, c / 1200), ["ahr", 0.6, 1.1, 1.5], 0.1, "saw");
  });
  for (const p of pad) {
    svf(p, sr, "lp", sweep(350, 2600, 0.9), 0.9);
    svf(p, sr, "lp", 4200, 0.6);
  }
  [293.66, 440, 587.33, 739.99, 880].forEach((f, i) => {
    bell(out[i % 2], sr, 0.12 * i, f, 0.6, 0.6);
    bell(out[(i + 1) % 2], sr, 0.12 * i + 0.005, f, 0.35, 0.6);
  });
  for (let c = 0; c < 2; c++) {
    mixInto(out[c], pad[c], sr, 0, 1);
    addTone(out[c], sr, 0, len - 0.05, 73.42, ["ahr", 0.3, 0.9, 1.6], 0.3);
    addNoise(out[c], sr, rand, 0.3, len - 0.35, [0.3, 0.8], [["hp", 6000, 0.7]], 0.025);
  }
  return finish(out, sr, { hp: 30, fade: 0.1 });
}

// ───────────────────────────── loops & impulse response ─────────────────────────────

/** Seamless stereo pink noise (decorrelated L/R): wind beds, powder, ambience. */
function loopPink(sr, rand) {
  const n = Math.round(3 * sr);
  const xf = Math.round(0.25 * sr);
  const out = [0, 1].map(() => loopify(dcBlock(pink(n + xf, rand), sr, 12), n));
  return normalize(out);
}

/** Ski carve: bright hiss chopped by ~30 Hz snow-crystal grains (rate scales with playbackRate). */
function loopCrunchSki(sr, rand) {
  const n = Math.round(3 * sr);
  const N = n + Math.round(0.15 * sr);
  const g = grainEnv(N, sr, rand, 30, { jitter: 0.4, attack: 0.0007, decay: 0.009, min: 0.25, floor: 0.32 });
  const x = svf(white(N, rand), sr, "hp", 700, 0.7);
  for (let i = 0; i < N; i++) x[i] *= g[i];
  return [normalize(loopify(x, n))];
}

/** Board: a lower, rougher scrape (slower, longer grains + a grinding low-mid layer). */
function loopCrunchBoard(sr, rand) {
  const n = Math.round(3 * sr);
  const N = n + Math.round(0.15 * sr);
  const g = grainEnv(N, sr, rand, 21, { jitter: 0.45, attack: 0.001, decay: 0.016, min: 0.25, floor: 0.35 });
  const g2 = grainEnv(N, sr, rand, 9, { jitter: 0.5, attack: 0.004, decay: 0.05, min: 0.3, floor: 0.4 });
  const x = svf(white(N, rand), sr, "hp", 250, 0.7);
  const low = svf(white(N, rand), sr, "lp", 500, 0.7);
  for (let i = 0; i < N; i++) x[i] = x[i] * g[i] + 1.6 * low[i] * g2[i];
  return [normalize(loopify(x, n))];
}

/** Skid / scrape rasp: jagged fast stick-slip grains. */
function loopRasp(sr, rand) {
  const n = Math.round(2 * sr);
  const N = n + Math.round(0.12 * sr);
  const g = grainEnv(N, sr, rand, 70, { jitter: 0.55, attack: 0.0004, decay: 0.0045, min: 0.2, floor: 0.18 });
  const x = svf(white(N, rand), sr, "hp", 300, 0.7);
  for (let i = 0; i < N; i++) x[i] *= g[i];
  return [normalize(loopify(x, n))];
}

/** Control signal (±1): slow gusts + faster buffeting, for wind gain/whistle modulation. */
function loopFlutter(sr, rand) {
  const n = Math.round(8 * sr);
  const N = n + Math.round(1 * sr);
  const x = new Float32Array(N);
  const layer = (rate, amp) => {
    const step = sr / rate;
    const pts = [];
    for (let i = 0; i <= N / step + 2; i++) pts.push(rand() * 2 - 1);
    for (let i = 0; i < N; i++) {
      const p = i / step;
      const k = Math.floor(p);
      const w = 0.5 - 0.5 * Math.cos(Math.PI * (p - k));
      x[i] += amp * (pts[k] * (1 - w) + pts[k + 1] * w);
    }
  };
  layer(1.3, 1);
  layer(5.5, 0.45);
  layer(13, 0.15);
  return [normalize(loopify(x, n))];
}

/**
 * The mountain: near snow/forest scatter, tree-line slaps (40–250 ms), then discrete ridge echoes
 * (0.3–3.2 s) that get smeared and darker — the rolling outdoor tail — plus a faint diffuse roll.
 * Normalised to unit energy per channel; the engine's return gain sets the wet level.
 */
function irValley(sr, rand) {
  const len = 3.6;
  const n = Math.round(len * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const x of out) {
    addNoise(x, sr, rand, 0.006, 0.6, [0.012, 0.075], [["lp", glide(6000, 1800, 0.12), 0.7], ["hp", 160, 0.7]], 0.28);
    for (let k = 0; k < 8; k++) {
      const tk = 0.04 + 0.21 * rand();
      const a = 0.26 * (0.4 + 0.6 * rand()) * Math.exp(-tk / 0.2);
      addNoise(x, sr, rand, tk, 0.08, [0.0015, 0.012], [["bp", 1200 + 1500 * rand(), 0.8]], a);
    }
    for (let k = 0; k < 16; k++) {
      const tk = 0.3 + 2.9 * Math.pow((k + rand() * 0.8) / 16, 1.3);
      const a = 0.5 * Math.exp(-tk / 1.4) * (0.5 + 0.5 * rand());
      const sm = 0.02 + 0.045 * tk;
      const lpf = 3800 * Math.exp(-tk / 1.1) + 420;
      addNoise(x, sr, rand, tk, Math.min(len - tk, sm * 10), [sm * 0.4, sm], [["lp", lpf, 0.7], ["hp", 140, 0.7]], a);
    }
    addNoise(x, sr, rand, 0.25, len - 0.25, [0.35, 0.75], [["lp", glide(1500, 500, 1), 0.7], ["hp", 120, 0.7]], 0.06);
    fadeOut(x, sr, 0.08);
  }
  for (const x of out) {
    let e = 0;
    for (let i = 0; i < n; i++) e += x[i] * x[i];
    const g = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) x[i] *= g;
  }
  return out;
}

// ───────────────────────────── dispatch ─────────────────────────────

/** Renders one bank entry. Returns Float32Array[] (channels) or null for an unknown name. */
export function generate(name, sr) {
  const rand = makeRng((hashStr(name) ^ SEED) >>> 0);
  const p = name.split("/");
  switch (p[0]) {
    case "gun":
      return genGun(p[1], p[2], sr, rand);
    case "whiz":
      return genWhiz(sr, rand);
    case "imp":
      return genImpact(p[1], sr, rand);
    case "hit":
      return genHit(p[1], sr, rand);
    case "ui":
      return genUi(p[1], sr, rand);
    case "fol":
      return genFoley(p[1], sr, rand, p[2]);
    case "pl":
      return genPlayer(p[1], sr, rand);
    case "amb":
      return p[1] === "raven" ? genRaven(sr, rand) : p[1] === "sheave" ? genSheave(sr, rand) : null;
    case "mus":
      return p[1] === "results" ? genResults(sr, rand) : null;
    case "loop":
      if (p[1] === "pink") return loopPink(sr, rand);
      if (p[1] === "crunchSki") return loopCrunchSki(sr, rand);
      if (p[1] === "crunchBoard") return loopCrunchBoard(sr, rand);
      if (p[1] === "rasp") return loopRasp(sr, rand);
      if (p[1] === "flutter") return loopFlutter(sr, rand);
      return null;
    case "ir":
      return p[1] === "valley" ? irValley(sr, rand) : null;
    default:
      return null;
  }
}

/** Every bank entry, in pre-warm priority order (combat-critical first). */
export function bankList() {
  const L = ["ir/valley"];
  const parts = (w) => {
    const G = GUNS[w];
    const out = [];
    for (const part of ["body", "crack", "thump", "mech", "tail"]) for (let v = 0; v < VARIANTS[part]; v++) out.push(`gun/${w}/${part}/${v}`);
    if (G.boom) out.push(`gun/${w}/boom/0`);
    if (G.roll) out.push(`gun/${w}/roll/0`);
    return out;
  };
  for (const w of WEAPON_IDS) L.push(`gun/${w}/body/0`, `gun/${w}/crack/0`, `gun/${w}/thump/0`);
  L.push("hit/body/0", "hit/head/0", "hit/kill/0", "whiz/0", "imp/snow/0", "imp/body/0", "imp/tree/0", "imp/metal/0");
  for (const w of WEAPON_IDS) L.push(...parts(w));
  for (let v = 0; v < VARIANTS.whiz; v++) L.push(`whiz/${v}`);
  for (const k of ["snow", "body", "tree", "metal"]) for (let v = 0; v < VARIANTS.imp; v++) L.push(`imp/${k}/${v}`);
  for (const k of ["body", "head", "kill"]) for (let v = 0; v < VARIANTS.hit; v++) L.push(`hit/${k}/${v}`);
  L.push("loop/pink", "loop/crunchSki", "loop/crunchBoard", "loop/rasp", "loop/flutter");
  for (const k of ["magOut", "magIn", "bolt", "charge", "slide", "pump", "shell", "chamber", "dry", "adsIn", "adsOut"]) for (let v = 0; v < VARIANTS.fol; v++) L.push(`fol/${k}/${v}`);
  for (const w of WEAPON_IDS) L.push(`fol/equip/${w}`);
  for (const k of ["move", "select", "back", "beepLo", "beepHi", "go", "medal", "streak", "confirm"]) L.push(`ui/${k}`);
  for (const k of ["land", "clatter", "crash", "hurt"]) for (let v = 0; v < VARIANTS.pl; v++) L.push(`pl/${k}/${v}`);
  L.push("pl/tree/0", "pl/heart/0", "pl/death/0", "pl/respawn/0", "amb/sheave/0", "mus/results");
  for (let v = 0; v < VARIANTS.raven; v++) L.push(`amb/raven/${v}`);
  return [...new Set(L)];
}
