/**
 * Hitscan resolution: every pellet is a ray from the shooter's eye tested against the snow,
 * the forest and every other rider's hitboxes (head sphere, torso and leg capsules that follow
 * the rider's crouch and lean). Also line-of-sight for the bots.
 */
import { damageAt } from "./weapons.js";
import { KIND } from "./rider.js";

const MAX_RANGE = 650;

/** Body points of a rider (world space): the hitboxes and the third-person model share them. */
export function riderFrame(r, out = {}) {
  // Body "up": world up tilted by the lean around the heading axis.
  const fx = -Math.sin(r.heading);
  const fz = -Math.cos(r.heading);
  const rx = Math.cos(r.heading);
  const rz = -Math.sin(r.heading);
  const crash = r.crash > 0 ? 1 : 0;
  const lean = r.lean * (1 - crash);
  const ux = rx * Math.sin(lean);
  const uy = Math.cos(lean) * (1 - crash * 0.6);
  const uz = rz * Math.sin(lean);
  const hips = 0.96 - r.crouch * 0.42;
  out.fx = fx;
  out.fz = fz;
  out.rx = rx;
  out.rz = rz;
  out.ux = ux;
  out.uy = uy;
  out.uz = uz;
  out.hips = hips;
  out.head = hips + 0.72 - r.crouch * 0.08;
  out.chest = hips + 0.42;
  return out;
}

const F = {};
function segPoint(r, h, out) {
  out.x = r.p.x + F.ux * h;
  out.y = r.p.y + F.uy * h;
  out.z = r.p.z + F.uz * h;
  return out;
}

/** Ray (unit dir) vs sphere: distance or Infinity. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, rad) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > rad * rad) return Infinity;
  return tca - Math.sqrt(rad * rad - d2);
}

/** Ray vs capsule (segment a-b, radius): distance or Infinity. Sampled closest approach. */
function rayCapsule(ox, oy, oz, dx, dy, dz, a, b, rad) {
  // Closest points between the ray and the segment.
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const wx = ox - a.x;
  const wy = oy - a.y;
  const wz = oz - a.z;
  const A = dx * dx + dy * dy + dz * dz;
  const B = dx * ux + dy * uy + dz * uz;
  const C = ux * ux + uy * uy + uz * uz;
  const D = dx * wx + dy * wy + dz * wz;
  const E = ux * wx + uy * wy + uz * wz;
  const den = A * C - B * B;
  let s = den > 1e-8 ? (B * E - C * D) / den : 0;
  let t = den > 1e-8 ? (A * E - B * D) / den : E / C;
  t = Math.max(0, Math.min(1, t));
  s = Math.max(0, (B * t - D) / A);
  const px = ox + dx * s - (a.x + ux * t);
  const py = oy + dy * s - (a.y + uy * t);
  const pz = oz + dz * s - (a.z + uz * t);
  const dist2 = px * px + py * py + pz * pz;
  if (dist2 > rad * rad) return Infinity;
  // Back off to the surface along the ray.
  return Math.max(0, s - Math.sqrt(rad * rad - dist2));
}

const A = { x: 0, y: 0, z: 0 };
const B = { x: 0, y: 0, z: 0 };

/** Nearest rider hit along the ray: { agent, t, part } or null. */
export function rayRiders(agents, ox, oy, oz, dx, dy, dz, maxDist, exclude) {
  let best = null;
  for (const ag of agents) {
    if (ag === exclude || !ag.alive) continue;
    const r = ag.rider;
    // Cheap reject: distance from the ray to the rider's centre.
    const cx = r.p.x - ox;
    const cy = r.p.y + 0.9 - oy;
    const cz = r.p.z - oz;
    const along = cx * dx + cy * dy + cz * dz;
    if (along < 0 || along > maxDist + 2) continue;
    const off2 = cx * cx + cy * cy + cz * cz - along * along;
    if (off2 > 2.2 * 2.2) continue;
    riderFrame(r, F);
    segPoint(r, F.head, A);
    let t = raySphere(ox, oy, oz, dx, dy, dz, A.x, A.y, A.z, 0.17);
    let part = "head";
    segPoint(r, F.hips, A);
    segPoint(r, F.head - 0.24, B);
    const tt = rayCapsule(ox, oy, oz, dx, dy, dz, A, B, 0.25);
    if (tt < t) {
      t = tt;
      part = "body";
    }
    segPoint(r, 0.12, A);
    segPoint(r, F.hips, B);
    const tl = rayCapsule(ox, oy, oz, dx, dy, dz, A, B, 0.2);
    if (tl < t) {
      t = tl;
      part = "legs";
    }
    if (t < maxDist && (!best || t < best.t)) best = { agent: ag, t, part };
  }
  return best;
}

/**
 * Resolve a shot. Returns { hits: [{agent, part, damage, x,y,z}], impacts: [{x,y,z,kind,nx,ny,nz}],
 * tracers: [{x0,y0,z0,x1,y1,z1}] }.
 */
export function resolveShot(shooter, shot, origin, agents, ground, forest) {
  const out = { hits: [], impacts: [], tracers: [] };
  const byAgent = new Map();
  for (const pel of shot.pellets) {
    const { dx, dy, dz } = pel;
    const tg = ground.raycast(origin.x, origin.y, origin.z, dx, dy, dz, MAX_RANGE);
    const tt = forest ? forest.raycast(origin.x, origin.y, origin.z, dx, dy, dz, Math.min(tg, MAX_RANGE)) : Infinity;
    const world = Math.min(tg, tt);
    const rh = rayRiders(agents, origin.x, origin.y, origin.z, dx, dy, dz, Math.min(world, MAX_RANGE), shooter);
    let end = Math.min(world, MAX_RANGE);
    if (rh) {
      end = rh.t;
      const dmg = damageAt(shot.def, rh.t) * (rh.part === "head" ? shot.def.headMul : rh.part === "legs" ? 0.85 : 1);
      const prev = byAgent.get(rh.agent);
      if (prev) {
        prev.damage += dmg;
        if (rh.part === "head") prev.part = "head";
      } else {
        const hit = { agent: rh.agent, part: rh.part, damage: dmg, x: origin.x + dx * rh.t, y: origin.y + dy * rh.t, z: origin.z + dz * rh.t, dist: rh.t };
        byAgent.set(rh.agent, hit);
        out.hits.push(hit);
      }
      // Headshots ping off the helmet (sparks + chips), body shots puff the jacket.
      out.impacts.push({ x: origin.x + dx * end, y: origin.y + dy * end, z: origin.z + dz * end, kind: rh.part === "head" ? "helmet" : "flesh" });
    } else if (end < MAX_RANGE) {
      out.impacts.push({ x: origin.x + dx * end, y: origin.y + dy * end, z: origin.z + dz * end, kind: tt < tg ? "tree" : "snow" });
    }
    if (shot.tracer || shot.pellets.length > 1) {
      out.tracers.push({ x0: origin.x, y0: origin.y, z0: origin.z, x1: origin.x + dx * end, y1: origin.y + dy * end, z1: origin.z + dz * end });
    }
  }
  return out;
}

/** Can `a` see point (x,y,z)? Terrain + forest occlusion. */
export function lineOfSight(ox, oy, oz, x, y, z, ground, forest) {
  const dx = x - ox;
  const dy = y - oy;
  const dz = z - oz;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return true;
  const ux = dx / d;
  const uy = dy / d;
  const uz = dz / d;
  if (ground.raycast(ox, oy, oz, ux, uy, uz, d - 0.5) < d - 0.5) return false;
  if (forest && forest.raycast(ox, oy, oz, ux, uy, uz, d - 0.5) < d - 0.5) return false;
  return true;
}

/** Eye position of an agent (for shooting and sight lines). */
export function eyeOf(ag, out = {}) {
  const r = ag.rider;
  riderFrame(r, F);
  const h = KIND[r.kind].eye - r.crouch * 0.52;
  out.x = r.p.x + F.ux * h;
  out.y = r.p.y + F.uy * h;
  out.z = r.p.z + F.uz * h;
  return out;
}
