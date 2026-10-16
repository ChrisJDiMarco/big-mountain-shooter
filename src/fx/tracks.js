/**
 * Ski and board tracks: every grounded rider lays short quads behind it (two grooves for skis,
 * one wide one for a board) into a ring buffer. Each quad stores its birth time so the fade
 * happens in the shader — the CPU only writes new segments.
 */
import * as THREE from "three";

const MAX = 9000; // segments
const LIFE = 60; // seconds

export function createTracks(scene, ground) {
  const pos = new Float32Array(MAX * 4 * 3);
  const birth = new Float32Array(MAX * 4).fill(-1e6);
  const idx = new Uint32Array(MAX * 6);
  for (let i = 0; i < MAX; i++) {
    const o = i * 4;
    idx.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const birthAttr = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("aBirth", birthAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      attribute float aBirth;
      uniform float uTime;
      varying float vA;
      #include <fog_pars_vertex>
      void main() {
        float age = uTime - aBirth;
        vA = age < 0.0 ? 0.0 : (1.0 - smoothstep(${(LIFE * 0.5).toFixed(1)}, ${LIFE.toFixed(1)}, age));
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      #include <fog_pars_fragment>
      void main() {
        if (vA <= 0.01) discard;
        // A groove: shadowed blue snow, slightly darker than the surface around it.
        gl_FragColor = vec4(vec3(0.42, 0.5, 0.66), 0.3 * vA);
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.userData.tag = "ski-tracks";
  scene.add(mesh);

  let head = 0;
  const last = new Map(); // agent → {x, z, y}
  const dirty = { from: Infinity, to: -1 };

  function writeQuad(ax, az, bx, bz, half, t) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;
    const i = head;
    head = (head + 1) % MAX;
    const ya = ground.ground(ax, az) + 0.02;
    const yb = ground.ground(bx, bz) + 0.02;
    const o = i * 12;
    pos[o] = ax + nx;
    pos[o + 1] = ya;
    pos[o + 2] = az + nz;
    pos[o + 3] = ax - nx;
    pos[o + 4] = ya;
    pos[o + 5] = az - nz;
    pos[o + 6] = bx - nx;
    pos[o + 7] = yb;
    pos[o + 8] = bz - nz;
    pos[o + 9] = bx + nx;
    pos[o + 10] = yb;
    pos[o + 11] = bz + nz;
    birth.fill(t, i * 4, i * 4 + 4);
    dirty.from = Math.min(dirty.from, i);
    dirty.to = Math.max(dirty.to, i);
  }

  return {
    reset() {
      birth.fill(-1e6);
      last.clear();
      head = 0;
      dirty.from = 0;
      dirty.to = MAX - 1;
    },
    /** Lay track behind each grounded rider (call once per step). */
    update(agents, time) {
      mat.uniforms.uTime.value = time;
      for (const ag of agents) {
        const r = ag.rider;
        if (!ag.alive || !r.grounded || r.speed < 1.5) {
          last.delete(ag);
          continue;
        }
        const prev = last.get(ag);
        if (!prev) {
          last.set(ag, { x: r.p.x, z: r.p.z });
          continue;
        }
        const d = Math.hypot(r.p.x - prev.x, r.p.z - prev.z);
        if (d < 1.2) continue;
        if (d > 6) {
          prev.x = r.p.x;
          prev.z = r.p.z;
          continue;
        }
        if (r.kind === "board") {
          writeQuad(prev.x, prev.z, r.p.x, r.p.z, 0.14, time);
        } else {
          // Two grooves either side of the centre line, perpendicular to travel.
          const dx = r.p.x - prev.x;
          const dz = r.p.z - prev.z;
          const len = Math.hypot(dx, dz) || 1;
          const ox = (-dz / len) * 0.12;
          const oz = (dx / len) * 0.12;
          writeQuad(prev.x + ox, prev.z + oz, r.p.x + ox, r.p.z + oz, 0.045, time);
          writeQuad(prev.x - ox, prev.z - oz, r.p.x - ox, r.p.z - oz, 0.045, time);
        }
        prev.x = r.p.x;
        prev.z = r.p.z;
      }
      if (dirty.to >= 0) {
        // Ring buffer wraps: upload the whole touched span (simple + rare wraps).
        const from = dirty.from;
        const to = dirty.to;
        posAttr.clearUpdateRanges();
        birthAttr.clearUpdateRanges();
        posAttr.addUpdateRange(from * 12, (to - from + 1) * 12);
        birthAttr.addUpdateRange(from * 4, (to - from + 1) * 4);
        posAttr.needsUpdate = true;
        birthAttr.needsUpdate = true;
        dirty.from = Infinity;
        dirty.to = -1;
      }
    },
  };
}
