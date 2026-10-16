/**
 * Audio engine core. Feature code (audio.js, loops.js) talks only to this.
 *
 * Mix graph (built in start()):
 *
 *   voice ─► bus.weapons ─► duck ─┐
 *   voice ─► bus.impacts ─► duck ─┤
 *   loops ─► bus.motion  ─► duck ─┼─► world ─► worldLP (death / hurt muffle) ─┐
 *   loops ─► bus.ambience ─► duck ┤                                           │
 *   sends ─► verbIn ─► HP ─► LP ─► Convolver (valley IR) ─► verbOut ──┘      │
 *   voice ─► bus.ui     ─► duck ──────────────────────────────────────────────┤
 *   voice ─► bus.player ─► duck ──────────────────────────────────────────────┤
 *   music ─► bus.music  ─► duck ──────────────────────────────────────────────┤
 *                                                                               ▼
 *   master (volume · mute) ─► DynamicsCompressor ─► soft clip (WaveShaper, 2×) ─► Analyser ─► out
 *
 * One-shot VOICES: a voice is one sound event (e.g. a gunshot = 2–5 BufferSources summed into
 * one input gain, then [distance low-pass ─► HRTF panner] for world sounds, plus a reverb send).
 * Budget: at most MAX_VOICES playing; beyond that the voice with the lowest
 * (loudness × age-decay) score is faded out in 20 ms, or the new one is dropped if it would be
 * the quietest. Group caps (own gun, each rider, whizzes, impacts) keep bursts from hogging it.
 * Every source has onended → when a voice's last source ends, ALL its nodes are disconnected.
 * A reaper also disposes anything 1 s past its scheduled end (belt and braces), so the node
 * count is bounded by MAX_VOICES × (≤ 16 nodes) + MAX_DYING voices + the persistent loops.
 *
 * Distant world events are delayed by distance / 343 m/s. They wait in a small queue (JS
 * objects, no nodes; capped at MAX_PENDING) and only become voices ~120 ms before they sound.
 */
import { makeRng, clamp, dbToGain, biquad } from "./dsp.js";
import { SEED, GUNS, generate, bankList, rateFor, shotPlan, mixPeak } from "./sounds.js";

export const MAX_VOICES = 40;
export const MAX_DYING = 24;
export const MAX_PENDING = 48;
/** Scheduling offset for "now" sounds: keeps attacks out of the past on a busy main thread. */
export const LOOK = 0.006;
const AHEAD = 0.12;
export const SPEED_OF_SOUND = 343;
export const REF_DIST = 8;
export const MAX_DIST = 2000;

/** Category trims (dB). Per-sound levels live with the features; this is the coarse balance. */
export const BUS_DB = { weapons: 0, impacts: -1, motion: 0, ambience: -1, ui: 0, player: 0, music: -2 };
const WORLD_BUSES = new Set(["weapons", "impacts", "motion", "ambience"]);
/** Return level of the valley convolver (its IR is unit-energy; see .studio/audio-dev/levels.mjs). */
export const VERB_RETURN = 0.55;
/** Master trim at volume 1. */
const MASTER_TRIM = 1;

/** Direct sound: the PannerNodes' inverse law (refDistance 8, rolloff 1). */
export const dryGain = (d) => REF_DIST / Math.max(REF_DIST, Math.min(d, MAX_DIST));
/**
 * Reverberant field: falls far slower than the direct sound, so distant sources turn to echo
 * (echo ≈ −22 dB under the dry at 8 m, level at ~150 m, dominant beyond 300 m).
 */
export const wetGain = (d) => Math.sqrt((1 + Math.max(0, d) / 400) / (1 + Math.max(0, d) / 30));
/** Air absorption: ~16 kHz up close → 1.5 kHz at 400 m (log-linear, slightly front-loaded). */
export const airCutoff = (d) => Math.max(1200, 16000 * Math.pow(1500 / 16000, Math.pow(clamp(d, 0, 600) / 400, 0.8)));

const clock = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const finite = (v) => typeof v === "number" && Number.isFinite(v);
export const validPos = (p) => !!p && finite(p.x) && finite(p.y) && finite(p.z);
const channelsOf = (b) => {
  const out = [];
  for (let c = 0; c < b.numberOfChannels; c++) out.push(b.getChannelData(c));
  return out;
};

/** Soft clipper curve: linear to ±0.7, tanh knee to a 0.98 ceiling; input pre-scaled by ½ so overs up to +6 dB bend smoothly. */
function softClipCurve(n = 4097) {
  const c = new Float32Array(n);
  const T = 0.7;
  const CEIL = 0.98;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a <= T ? a : T + (CEIL - T) * Math.tanh((a - T) / (CEIL - T));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

function makePanner(ctx, p, hrtf = true) {
  const pn = ctx.createPanner();
  pn.panningModel = hrtf ? "HRTF" : "equalpower";
  pn.distanceModel = "inverse";
  pn.refDistance = REF_DIST;
  pn.rolloffFactor = 1;
  pn.maxDistance = MAX_DIST;
  pn.coneInnerAngle = 360;
  pn.coneOuterAngle = 360;
  if (pn.positionX) {
    pn.positionX.value = p.x;
    pn.positionY.value = p.y;
    pn.positionZ.value = p.z;
  } else pn.setPosition(p.x, p.y, p.z);
  return pn;
}

/** One sound event: layers → in (level) → [air LP → HRTF panner] → bus, + reverb send. */
class Voice {
  constructor(E, o) {
    const ctx = E.ctx;
    this.E = E;
    this.prio = o.prio;
    this.group = o.group ?? null;
    this.protect = !!o.protect;
    this.t0 = o.t0;
    this.tEnd = o.t0 + (o.dur ?? 0.3);
    this.level = o.level ?? 1;
    this.nodes = [];
    this.srcs = [];
    this.live = 0;
    this.dead = false;
    this.dying = false;
    this.killedAt = 0;
    this.onEnded = () => {
      this.live--;
      if (this.live <= 0) this.dispose();
    };
    const inp = ctx.createGain();
    inp.gain.value = this.level;
    this.in = inp;
    this.nodes.push(inp);
    const bus = E.bus[o.cat] ?? E.bus.weapons;
    if (o.pos) {
      const d = o.dist ?? E.distTo(o.pos);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = airCutoff(d);
      lp.Q.value = -3; // dB for lowpass: Butterworth-ish, no resonance
      const pn = makePanner(ctx, o.pos, d <= E.hrtfMax);
      inp.connect(lp);
      lp.connect(pn);
      pn.connect(bus);
      this.nodes.push(lp, pn);
      if (o.send > 0) {
        const s = ctx.createGain();
        s.gain.value = o.send * wetGain(d);
        lp.connect(s);
        this.nodes.push(s);
        if (E.canPan) {
          const sp = ctx.createStereoPanner();
          sp.pan.value = E.panOf(o.pos) * 0.6; // echoes lean toward the source but stay wide
          s.connect(sp);
          sp.connect(E.verbIn);
          this.nodes.push(sp);
        } else s.connect(E.verbIn);
      }
    } else {
      let head = inp;
      if (o.pan && E.canPan) {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(o.pan, -1, 1);
        inp.connect(p);
        head = p;
        this.nodes.push(p);
      }
      head.connect(bus);
      if (o.send > 0) {
        const s = ctx.createGain();
        s.gain.value = o.send;
        head.connect(s);
        s.connect(E.verbIn);
        this.nodes.push(s);
      }
    }
  }

  /**
   * Adds a layer: buffer at ctx time `when`. o: gain, rate, pan (equal-power), offset (s into the
   * buffer), dur (truncate with an exponential fade of `fade` s), filter [type, Hz, Q, dB].
   */
  play(buffer, when, o = {}) {
    if (!buffer || this.dead || this.dying) return null;
    const gain = o.gain ?? 1;
    if (!(gain > 0)) return null;
    const ctx = this.E.ctx;
    const rate = o.rate ?? 1;
    const offset = Math.max(0, o.offset ?? 0);
    const natural = (buffer.duration - offset) / rate;
    if (!(natural > 0)) return null;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    if (rate !== 1) s.playbackRate.value = rate;
    this.nodes.push(s);
    let head = s;
    if (o.filter) {
      const [type, f, q = 0, db = 0] = o.filter;
      const bq = ctx.createBiquadFilter();
      bq.type = type;
      bq.frequency.value = f;
      bq.Q.value = q;
      if (db) bq.gain.value = db;
      head.connect(bq);
      head = bq;
      this.nodes.push(bq);
    }
    const truncated = o.dur != null && o.dur < natural;
    const dur = truncated ? o.dur : natural;
    if (gain !== 1 || truncated) {
      const g = ctx.createGain();
      g.gain.value = gain;
      if (truncated) {
        // Anchor at the value the gain already holds (no jump), then decay to −80 dB.
        const f = Math.min(o.fade ?? 0.06, dur * 0.5);
        g.gain.setValueAtTime(gain, when + dur - f);
        g.gain.exponentialRampToValueAtTime(gain * 1e-4, when + dur);
      }
      head.connect(g);
      head = g;
      this.nodes.push(g);
    }
    if (o.pan && this.E.canPan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      head.connect(p);
      head = p;
      this.nodes.push(p);
    }
    head.connect(this.in);
    this.srcs.push(s);
    this.live++;
    s.onended = this.onEnded;
    s.start(when, offset);
    s.stop(when + dur + 0.004);
    this.tEnd = Math.max(this.tEnd, when + dur);
    return s;
  }

  /** Call after adding layers: a voice that ended up with none is released at once. */
  commit() {
    if (!this.live && !this.dead) this.dispose();
    return this;
  }

  /** Budget score: estimated loudness decaying with age (old, nearly-finished voices go first). */
  score(now) {
    const age = Math.max(0, now - this.t0);
    const span = Math.max(0.05, this.tEnd - this.t0);
    return this.prio * Math.exp(-age / (span * 0.35));
  }

  /** Steal: 20 ms linear fade from the (constant) level, then stop; cleanup follows onended. */
  kill(fade = 0.02) {
    if (this.dead || this.dying) return;
    const ctx = this.E.ctx;
    const now = ctx.currentTime;
    this.dying = true;
    this.killedAt = now;
    const g = this.in.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(this.level, now);
      g.linearRampToValueAtTime(0, now + fade);
    } catch (e) {
      /* closed context */
    }
    for (const s of this.srcs) {
      try {
        s.stop(now + fade + 0.004);
      } catch (e) {
        /* already stopped */
      }
    }
    this.E._toDying(this);
    if (!this.live) this.dispose();
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    for (const s of this.srcs) s.onended = null;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* already disconnected */
      }
    }
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.E._release(this);
  }
}

export class Engine {
  constructor(opts = {}) {
    this.ctx = null;
    this.analyser = null;
    this.muted = false;
    this.volume = 1;
    /** Event-level randomness (variant picks, pitch jitter, scheduling): one constant-seeded LCG. */
    this.rand = makeRng(SEED ^ 0x9e3779b9);
    /** Listener pose (world space), kept in JS for distance / delay / pan maths. */
    this.L = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0 };
    this.voices = [];
    this.dying = [];
    this.pending = [];
    this.cache = new Map();
    this.samples = new Map();
    this.mixScale = new Map();
    this.tickers = [];
    this.warmQueue = [];
    this.decodeQueue = [];
    this.autoTick = opts.autoTick !== false;
    this.useWorker = opts.worker !== false;
    /** CPU knob: voices farther than this use equal-power panning instead of HRTF (default: all HRTF). */
    this.hrtfMax = Number.isFinite(opts.hrtfMaxDistance) ? opts.hrtfMaxDistance : Infinity;
    this.worker = null;
    this.inflight = new Set();
    this.lowRates = true;
    this.verbSet = false;
    this.startedWall = 0;
    this.workerSeen = 0;
    this.timer = null;
    this.dead = false;
    this.deadUntil = 0;
    this.lowHealth = false;
    this.errors = 0;
    this.stats = { created: 0, dropped: 0, stolen: 0, peakVoices: 0, peakPending: 0, peakDying: 0 };
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Uniform integer in [0, n). */
  pick(n) {
    return Math.min(n - 1, Math.floor(this.rand() * n));
  }

  /** 1 ± amt, uniformly. */
  jitter(amt) {
    return 1 + (this.rand() * 2 - 1) * amt;
  }

  /** Creates the context and graph (first call only). Returns true when it just started. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended" && this.ctx.resume) this.ctx.resume().catch(() => {});
      return false;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    let ctx = null;
    try {
      ctx = new AC({ latencyHint: "interactive" });
    } catch (e) {
      try {
        ctx = new AC();
      } catch (e2) {
        return false;
      }
    }
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.buildGraph();
    if (ctx.state === "suspended" && ctx.resume) ctx.resume().catch(() => {});
    this.applyListener();
    this.startedWall = clock();
    this.warmQueue = bankList();
    this.startWorker();
    // Samples requested before start() on a browser without OfflineAudioContext decode now.
    const q = this.decodeQueue.splice(0);
    for (const j of q) this.decode(j.data).then(j.resolve);
    if (this.autoTick && typeof globalThis.setInterval === "function") this.timer = globalThis.setInterval(() => this.tick(), 40);
    return true;
  }

  buildGraph() {
    const ctx = this.ctx;
    this.canPan = typeof ctx.createStereoPanner === "function"; // (Safari < 14.1 lacks it)
    this.master = ctx.createGain();
    this.master.gain.value = this.masterTarget();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.comp = comp;
    const pre = ctx.createGain();
    pre.gain.value = 0.5; // the clip curve spans ±2 so overs up to +6 dB bend instead of hard-clipping
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = "2x";
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.5;
    this.master.connect(comp);
    comp.connect(pre);
    pre.connect(clip);
    clip.connect(an);
    an.connect(ctx.destination);
    this.analyser = an;

    this.world = ctx.createGain();
    this.worldLP = ctx.createBiquadFilter();
    this.worldLP.type = "lowpass";
    this.worldLP.frequency.value = 20000;
    this.worldLP.Q.value = -1;
    this.world.connect(this.worldLP);
    this.worldLP.connect(this.master);

    this.bus = {};
    this.ducks = {};
    for (const name of Object.keys(BUS_DB)) {
      const g = ctx.createGain();
      g.gain.value = dbToGain(BUS_DB[name]);
      const d = ctx.createGain();
      g.connect(d);
      d.connect(WORLD_BUSES.has(name) ? this.world : this.master);
      this.bus[name] = g;
      this.ducks[name] = d;
    }

    // Environment reverb: band-limit the send (no sub boom or fizz in the echoes), then the valley IR.
    this.verbIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 140;
    hp.Q.value = -3;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5200;
    lp.Q.value = -3;
    this.verb = ctx.createConvolver();
    this.verb.normalize = false;
    this.verbOut = ctx.createGain();
    this.verbOut.gain.value = VERB_RETURN;
    this.verbIn.connect(hp);
    hp.connect(lp);
    lp.connect(this.verb);
    this.verb.connect(this.verbOut);
    this.verbOut.connect(this.world);
    // The valley IR arrives from the bank worker (or is rendered on a tick): see ensureVerb().

    // Creating an HRTF panner up front makes the browser load its HRTF set before the first shot.
    try {
      this.warmPanner = ctx.createPanner();
      this.warmPanner.panningModel = "HRTF";
    } catch (e) {
      this.warmPanner = null;
    }
  }

  // ───────────────────────────── assets ─────────────────────────────

  /** Render rate for a bank entry (band-limited material uses less; see sounds.rateFor). */
  rateOf(name) {
    return this.lowRates ? rateFor(name, this.sr) : this.sr;
  }

  /** The AudioBuffer for a bank entry: cached, else rendered right now on this thread. */
  buf(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    if (!this.ctx) return null;
    const rate = this.rateOf(name);
    let data = null;
    try {
      data = generate(name, rate);
    } catch (e) {
      this.err(e);
    }
    return this.store(name, data, rate);
  }

  /** Wraps rendered channels in an AudioBuffer (falls back to the context rate if a low rate is refused). */
  store(name, data, rate) {
    if (!data || !data.length || !data[0].length) {
      this.cache.set(name, null);
      return null;
    }
    let b = null;
    try {
      b = this.ctx.createBuffer(data.length, data[0].length, rate);
    } catch (e) {
      if (rate === this.sr) {
        this.err(e);
        this.cache.set(name, null);
        return null;
      }
      this.lowRates = false; // an old engine that only takes ≥ 22.05 kHz buffers: render at full rate
      return this.buf(name);
    }
    for (let c = 0; c < data.length; c++) b.getChannelData(c).set(data[c]);
    this.cache.set(name, b);
    if (name === "ir/valley") this.ensureVerb();
    return b;
  }

  /** Puts the valley IR into the convolver once it exists (worker, or rendered here as a fallback). */
  ensureVerb() {
    if (this.verbSet || !this.verb) return;
    const late = clock() - this.startedWall > 1500;
    if (!this.cache.has("ir/valley") && this.worker && !late) return; // the worker is on it
    const ir = this.buf("ir/valley");
    this.verbSet = true;
    if (!ir) return;
    try {
      this.verb.buffer = ir;
    } catch (e) {
      this.err(e);
    }
  }

  /** Off-thread bank rendering (module worker). Any failure falls back to main-thread slices. */
  startWorker() {
    if (!this.useWorker || typeof globalThis.Worker !== "function") return;
    let w;
    try {
      w = new globalThis.Worker(new URL("./bankWorker.js", import.meta.url), { type: "module" });
    } catch (e) {
      return;
    }
    this.worker = w;
    this.workerSeen = clock();
    w.onmessage = (e) => {
      const { name, rate, data } = e.data || {};
      this.workerSeen = clock();
      this.inflight.delete(name);
      if (data && !this.cache.has(name) && rate === this.rateOf(name)) this.store(name, data, rate);
      this.feed();
    };
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      this.stopWorker();
    };
    this.feed();
  }

  stopWorker() {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch (e) {
      /* gone */
    }
    this.worker = null;
    for (const n of this.inflight) this.warmQueue.unshift(n);
    this.inflight.clear();
  }

  feed() {
    if (!this.worker) return;
    while (this.inflight.size < 2 && this.warmQueue.length) {
      const name = this.warmQueue.shift();
      if (this.cache.has(name)) continue;
      this.inflight.add(name);
      this.worker.postMessage({ name, rate: this.rateOf(name) });
    }
  }

  /** Main-thread warm-up (only without a worker): ~3 ms of rendering per tick, most-needed first. */
  warmStep(budgetMs = 3) {
    this.ensureVerb();
    // A worker that never answers (blocked script, odd browser) hands the queue back to us.
    if (this.worker && this.inflight.size && clock() - this.workerSeen > 5000) this.stopWorker();
    if (this.worker || !this.warmQueue.length) return;
    const t0 = clock();
    while (this.warmQueue.length && clock() - t0 < budgetMs) {
      const name = this.warmQueue.shift();
      if (!this.cache.has(name)) this.buf(name);
    }
  }

  // ───────────────────────────── samples ─────────────────────────────

  /** fetch + decode a recorded sample. Works before start() (decodes on an OfflineAudioContext). */
  loadSample(name, url) {
    if (typeof name !== "string" || !url) return Promise.resolve(false);
    const job = async () => {
      if (typeof globalThis.fetch !== "function") return false;
      const res = await globalThis.fetch(url);
      if (!res || !res.ok) return false;
      const data = await res.arrayBuffer();
      const buffer = await this.decode(data);
      if (!buffer || !buffer.length) return false;
      const info = analyseSample(buffer);
      if (!info) return false;
      this.samples.set(name, { buffer, ...info });
      this.mixScale.clear(); // own-shot calibration now includes the sample
      return true;
    };
    return job().catch(() => false);
  }

  decode(data) {
    const ctx = this.ctx || this.offlineCtx();
    if (!ctx) return new Promise((resolve) => this.decodeQueue.push({ data, resolve }));
    return new Promise((resolve) => {
      let settled = false;
      const done = (b) => {
        if (settled) return;
        settled = true;
        resolve(b || null);
      };
      try {
        const r = ctx.decodeAudioData(data, done, () => done(null));
        if (r && typeof r.then === "function") r.then(done, () => done(null));
      } catch (e) {
        done(null);
      }
    });
  }

  offlineCtx() {
    if (this.offline) return this.offline;
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) return null;
    try {
      this.offline = new OAC(1, 1, 48000); // decoding only; never rendered
    } catch (e) {
      this.offline = null;
    }
    return this.offline;
  }

  /** Own-shot layer scale so the summed peak lands on the weapon's ownDb (−6 dBFS for the AR). */
  shotScale(w, useSample) {
    const key = w + (useSample ? ":sample" : ":synth");
    const hit = this.mixScale.get(key);
    if (hit) return hit;
    const G = GUNS[w];
    const S = this.samples.get("rifle");
    const layers = [];
    for (const l of shotPlan(w, useSample && !!S, 0)) {
      if (l.part === "sample") {
        // Measure the sample through the same per-weapon filter the voice applies.
        const data = filteredSample(S, G.sample, 0.4);
        layers.push({ data, gain: l.gain * S.norm, at: l.at, rate: G.sample.rate, offset: 0, sr: S.buffer.sampleRate });
      } else {
        const b = this.buf(`gun/${w}/${l.part}/0`);
        if (b) layers.push({ data: channelsOf(b), gain: l.gain, at: l.at, pan: l.pan, sr: b.sampleRate });
      }
    }
    const peak = mixPeak(layers, this.sr, 0.4);
    const s = peak > 0 ? dbToGain(G.ownDb) / peak : 0.5;
    this.mixScale.set(key, s);
    return s;
  }

  // ───────────────────────────── voices ─────────────────────────────

  /**
   * Allocates a one-shot voice, or returns null when the budget culls it.
   * o: { cat, prio (≈ linear loudness at the listener), t0, dur, level, pos?, dist?, send?,
   *      pan?, group?, groupMax?, protect? }
   */
  voice(o) {
    const ctx = this.ctx;
    if (!ctx) return null;
    const now = ctx.currentTime;
    this.reap(now);
    if (o.group) {
      let n = 0;
      let oldest = null;
      for (const v of this.voices) {
        if (v.group !== o.group) continue;
        n++;
        if (!oldest || v.t0 < oldest.t0) oldest = v;
      }
      if (oldest && n >= (o.groupMax ?? 4)) oldest.kill(0.03);
    }
    if (this.voices.length >= MAX_VOICES) {
      let victim = null;
      let worst = Infinity;
      for (const v of this.voices) {
        if (v.protect) continue;
        const s = v.score(now);
        if (s < worst) {
          worst = s;
          victim = v;
        }
      }
      if (victim && (o.protect || worst < o.prio)) {
        victim.kill(0.02);
        this.stats.stolen++;
      } else if (!o.protect || this.voices.length >= MAX_VOICES + 8) {
        this.stats.dropped++;
        return null;
      }
    }
    if (this.dying.length >= MAX_DYING && !o.protect) {
      this.stats.dropped++;
      return null;
    }
    let v;
    try {
      v = new Voice(this, o);
    } catch (e) {
      this.err(e);
      return null;
    }
    this.voices.push(v);
    this.stats.created++;
    if (this.voices.length > this.stats.peakVoices) this.stats.peakVoices = this.voices.length;
    return v;
  }

  _toDying(v) {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    this.dying.push(v);
    if (this.dying.length > this.stats.peakDying) this.stats.peakDying = this.dying.length;
  }

  _release(v) {
    let i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    i = this.dying.indexOf(v);
    if (i >= 0) this.dying.splice(i, 1);
  }

  /** Failsafe: dispose voices well past their end (e.g. onended lost while suspended). */
  reap(now) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v && now > v.tEnd + 1) v.dispose();
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (v && now > v.killedAt + 0.5) v.dispose();
    }
  }

  /**
   * Runs fn(t) for an event that should sound at ctx time t: right away when t is near,
   * otherwise queued (no nodes yet) until ~120 ms before. Over the cap, the quietest waits lose.
   */
  at(t, prio, fn) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (t - now <= AHEAD) {
      fn(Math.max(t, now + LOOK));
      return;
    }
    if (this.pending.length >= MAX_PENDING) {
      let wi = -1;
      let wp = Infinity;
      for (let i = 0; i < this.pending.length; i++) {
        if (this.pending[i].prio < wp) {
          wp = this.pending[i].prio;
          wi = i;
        }
      }
      this.stats.dropped++;
      if (wp >= prio) return;
      this.pending.splice(wi, 1);
    }
    this.pending.push({ t, prio, fn });
    if (this.pending.length > this.stats.peakPending) this.stats.peakPending = this.pending.length;
  }

  pump(now) {
    for (let i = 0; i < this.pending.length; ) {
      const e = this.pending[i];
      if (e.t - now > AHEAD) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      if (e.t < now - 0.25) {
        this.stats.dropped++; // stale (the tab stalled): better silent than late
        continue;
      }
      try {
        e.fn(Math.max(e.t, now + LOOK));
      } catch (err) {
        this.err(err);
      }
    }
  }

  // ───────────────────────────── space ─────────────────────────────

  distTo(p) {
    const L = this.L;
    return Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z);
  }

  /** −1 (left) … 1 (right) for a world point, from the listener's right vector. */
  panOf(p) {
    const L = this.L;
    const dx = p.x - L.x;
    const dy = p.y - L.y;
    const dz = p.z - L.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return 0;
    return clamp((dx * L.rx + dy * L.ry + dz * L.rz) / d, -1, 1);
  }

  /** Reads a three.js camera (position + matrixWorld basis columns) without importing three. */
  setListener(cam) {
    if (!cam) return;
    const m = cam.matrixWorld && cam.matrixWorld.elements;
    const p = cam.position;
    let x;
    let y;
    let z;
    if (m && (cam.parent || !p)) {
      x = m[12];
      y = m[13];
      z = m[14];
    } else if (p) {
      x = p.x;
      y = p.y;
      z = p.z;
    }
    if (!finite(x) || !finite(y) || !finite(z)) return;
    let fx = 0;
    let fy = 0;
    let fz = -1;
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (m) {
      // three.js cameras look down −Z; column 1 is up.
      const fl = Math.hypot(m[8], m[9], m[10]);
      const ul = Math.hypot(m[4], m[5], m[6]);
      if (fl > 1e-6 && ul > 1e-6 && finite(fl) && finite(ul)) {
        fx = -m[8] / fl;
        fy = -m[9] / fl;
        fz = -m[10] / fl;
        ux = m[4] / ul;
        uy = m[5] / ul;
        uz = m[6] / ul;
      }
    }
    const L = this.L;
    L.x = x;
    L.y = y;
    L.z = z;
    L.fx = fx;
    L.fy = fy;
    L.fz = fz;
    L.ux = ux;
    L.uy = uy;
    L.uz = uz;
    L.rx = fy * uz - fz * uy;
    L.ry = fz * ux - fx * uz;
    L.rz = fx * uy - fy * ux;
    this.applyListener();
  }

  applyListener() {
    if (!this.ctx) return;
    const L = this.L;
    const lis = this.ctx.listener;
    try {
      if (lis.positionX) {
        lis.positionX.value = L.x;
        lis.positionY.value = L.y;
        lis.positionZ.value = L.z;
        lis.forwardX.value = L.fx;
        lis.forwardY.value = L.fy;
        lis.forwardZ.value = L.fz;
        lis.upX.value = L.ux;
        lis.upY.value = L.uy;
        lis.upZ.value = L.uz;
      } else {
        lis.setPosition(L.x, L.y, L.z);
        lis.setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
      }
    } catch (e) {
      this.err(e);
    }
  }

  // ───────────────────────────── mix automation ─────────────────────────────

  /** Sidechain-style dip of a bus: setTargetAtTime only, so it is continuous from wherever it is. */
  duck(name, db, attack = 0.004, hold = 0.04, release = 0.2) {
    const d = this.ducks && this.ducks[name];
    if (!d) return;
    const now = this.ctx.currentTime;
    const g = d.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(dbToGain(db), now, attack / 3);
    g.setTargetAtTime(1, now + attack + hold, release / 3);
  }

  worldBase() {
    return this.dead ? 650 : this.lowHealth ? 5200 : 20000;
  }

  applyWorld(tau = 0.25) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const f = this.worldLP.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(this.worldBase(), now, tau);
    const g = this.world.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this.dead ? 0.5 : 1, now, tau * 1.5);
  }

  /** Death muffles the world (with a failsafe if respawn() never comes). */
  setDead(on) {
    if (!this.ctx || this.dead === !!on) return;
    this.dead = !!on;
    this.deadUntil = on ? this.ctx.currentTime + 12 : 0;
    this.applyWorld(on ? 0.12 : 0.3);
  }

  setLowHealth(on) {
    if (!this.ctx || this.lowHealth === !!on) return;
    this.lowHealth = !!on;
    this.applyWorld(0.4);
  }

  /** A hit punches the world filter down briefly (k ≈ 0..1.5 severity). */
  hitMuffle(k) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const base = this.worldBase();
    const dip = Math.min(base, 2600 - 1500 * Math.min(1, k));
    const f = this.worldLP.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(dip, now, 0.008);
    f.setTargetAtTime(base, now + 0.06 + 0.1 * Math.min(1, k), 0.18);
  }

  // ───────────────────────────── master ─────────────────────────────

  masterTarget() {
    return this.muted ? 0 : MASTER_TRIM * this.volume * this.volume;
  }

  applyMaster() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this.masterTarget(), now, 0.03);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyMaster();
    return this.muted;
  }

  setVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this.volume = clamp(n, 0, 1);
    this.applyMaster();
  }

  // ───────────────────────────── housekeeping ─────────────────────────────

  /** Per frame (from setListener) and every 40 ms (timer): queue, reaper, loop schedulers, warm-up. */
  tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.pump(now);
    this.reap(now);
    if (this.dead && this.deadUntil && now > this.deadUntil) this.setDead(false);
    for (const f of this.tickers) {
      try {
        f(now);
      } catch (e) {
        this.err(e);
      }
    }
    this.warmStep();
  }

  err(e) {
    this.errors++;
    if (this.errors <= 3 && globalThis.console) globalThis.console.warn("[audio]", e);
  }

  info() {
    return {
      state: this.ctx ? this.ctx.state : "idle",
      voices: this.voices.length,
      dying: this.dying.length,
      pending: this.pending.length,
      cached: this.cache.size,
      warming: this.warmQueue.length + this.inflight.size,
      worker: !!this.worker,
      samples: [...this.samples.keys()],
      ...this.stats,
      errors: this.errors,
    };
  }

  /** Stops the timer and closes the context (tests / teardown). */
  dispose() {
    if (this.timer) globalThis.clearInterval(this.timer);
    this.timer = null;
    this.stopWorker();
    this.warmQueue.length = 0;
    for (const v of [...this.voices, ...this.dying]) v.dispose();
    this.pending.length = 0;
    if (this.ctx && this.ctx.close) this.ctx.close().catch(() => {});
  }
}

/**
 * The first `sec` s (after the onset, at playback rate) of a sample's channels run through a
 * WebAudio-equivalent biquad (lowpass/highpass Q in dB; shelves use slope S = 1 ≡ Q 0.7071).
 */
export function filteredSample(S, cfg, sec) {
  const b = S.buffer;
  const i0 = Math.round(S.offset * b.sampleRate);
  const n = Math.min(b.length - i0, Math.ceil(sec * cfg.rate * b.sampleRate) + 2);
  const out = [];
  for (let c = 0; c < b.numberOfChannels; c++) {
    const x = b.getChannelData(c).slice(i0, i0 + n);
    if (cfg.filter) {
      const [type, f, q = 0, db = 0] = cfg.filter;
      const lin = type === "lowpass" || type === "highpass" ? Math.pow(10, q / 20) : type.endsWith("shelf") ? Math.SQRT1_2 : q;
      // The voice filters at the buffer's own rate before resampling, so the cutoff scales with rate.
      biquad(x, b.sampleRate, type, f / cfg.rate, lin, db);
    }
    out.push(x);
  }
  return out;
}

/** Peak, onset and length of a decoded sample (so any recording level/lead-in plays the same). */
function analyseSample(b) {
  const ch = channelsOf(b);
  let peak = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i]);
    if (a > peak) peak = a;
  }
  if (!(peak > 1e-5)) return null;
  const thr = peak * 0.05;
  let on = 0;
  search: for (let i = 0; i < b.length; i++) {
    for (const c of ch) {
      if (Math.abs(c[i]) > thr) {
        on = i;
        break search;
      }
    }
  }
  const offset = Math.max(0, on / b.sampleRate - 0.0015);
  // A recording that ends abruptly would click: fade its last 8 ms to exactly 0 (in place).
  const nf = Math.min(b.length, Math.round(0.008 * b.sampleRate));
  for (const c of ch) for (let i = 0; i < nf; i++) c[c.length - 1 - i] *= i / nf;
  return { peak, norm: 1 / peak, offset, dur: b.duration - offset };
}
