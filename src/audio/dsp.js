/**
 * Offline DSP toolkit for the sound bank.
 *
 * Pure functions that render into Float32Arrays (no WebAudio). sounds.js composes them into the
 * game's one-shot buffers, which are rendered once (in a worker when available, else in small
 * main-thread slices) and cached as AudioBuffers, so a gunshot in the live graph is 2–5
 * BufferSources instead of a dozen oscillators and filters.
 * Everything is deterministic: callers pass an rng made by makeRng() — never Math.random.
 *
 * Envelope specs (env arguments) are either a function of seconds, or a fast array form:
 *   [a, d]                  raised-cosine rise over a, exponential decay (time constant d)
 *   [a, d, a2, d2, w2]      (1 − w2)·AD(a, d) + w2·AD(a2, d2)   (two-stage decays)
 *   ["ahr", a, h, r]        raised-cosine rise, hold, raised-cosine fall to exactly 0
 * Array envelopes also bound the work: noise is only rendered until the envelope is < −100 dB.
 */

export const TAU = Math.PI * 2;

/**
 * 32-bit LCG (Numerical Recipes constants) with an xorshift-multiply output mix so the low bits
 * are usable too. Deterministic for a given seed. rand.noise() fills arrays with the same stream.
 */
export function makeRng(seed) {
  let s = seed >>> 0;
  function rand() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    let x = s ^ (s >>> 16);
    x = Math.imul(x, 0x45d9f3b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  /** Fills out[i0 … i0+n) with uniform noise in [−1, 1): the same stream as n calls to rand(). */
  rand.noise = (out, i0, n) => {
    let st = s;
    for (let i = 0; i < n; i++) {
      st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
      let x = st ^ (st >>> 16);
      x = Math.imul(x, 0x45d9f3b);
      x ^= x >>> 16;
      out[i0 + i] = (x >>> 0) * 4.656612873077393e-10 - 1;
    }
    s = st;
    return out;
  };
  return rand;
}

/** FNV-1a: a stable 32-bit seed from a sound name (so each asset renders the same in any order). */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A zeroed buffer `sec` seconds long. */
export const buf = (sr, sec) => new Float32Array(Math.max(1, Math.round(sec * sr)));

// ───────────────────────────── envelopes ─────────────────────────────

/** Raised-cosine rise over `a` s, then exponential decay with time constant `d` s. 0 for t ≤ 0. */
export function envAD(t, a, d) {
  if (t <= 0) return 0;
  if (t < a) return 0.5 - 0.5 * Math.cos((Math.PI * t) / a);
  return Math.exp(-(t - a) / d);
}

/** Raised-cosine rise over `a`, hold `h`, raised-cosine fall over `r` (exactly 0 afterwards). */
export function envAHR(t, a, h, r) {
  if (t <= 0) return 0;
  if (t < a) return 0.5 - 0.5 * Math.cos((Math.PI * t) / a);
  if (t < a + h) return 1;
  const u = t - a - h;
  return u < r ? 0.5 + 0.5 * Math.cos((Math.PI * u) / r) : 0;
}

/** Exponential glide from f0 toward f1 with time constant tau: a Hz-vs-seconds function. */
export const glide = (f0, f1, tau) => (t) => f1 + (f0 - f1) * Math.exp(-t / tau);

/** Constant-ratio sweep from f0 to f1 over `dur` seconds, then holds f1. */
export const sweep = (f0, f1, dur) => (t) => f0 * Math.pow(f1 / f0, Math.min(1, t / dur));

/** Seconds until an envelope spec is below −100 dB (Infinity for functions). */
export function envLen(env) {
  if (typeof env === "function") return Infinity;
  if (env[0] === "ahr") return env[1] + env[2] + env[3];
  if (env.length >= 5) return Math.max(env[0] + env[1] * 11.5, env[2] + env[3] * 11.5);
  return env[0] + env[1] * 11.5;
}

function addAD(out, n, sr, a, d, w) {
  const na = Math.min(n, Math.round(a * sr));
  const inv = Math.PI / Math.max(1, a * sr);
  for (let i = 0; i < na; i++) out[i] += w * (0.5 - 0.5 * Math.cos(i * inv));
  const k = Math.exp(-1 / (d * sr));
  let g = w;
  for (let i = na; i < n; i++) {
    out[i] += g;
    g *= k;
  }
}

/** Renders an envelope spec into a new Float32Array of n samples. */
export function envArray(n, sr, env) {
  const out = new Float32Array(n);
  if (typeof env === "function") {
    for (let i = 0; i < n; i++) out[i] = env(i / sr);
  } else if (env[0] === "ahr") {
    for (let i = 0; i < n; i++) out[i] = envAHR(i / sr, env[1], env[2], env[3]);
  } else if (env.length >= 5) {
    addAD(out, n, sr, env[0], env[1], 1 - env[4]);
    addAD(out, n, sr, env[2], env[3], env[4]);
  } else addAD(out, n, sr, env[0], env[1], 1);
  return out;
}

// ───────────────────────────── filters ─────────────────────────────

const SVF_MODES = new Set(["lp", "hp", "bp", "bpq"]);

/**
 * Zero-delay-feedback state-variable filter (Zavalishin), in place. Stable under fast modulation.
 * mode: "lp" | "hp" | "bp" (unity gain at the centre) | "bpq" (raw band output, gain = q).
 * `freq` is Hz or a function of seconds (evaluated every 32 samples at t + t0). q is linear.
 */
export function svf(x, sr, mode, freq, q = 0.707, t0 = 0) {
  const k = 1 / q;
  const n = x.length;
  const fn = typeof freq === "function" ? freq : null;
  const block = fn ? 32 : n;
  const nyq = sr * 0.45;
  const m = mode === "lp" ? 0 : mode === "hp" ? 1 : mode === "bp" ? 2 : 3;
  let ic1 = 0;
  let ic2 = 0;
  for (let b = 0; b < n; b += block) {
    let f = fn ? fn(Math.max(0, b / sr + t0)) : freq;
    f = f < 5 ? 5 : f > nyq ? nyq : f;
    const g = Math.tan((Math.PI * f) / sr);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const e = Math.min(n, b + block);
    if (m === 0) {
      for (let i = b; i < e; i++) {
        const v3 = x[i] - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        x[i] = v2;
      }
    } else if (m === 1) {
      for (let i = b; i < e; i++) {
        const v0 = x[i];
        const v3 = v0 - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        x[i] = v0 - k * v1 - v2;
      }
    } else {
      const s = m === 2 ? k : 1;
      for (let i = b; i < e; i++) {
        const v3 = x[i] - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        x[i] = s * v1;
      }
    }
  }
  return x;
}

/**
 * RBJ-cookbook biquad, in place. type: lowpass | highpass | bandpass | peaking | lowshelf |
 * highshelf. q is LINEAR here (note: WebAudio's lowpass/highpass Q is in dB).
 */
export function biquad(x, sr, type, f, q = 0.707, db = 0) {
  const w0 = (TAU * clamp(f, 5, sr * 0.45)) / sr;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const A = Math.pow(10, db / 40);
  const al = sn / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === "peaking") {
    b0 = 1 + al * A;
    b1 = -2 * cs;
    b2 = 1 - al * A;
    a0 = 1 + al / A;
    a1 = -2 * cs;
    a2 = 1 - al / A;
  } else if (type === "lowshelf" || type === "highshelf") {
    const sA = 2 * Math.sqrt(A) * al;
    if (type === "lowshelf") {
      b0 = A * (A + 1 - (A - 1) * cs + sA);
      b1 = 2 * A * (A - 1 - (A + 1) * cs);
      b2 = A * (A + 1 - (A - 1) * cs - sA);
      a0 = A + 1 + (A - 1) * cs + sA;
      a1 = -2 * (A - 1 + (A + 1) * cs);
      a2 = A + 1 + (A - 1) * cs - sA;
    } else {
      b0 = A * (A + 1 + (A - 1) * cs + sA);
      b1 = -2 * A * (A - 1 + (A + 1) * cs);
      b2 = A * (A + 1 + (A - 1) * cs - sA);
      a0 = A + 1 - (A - 1) * cs + sA;
      a1 = 2 * (A - 1 - (A + 1) * cs);
      a2 = A + 1 - (A - 1) * cs - sA;
    }
  } else if (type === "lowpass") {
    b1 = 1 - cs;
    b0 = b1 / 2;
    b2 = b0;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else if (type === "highpass") {
    b1 = -(1 + cs);
    b0 = (1 + cs) / 2;
    b2 = b0;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else if (type === "bandpass") {
    b0 = al;
    b1 = 0;
    b2 = -al;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else return x;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** One-pole DC blocker / gentle high-pass at fc Hz, in place. */
export function dcBlock(x, sr, fc = 20) {
  const R = Math.exp((-TAU * fc) / sr);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = v - x1 + R * y1;
    x1 = v;
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** Applies filter specs [mode, freq, q, db] (svf modes or biquad types), in place. */
export function applyFilters(x, sr, filters, t0 = 0) {
  for (const [mode, f, q, db] of filters) {
    if (SVF_MODES.has(mode)) svf(x, sr, mode, f, q ?? 0.707, t0);
    else biquad(x, sr, mode, f, q ?? 0.707, db ?? 0);
  }
  return x;
}

// ───────────────────────────── sources ─────────────────────────────

export function white(n, rand) {
  const b = new Float32Array(n);
  if (rand.noise) return rand.noise(b, 0, n);
  for (let i = 0; i < n; i++) b[i] = rand() * 2 - 1;
  return b;
}

/** Paul Kellet's refined pink-noise filter (≈ ±1 peak). */
export function pink(n, rand) {
  const b = white(n, rand);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = b[i];
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    b[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return b;
}

function polyblep(t, dt) {
  if (t < dt) {
    const u = t / dt;
    return u + u - u * u - 1;
  }
  if (t > 1 - dt) {
    const u = (t - 1) / dt;
    return u * u + u + u + 1;
  }
  return 0;
}

/**
 * Adds an oscillator at `at` s for (at most) `dur` s. freq: Hz or fn(t); env: envelope spec.
 * shape: sine | tri | saw (PolyBLEP, band-limited) | square (PolyBLEP).
 */
export function addTone(x, sr, at, dur, freq, env, gain = 1, shape = "sine") {
  const i0 = Math.round(at * sr);
  const n = Math.min(x.length - i0, Math.round(Math.min(dur, envLen(env)) * sr));
  if (n <= 0) return x;
  const e = envArray(n, sr, env);
  const ff = typeof freq === "function" ? freq : null;
  if (!ff && shape === "sine") {
    // Constant-frequency sine by rotation (no per-sample trig).
    const w = (TAU * freq) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = 1;
    let s = 0;
    for (let i = 0; i < n; i++) {
      x[i0 + i] += s * e[i] * gain;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
    }
    return x;
  }
  // Per-sample phase increment (from a function, or constant).
  const inc = new Float32Array(n);
  if (ff) for (let i = 0; i < n; i++) inc[i] = ff(i / sr) / sr;
  else inc.fill(freq / sr);
  let ph = 0;
  if (shape === "sine") {
    for (let i = 0; i < n; i++) {
      x[i0 + i] += Math.sin(TAU * ph) * e[i] * gain;
      ph += inc[i];
      if (ph >= 1) ph -= 1;
    }
  } else if (shape === "tri") {
    for (let i = 0; i < n; i++) {
      const v = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
      x[i0 + i] += v * e[i] * gain;
      ph += inc[i];
      if (ph >= 1) ph -= 1;
    }
  } else if (shape === "saw") {
    for (let i = 0; i < n; i++) {
      const dt = inc[i];
      let v = 2 * ph - 1;
      if (ph < dt) {
        const u = ph / dt;
        v -= u + u - u * u - 1;
      } else if (ph > 1 - dt) {
        const u = (ph - 1) / dt;
        v -= u * u + u + u + 1;
      }
      x[i0 + i] += v * e[i] * gain;
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const dt = inc[i];
      let p2 = ph + 0.5;
      if (p2 >= 1) p2 -= 1;
      const v = (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep(p2, dt);
      x[i0 + i] += v * e[i] * gain;
      ph += dt;
      if (ph >= 1) ph -= 1;
    }
  }
  return x;
}

/**
 * Struck-object partials (modal synthesis): modes = [[freqHz, decayTau, amp], ...]. Each partial
 * starts at phase 0 with a raised-cosine onset of `attack` s, so the buffer never steps.
 */
export function addModes(x, sr, at, modes, attack = 0.0004, gain = 1) {
  const i0 = Math.round(at * sr);
  const na = Math.max(1, Math.round(attack * sr));
  for (const [f, tau, a] of modes) {
    if (!(f > 0) || f >= sr * 0.45 || !(a > 0)) continue;
    const w = (TAU * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const dec = Math.exp(-1 / (tau * sr));
    const n = Math.min(x.length - i0, Math.ceil(tau * 9.5 * sr) + na);
    let c = 1;
    let s = 0;
    let g = a * gain;
    for (let i = 0; i < n; i++) {
      const rise = i < na ? 0.5 - 0.5 * Math.cos((Math.PI * i) / na) : 1;
      x[i0 + i] += s * g * rise;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
      g *= dec;
    }
  }
  return x;
}

/**
 * Supersonic N-wave (bullet crack): a ~50 µs rise to +1, linear fall to −1 over T, ~50 µs return
 * to 0. Zero net area, so no DC.
 */
export function addNWave(x, sr, at, T, amp = 1, rise = 0.00005) {
  const i0 = Math.round(at * sr);
  const n = Math.min(x.length - i0, Math.ceil((T + 2 * rise) * sr) + 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if (t < rise) v = 0.5 - 0.5 * Math.cos((Math.PI * t) / rise);
    else if (t < rise + T) v = 1 - (2 * (t - rise)) / T;
    else if (t < 2 * rise + T) v = -(0.5 + 0.5 * Math.cos((Math.PI * (t - rise - T)) / rise));
    x[i0 + i] += v * amp;
  }
  return x;
}

/**
 * Friedlander blast wave p(t) = (1 − t/T)·e^(−t/T): the muzzle-blast pressure pulse (positive
 * phase T, longer negative phase, zero net area), with a ~60 µs smoothed onset.
 */
export function addFriedlander(x, sr, at, T, amp = 1, rise = 0.00006) {
  const i0 = Math.round(at * sr);
  const nr = Math.max(1, Math.round(rise * sr));
  const n = Math.min(x.length - i0, Math.ceil(T * 12 * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const r = i < nr ? 0.5 - 0.5 * Math.cos((Math.PI * i) / nr) : 1;
    x[i0 + i] += amp * r * (1 - t / T) * Math.exp(-t / T);
  }
  return x;
}

/**
 * Adds filtered white noise shaped by `env` at `at` s for up to `len` s. The noise is filtered
 * with a 20 ms pre-roll (so low cut-offs have settled) BEFORE the envelope, keeping attacks crisp.
 * `grain` (optional Float32Array covering `len`) multiplies the result (crunch / stick-slip).
 */
export function addNoise(x, sr, rand, at, len, env, filters = [], gain = 1, grain = null) {
  const i0 = Math.round(at * sr);
  const n = Math.min(x.length - i0, Math.round(Math.min(len, envLen(env)) * sr), grain ? grain.length : Infinity);
  if (n <= 0) return x;
  const pre = Math.round(0.02 * sr);
  const tmp = white(n + pre, rand);
  applyFilters(tmp, sr, filters, -pre / sr);
  const e = envArray(n, sr, env);
  if (grain) for (let i = 0; i < n; i++) x[i0 + i] += tmp[pre + i] * e[i] * gain * grain[i];
  else for (let i = 0; i < n; i++) x[i0 + i] += tmp[pre + i] * e[i] * gain;
  return x;
}

/**
 * Amplitude envelope of random grains (snow crunch, stick-slip, crackle): about `rate` grains per
 * second, each a fast rise + exponential decay, on top of a constant `floor`.
 */
export function grainEnv(n, sr, rand, rate, o = {}) {
  const { jitter = 0.35, attack = 0.0006, decay = 0.008, min = 0.3, floor = 0.25 } = o;
  const env = new Float32Array(n).fill(floor);
  const dur = n / sr;
  const na = Math.max(1, Math.round(attack * sr));
  let t = rand() / rate;
  while (t < dur) {
    const a = min + (1 - min) * rand();
    const d = decay * (0.6 + 0.8 * rand());
    const s = Math.round(t * sr);
    const len = Math.min(n - s, na + Math.ceil(d * 7 * sr));
    const k = Math.exp(-1 / (d * sr));
    let g = a;
    for (let i = 0; i < len; i++) {
      if (i < na) env[s + i] += a * (0.5 - 0.5 * Math.cos((Math.PI * i) / na));
      else {
        env[s + i] += g;
        g *= k;
      }
    }
    t += (1 + (rand() * 2 - 1) * jitter) / rate;
  }
  return env;
}

// ───────────────────────────── utilities ─────────────────────────────

const chans = (b) => (Array.isArray(b) ? b : [b]);

export function peakOf(b) {
  let p = 0;
  for (const c of chans(b)) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i] < 0 ? -c[i] : c[i];
      if (a > p) p = a;
    }
  }
  return p;
}

export function rmsOf(b) {
  let e = 0;
  let n = 0;
  for (const c of chans(b)) {
    for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    n += c.length;
  }
  return Math.sqrt(e / Math.max(1, n));
}

/** Scales one buffer (or a stereo pair, jointly) so its peak is `target`. */
export function normalize(b, target = 1) {
  const p = peakOf(b);
  if (p > 0) {
    const g = target / p;
    for (const c of chans(b)) for (let i = 0; i < c.length; i++) c[i] *= g;
  }
  return b;
}

/** tanh soft saturation (expects a normalized input; keeps ±1 at ±1). */
export function saturate(x, drive) {
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) * k;
  return x;
}

export function fadeIn(x, sr, sec) {
  const n = Math.min(x.length, Math.round(sec * sr));
  for (let i = 0; i < n; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return x;
}

/** Raised-cosine fade over the last `sec` s; the final sample is exactly 0 (no end click). */
export function fadeOut(x, sr, sec = 0.005) {
  const n = Math.min(x.length, Math.max(2, Math.round(sec * sr)));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return x;
}

/** dst[at…] += src·gain */
export function mixInto(dst, src, sr, at = 0, gain = 1) {
  const i0 = Math.round(at * sr);
  const n = Math.min(src.length, dst.length - i0);
  for (let i = 0; i < n; i++) dst[i0 + i] += src[i] * gain;
  return dst;
}

/**
 * Seamless loop of length n from x (length n + crossfade): the extra tail is equal-power
 * crossfaded into the head, so the wrap point continues the original signal exactly.
 */
export function loopify(x, n) {
  const xf = x.length - n;
  const out = x.slice(0, n);
  for (let i = 0; i < xf; i++) {
    const w = (i / xf) * (Math.PI / 2);
    out[i] = x[i] * Math.sin(w) + x[n + i] * Math.cos(w);
  }
  return out;
}

/** Final hygiene for a one-shot: optional DC/low cut, an end fade to exactly 0, peak = 1. */
export function finish(b, sr, { hp = 0, fade = 0.006 } = {}) {
  for (const c of chans(b)) {
    if (hp > 0) dcBlock(c, sr, hp);
    fadeOut(c, sr, fade);
    c[0] = 0;
  }
  return normalize(b);
}
