/**
 * Weapons: stats and the per-step trigger/reload/spread/recoil logic shared by the player and
 * bots. Firing produces shot events (origin + pellet directions); combat.js resolves them.
 * All randomness comes from the rng passed in (deterministic runs).
 */
import { clamp, damp } from "../core/noise.js";

export const WEAPONS = {
  ar: {
    id: "ar",
    name: "RIDGELINE AR",
    kind: "Assault Rifle",
    model: "gun-ar",
    rpm: 760,
    auto: true,
    damage: [30, 21],
    range: [40, 120],
    headMul: 1.6,
    mag: 30,
    reserve: 120,
    reload: 2.1,
    pellets: 1,
    spreadHip: 0.032,
    spreadAds: 0.0035,
    bloom: 0.006,
    recoil: [0.0105, 0.0045],
    zoom: 1.45,
    adsTime: 0.2,
    sound: "rifle",
    tracerEvery: 2,
  },
  smg: {
    id: "smg",
    name: "POWDER SMG",
    kind: "Submachine Gun",
    model: "gun-smg",
    rpm: 940,
    auto: true,
    damage: [26, 15],
    range: [18, 60],
    headMul: 1.4,
    mag: 32,
    reserve: 160,
    reload: 1.7,
    pellets: 1,
    spreadHip: 0.024,
    spreadAds: 0.0065,
    bloom: 0.004,
    recoil: [0.008, 0.0065],
    zoom: 1.25,
    adsTime: 0.14,
    sound: "smg",
    tracerEvery: 3,
  },
  shotgun: {
    id: "shotgun",
    name: "AVALANCHE 12",
    kind: "Shotgun",
    model: "gun-shotgun",
    rpm: 72,
    auto: false,
    damage: [21, 5],
    range: [9, 32],
    headMul: 1.2,
    mag: 6,
    reserve: 30,
    reload: 0.55, // per shell
    perShell: true,
    pellets: 9,
    spreadHip: 0.065,
    spreadAds: 0.048,
    bloom: 0,
    recoil: [0.05, 0.012],
    zoom: 1.15,
    adsTime: 0.2,
    sound: "shotgun",
    tracerEvery: 1,
  },
  sniper: {
    id: "sniper",
    name: "SUMMIT .338",
    kind: "Sniper Rifle",
    model: "gun-sniper",
    rpm: 48,
    auto: false,
    damage: [105, 92],
    range: [80, 400],
    headMul: 2.2,
    mag: 5,
    reserve: 25,
    reload: 2.9,
    pellets: 1,
    spreadHip: 0.07,
    spreadAds: 0.00025,
    bloom: 0,
    recoil: [0.06, 0.01],
    zoom: 4.2,
    scope: true,
    adsTime: 0.32,
    sound: "sniper",
    tracerEvery: 1,
  },
  pistol: {
    id: "pistol",
    name: "SIDEARM 9",
    kind: "Pistol",
    model: "gun-pistol",
    rpm: 420,
    auto: false,
    damage: [30, 17],
    range: [14, 45],
    headMul: 1.5,
    mag: 12,
    reserve: 48,
    reload: 1.35,
    pellets: 1,
    spreadHip: 0.02,
    spreadAds: 0.006,
    bloom: 0.008,
    recoil: [0.016, 0.006],
    zoom: 1.2,
    adsTime: 0.12,
    sound: "pistol",
    tracerEvery: 2,
  },
};

export const PRIMARIES = ["ar", "smg", "shotgun", "sniper"];

export function makeLoadout(primary = "ar") {
  const make = (id) => {
    const d = WEAPONS[id];
    return { def: d, mag: d.mag, reserve: d.reserve, cooldown: 0, reloading: false, reloadT: 0, triggerHeld: false, shots: 0 };
  };
  return {
    slots: [make(primary), make("pistol")],
    active: 0,
    switchT: 0,
    ads: 0,
    bloom: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    kick: 0,
    fired: 0,
    raise: 1, // 1 = gun up, 0 = low ready (tucking)
    burst: 0, // shots in the current trigger pull (recoil pattern index)
    t: 0,
    swayYaw: 0, // scope sway (sniper), part of the aim
    swayPitch: 0,
    steady: 4, // seconds of held breath left
    dry: false, // set for one step when the trigger clicks on an empty gun
  };
}

/**
 * Recoil patterns: learnable, mostly vertical climb with a per-gun horizontal drift, plus a
 * little noise. Index = shot number in the current trigger pull.
 */
const PATTERN = {
  ar: (i) => [Math.sin(i * 0.55) * 0.45 + (i > 6 ? 0.35 : 0.1), 1 - Math.min(i, 12) * 0.035],
  smg: (i) => [Math.sin(i * 1.3) * 0.8, 0.85 - Math.min(i, 16) * 0.02],
  shotgun: () => [0.15, 1],
  sniper: () => [0.05, 1],
  pistol: (i) => [Math.sin(i * 2.1) * 0.5, 1],
};

/** Taking a hit flinches the aim (like Call of Duty's flinch). */
export function flinch(l, amount, rng) {
  const k = Math.min(1, amount / 40) * (1 - l.ads * 0.35);
  l.recoilPitch += (0.012 + rng() * 0.012) * k;
  l.recoilYaw += (rng() - 0.5) * 0.03 * k;
}

export function activeWeapon(l) {
  return l.slots[l.active];
}

/** Damage at distance d (linear falloff between the two ranges). */
export function damageAt(def, d) {
  const t = clamp((d - def.range[0]) / (def.range[1] - def.range[0]), 0, 1);
  return def.damage[0] + (def.damage[1] - def.damage[0]) * t;
}

/**
 * One step of the trigger. `input`: { fire, ads, reload, swap }. `motion`: { speed, grounded }.
 * Returns a shot { pellets: [{dx,dy,dz}], def } or null. `aim` = { yaw, pitch } (world).
 */
export function weaponStep(l, input, motion, aim, dt, rng) {
  const w = activeWeapon(l);
  const d = w.def;
  l.t += dt;
  l.dry = false;
  w.cooldown = Math.max(0, w.cooldown - dt);
  // Low ready while tucking: the gun has to come up before it can fire (~0.15 s).
  const lowered = input.tuck && !input.fire && !input.ads;
  l.raise = lowered ? Math.max(0, l.raise - dt * 5) : Math.min(1, l.raise + dt * 7);
  // Scope sway on the sniper; holding breath (steady) calms it for a few seconds.
  if (d.scope && l.ads > 0.5) {
    const holding = input.steady && l.steady > 0;
    l.steady = holding ? Math.max(0, l.steady - dt) : Math.min(4, l.steady + dt * 0.5);
    const amp = (holding ? 0.0004 : l.steady <= 0 ? 0.0065 : 0.0038) * l.ads;
    l.swayYaw = Math.sin(l.t * 0.83) * amp + Math.sin(l.t * 2.1) * amp * 0.25;
    l.swayPitch = Math.sin(l.t * 1.27 + 1.1) * amp * 0.7;
  } else {
    l.swayYaw *= 0.9;
    l.swayPitch *= 0.9;
  }
  l.switchT = Math.max(0, l.switchT - dt);
  l.kick = damp(l.kick, 0, 14, dt);
  l.bloom = damp(l.bloom, 0, 5, dt);
  // Recoil recovers.
  l.recoilPitch = damp(l.recoilPitch, 0, 7, dt);
  l.recoilYaw = damp(l.recoilYaw, 0, 7, dt);
  // Weapon swap.
  if (input.swap !== undefined && input.swap !== null && input.swap !== l.active && !w.reloadingLock) {
    l.active = input.swap;
    l.switchT = 0.45;
    w.reloading = false;
    l.ads = 0;
    return null;
  }
  const adsTarget = input.ads && !w.reloading && l.switchT <= 0 ? 1 : 0;
  l.ads = adsTarget ? Math.min(1, l.ads + dt / d.adsTime) : Math.max(0, l.ads - dt / (d.adsTime * 0.8));
  // Reload.
  if (w.reloading) {
    w.reloadT -= dt;
    if (d.perShell) {
      if (w.reloadT <= 0 && w.mag < d.mag && w.reserve > 0) {
        w.mag++;
        w.reserve--;
        w.reloadT = d.reload;
        if (w.mag >= d.mag || w.reserve <= 0) w.reloading = false;
      }
      // A shotgun reload can be interrupted by firing.
      if (input.fire && w.mag > 0 && !w.triggerHeld) w.reloading = false;
    } else if (w.reloadT <= 0) {
      const take = Math.min(d.mag - w.mag, w.reserve);
      w.mag += take;
      w.reserve -= take;
      w.reloading = false;
    }
    if (w.reloading) {
      w.triggerHeld = input.fire;
      return null;
    }
  }
  if ((input.reload || (input.fire && w.mag <= 0)) && w.mag < d.mag && w.reserve > 0 && !w.reloading) {
    w.reloading = true;
    w.reloadT = d.perShell ? d.reload * 1.3 : d.reload;
    l.ads = 0;
    w.triggerHeld = input.fire;
    return null;
  }
  let shot = null;
  if (!input.fire) l.burst = 0;
  if (input.fire && !w.triggerHeld && w.mag <= 0 && w.reserve <= 0) l.dry = true;
  const canFire = input.fire && w.cooldown <= 0 && w.mag > 0 && l.switchT <= 0 && l.raise > 0.85 && (d.auto || !w.triggerHeld);
  if (canFire) {
    w.mag--;
    w.shots++;
    w.cooldown += 60 / d.rpm;
    // Spread: hip ↔ ADS, plus movement, air and bloom from sustained fire.
    const base = d.spreadHip + (d.spreadAds - d.spreadHip) * l.ads;
    const moving = clamp((motion.speed - 8) / 30, 0, 1) * 0.012 * (1 - l.ads * 0.6);
    const air = motion.grounded ? 0 : 0.02 * (1 - l.ads * 0.5);
    const spread = base + moving + air + l.bloom;
    const pellets = [];
    for (let i = 0; i < d.pellets; i++) {
      // Uniform within a cone (sqrt for area).
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * spread;
      const yaw = aim.yaw + l.recoilYaw + l.swayYaw + Math.cos(a) * r;
      const pitch = aim.pitch + l.recoilPitch + l.swayPitch + Math.sin(a) * r;
      const cp = Math.cos(pitch);
      pellets.push({ dx: -Math.sin(yaw) * cp, dy: Math.sin(pitch), dz: -Math.cos(yaw) * cp });
    }
    shot = { def: d, pellets, tracer: w.shots % d.tracerEvery === 0 };
    // Recoil kicks the aim up and sideways; ADS tames it.
    const tame = 1 - l.ads * 0.45;
    const [py, pp] = (PATTERN[d.id] ?? PATTERN.ar)(l.burst);
    l.burst++;
    l.recoilPitch += d.recoil[0] * tame * pp;
    l.recoilYaw += (py + (rng() - 0.5) * 0.6) * d.recoil[1] * tame;
    l.bloom = Math.min(0.03, l.bloom + d.bloom);
    l.kick = 1;
    l.fired++;
  }
  w.triggerHeld = input.fire;
  return shot;
}
