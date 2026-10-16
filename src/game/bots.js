/**
 * Bot riders. Each bot follows a run (with its own lane that drifts), dodges trees, hits the
 * kickers (the skilled ones spin), and fights: it scans for enemies it can actually see, reacts
 * after a human-ish delay, tracks with an aim error that shrinks while it holds the target and
 * grows when either of them moves fast, and fires in bursts. Deterministic (rng from the run).
 */
import { clamp, wrapAngle } from "../core/noise.js";
import { lineOfSight, eyeOf } from "./combat.js";
import { activeWeapon } from "./weapons.js";

export function makeBrain(rng, skill) {
  return {
    skill,
    trail: null,
    idx: 0,
    lane: 0,
    laneTarget: 0,
    laneTimer: 0,
    target: null,
    seen: 0, // time the current target has been tracked
    react: 0.3 + (1 - skill) * 0.5,
    aimErrYaw: 0,
    aimErrPitch: 0,
    scanT: rng() * 0.25,
    burst: 0,
    pause: 0,
    trickPlan: null,
    stuckT: 0,
    jumpT: 0,
    spinDir: rng() < 0.5 ? -1 : 1,
  };
}

/** Pick a run for the bot and snap its progress to the nearest path sample. */
export function assignTrail(bot, trails, rng) {
  const main = trails.filter((t) => t.path.length > 200);
  bot.brain.trail = main[Math.floor(rng() * main.length) % main.length];
  bot.brain.idx = nearestIndex(bot.brain.trail, bot.rider.p.x, bot.rider.p.z, 0);
  bot.brain.lane = 0;
  bot.brain.laneTarget = (rng() - 0.5) * 0.9;
}

function nearestIndex(trail, x, z, from) {
  let best = from;
  let bd = Infinity;
  const path = trail.path;
  const end = Math.min(path.length, from + 160);
  for (let i = Math.max(0, from - 10); i < end; i++) {
    const d = (path[i].x - x) ** 2 + (path[i].z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

const EYE = {};
const TEYE = {};

/**
 * Produce this step's input for a bot. `game` gives agents, ground, forest, park, rng.
 */
export function botThink(bot, game, dt) {
  const b = bot.brain;
  const r = bot.rider;
  const rng = game.rng;
  const input = { steer: 0, tuck: 0, brake: 0, jump: 0, spin: 0, flip: 0, fire: false, ads: false, reload: false, swap: null };
  if (!b.trail) return input;
  const path = b.trail.path;

  // ── navigation ──
  b.idx = nearestIndex(b.trail, r.p.x, r.p.z, b.idx);
  b.laneTimer -= dt;
  if (b.laneTimer <= 0) {
    b.laneTimer = 2 + rng() * 4;
    b.laneTarget = clamp(b.laneTarget + (rng() - 0.5) * 0.7, -0.75, 0.75);
  }
  b.lane += (b.laneTarget - b.lane) * Math.min(1, dt * 0.6);
  const look = Math.round(5 + r.speed * 0.55);
  const p = path[Math.min(path.length - 1, b.idx + look)];
  // Park lines: steer onto the kicker line when one is coming up.
  let lateral = b.lane * p.w;
  if (game.park) {
    for (const f of game.park.features) {
      if (f.type !== "kicker") continue;
      const dx = f.x - r.p.x;
      const dz = f.z - r.p.z;
      const d = Math.hypot(dx, dz);
      if (d < 70 && d > 3 && dx * f.tx + dz * f.tz > 0 && b.skill > 0.35) {
        // Aim at the ramp's centre line: offset the target across the run.
        const across = (f.x - p.x) * -p.tz + (f.z - p.z) * p.tx;
        lateral = across;
        b.jumpT = 1.5;
      }
    }
    // Some skilled riders also take the rails and boxes: line up with the feed ramp and ride on.
    if (b.skill > 0.45 && bot.id % 2 === 0) {
      for (const f of game.park.features) {
        if (f.type !== "box" && f.type !== "rail") continue;
        const back = f.length / 2 + f.ramp + 2;
        const sx = f.x - f.tx * back;
        const sz = f.z - f.tz * back;
        const dx = sx - r.p.x;
        const dz = sz - r.p.z;
        const ahead = dx * f.tx + dz * f.tz;
        if (ahead > 2 && ahead < 60 && Math.abs(dx * -f.tz + dz * f.tx) < 40) {
          lateral = (f.x - p.x) * -p.tz + (f.z - p.z) * p.tx;
        } else if (r.grind) lateral = (r.p.x - p.x) * -p.tz + (r.p.z - p.z) * p.tx;
      }
    }
  }
  const tx = p.x - p.tz * lateral;
  const tz = p.z + p.tx * lateral;
  let want = Math.atan2(-(tx - r.p.x), -(tz - r.p.z));
  // Tree dodge: probe ahead along the current heading.
  const fx = -Math.sin(r.heading);
  const fz = -Math.cos(r.heading);
  if (game.forest) {
    let threat = 0;
    for (const dist of [6, 12, 20]) {
      const px = r.p.x + fx * dist;
      const pz = r.p.z + fz * dist;
      game.forest.near(px, pz, 3.2, (i) => {
        const t = game.forest.trees;
        const side = (t.x[i] - r.p.x) * Math.cos(r.heading) + (t.z[i] - r.p.z) * -Math.sin(r.heading);
        threat += side > 0 ? -1 : 1; // tree on the right → turn left
      });
    }
    if (threat !== 0) want = r.heading + clamp(threat, -1, 1) * -0.6;
  }
  const diff = wrapAngle(want - r.heading);
  input.steer = clamp(-diff * 2.6, -1, 1);
  // Speed: tuck on straights, check speed in hard turns, brake if way off line.
  const wantSpeed = 15 + b.skill * 12;
  input.tuck = Math.abs(diff) < 0.25 && r.speed < wantSpeed ? 1 : 0;
  input.brake = Math.abs(diff) > 1.2 && r.speed > 12 ? 1 : 0;
  // Unstick: crawling on a flat, push.
  if (r.speed < 2 && r.grounded) {
    b.stuckT += dt;
    input.tuck = 1;
  } else b.stuckT = 0;

  // ── tricks in the air ──
  if (!r.grounded && r.crash <= 0) {
    if (!b.trickPlan && r.air > 0.05 && b.skill > 0.55) {
      const big = r.v.y > 3.5;
      b.trickPlan = big ? { spin: (rng() < 0.5 ? 1 : 2) * Math.PI, dir: b.spinDir } : null;
    }
    if (b.trickPlan) {
      const done = Math.abs(r.spin) >= b.trickPlan.spin - 0.15;
      input.spin = done ? 0 : b.trickPlan.dir;
      input.steer = input.spin;
    } else {
      input.steer = 0;
    }
  } else {
    b.trickPlan = null;
  }

  // ── combat ──
  combat(bot, game, dt, input);
  return input;
}

function combat(bot, game, dt, input) {
  const b = bot.brain;
  const r = bot.rider;
  const rng = game.rng;
  const w = activeWeapon(bot.loadout);
  b.scanT -= dt;
  if (b.target && (!b.target.alive || b.target.team === bot.team)) {
    b.target = null;
  }
  if (b.scanT <= 0) {
    b.scanT = 0.25;
    eyeOf(bot, EYE);
    const range = w.def.id === "sniper" ? 380 : w.def.id === "shotgun" ? 60 : 210;
    // Nearest few enemies by distance, then a real sight-line check.
    const cands = [];
    for (const ag of game.agents) {
      if (ag.team === bot.team || !ag.alive) continue;
      const d = Math.hypot(ag.rider.p.x - r.p.x, ag.rider.p.y - r.p.y, ag.rider.p.z - r.p.z);
      if (d < range) cands.push([d, ag]);
    }
    cands.sort((a, c) => a[0] - c[0]);
    let found = null;
    for (const [, ag] of cands.slice(0, 3)) {
      eyeOf(ag, TEYE);
      if (lineOfSight(EYE.x, EYE.y, EYE.z, TEYE.x, TEYE.y - 0.4, TEYE.z, game.ground, game.forest)) {
        found = ag;
        break;
      }
    }
    if (found !== b.target) {
      b.target = found;
      b.seen = 0;
      if (found) {
        const d = Math.hypot(found.rider.p.x - r.p.x, found.rider.p.z - r.p.z);
        // Bots are a little kinder to the human player (they still fight each other at full skill).
        const kind = found.isPlayer ? 1.6 : 1;
        const err = (0.05 + (1 - b.skill) * 0.12) * (1 + d / 120) * kind;
        b.aimErrYaw = (rng() - 0.5) * 2 * err;
        b.aimErrPitch = (rng() - 0.5) * err;
      }
    } else if (!found) {
      b.target = null;
    }
  }
  const underFire = game.time - bot.lastDamageT < 1.4;
  if (underFire && !b.target && bot.lastAttacker && bot.lastAttacker.alive && bot.lastAttacker.team !== bot.team) {
    // Swing toward the shots; the next scan will usually find the shooter.
    const a = bot.lastAttacker.rider.p;
    bot.lookYaw = approachAngle(bot.lookYaw, Math.atan2(-(a.x - r.p.x), -(a.z - r.p.z)), 6 * dt);
    b.scanT = Math.min(b.scanT, 0.05);
  }
  // Juking: weave hard for a moment when hit.
  if (underFire && r.grounded && r.speed > 6) {
    b.jukeT = (b.jukeT ?? 0) + dt;
    input.steer = Math.sin(b.jukeT * (5 + b.skill * 4) + bot.id) > 0 ? 1 : -1;
  }
  if (!b.target) {
    // Look where we're going; top up the mag when calm.
    bot.lookYaw = approachAngle(bot.lookYaw, r.heading, 3 * dt);
    bot.lookPitch += (-0.12 - bot.lookPitch) * Math.min(1, dt * 3);
    if (w.mag < w.def.mag * 0.5 && w.reserve > 0) input.reload = true;
    return;
  }
  b.seen += dt;
  const t = b.target;
  eyeOf(bot, EYE);
  const tx = t.rider.p.x - EYE.x;
  const ty = t.rider.p.y + 1.05 - t.rider.crouch * 0.35 - EYE.y;
  const tz = t.rider.p.z - EYE.z;
  const dist = Math.hypot(tx, ty, tz);
  const wantYaw = Math.atan2(-tx, -tz);
  const wantPitch = Math.atan2(ty, Math.hypot(tx, tz));
  // Aim error shrinks while tracking; motion makes it worse.
  const settle = 1.6 + b.skill * 2.4;
  const motion = clamp((r.speed + t.rider.speed) / 40, 0, 1) * (1 - b.skill * 0.5);
  b.aimErrYaw *= Math.exp(-settle * dt);
  b.aimErrPitch *= Math.exp(-settle * dt);
  const wobble = (0.006 + 0.02 * motion) * (1 + dist / 150) * (t.isPlayer ? 1.5 : 1);
  const ey = b.aimErrYaw + (rng() - 0.5) * wobble;
  const ep = b.aimErrPitch + (rng() - 0.5) * wobble * 0.6;
  const turn = (4 + b.skill * 5) * dt;
  bot.lookYaw = approachAngle(bot.lookYaw, wantYaw + ey, turn);
  bot.lookPitch = clamp(bot.lookPitch + clamp(wantPitch + ep - bot.lookPitch, -turn, turn), -1.3, 1.3);
  const onTarget = Math.abs(wrapAngle(bot.lookYaw - wantYaw)) < 0.06 + 2 / Math.max(dist, 1) * 0.5;
  input.ads = dist > 35 && w.def.id !== "shotgun";
  input.tuck = 0;
  if (dist > 90 && r.speed > 18 && b.skill > 0.5 && r.grounded) input.brake = 1;
  if (b.seen > b.react + (t.isPlayer ? 0.35 : 0) && onTarget) {
    if (b.pause > 0) {
      b.pause -= dt;
    } else {
      input.fire = true;
      if (w.def.auto) {
        b.burst += dt;
        if (b.burst > 0.25 + b.skill * 0.45) {
          b.burst = 0;
          b.pause = 0.25 + (1 - b.skill) * 0.4;
        }
      } else {
        // Semi/pump/bolt: let go between shots.
        input.fire = w.cooldown <= 0 && !w.triggerHeld;
      }
    }
  }
}

function approachAngle(a, target, maxStep) {
  const d = wrapAngle(target - a);
  return wrapAngle(a + clamp(d, -maxStep, maxStep));
}
