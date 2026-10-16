/**
 * Damped springs — the backbone of weapon/camera feel. Underdamped springs overshoot a little
 * and settle (recoil snap-back), critically damped ones glide (sway, settle). Substepped so any
 * frame rate integrates the same.
 */
export class Spring {
  constructor(stiffness = 120, damping = 2 * Math.sqrt(120)) {
    this.k = stiffness;
    this.c = damping;
    this.x = 0;
    this.v = 0;
    this.target = 0;
  }
  impulse(dv) {
    this.v += dv;
    return this;
  }
  set(x) {
    this.x = x;
    this.v = 0;
    return this;
  }
  step(dt) {
    if (dt <= 0) return this.x;
    const n = Math.min(16, Math.max(1, Math.ceil(dt / (1 / 240))));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Three independent springs sharing parameters. */
export class Spring3 {
  constructor(stiffness, damping) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
  }
  impulse(x, y, z) {
    this.x.impulse(x);
    this.y.impulse(y);
    this.z.impulse(z);
    return this;
  }
  target(x, y, z) {
    this.x.target = x;
    this.y.target = y;
    this.z.target = z;
    return this;
  }
  step(dt) {
    this.x.step(dt);
    this.y.step(dt);
    this.z.step(dt);
    return this;
  }
  reset() {
    for (const s of [this.x, this.y, this.z]) {
      s.x = 0;
      s.v = 0;
      s.target = 0;
    }
  }
}

/** Smootherstep easing 0..1. */
export const ease = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** 0..1 bump that rises over [a,b] and falls over [c,d]. */
export function window4(t, a, b, c, d) {
  if (t <= a || t >= d) return 0;
  if (t < b) return ease((t - a) / (b - a));
  if (t <= c) return 1;
  return 1 - ease((t - c) / (d - c));
}
