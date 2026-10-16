/**
 * First-person camera, AAA-style: the eye rides on SPRINGS (height glides over the 4 m terrain
 * facets, landings compress it and it rebounds), the head leans into carves, every shot punches
 * the view (pitch + roll + a quick FOV kick), impacts add TRAUMA (squared → smooth noise shake),
 * speed widens the FOV and adds a fine edge chatter, wipe-outs tumble.
 */
import * as THREE from "three";
import { clamp, damp } from "../core/noise.js";
import { Spring, Spring3 } from "../core/spring.js";
import { KIND } from "./rider.js";

/** Smooth 1D value noise for shake (deterministic, no Math.random). */
function vnoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 57.3) * 12.9898) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

export function createFirstPersonCamera(camera) {
  const state = {
    fov: 74,
    roll: 0,
    t: 0,
    trauma: 0,
    tumble: 0,
    eye: new THREE.Vector3(),
    lastGrounded: true,
  };
  const height = new Spring(140, 2 * Math.sqrt(140) * 0.85); // eye height follow (slightly soft)
  const land = new Spring(90, 9); // landing compression (underdamped rebound)
  const punch = new Spring3(220, 18); // shot punch: pitch, yaw, roll
  const fovKick = new Spring(260, 22);
  let primed = false;
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  return {
    state,
    /** A shot or a hit punches the view (radians). */
    kick(pitch, yaw = 0, roll = 0, fov = 0) {
      punch.impulse(pitch, yaw, roll);
      fovKick.impulse(fov);
    },
    /** Add shake trauma (0..1); it decays on its own. */
    shake(amount) {
      state.trauma = Math.min(1, state.trauma + amount);
    },
    /** Snap the springs (spawn / teleport) so the camera doesn't glide in from far away. */
    snap() {
      primed = false;
    },
    update(agent, dt, adsZoom = 1, baseFov = 74) {
      const r = agent.rider;
      const K = KIND[r.kind];
      state.t += dt;
      // Eye height: target from the snow surface + crouch; the spring smooths terrain facets.
      const targetY = r.p.y + K.eye - r.crouch * 0.52;
      if (!primed || Math.abs(height.x - targetY) > 6) {
        height.set(targetY);
        primed = true;
      }
      height.target = targetY;
      // In the air the eye follows the body exactly (no lag on a jump arc).
      if (!r.grounded) height.set(targetY);
      height.step(dt);
      // Landing: compress by impact, rebound.
      if (r.grounded && !state.lastGrounded) {
        land.impulse(-Math.min(3.2, 0.6 + r.impact * 0.22));
        state.trauma = Math.min(1, state.trauma + Math.min(0.5, r.impact * 0.035));
      }
      state.lastGrounded = r.grounded;
      land.step(dt);
      // Lean: the head shifts toward the inside of the turn.
      const hx = Math.cos(r.heading);
      const hz = -Math.sin(r.heading);
      const lean = r.lean;
      state.eye.set(r.p.x + hx * Math.sin(lean) * 0.35, height.x + land.x * 0.16, r.p.z + hz * Math.sin(lean) * 0.35);
      // Speed chatter (edges on hard snow) + trauma shake.
      const speed = r.speed;
      const chatter = r.grinding ? 0.6 + clamp(speed / 25, 0, 0.5) : clamp((speed - 12) / 26, 0, 1) * (r.grounded ? 0.55 + r.edge * 0.45 : 0.15);
      state.trauma = Math.max(0, state.trauma - dt * 1.4);
      const shake = state.trauma * state.trauma;
      const t = state.t;
      const sx = vnoise(t * 22, 1) * (0.0035 * chatter + 0.045 * shake);
      const sy = vnoise(t * 22, 2) * (0.0035 * chatter + 0.045 * shake);
      const sr = vnoise(t * 14, 3) * (0.002 * chatter + 0.06 * shake);
      state.eye.y += vnoise(t * 30, 4) * 0.01 * chatter;
      punch.step(dt);
      fovKick.step(dt);
      // Roll: horizon tilts a little with the lean, relative to where we look.
      const rel = Math.cos(agent.lookYaw - r.heading);
      state.roll = damp(state.roll, -lean * 0.3 * rel, 8, dt);
      // Tumble while wiping out.
      state.tumble = damp(state.tumble, r.crash > 0 ? 1 : 0, r.crash > 0 ? 10 : 3, dt);
      camera.position.copy(state.eye);
      euler.set(
        agent.lookPitch + sx + punch.x.x + state.tumble * Math.sin(t * 9) * 0.5,
        agent.lookYaw + sy + punch.y.x,
        state.roll + sr + punch.z.x + state.tumble * Math.sin(t * 7.1) * 0.8,
      );
      camera.quaternion.setFromEuler(euler);
      // FOV: wider with speed, narrower when aiming, a quick kick on each shot.
      const target = (baseFov + clamp((speed - 10) * 0.32, 0, 11)) / adsZoom;
      state.fov = damp(state.fov, target, 9, dt);
      const fov = state.fov + fovKick.x;
      if (Math.abs(camera.fov - fov) > 0.005) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();
    },
  };
}
