/**
 * Continuous and scheduled sound: the rider's motion beds (wind, carve, skid, powder, air, grind),
 * the chairlift hum, the mountain ambience (gusts + a distant raven), music (menu pad, match
 * pulse, results sting) and the heartbeat.
 *
 * Persistent nodes (filters/gains) are built lazily once per feature. Their noise SOURCES exist
 * only while a layer is audible: a layer that has been silent for a few seconds has its source
 * stopped and disconnected, and the next audible frame starts a fresh one. Music chords and
 * pulses are short-lived nodes with their own envelopes and onended cleanup (≤ 3 chords alive).
 * Every level/frequency change is setTargetAtTime (continuous), never a step.
 */
import { clamp, smoothstep, dbToGain } from "./dsp.js";
import { LOOK } from "./engine.js";

/** Loop levels (linear, into their bus) — calibrated in .studio/audio-dev/levels.mjs. */
export const K = {
  windLow: 0.44,
  windMid: 0.43,
  whistle: 1,
  flutter: 0.35,
  ski: 0.31,
  board: 0.37,
  skid: 0.88,
  powder: 0.2,
  ring: 3.5,
  scrape: 0.35,
  grind: 0.75,
  hum: 0.05,
  rumble: 0.35,
  sing: 0.5,
  bed: 0.1,
  air: 0.012,
  padOsc: 0.015,
  padBass: 0.05,
  pulse: 0.035,
  heartDb: -13,
  ravenDb: -31,
  sheaveDb: -22,
};

const PAD_CHORDS = [
  { bass: 73.42, notes: [146.83, 220.0, 277.18, 329.63, 369.99] }, // Dmaj9
  { bass: 61.74, notes: [146.83, 220.0, 246.94, 329.63, 369.99] }, // Bm7(add11)
  { bass: 98.0, notes: [146.83, 196.0, 246.94, 369.99, 440.0] }, // Gmaj9
  { bass: 110.0, notes: [164.81, 220.0, 293.66, 329.63, 369.99] }, // A sus4(add9)
];
const CHORD_LEN = 7.5;
const CHORD_ATT = 2.6;
const CHORD_REL = 4.5;
const PULSE_BEAT = 0.6;

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * The motion mix as a pure function of the rider state (unit-testable; .studio/audio-dev/levels.mjs measures
 * it). Gains are linear into the motion bus; frequencies in Hz; tau = smoothing time constants.
 */
export function motionTargets(s) {
  const v = Math.max(0, num(s.speed));
  const g = s.grounded === false ? 0 : 1;
  const edge = clamp(num(s.edge), 0, 1);
  const skid = clamp(num(s.skid), 0, 1);
  const powder = clamp(num(s.powder), 0, 1);
  const board = s.kind === "board";
  const grinding = !!s.grinding;
  const sp = clamp(v / 32, 0, 1); // 32 m/s ≈ 115 km/h
  const moving = smoothstep(1.5, 9, v); // the wind ducks away when slow
  const airAmt = g ? 0 : smoothstep(0.05, 0.6, num(s.air));
  // Carve: speed × edge load, gone quickly in the air, muffled in deep snow, dropped on rails.
  const carve = g * smoothstep(0.8, 16, v) * (0.22 + 0.78 * edge) * (1 - 0.55 * powder) * (grinding ? 0.15 : 1);
  return {
    // Wind rises with speed (low buffet first, then the rush, then the whistle); in the air,
    // where nothing masks it, it is louder and brighter.
    windLow: K.windLow * (0.08 + 0.92 * Math.pow(sp, 1.3)) * (0.2 + 0.8 * moving) * (1 + 0.2 * airAmt),
    windLowF: 200 + 700 * sp + 250 * airAmt,
    windMid: K.windMid * Math.pow(sp, 1.8) * moving * (1 + 0.45 * airAmt),
    windMidF: 600 + 2000 * sp + 500 * airAmt,
    whistle: K.whistle * smoothstep(0.3, 0.95, sp) * (1 + 0.6 * airAmt),
    whistleF: 520 + 1100 * sp + 120 * airAmt,
    flutter: K.flutter * (0.3 + sp + 0.4 * airAmt),
    ski: board ? 0 : K.ski * carve,
    board: board ? K.board * carve : 0,
    tauCarve: g ? 0.06 : 0.025,
    grainRate: 0.72 + 0.56 * clamp(v / 26, 0, 1), // ≈ 22–38 Hz crunch
    skiHP: Math.max(500, 1300 + 900 * edge - 600 * powder),
    skiPk: 3600 + 2000 * edge,
    skiPkDb: 3 + 5 * edge,
    boardPk: 800 + 600 * edge,
    boardLP: 3600 + 2000 * edge,
    // Skid: broadband rasp on sideways slip (board stops are bigger and lower).
    skid: g * Math.pow(skid, 1.2) * smoothstep(0.5, 9, v) * (board ? 1.2 : 1) * K.skid,
    tauSkid: g ? 0.05 : 0.025,
    skidF: board ? 700 + 25 * v : 1100 + 35 * v,
    skidRate: 0.85 + 0.3 * clamp(v / 20, 0, 1),
    // Powder: a soft whoosh in deep snow.
    powder: g * powder * smoothstep(0.8, 12, v) * K.powder,
    tauPowder: g ? 0.08 : 0.03,
    powderF: Math.min(1600, 350 + 40 * v),
    // Grind: metallic ring + scrape while on a rail.
    grind: grinding ? K.grind * (0.35 + 0.65 * smoothstep(0.5, 10, v)) : 0,
    tauGrind: grinding ? 0.015 : 0.06,
  };
}

export function createLoops(E) {
  const last = new WeakMap();
  const st = {
    lift: false,
    amb: false,
    ambWant: false,
    heart: false,
    hbNext: 0,
    hbCount: 0,
    hbVoices: [],
    music: "off",
    musicWant: "off",
    nextGust: 0,
    nextRaven: 0,
    nextSheave: 0,
  };
  let M = null; // motion rig
  let LF = null; // lift rig
  let A = null; // ambience rig
  let MU = null; // music rig

  /** Steers a param smoothly; skips changes too small to matter so per-frame calls stay cheap. */
  function aim(param, v, tau, now) {
    const prev = last.get(param);
    if (prev !== undefined && Math.abs(prev - v) <= Math.max(1e-5, Math.abs(v) * 0.004)) return;
    last.set(param, v);
    param.setTargetAtTime(v, now, tau);
  }

  // Node factories (lowpass/highpass Q is in dB in WebAudio; bandpass/peaking Q is linear).
  const gainNode = (v = 0) => {
    const g = E.ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const filter = (type, f, q, db) => {
    const b = E.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    if (q != null) b.Q.value = q;
    if (db != null) b.gain.value = db;
    return b;
  };
  const chain = (...ns) => {
    for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]);
    return ns[0];
  };

  /** A looping-buffer layer whose source only exists while it is (about to be) audible. */
  const layer = (input, bufName, rate = 1) => ({ input, bufName, rate, src: null, quietSince: 0 });

  function keep(L, audible, now, hold = 2.5) {
    if (audible) {
      L.quietSince = 0;
      if (L.src) return;
      const b = E.buf(L.bufName);
      if (!b) return;
      const s = E.ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = L.rate;
      s.connect(L.input);
      s.start(now + 0.005, E.rand() * b.duration * 0.95);
      L.src = s;
    } else if (L.src) {
      if (!L.quietSince) L.quietSince = now;
      else if (now - L.quietSince > hold) stopLayer(L);
    }
  }

  function stopLayer(L) {
    const s = L.src;
    L.src = null;
    L.quietSince = 0;
    if (!s) return;
    try {
      s.stop();
    } catch (e) {
      /* never started */
    }
    try {
      s.disconnect();
    } catch (e) {
      /* already */
    }
  }

  // ───────────────────────────── motion ─────────────────────────────

  function buildMotion() {
    const out = E.bus.motion;
    const R = {};
    // Wind: two noise beds (low buffet + mid rush) and a resonant whistle, buffeted by a flutter signal.
    R.windIn = gainNode(1);
    R.windLowF = filter("lowpass", 300, -3);
    R.windLowG = gainNode(0);
    R.windMidF = filter("bandpass", 900, 0.6);
    R.windMidG = gainNode(0);
    R.whistleF = filter("bandpass", 700, 14);
    R.whistleG = gainNode(0);
    R.windSum = gainNode(1);
    chain(R.windIn, R.windLowF, R.windLowG, R.windSum);
    chain(R.windIn, R.windMidF, R.windMidG, R.windSum);
    chain(R.windIn, R.whistleF, R.whistleG, R.windSum);
    R.windSum.connect(out);
    R.flutIn = gainNode(1);
    R.flutterDepth = gainNode(0.1);
    R.whistleFM = gainNode(25);
    chain(R.flutIn, R.flutterDepth);
    R.flutterDepth.connect(R.windSum.gain); // AM: windSum gain = 1 + depth·flutter
    R.flutIn.connect(R.whistleFM);
    R.whistleFM.connect(R.whistleF.frequency); // the whistle wavers with the gusts
    // Ski carve: bright crunchy hiss.
    R.skiIn = gainNode(1);
    R.skiHP = filter("highpass", 1500, -3);
    R.skiPk = filter("peaking", 3800, 0.9, 5);
    R.skiLP = filter("lowpass", 10000, -3);
    R.skiG = gainNode(0);
    chain(R.skiIn, R.skiHP, R.skiPk, R.skiLP, R.skiG, out);
    // Board carve: lower, rougher scrape.
    R.boardIn = gainNode(1);
    R.boardHP = filter("highpass", 160, -3);
    R.boardPk = filter("peaking", 900, 0.8, 6);
    R.boardLP = filter("lowpass", 4200, -3);
    R.boardG = gainNode(0);
    chain(R.boardIn, R.boardHP, R.boardPk, R.boardLP, R.boardG, out);
    // Skid / hockey-stop rasp.
    R.skidIn = gainNode(1);
    R.skidBP = filter("bandpass", 1200, 0.75);
    R.skidHS = filter("highshelf", 3000, null, 4);
    R.skidG = gainNode(0);
    chain(R.skidIn, R.skidBP, R.skidHS, R.skidG, out);
    // Powder: soft low whoosh.
    R.powderIn = gainNode(1);
    R.powderLP = filter("lowpass", 600, -3);
    R.powderG = gainNode(0);
    chain(R.powderIn, R.powderLP, R.powderG, out);
    // Rail grind: rasp exciting three narrow resonators (metallic ring) + a scrape band.
    R.grindIn = gainNode(1);
    R.ringG = gainNode(K.ring);
    R.scrapeG = gainNode(K.scrape);
    R.grindG = gainNode(0);
    for (const [f, q] of [[1870, 35], [2790, 35], [4210, 30]]) chain(R.grindIn, filter("bandpass", f, q), R.ringG);
    chain(R.grindIn, filter("bandpass", 2600, 1.4), R.scrapeG);
    R.ringG.connect(R.grindG);
    R.scrapeG.connect(R.grindG);
    R.grindG.connect(out);

    R.wind = layer(R.windIn, "loop/pink");
    R.flutter = layer(R.flutIn, "loop/flutter");
    R.ski = layer(R.skiIn, "loop/crunchSki");
    R.board = layer(R.boardIn, "loop/crunchBoard");
    R.skid = layer(R.skidIn, "loop/rasp");
    R.powder = layer(R.powderIn, "loop/pink", 0.55);
    R.grind = layer(R.grindIn, "loop/rasp", 1.35);
    R.layers = [R.wind, R.flutter, R.ski, R.board, R.skid, R.powder, R.grind];
    M = R;
    return R;
  }

  /** Per frame while riding. s = { speed, grounded, edge, skid, kind, air, powder, grinding }. */
  function motion(s, dt) {
    if (!E.ctx || !s) return;
    const R = M || buildMotion();
    const now = E.ctx.currentTime;
    const T = motionTargets(s);
    aim(R.windLowG.gain, T.windLow, 0.12, now);
    aim(R.windLowF.frequency, T.windLowF, 0.2, now);
    aim(R.windMidG.gain, T.windMid, 0.12, now);
    aim(R.windMidF.frequency, T.windMidF, 0.2, now);
    aim(R.whistleG.gain, T.whistle, 0.15, now);
    aim(R.whistleF.frequency, T.whistleF, 0.25, now);
    aim(R.whistleFM.gain, T.whistleF * 0.05, 0.25, now);
    aim(R.flutterDepth.gain, T.flutter, 0.3, now);
    keep(R.wind, true, now);
    keep(R.flutter, true, now);

    aim(R.skiG.gain, T.ski, T.tauCarve, now);
    aim(R.boardG.gain, T.board, T.tauCarve, now);
    if (T.ski > 0) {
      aim(R.skiHP.frequency, T.skiHP, 0.1, now);
      aim(R.skiPk.frequency, T.skiPk, 0.1, now);
      aim(R.skiPk.gain, T.skiPkDb, 0.1, now);
    }
    if (T.board > 0) {
      aim(R.boardPk.frequency, T.boardPk, 0.1, now);
      aim(R.boardLP.frequency, T.boardLP, 0.1, now);
    }
    keep(R.ski, T.ski > 1e-4, now);
    keep(R.board, T.board > 1e-4, now);
    if (R.ski.src) aim(R.ski.src.playbackRate, T.grainRate, 0.1, now);
    if (R.board.src) aim(R.board.src.playbackRate, T.grainRate * 0.9, 0.1, now);

    aim(R.skidG.gain, T.skid, T.tauSkid, now);
    aim(R.skidBP.frequency, T.skidF, 0.1, now);
    keep(R.skid, T.skid > 1e-4, now);
    if (R.skid.src) aim(R.skid.src.playbackRate, T.skidRate, 0.1, now);

    aim(R.powderG.gain, T.powder, T.tauPowder, now);
    aim(R.powderLP.frequency, T.powderF, 0.15, now);
    keep(R.powder, T.powder > 1e-4, now);

    aim(R.grindG.gain, T.grind, T.tauGrind, now);
    keep(R.grind, T.grind > 1e-4, now);
  }

  function silenceMotion() {
    if (!E.ctx || !M) return;
    const now = E.ctx.currentTime;
    for (const gn of [M.windLowG, M.windMidG, M.whistleG]) aim(gn.gain, 0, 0.15, now);
    for (const gn of [M.skiG, M.boardG, M.skidG, M.powderG, M.grindG]) aim(gn.gain, 0, 0.06, now);
  }

  /** Stops sources of silent motion layers (motion() may stop being called at all). */
  function motionIdle(now) {
    if (!M) return;
    const targets = [
      [M.wind, Math.max(last.get(M.windLowG.gain) ?? 0, last.get(M.windMidG.gain) ?? 0, last.get(M.whistleG.gain) ?? 0)],
      [M.ski, last.get(M.skiG.gain) ?? 0],
      [M.board, last.get(M.boardG.gain) ?? 0],
      [M.skid, last.get(M.skidG.gain) ?? 0],
      [M.powder, last.get(M.powderG.gain) ?? 0],
      [M.grind, last.get(M.grindG.gain) ?? 0],
    ];
    for (const [L, t] of targets) if (!(t > 1e-4)) keep(L, false, now);
    if (!M.wind.src) keep(M.flutter, false, now, 0);
  }

  // ───────────────────────────── chairlift ─────────────────────────────

  function buildLift() {
    const R = { oscs: [], quietSince: 0 };
    R.level = gainNode(0);
    R.level.connect(E.bus.ambience);
    R.humLP = filter("lowpass", 380, -3);
    R.humG = gainNode(K.hum);
    chain(R.humLP, R.humG, R.level);
    R.rumbleIn = gainNode(1);
    chain(R.rumbleIn, filter("bandpass", 110, 0.9), gainNode(K.rumble), R.level);
    R.singIn = gainNode(1);
    chain(R.singIn, filter("bandpass", 640, 25), gainNode(K.sing), R.level);
    R.rumble = layer(R.rumbleIn, "loop/pink", 0.35);
    R.sing = layer(R.singIn, "loop/pink", 1);
    LF = R;
    return R;
  }

  function liftHum(on) {
    on = !!on;
    if (!E.ctx || on === st.lift) return;
    st.lift = on;
    const R = LF || buildLift();
    const now = E.ctx.currentTime;
    R.level.gain.cancelScheduledValues(now);
    R.level.gain.setTargetAtTime(on ? 1 : 0, now, on ? 0.5 : 0.35);
    if (on) {
      R.quietSince = 0;
      if (!R.oscs.length) {
        // Drive motor hum: 50 Hz + harmonics, low-passed.
        for (const [f, type, a] of [[50, "sine", 0.5], [100, "sine", 0.35], [150, "triangle", 0.12]]) {
          const o = E.ctx.createOscillator();
          o.type = type;
          o.frequency.value = f;
          const g = gainNode(a);
          o.connect(g);
          g.connect(R.humLP);
          o.start(now + 0.01);
          R.oscs.push(o, g);
        }
      }
      st.nextSheave = now + 1.2 + 2 * E.rand();
    }
  }

  function liftTick(now) {
    if (!LF) return;
    keep(LF.rumble, st.lift, now, 3);
    keep(LF.sing, st.lift, now, 3);
    if (st.lift) {
      LF.quietSince = 0;
      if (now + 0.3 > st.nextSheave) {
        const T = Math.max(now + LOOK, st.nextSheave);
        const b = E.buf("amb/sheave/0");
        const v = b && E.voice({ cat: "ambience", prio: 0.3, t0: T, dur: b.duration, level: dbToGain(K.sheaveDb), pan: (E.rand() - 0.5) * 0.4, send: 0.12, group: "sheave", groupMax: 1 });
        if (v) {
          v.play(b, T, { rate: E.jitter(0.04) });
          v.commit();
        }
        st.nextSheave = T + 4.5 + 2.5 * E.rand();
      }
    } else if (LF.oscs.length) {
      if (!LF.quietSince) LF.quietSince = now;
      else if (now - LF.quietSince > 3) {
        for (const n of LF.oscs) {
          try {
            if (n.stop) n.stop();
            n.disconnect();
          } catch (e) {
            /* already */
          }
        }
        LF.oscs = [];
      }
    }
  }

  // ───────────────────────────── ambience ─────────────────────────────

  function buildAmb() {
    const R = {};
    R.level = gainNode(0);
    R.level.connect(E.bus.ambience);
    R.bedIn = gainNode(1);
    R.bedLP = filter("lowpass", 450, -3);
    R.bedG = gainNode(K.bed);
    chain(R.bedIn, R.bedLP, R.bedG, R.level);
    R.airIn = gainNode(1);
    R.airG = gainNode(K.air);
    chain(R.airIn, filter("highpass", 4200, -3), R.airG, R.level);
    R.bed = layer(R.bedIn, "loop/pink", 0.6);
    R.air = layer(R.airIn, "loop/pink", 1);
    A = R;
    return R;
  }

  function ambience(on) {
    on = !!on;
    st.ambWant = on;
    if (!E.ctx || on === st.amb) return;
    st.amb = on;
    const R = A || buildAmb();
    const now = E.ctx.currentTime;
    R.level.gain.cancelScheduledValues(now);
    R.level.gain.setTargetAtTime(on ? 1 : 0, now, on ? 1.2 : 0.7);
    if (on) {
      st.nextGust = now + 0.3;
      st.nextRaven = now + 8 + 14 * E.rand();
    }
  }

  function ambTick(now) {
    if (!A) return;
    keep(A.bed, st.amb, now, 5);
    keep(A.air, st.amb, now, 5);
    if (!st.amb) return;
    if (now + 0.5 > st.nextGust) {
      // A gust: swell up over rise, hold, fall away; the low-pass opens with it.
      const T = Math.max(now + 0.05, st.nextGust);
      const r = E.rand();
      const rise = 1.2 + 2 * E.rand();
      const hold = 0.3 + 1.2 * E.rand();
      const fall = 2 + 3 * E.rand();
      A.bedG.gain.setTargetAtTime(K.bed * (1.6 + 1.6 * r), T, rise / 3);
      A.bedG.gain.setTargetAtTime(K.bed, T + rise + hold, fall / 3);
      A.bedLP.frequency.setTargetAtTime(500 + 900 * r, T, rise / 3);
      A.bedLP.frequency.setTargetAtTime(420, T + rise + hold, fall / 3);
      A.airG.gain.setTargetAtTime(K.air * (1 + 2 * r), T, rise / 3);
      A.airG.gain.setTargetAtTime(K.air, T + rise + hold, fall / 3);
      st.nextGust = T + rise + hold + fall * (0.5 + 0.6 * E.rand());
    }
    if (now > st.nextRaven) {
      st.nextRaven = now + 25 + 45 * E.rand();
      const T = now + LOOK;
      const b = E.buf(`amb/raven/${E.pick(3)}`);
      const v = b && E.voice({ cat: "ambience", prio: 0.05, t0: T, dur: b.duration, level: dbToGain(K.ravenDb), pan: (E.rand() * 2 - 1) * 0.85, send: 0.9, group: "raven", groupMax: 1 });
      if (v) {
        v.play(b, T, { rate: E.jitter(0.04) });
        v.commit();
      }
    }
  }

  // ───────────────────────────── music ─────────────────────────────

  function buildMusic() {
    const R = { chords: new Set(), pulses: new Set(), padRun: false, padStopAt: 0, pulseRun: false, pulseStopAt: 0, ci: 0, pi: 0, nextChord: 0, nextPulse: 0, lfo: null };
    R.padLayer = gainNode(0);
    R.padLayer.connect(E.bus.music);
    R.padLP = filter("lowpass", 1000, 1);
    R.padLP.connect(R.padLayer);
    R.pulseLayer = gainNode(0);
    R.pulseLayer.connect(E.bus.music);
    R.pulseLP = filter("lowpass", 320, -1);
    R.pulseLP.connect(R.pulseLayer);
    MU = R;
    return R;
  }

  /** One pad chord at T: detuned saws spread L/R + a triangle bass, slow linear swell, long release. */
  function chord(T, c) {
    const ctx = E.ctx;
    const nodes = [];
    const env = gainNode(0.0001);
    env.gain.setValueAtTime(0.0001, T);
    env.gain.linearRampToValueAtTime(1, T + CHORD_ATT);
    env.gain.setValueAtTime(1, T + CHORD_LEN);
    env.gain.setTargetAtTime(0.0001, T + CHORD_LEN, CHORD_REL / 7);
    env.connect(MU.padLP);
    nodes.push(env);
    const sides = [-0.55, 0.55].map((p) => {
      const g = gainNode(K.padOsc);
      nodes.push(g);
      if (!E.canPan) {
        g.connect(env);
        return g;
      }
      const sp = ctx.createStereoPanner();
      sp.pan.value = p;
      g.connect(sp);
      sp.connect(env);
      nodes.push(sp);
      return g;
    });
    const oscs = [];
    c.notes.forEach((f, i) => {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = det + (E.rand() - 0.5) * 4;
        o.connect(sides[(i + (det > 0 ? 1 : 0)) % 2]);
        oscs.push(o);
      }
    });
    const b = ctx.createOscillator();
    b.type = "triangle";
    b.frequency.value = c.bass;
    const bg = gainNode(K.padBass);
    b.connect(bg);
    bg.connect(env);
    oscs.push(b);
    nodes.push(bg);
    const end = T + CHORD_LEN + CHORD_REL;
    for (const o of oscs) {
      o.start(T);
      o.stop(end);
      nodes.push(o);
    }
    const rec = { nodes, end };
    const done = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch (e) {
          /* already */
        }
      }
      MU.chords.delete(rec);
    };
    rec.done = done;
    oscs[0].onended = done;
    MU.chords.add(rec);
  }

  /** A faint low pulse note (match mode). */
  function pulse(T, f) {
    const o = E.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const g = gainNode(0.0001);
    g.gain.setValueAtTime(0.0001, T);
    g.gain.exponentialRampToValueAtTime(1, T + 0.012);
    g.gain.setTargetAtTime(0.0001, T + 0.012, 0.1);
    o.connect(g);
    g.connect(MU.pulseLP);
    o.start(T);
    o.stop(T + 0.8);
    const rec = { end: T + 0.8 };
    rec.done = () => {
      try {
        o.disconnect();
        g.disconnect();
      } catch (e) {
        /* already */
      }
      MU.pulses.delete(rec);
    };
    o.onended = rec.done;
    MU.pulses.add(rec);
  }

  function startPad(R, T) {
    R.padStopAt = 0;
    if (R.padRun) return;
    R.padRun = true;
    R.nextChord = T;
    if (!R.lfo) {
      // The pad's low-pass breathes slowly (±380 Hz around 1 kHz, ~22 s period).
      const o = E.ctx.createOscillator();
      o.frequency.value = 0.045;
      const g = gainNode(380);
      o.connect(g);
      g.connect(R.padLP.frequency);
      o.start(T);
      R.lfo = { o, g };
    }
  }

  function startPulse(R, T) {
    R.pulseStopAt = 0;
    if (R.pulseRun) return;
    R.pulseRun = true;
    R.nextPulse = T;
  }

  function fadeLayer(g, v, tau, at) {
    const now = E.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setTargetAtTime(v, Math.max(now, at ?? now), tau);
  }

  function music(mode) {
    const m = mode === "menu" || mode === "match" || mode === "results" ? mode : "off";
    st.musicWant = m;
    if (!E.ctx || m === st.music) return;
    st.music = m;
    const R = MU || buildMusic();
    const now = E.ctx.currentTime;
    if (m === "menu") {
      startPad(R, now + 0.05);
      fadeLayer(R.padLayer, 1, 1.2);
      fadeLayer(R.pulseLayer, 0, 0.8);
      R.pulseStopAt = now + 5;
    } else if (m === "match") {
      fadeLayer(R.padLayer, 0, 1);
      R.padStopAt = now + 6;
      startPulse(R, now + 0.3);
      fadeLayer(R.pulseLayer, 1, 1.2);
    } else if (m === "results") {
      const b = E.buf("mus/results");
      const T = now + LOOK;
      const v = b && E.voice({ cat: "music", prio: 2, t0: T, dur: b.duration, level: dbToGain(-14), protect: true });
      if (v) {
        v.play(b, T);
        v.commit();
      }
      startPad(R, now + 1.6);
      fadeLayer(R.padLayer, 1, 1.5, now + 1.4);
      fadeLayer(R.pulseLayer, 0, 0.5);
      R.pulseStopAt = now + 4;
    } else {
      fadeLayer(R.padLayer, 0, 0.8);
      fadeLayer(R.pulseLayer, 0, 0.8);
      R.padStopAt = now + 6;
      R.pulseStopAt = now + 6;
    }
  }

  function musicTick(now) {
    const R = MU;
    if (!R) return;
    if (R.padRun) {
      if (R.nextChord < now - 1) R.nextChord = now + 0.05; // the tab stalled: resume, don't burst
      while (R.nextChord < now + 1) {
        chord(R.nextChord, PAD_CHORDS[R.ci++ % PAD_CHORDS.length]);
        R.nextChord += CHORD_LEN;
      }
      if (R.padStopAt && now > R.padStopAt) {
        R.padRun = false;
        R.padStopAt = 0;
      }
    }
    if (R.pulseRun) {
      if (R.nextPulse < now - 1) R.nextPulse = now + 0.05;
      while (R.nextPulse < now + 0.3) {
        const root = PAD_CHORDS[Math.floor(R.pi / 8) % PAD_CHORDS.length].bass;
        pulse(R.nextPulse, R.pi % 8 === 7 ? root * 1.5 : root);
        R.pi++;
        R.nextPulse += PULSE_BEAT;
      }
      if (R.pulseStopAt && now > R.pulseStopAt) {
        R.pulseRun = false;
        R.pulseStopAt = 0;
      }
    }
    // Failsafe for lost onended events, and stop the LFO once the pad has fully gone.
    for (const set of [R.chords, R.pulses]) for (const rec of set) if (now > rec.end + 2) rec.done();
    if (!R.padRun && !R.chords.size && R.lfo) {
      try {
        R.lfo.o.stop();
        R.lfo.o.disconnect();
        R.lfo.g.disconnect();
      } catch (e) {
        /* already */
      }
      R.lfo = null;
    }
  }

  // ───────────────────────────── heartbeat ─────────────────────────────

  function heartbeat(on) {
    on = !!on;
    if (!E.ctx || on === st.heart) return;
    st.heart = on;
    const now = E.ctx.currentTime;
    if (on) {
      st.hbNext = now + 0.05;
      st.hbCount = 0;
    } else {
      for (const v of st.hbVoices) if (!v.dead && v.t0 > now + 0.01) v.kill(0.01);
      st.hbVoices.length = 0;
    }
    E.setLowHealth(on);
  }

  function heartTick(now) {
    if (!st.heart) return;
    if (st.hbNext < now) st.hbNext = now + LOOK;
    while (st.hbNext < now + 0.25) {
      const T = st.hbNext;
      const b = E.buf("pl/heart/0");
      const lvl = dbToGain(K.heartDb) * Math.min(1, 0.55 + 0.15 * st.hbCount++);
      const v = b && E.voice({ cat: "player", prio: 1, t0: T, dur: b.duration, level: lvl, protect: true, group: "heart", groupMax: 2 });
      if (v) {
        v.play(b, T, { rate: E.jitter(0.015) });
        v.commit();
        st.hbVoices.push(v);
      }
      st.hbNext += (60 / 70) * E.jitter(0.02);
    }
    for (let i = st.hbVoices.length - 1; i >= 0; i--) if (st.hbVoices[i].dead) st.hbVoices.splice(i, 1);
  }

  // ───────────────────────────── wiring ─────────────────────────────

  E.tickers.push((now) => {
    motionIdle(now);
    liftTick(now);
    ambTick(now);
    musicTick(now);
    heartTick(now);
  });

  /** After start(): honour music/ambience requested while the context did not exist yet. */
  function onStart() {
    if (st.ambWant) ambience(true);
    if (st.musicWant !== "off") music(st.musicWant);
  }

  function info() {
    const srcs = (R, names) => (R ? names.filter((k) => R[k] && R[k].src).length : 0);
    return {
      motionSources: srcs(M, ["wind", "flutter", "ski", "board", "skid", "powder", "grind"]),
      liftSources: (LF ? LF.oscs.length / 2 : 0) + srcs(LF, ["rumble", "sing"]),
      ambienceSources: srcs(A, ["bed", "air"]),
      chords: MU ? MU.chords.size : 0,
      pulses: MU ? MU.pulses.size : 0,
      music: st.music,
      ambience: st.amb,
      lift: st.lift,
      heartbeat: st.heart,
    };
  }

  return { motion, silenceMotion, liftHum, ambience, music, heartbeat, onStart, info };
}
