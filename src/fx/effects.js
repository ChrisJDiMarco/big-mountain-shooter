/**
 * World effects: one GPU point-sprite system for snow spray / powder bursts / impacts / smoke,
 * camera-facing tracer streaks, and muzzle-flash sprites for riders in the world.
 * Visual randomness comes from a seeded generator reset with the match.
 */
import * as THREE from "three";
import { makeRng } from "../core/noise.js";

const MAX = 6000;

const vert = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aSeed;
varying vec4 vColor;
varying float vSeed;
varying float vNear;
uniform float uScale;
void main() {
  vColor = aColor;
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float z = -mv.z;
  // Fade out right in front of the lens: your own landing puff mustn't white out the view.
  vNear = smoothstep(0.35, 1.0 + aSize * 2.5, z);
  gl_PointSize = min(aSize * uScale / max(0.1, z), 480.0);
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex_dummy>
}`;

const frag = /* glsl */ `
uniform float uBright;
varying vec4 vColor;
varying float vSeed;
varying float vNear;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  // Puffs are three overlapping lobes (turned per particle), not perfect discs.
  float s = vSeed * 6.2831;
  vec2 o1 = vec2(cos(s), sin(s)) * 0.13;
  vec2 o2 = vec2(cos(s + 2.4), sin(s + 2.4)) * 0.11;
  float d = min(length(c), min(length(c - o1) * 1.3, length(c - o2) * 1.45));
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.12, d);
  // A little volume: lit from above.
  float shade = 0.82 + 0.36 * (0.5 - gl_PointCoord.y);
  gl_FragColor = vec4(vColor.rgb * uBright * shade, vColor.a * a * vNear);
}`;

export function createEffects(scene) {
  let rng = makeRng(99);
  const pos = new Float32Array(MAX * 3);
  const vel = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 4);
  const size = new Float32Array(MAX);
  const life = new Float32Array(MAX);
  const maxLife = new Float32Array(MAX);
  const grow = new Float32Array(MAX);
  const drag = new Float32Array(MAX);
  const grav = new Float32Array(MAX);
  const baseA = new Float32Array(MAX);
  const seed = new Float32Array(MAX);
  let seedDirty = false;
  let head = 0;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aColor", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 600 }, uBright: { value: 1.7 } },
    vertexShader: vert.replace("#include <fog_vertex_dummy>", ""),
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.tag = "fx";
  points.renderOrder = 5;
  scene.add(points);

  function emit(x, y, z, vx, vy, vz, s, r, g, b, a, lifeS, opts = {}) {
    const i = head;
    head = (head + 1) % MAX;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vel[i * 3] = vx;
    vel[i * 3 + 1] = vy;
    vel[i * 3 + 2] = vz;
    col[i * 4] = r;
    col[i * 4 + 1] = g;
    col[i * 4 + 2] = b;
    col[i * 4 + 3] = a;
    baseA[i] = a;
    size[i] = s;
    life[i] = lifeS;
    maxLife[i] = lifeS;
    grow[i] = opts.grow ?? 1.2;
    drag[i] = opts.drag ?? 2.5;
    grav[i] = opts.grav ?? -3;
    seed[i] = rng();
    seedDirty = true;
  }

  // ── tracers ──
  const TR = 96;
  const trPos = new Float32Array(TR * 4 * 3);
  const trAlpha = new Float32Array(TR * 4);
  const trIdx = [];
  for (let i = 0; i < TR; i++) {
    const o = i * 4;
    trIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute("position", new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute("aAlpha", new THREE.BufferAttribute(trAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  trGeo.setIndex(trIdx);
  const trMat = new THREE.ShaderMaterial({
    vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(vec3(4.0, 2.6, 1.2) * vA, vA); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trMesh = new THREE.Mesh(trGeo, trMat);
  trMesh.frustumCulled = false;
  trMesh.userData.tag = "tracer";
  scene.add(trMesh);
  const tracers = [];

  // ── muzzle flashes in the world (bots) ──
  const flashTex = makeFlashTexture();
  const flashes = [];
  for (let i = 0; i < 16; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: new THREE.Color(6, 4, 2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.visible = false;
    s.userData.tag = "muzzle-flash";
    scene.add(s);
    flashes.push({ s, t: 0 });
  }
  let flashHead = 0;

  const camPos = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const side = new THREE.Vector3();
  const view = new THREE.Vector3();
  const api = {
    points,
    reset(seed) {
      rng = makeRng(seed * 31 + 7);
      life.fill(0);
      tracers.length = 0;
    },
    /** Snow spray off the edges of a carving/skidding rider. */
    spray(r, dt) {
      if (r.grind) {
        // Grinding: sparks off a rail (hot, fast, falling), a dusting of snow off a box.
        const rail = r.grind.f.type === "rail";
        const n = Math.floor((rail ? 70 : 18) * dt * Math.min(1.5, r.speed / 8) + rng());
        for (let i = 0; i < n; i++) {
          if (rail) emit(r.p.x, r.p.y + 0.03, r.p.z, -r.v.x * (0.2 + rng() * 0.4) + (rng() - 0.5) * 3, 0.5 + rng() * 2.5, -r.v.z * (0.2 + rng() * 0.4) + (rng() - 0.5) * 3, 0.025 + rng() * 0.02, 7, 4, 1.6, 1, 0.22 + rng() * 0.2, { grow: 0.3, drag: 0.8, grav: -9.8 });
          else emit(r.p.x + (rng() - 0.5) * 0.4, r.p.y + 0.05, r.p.z + (rng() - 0.5) * 0.4, (rng() - 0.5) * 1.5, 0.5 + rng(), (rng() - 0.5) * 1.5, 0.15 + rng() * 0.15, 1, 1, 1, 0.5, 0.5, { grow: 2, drag: 2, grav: -3 });
        }
        return;
      }
      if (!r.grounded || r.speed < 4) return;
      const powder = r.powder || 0;
      const amount = (r.edge * 0.7 + r.skid * 1.5 + powder * 0.9) * Math.min(1, r.speed / 20);
      const n = Math.floor(amount * 70 * dt + rng());
      // Powder roost: a plume kicked up behind the rider.
      const roost = Math.floor(powder * Math.min(1, r.speed / 18) * 45 * dt + rng() * powder);
      for (let i = 0; i < roost; i++) {
        emit(
          r.p.x - r.v.x * 0.04 + (rng() - 0.5) * 0.5,
          r.p.y + 0.1,
          r.p.z - r.v.z * 0.04 + (rng() - 0.5) * 0.5,
          r.v.x * (0.15 + rng() * 0.25) + (rng() - 0.5) * 1.5,
          1.5 + rng() * 2.5,
          r.v.z * (0.15 + rng() * 0.25) + (rng() - 0.5) * 1.5,
          0.45 + rng() * 0.6,
          1,
          1,
          1,
          0.5,
          0.9 + rng() * 0.9,
          { grow: 2.6, drag: 1.6, grav: -1.2 },
        );
      }
      const rx = Math.cos(r.heading);
      const rz = -Math.sin(r.heading);
      const side = r.lean >= 0 ? -1 : 1; // spray flies to the outside of the turn
      for (let i = 0; i < n; i++) {
        const sp = r.speed * (0.25 + rng() * 0.35);
        emit(
          r.p.x + (rng() - 0.5) * 0.6,
          r.p.y + 0.05,
          r.p.z + (rng() - 0.5) * 0.6,
          r.v.x * 0.5 + rx * side * sp * 0.6 + (rng() - 0.5) * 2,
          1.5 + rng() * 3 + r.skid * 2,
          r.v.z * 0.5 + rz * side * sp * 0.6 + (rng() - 0.5) * 2,
          0.25 + rng() * 0.35,
          1,
          1,
          1,
          0.75,
          0.5 + rng() * 0.6,
          { grow: 2.4, drag: 2.2, grav: -6 },
        );
      }
    },
    /** A burst of powder (landings, crashes). */
    burst(x, y, z, strength = 1) {
      const n = Math.round(30 * strength);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const sp = (1 + rng() * 4) * strength;
        emit(x, y + 0.1, z, Math.cos(a) * sp, 1 + rng() * 3 * strength, Math.sin(a) * sp, 0.4 + rng() * 0.6, 1, 1, 1, 0.7, 0.7 + rng() * 0.8, { grow: 2.8, drag: 2.5, grav: -2.5 });
      }
    },
    impact(x, y, z, kind) {
      if (kind === "snow") {
        // A burst column, a ring of chunks and a lingering haze.
        for (let i = 0; i < 9; i++) emit(x, y + 0.05, z, (rng() - 0.5) * 1.2, 2.5 + rng() * 3.5, (rng() - 0.5) * 1.2, 0.2 + rng() * 0.25, 1, 1, 1, 0.9, 0.55 + rng() * 0.35, { grow: 2.2, drag: 3, grav: -6 });
        for (let i = 0; i < 8; i++) {
          const a = rng() * Math.PI * 2;
          emit(x, y + 0.05, z, Math.cos(a) * (2 + rng() * 2), 1 + rng() * 2, Math.sin(a) * (2 + rng() * 2), 0.07 + rng() * 0.06, 0.95, 0.97, 1, 1, 0.5 + rng() * 0.3, { grow: 0.8, drag: 1.2, grav: -9.8 });
        }
        for (let i = 0; i < 3; i++) emit(x, y + 0.2, z, (rng() - 0.5) * 0.5, 0.3 + rng() * 0.3, (rng() - 0.5) * 0.5, 0.5 + rng() * 0.4, 1, 1, 1, 0.22, 1.0, { grow: 2.2, drag: 1.5, grav: -0.2 });
      } else if (kind === "tree") {
        for (let i = 0; i < 9; i++) emit(x, y, z, (rng() - 0.5) * 4, rng() * 3, (rng() - 0.5) * 4, 0.06 + rng() * 0.08, 0.33, 0.24, 0.15, 1, 0.7, { grow: 0.6, drag: 1, grav: -9 });
        // The hit knocks snow off the branches above: it pours down in a soft curtain.
        for (let i = 0; i < 16; i++) emit(x + (rng() - 0.5) * 1.6, y + 0.5 + rng() * 2.5, z + (rng() - 0.5) * 1.6, (rng() - 0.5) * 0.6, -0.5 - rng(), (rng() - 0.5) * 0.6, 0.25 + rng() * 0.35, 1, 1, 1, 0.75, 1.3 + rng() * 0.8, { grow: 1.8, drag: 1.4, grav: -3.5 });
      } else if (kind === "flesh") {
        for (let i = 0; i < 6; i++) emit(x, y, z, (rng() - 0.5) * 2.5, rng() * 1.5, (rng() - 0.5) * 2.5, 0.12 + rng() * 0.15, 0.5, 0.03, 0.03, 0.85, 0.32, { grow: 1.7, drag: 3, grav: -4 });
        // Down feathers from the puffy jacket, drifting slowly in the breeze.
        for (let i = 0; i < 10; i++) emit(x, y, z, (rng() - 0.5) * 3, 0.5 + rng() * 2, (rng() - 0.5) * 3, 0.05 + rng() * 0.04, 0.98, 0.98, 1, 0.95, 1.6 + rng() * 1.2, { grow: 1, drag: 3.5, grav: -0.6 });
      } else if (kind === "helmet") {
        // A hard ping: bright sparks, a few shell chips, a little white shock puff.
        for (let i = 0; i < 10; i++) emit(x, y, z, (rng() - 0.5) * 7, rng() * 4.5, (rng() - 0.5) * 7, 0.03 + rng() * 0.02, 7, 4.5, 2, 1, 0.16 + rng() * 0.12, { grow: 0.4, drag: 1.2, grav: -9.8 });
        for (let i = 0; i < 5; i++) emit(x, y, z, (rng() - 0.5) * 3, 1 + rng() * 2, (rng() - 0.5) * 3, 0.04 + rng() * 0.03, 0.15, 0.16, 0.18, 1, 0.7, { grow: 0.9, drag: 0.6, grav: -9.8 });
        emit(x, y, z, 0, 0.2, 0, 0.22, 1.4, 1.4, 1.4, 0.6, 0.12, { grow: 6, drag: 4, grav: 0 });
        for (let i = 0; i < 4; i++) emit(x, y, z, (rng() - 0.5) * 2.5, 0.5 + rng() * 1.5, (rng() - 0.5) * 2.5, 0.05 + rng() * 0.04, 0.98, 0.98, 1, 0.95, 1.4 + rng(), { grow: 1, drag: 3.5, grav: -0.6 });
      } else if (kind === "metal") {
        for (let i = 0; i < 8; i++) emit(x, y, z, (rng() - 0.5) * 6, rng() * 4, (rng() - 0.5) * 6, 0.04, 6, 3.5, 1.4, 1, 0.18, { grow: 0.5, drag: 1, grav: -9 });
      }
    },
    smoke(x, y, z) {
      for (let i = 0; i < 2; i++) emit(x, y, z, (rng() - 0.5) * 0.4, 0.3 + rng() * 0.4, (rng() - 0.5) * 0.4, 0.15, 0.85, 0.85, 0.85, 0.25, 0.6, { grow: 3, drag: 1, grav: 0.3 });
    },
    tracer(x0, y0, z0, x1, y1, z1) {
      tracers.push({ x0, y0, z0, x1, y1, z1, t: 0 });
      if (tracers.length > TR) tracers.shift();
    },
    muzzle(x, y, z, scale = 0.6) {
      const f = flashes[flashHead];
      flashHead = (flashHead + 1) % flashes.length;
      f.s.position.set(x, y, z);
      f.s.scale.setScalar(scale * (0.8 + rng() * 0.4));
      f.s.material.rotation = rng() * Math.PI * 2;
      f.s.visible = true;
      f.t = 0.05;
    },
    update(dt, camera) {
      camPos.copy(camera.position);
      for (let i = 0; i < MAX; i++) {
        if (life[i] <= 0) {
          if (col[i * 4 + 3] !== 0) col[i * 4 + 3] = 0;
          continue;
        }
        life[i] -= dt;
        const k = Math.exp(-drag[i] * dt);
        vel[i * 3] *= k;
        vel[i * 3 + 1] = vel[i * 3 + 1] * k + grav[i] * dt;
        vel[i * 3 + 2] *= k;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        size[i] *= 1 + (grow[i] - 1) * dt;
        const f = Math.max(0, life[i] / maxLife[i]);
        col[i * 4 + 3] = baseA[i] * Math.min(1, f * 1.6);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      if (seedDirty) {
        geo.attributes.aSeed.needsUpdate = true;
        seedDirty = false;
      }
      // Tracers: camera-facing quads.
      let n = 0;
      for (let i = tracers.length - 1; i >= 0; i--) {
        const t = tracers[i];
        t.t += dt;
        if (t.t > 0.07) {
          tracers.splice(i, 1);
          continue;
        }
        // A short bright slug travelling along the line.
        const len = Math.hypot(t.x1 - t.x0, t.y1 - t.y0, t.z1 - t.z0);
        const head = Math.min(1, (t.t / 0.07) * 1.2 + 0.15);
        const tail = Math.max(0, head - Math.min(0.6, 25 / Math.max(len, 1)));
        tmpA.set(t.x0 + (t.x1 - t.x0) * tail, t.y0 + (t.y1 - t.y0) * tail, t.z0 + (t.z1 - t.z0) * tail);
        tmpB.set(t.x0 + (t.x1 - t.x0) * head, t.y0 + (t.y1 - t.y0) * head, t.z0 + (t.z1 - t.z0) * head);
        view.copy(tmpA).sub(camPos);
        side.copy(tmpB).sub(tmpA).cross(view).normalize().multiplyScalar(0.025 + 0.0015 * view.length());
        const o = n * 12;
        trPos[o] = tmpA.x + side.x;
        trPos[o + 1] = tmpA.y + side.y;
        trPos[o + 2] = tmpA.z + side.z;
        trPos[o + 3] = tmpA.x - side.x;
        trPos[o + 4] = tmpA.y - side.y;
        trPos[o + 5] = tmpA.z - side.z;
        trPos[o + 6] = tmpB.x - side.x;
        trPos[o + 7] = tmpB.y - side.y;
        trPos[o + 8] = tmpB.z - side.z;
        trPos[o + 9] = tmpB.x + side.x;
        trPos[o + 10] = tmpB.y + side.y;
        trPos[o + 11] = tmpB.z + side.z;
        const a = 1 - t.t / 0.07;
        trAlpha.fill(a, n * 4, n * 4 + 4);
        n++;
      }
      trGeo.setDrawRange(0, n * 6);
      trGeo.attributes.position.needsUpdate = true;
      trGeo.attributes.aAlpha.needsUpdate = true;
      for (const f of flashes) {
        if (!f.s.visible) continue;
        f.t -= dt;
        if (f.t <= 0) f.s.visible = false;
      }
    },
    activeCount() {
      let c = 0;
      for (let i = 0; i < MAX; i++) if (life[i] > 0) c++;
      return c;
    },
  };
  return api;
}

function makeFlashTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 60);
  grad.addColorStop(0, "rgba(255,255,230,1)");
  grad.addColorStop(0.25, "rgba(255,200,90,0.9)");
  grad.addColorStop(1, "rgba(255,120,20,0)");
  g.fillStyle = grad;
  g.translate(64, 64);
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    g.beginPath();
    g.moveTo(-6, 0);
    g.lineTo(0, -60);
    g.lineTo(6, 0);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
