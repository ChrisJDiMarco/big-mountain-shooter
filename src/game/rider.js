/**
 * Ski / snowboard physics, shared by the player and the bots (deterministic: no randomness,
 * time only from dt). A rider is a point on the snow with a ski heading and a 3D velocity:
 *
 *  - On the ground, gravity along the slope accelerates; snow friction and air drag (less in a
 *    tuck) cap the speed around 70–100 km/h. The edges grip: velocity is steered toward the ski
 *    heading up to a carving limit; turning harder than the edge can hold skids (and scrubs speed).
 *  - Leaving a lip or a sharp crest launches you; in the air A/D spin and W/S flip; landing
 *    within tolerance of a clean stance scores the trick, otherwise you wipe out.
 *  - Trees: clip one fast and it hurts (or kills).
 *
 * Input each step: { steer -1..1, tuck 0/1, brake 0/1, jump (held) 0/1, spin -1..1, flip -1..1 }.
 */
import { clamp, damp, wrapAngle } from "../core/noise.js";

export const G = 9.81;

export const KIND = {
  ski: {
    turnRate: 2.25, // rad/s heading change at low speed
    carveAccel: 15.5, // m/s² max centripetal from the edges
    friction: 0.045,
    drag: 0.0058,
    tuckDrag: 0.0033,
    skate: 6.2, // push speed on the flats
    ollie: 4.6,
    spinRate: 6.6,
    flipRate: 5.2,
    landTolerance: 0.75, // rad off-stance still counted clean
    eye: 1.62,
  },
  board: {
    turnRate: 2.0,
    carveAccel: 14,
    friction: 0.05,
    drag: 0.006,
    tuckDrag: 0.0039,
    skate: 3.2,
    ollie: 5.6,
    spinRate: 7.8,
    flipRate: 6.0,
    landTolerance: 0.95,
    eye: 1.58,
  },
};

export const TRICK_POINTS = { spin180: 100, flip: 500, air: 50 };

export function makeRider(kind = "ski") {
  return {
    kind,
    p: { x: 0, y: 0, z: 0 }, // feet on the snow
    v: { x: 0, y: 0, z: 0 },
    heading: Math.PI, // ski direction (yaw): forward = (-sin, 0, -cos); π faces downhill (+z)
    grounded: true,
    n: { x: 0, y: 1, z: 0 }, // ground normal under the rider
    crouch: 0, // 0..1 (tuck / ollie preload / landing absorb)
    lean: 0, // visual inclination into the turn (rad, + = leaning right)
    edge: 0, // carve load 0..1 (sounds/spray)
    skid: 0, // skid amount 0..1
    air: 0, // seconds airborne
    airHeight: 0,
    spin: 0, // accumulated yaw spin in the air (rad)
    flip: 0, // accumulated pitch rotation (rad, + = front flip)
    lastGroundY: 0,
    crash: 0, // seconds left in a wipe-out
    landing: 0, // landing impulse for camera bob (decays)
    impact: 0,
    speed: 0,
    jumpHeld: false,
    preload: 0,
    grind: null, // on a box/rail: {f, t, dist, name, slide, ...}
    grindCool: 0,
    grinding: false,
    events: [], // filled during step: {type:"land"|"trick"|"crash"|"tree"|"launch", ...}
  };
}

export function placeRider(r, sampler, x, z, heading) {
  r.p.x = x;
  r.p.z = z;
  r.p.y = sampler.ground(x, z);
  r.v.x = 0;
  r.v.y = 0;
  r.v.z = 0;
  r.heading = heading;
  r.grounded = true;
  r.air = 0;
  r.spin = 0;
  r.flip = 0;
  r.crash = 0;
  r.crouch = 0;
  r.lean = 0;
  r.landing = 0;
  r.preload = 0;
  r.jumpHeld = false;
  r.grind = null;
  r.grindCool = 0;
  r.grinding = false;
  sampler.groundNormal(x, z, r.n);
}

const tmpN = { x: 0, y: 1, z: 0 };

/**
 * Advance one rider by dt. `world` provides: ground(x,z), groundNormal(x,z,out),
 * snowFriction(x,z) (1 groomed … ~2.5 deep powder), trees.near(x,z,r,fn), trees.trees.
 */
export function stepRider(r, input, dt, world) {
  const K = KIND[r.kind];
  r.events.length = 0;
  const steer = clamp(input.steer || 0, -1, 1);
  const tuck = input.tuck ? 1 : 0;
  const brake = input.brake ? 1 : 0;

  if (r.crash > 0) {
    r.crash -= dt;
  }
  const out = r.crash > 0; // tumbling: no control

  r.grindCool = Math.max(0, (r.grindCool || 0) - dt);
  if (r.grind) {
    grindStep(r, K, input, steer, out, dt, world);
  } else if (r.grounded) {
    groundStep(r, K, input, steer, tuck, brake, out, dt, world);
  } else {
    airStep(r, K, input, steer, out, dt, world);
  }
  r.grinding = Boolean(r.grind);

  // Trees: trunk + inner branches. A glancing hit at speed is a crash; a square hit at high speed kills.
  treeCollide(r, world);

  r.speed = Math.hypot(r.v.x, r.v.y, r.v.z);
  r.landing = damp(r.landing, 0, 6, dt);
}

function groundStep(r, K, input, steer, tuck, brake, out, dt, world) {
  const n = r.n;
  world.groundNormal(r.p.x, r.p.z, n);
  // Gravity along the surface.
  const gn = -G * n.y; // gravity · n
  let ax = -gn * n.x;
  let ay = -G - gn * n.y;
  let az = -gn * n.z;
  // Ski direction projected onto the surface.
  let fx = -Math.sin(r.heading);
  let fz = -Math.cos(r.heading);
  let fy = -(fx * n.x + fz * n.z) / n.y; // keep f tangent: f·n = 0
  let fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // Lateral axis (to the skier's right on the surface): f × n
  const lx = fy * n.z - fz * n.y;
  const ly = fz * n.x - fx * n.z;
  const lz = fx * n.y - fy * n.x;

  const v = r.v;
  // Keep velocity on the surface.
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  v.x -= vn * n.x;
  v.y -= vn * n.y;
  v.z -= vn * n.z;
  let speed = Math.hypot(v.x, v.y, v.z);
  const vf = v.x * fx + v.y * fy + v.z * fz; // along the skis (signed: negative = riding switch)
  const vl = v.x * lx + v.y * ly + v.z * lz;

  // ── steering: the edge angle builds and releases (a digital key becomes a progressive carve),
  // turning faster at low speed with a carving limit at high speed ──
  const edgeRate = steer !== 0 && Math.sign(steer) !== Math.sign(r.edgeAngle) ? 9 : 5.5;
  r.edgeAngle = damp(r.edgeAngle || 0, out ? 0 : steer, edgeRate, dt);
  if (!out) {
    const speedFactor = 1 / (1 + speed * 0.045);
    const rate = K.turnRate * (0.55 + 0.45 * speedFactor) * (brake ? 1.35 : 1);
    // A crisp edge change at speed un-weights the skis for a moment: a little pop of air.
    if (r.lastSteer !== undefined && steer !== 0 && r.lastSteer !== 0 && Math.sign(steer) !== Math.sign(r.lastSteer) && speed > 14) r.unweight = 0.12;
    r.heading = wrapAngle(r.heading - r.edgeAngle * rate * dt * (1 + (r.unweight > 0 ? 0.4 : 0)));
  }
  r.lastSteer = steer;
  r.unweight = Math.max(0, (r.unweight || 0) - dt);

  // ── edges: rotate velocity toward the ski line (switch counts: skis ride both ways) ──
  const dirSign = vf >= 0 ? 1 : -1;
  const tx = fx * dirSign;
  const ty = fy * dirSign;
  const tz = fz * dirSign;
  let skid = 0;
  if (speed > 0.3) {
    const ux = v.x / speed;
    const uy = v.y / speed;
    const uz = v.z / speed;
    const cos = clamp(ux * tx + uy * ty + uz * tz, -1, 1);
    const angle = Math.acos(cos);
    const grip = out ? 0.15 : 1;
    const maxTurn = ((K.carveAccel * grip) / Math.max(speed, 4)) * dt;
    const turn = Math.min(angle, maxTurn);
    if (angle > 1e-4) {
      // Rotate u toward t by `turn` within their plane.
      const s = Math.sin(turn) / Math.sin(angle);
      const c0 = Math.sin(angle - turn) / Math.sin(angle);
      const nx2 = ux * c0 + tx * s;
      const ny2 = uy * c0 + ty * s;
      const nz2 = uz * c0 + tz * s;
      v.x = nx2 * speed;
      v.y = ny2 * speed;
      v.z = nz2 * speed;
    }
    skid = clamp((angle - turn) / 0.6, 0, 1);
  }
  // Carve load for the visuals/audio: how hard the edges are working.
  r.edge = damp(r.edge, clamp(Math.abs(vl) / Math.max(speed, 1) * 2 + Math.abs(r.edgeAngle) * 0.45, 0, 1), 8, dt);
  r.skid = damp(r.skid, Math.max(skid, brake ? 1 : 0), 10, dt);

  // ── forces along the velocity ──
  speed = Math.hypot(v.x, v.y, v.z);
  const snow = world.snowFriction ? world.snowFriction(r.p.x, r.p.z) : 1;
  r.powder = damp(r.powder || 0, clamp((snow - 1.3) / 1.0, 0, 1), 4, dt);
  const drag = (tuck && !out ? K.tuckDrag : K.drag) * (1 + r.skid * 1.5);
  let decel = K.friction * snow * G * n.y + drag * speed * speed + r.skid * 3.2 + brake * 5.5 + (out ? 6 : 0);
  // Skating / pole push on the flats (only when slow, holding tuck).
  if (tuck && !out && speed < K.skate && !brake) {
    ax += fx * 3.4;
    ay += fy * 3.4;
    az += fz * 3.4;
  }
  v.x += ax * dt;
  v.y += ay * dt;
  v.z += az * dt;
  speed = Math.hypot(v.x, v.y, v.z);
  if (speed > 1e-4) {
    const ns = Math.max(0, speed - decel * dt);
    const k = ns / speed;
    v.x *= k;
    v.y *= k;
    v.z *= k;
  }

  // ── jump: hold to preload (crouch), release to pop ──
  if (!out) {
    if (input.jump) {
      r.preload = Math.min(1, r.preload + dt * 2.2);
      r.jumpHeld = true;
    } else if (r.jumpHeld) {
      // Popping right at a kicker's lip ("perfect pop") sends you higher.
      const lip = world.kickerLip ? world.kickerLip(r.p.x, r.p.z) : Infinity;
      const perfect = lip > -0.5 && lip < 2.6;
      const pop = K.ollie * (0.55 + 0.45 * r.preload) * (perfect ? 1.45 : 1);
      if (perfect) r.events.push({ type: "pop", perfect: true });
      v.x += n.x * pop;
      v.y += n.y * pop;
      v.z += n.z * pop;
      r.jumpHeld = false;
      r.preload = 0;
      r.grounded = false;
      r.air = 0;
      r.spin = 0;
      r.flip = 0;
      r.lastGroundY = r.p.y;
      r.airHeight = 0;
      r.events.push({ type: "launch", ollie: true });
    }
  }
  const crouchTarget = Math.max(tuck ? 0.75 : 0.18 + r.edge * 0.2, r.preload * 0.9, out ? 1 : 0);
  r.crouch = damp(r.crouch, crouchTarget, 7, dt);
  const leanTarget = out ? 0 : clamp(r.edgeAngle * Math.min(1, speed / 14) * 0.6 - (vl / Math.max(speed, 3)) * 0.4, -0.75, 0.75);
  r.lean = damp(r.lean, leanTarget, 6, dt);

  // ── move along the surface, then follow or leave the ground ──
  r.p.x += v.x * dt;
  r.p.y += v.y * dt;
  r.p.z += v.z * dt;
  if (!r.grounded) return; // popped this step
  const gy = world.ground(r.p.x, r.p.z);
  world.groundNormal(r.p.x, r.p.z, tmpN);
  const gap = r.p.y - gy;
  const away = v.x * tmpN.x + v.y * tmpN.y + v.z * tmpN.z;
  if (gap > 0.04 && (away > 2.2 || gap > 0.45 + speed * 0.02)) {
    // The ground fell away faster than we can follow (a lip or a sharp crest): airborne.
    r.grounded = false;
    r.air = 0;
    r.spin = 0;
    r.flip = 0;
    r.lastGroundY = r.p.y;
    r.airHeight = 0;
    r.events.push({ type: "launch", ollie: false });
  } else {
    r.p.y = gy;
    // Rode up the feed ramp onto a box or rail: lock on.
    if (world.jibAt && !out) {
      const j = world.jibAt(r.p.x, r.p.z, 0);
      if (j && r.p.y > j.f.topAt(j.u) - 0.15) tryGrind(r, K, j, world, false);
    }
  }
}

/**
 * Grinds (AAA arcade rules): a box or rail under you while you travel along it (±50°) locks you
 * on, a magnet pulls you to its centre line, gravity and a little friction act along it, and you
 * leave off the end or with a jump. Skis/board lined up = 50-50, across = a slide.
 */
function tryGrind(r, K, j, world, fromAir) {
  if (!j || r.grindCool > 0 || r.crash > 0) return false;
  const f = j.f;
  const v = r.v;
  const flat = Math.hypot(v.x, v.z);
  const along = v.x * f.tx + v.z * f.tz;
  if (flat < 2 || Math.abs(along) < flat * 0.64) return false;
  if (fromAir && Math.abs(wrapAngle(r.flip)) > 1.0) return false;
  const sign = Math.sign(along) || 1;
  const travel = Math.atan2(-f.tx * sign, -f.tz * sign);
  const rel = wrapAngle(r.heading - travel);
  const slide = Math.abs(rel) > Math.PI / 4 && Math.abs(rel) < (Math.PI * 3) / 4;
  const sw = Math.abs(rel) >= (Math.PI * 3) / 4;
  const base = slide ? (r.kind === "board" ? "BOARDSLIDE" : "SLIDE") : "50-50";
  const spinIn = fromAir ? Math.round(Math.abs(r.spin) / (Math.PI / 2)) * 90 : 0;
  const name = `${f.type === "rail" ? "RAIL" : "BOX"} ${spinIn >= 180 ? `${spinIn} ON ` : ""}${sw ? "SWITCH " : ""}${base}`;
  const impact = fromAir ? Math.max(0, -v.y) : 0;
  r.grind = { f, sign, t: 0, dist: 0, name, slide, side: Math.sign(rel) || 1, switch: sw, spinIn };
  r.grounded = true;
  r.p.y = f.topAt(j.u);
  v.y = 0;
  if (fromAir) {
    r.impact = impact;
    r.landing = Math.min(1.2, impact / 6);
    r.events.push({ type: "land", impact, air: r.air });
  }
  r.air = 0;
  r.spin = 0;
  r.flip = 0;
  r.events.push({ type: "grindStart", rail: f.type === "rail", fromAir, name });
  return true;
}

function grindStep(r, K, input, steer, out, dt, world) {
  const g = r.grind;
  const f = g.f;
  const v = r.v;
  const dx = r.p.x - f.x;
  const dz = r.p.z - f.z;
  let u = dx * f.tx + dz * f.tz;
  let w = dx * -f.tz + dz * f.tx;
  const half = f.length / 2;
  w *= Math.exp(-16 * dt); // the magnet: onto the centre line
  // Speed along the jib (+ = down the run): gravity along its slope, sliding friction, air drag.
  let s = v.x * f.tx + v.z * f.tz;
  const slope = f.slope; // rise per metre along +t (jibs are straight)
  s -= ((G * slope) / Math.sqrt(1 + slope * slope)) * dt;
  const dec = ((f.type === "rail" ? 0.05 : 0.08) * G * (g.slide ? 1.4 : 1) + K.drag * s * s) * dt;
  s = s > 0 ? Math.max(0, s - dec) : Math.min(0, s + dec);
  u += s * dt;
  const prevY = r.p.y;
  r.p.x = f.x + f.tx * u - f.tz * w;
  r.p.z = f.z + f.tz * u + f.tx * w;
  r.p.y = f.topAt(u);
  v.x = f.tx * s;
  v.z = f.tz * s;
  v.y = (r.p.y - prevY) / Math.max(dt, 1e-4);
  g.t += dt;
  g.dist += Math.abs(s) * dt;
  // Stance: lined up for a 50-50 (or switch), across the jib for a slide.
  const travel = Math.atan2(-f.tx * g.sign, -f.tz * g.sign);
  const target = g.slide ? travel + (g.side * Math.PI) / 2 : travel + (g.switch ? Math.PI : 0);
  r.heading = wrapAngle(r.heading + wrapAngle(target - r.heading) * Math.min(1, dt * 12));
  // Balance wobble you can lean against with the steer keys.
  const wobble = Math.sin(g.t * 6.3) * 0.1 + Math.sin(g.t * 11.7 + 1.3) * 0.05;
  r.lean = damp(r.lean, wobble + steer * 0.18, 7, dt);
  r.crouch = damp(r.crouch, 0.42, 8, dt);
  r.edge = damp(r.edge, 0, 10, dt);
  r.skid = damp(r.skid, g.slide ? 0.4 : 0, 10, dt);
  // The skis/board pitch with the jib.
  const nl = Math.hypot(slope, 1);
  r.n.x = (-f.tx * slope) / nl;
  r.n.y = 1 / nl;
  r.n.z = (-f.tz * slope) / nl;
  r.grounded = true;
  // Pop off with a jump, ride off the end, or stall out.
  let pop = 0;
  if (!out) {
    if (input.jump) {
      r.preload = Math.min(1, r.preload + dt * 2.2);
      r.jumpHeld = true;
    } else if (r.jumpHeld) {
      pop = K.ollie * (0.55 + 0.45 * r.preload);
      r.jumpHeld = false;
      r.preload = 0;
    }
  }
  if (pop || out || u > half || u < -half || (Math.abs(s) < 0.8 && g.t > 0.3)) endGrind(r, pop);
}

function endGrind(r, pop) {
  const g = r.grind;
  r.grind = null;
  r.grindCool = 0.35;
  r.grounded = false;
  r.air = 0;
  r.spin = 0;
  r.flip = 0;
  r.lastGroundY = r.p.y;
  r.airHeight = 0;
  r.p.y += 0.02;
  r.v.y = Math.max(r.v.y, 0) + pop + 0.9; // a little hop off the end
  // Slides turn back to the fall line as you come off.
  if (g.slide) r.heading = Math.atan2(-g.f.tx * g.sign, -g.f.tz * g.sign) + (g.switch ? Math.PI : 0);
  r.events.push({ type: "grindEnd", dist: g.dist, t: g.t, pop: pop > 0 });
  if (g.dist > 1.5) {
    const points = Math.round((40 + g.dist * 22 + (g.slide ? 60 : 0) + (g.spinIn >= 180 ? g.spinIn : 0)) / 10) * 10;
    r.events.push({ type: "trick", name: g.name, points, grind: true });
  }
  if (pop) r.events.push({ type: "launch", ollie: true });
}

function airStep(r, K, input, steer, out, dt, world) {
  const v = r.v;
  r.air += dt;
  v.y -= G * dt;
  const speed = Math.hypot(v.x, v.y, v.z);
  const k = Math.max(0, 1 - K.drag * speed * dt * 0.6);
  v.x *= k;
  v.y *= k;
  v.z *= k;
  if (!out) {
    // Spins (A/D) rotate the skis; flips (W/S) rotate the body.
    const spin = clamp(input.spin || 0, -1, 1);
    const dyaw = -spin * K.spinRate * dt;
    r.heading = wrapAngle(r.heading + dyaw);
    r.spin += dyaw;
    const flip = clamp(input.flip || 0, -1, 1);
    r.flip += flip * K.flipRate * dt;
    // Air control: a gentle lateral nudge from the steer keys when not spinning.
    if (!spin && steer) {
      const rx = Math.cos(r.heading);
      const rz = -Math.sin(r.heading);
      v.x += rx * steer * 1.6 * dt;
      v.z += rz * steer * 1.6 * dt;
    }
  }
  r.crouch = damp(r.crouch, out ? 1 : 0.55, 5, dt);
  r.p.x += v.x * dt;
  r.p.y += v.y * dt;
  r.p.z += v.z * dt;
  r.airHeight = Math.max(r.airHeight, r.p.y - world.ground(r.p.x, r.p.z));
  if (world.jibAt && v.y <= 0 && !out) {
    const j = world.jibAt(r.p.x, r.p.z, 0.6);
    if (j) {
      const top = j.f.topAt(j.u);
      if (r.p.y <= top + 0.05 && r.p.y >= top - 0.6 && tryGrind(r, K, j, world, true)) return;
    }
  }
  const gy = world.ground(r.p.x, r.p.z);
  if (r.p.y <= gy) {
    land(r, K, gy, world);
  }
}

function land(r, K, gy, world) {
  const n = r.n;
  world.groundNormal(r.p.x, r.p.z, n);
  const v = r.v;
  r.p.y = gy;
  const vn = v.x * n.x + v.y * n.y + v.z * n.z; // negative into the ground
  const impact = Math.max(0, -vn);
  v.x -= vn * n.x;
  v.y -= vn * n.y;
  v.z -= vn * n.z;
  r.grounded = true;
  r.impact = impact;
  r.landing = Math.min(1.5, impact / 6);
  // Stance check: flips must come round to upright; spins to forward or switch (skis and boards ride both).
  const flipOff = Math.abs(wrapAngle(r.flip));
  const spinOff = Math.abs(wrapAngle(r.spin * 2) / 2); // nearest multiple of 180°
  // Heading vs travel direction also matters: landing sideways at speed is a wipe-out.
  const speedFlat = Math.hypot(v.x, v.z);
  let sideways = 0;
  if (speedFlat > 4) {
    const fx = -Math.sin(r.heading);
    const fz = -Math.cos(r.heading);
    const c = Math.abs((v.x * fx + v.z * fz) / speedFlat);
    sideways = Math.acos(clamp(c, 0, 1));
  }
  const smallHop = r.air < 0.35 && flipOff < 1.2 && spinOff < 1.0;
  const clean = smallHop || (flipOff < K.landTolerance && spinOff < K.landTolerance * 0.85 && sideways < 0.95 && r.crash <= 0);
  const hard = impact > 13.5;
  const sketchy = !clean && !hard && r.crash <= 0 && flipOff < K.landTolerance * 1.4 && spinOff < K.landTolerance * 1.15 && sideways < 1.25;
  if (sketchy) {
    v.x *= 0.72;
    v.y *= 0.72;
    v.z *= 0.72;
    r.landing = Math.min(1.5, r.landing + 0.4);
    r.events.push({ type: "sketchy", impact });
    r.events.push({ type: "land", impact, air: r.air });
  } else if (!clean || hard) {
    r.crash = 1.3;
    r.events.push({ type: "crash", impact, damage: hard ? Math.min(60, (impact - 13.5) * 9) : 8 });
    // Wipe-outs bleed speed.
    const keep = 0.45;
    v.x *= keep;
    v.y *= keep;
    v.z *= keep;
  } else {
    const spins = Math.round(Math.abs(r.spin) / Math.PI);
    const flips = Math.round(Math.abs(r.flip) / (Math.PI * 2));
    const tricks = [];
    if (flips > 0) tricks.push(`${flips > 1 ? `${flips}× ` : ""}${r.flip > 0 ? "FRONTFLIP" : "BACKFLIP"}`);
    if (spins > 0) tricks.push(String(spins * 180));
    const SPIN_PTS = [0, 100, 250, 400, 600, 800, 1000];
    const points =
      flips * 500 + SPIN_PTS[Math.min(spins, 6)] + (r.air > 0.9 ? Math.round((r.air - 0.9) * 8) * 10 : 0) + (flips && spins ? 250 : 0);
    if (points >= 100 || tricks.length) {
      r.events.push({ type: "trick", name: tricks.length ? tricks.join(" ") : "BIG AIR", points: Math.max(points, 100), air: r.air });
    }
    r.events.push({ type: "land", impact, air: r.air });
    // Switch landings flip the heading so the skis point the way you travel.
    if (speedFlat > 2) {
      const fx = -Math.sin(r.heading);
      const fz = -Math.cos(r.heading);
      if (v.x * fx + v.z * fz < 0) r.heading = wrapAngle(r.heading + Math.PI);
    }
  }
  r.spin = 0;
  r.flip = 0;
  r.air = 0;
}

function obstacleCollide(r, world) {
  for (const o of world.obstacles) {
    const dx = r.p.x - o.x;
    const dz = r.p.z - o.z;
    if (Math.abs(dx) > o.r + 1 || Math.abs(dz) > o.r + 1) continue;
    if (r.p.y > o.top) continue;
    const d = Math.hypot(dx, dz) || 1;
    const reach = o.r + 0.4;
    if (d >= reach) continue;
    const nx = dx / d;
    const nz = dz / d;
    r.p.x = o.x + nx * reach;
    r.p.z = o.z + nz * reach;
    const into = -(r.v.x * nx + r.v.z * nz);
    if (into > 0) {
      r.v.x += nx * into * 1.2;
      r.v.z += nz * into * 1.2;
      if (into > 7) {
        r.crash = Math.max(r.crash, 1.6);
        r.events.push({ type: "tree", impact: into, damage: into > 17 ? 200 : (into - 7) * 9 });
        r.v.x *= 0.3;
        r.v.z *= 0.3;
      }
    }
  }
}

function treeCollide(r, world) {
  if (world.obstacles) obstacleCollide(r, world);
  if (!world.trees) return;
  const { trees } = world.trees;
  let hit = -1;
  let hitD = 0;
  world.trees.near(r.p.x, r.p.z, 2.4, (i, d) => {
    // Trunk + the dense inner branches near the ground level of the rider.
    const reach = Math.max(0.55, trees.r[i] * 0.22);
    const rel = r.p.y - trees.y[i];
    if (rel > trees.h[i] * 0.8) return; // flew over it
    if (d < reach + 0.35 && (hit < 0 || d < hitD)) {
      hit = i;
      hitD = d;
    }
  });
  if (hit < 0) return;
  const tx = trees.x[hit];
  const tz = trees.z[hit];
  let nx = r.p.x - tx;
  let nz = r.p.z - tz;
  const d = Math.hypot(nx, nz) || 1;
  nx /= d;
  nz /= d;
  const into = -(r.v.x * nx + r.v.z * nz);
  // Push out of the tree.
  const reach = Math.max(0.55, trees.r[hit] * 0.22) + 0.36;
  r.p.x = tx + nx * reach;
  r.p.z = tz + nz * reach;
  if (into > 0) {
    r.v.x += nx * into * 1.2;
    r.v.z += nz * into * 1.2;
    if (into > 7) {
      r.crash = Math.max(r.crash, 1.6);
      const damage = into > 17 ? 200 : (into - 7) * 9;
      r.events.push({ type: "tree", impact: into, damage });
      r.v.x *= 0.3;
      r.v.z *= 0.3;
    }
  }
}
