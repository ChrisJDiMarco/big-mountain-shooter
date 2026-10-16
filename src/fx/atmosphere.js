/**
 * Atmosphere touches: a sun lens flare (occluded by terrain/trees like a real lens) and
 * "diamond dust" — sparse ice crystals drifting around the camera that glint in the low sun.
 */
import * as THREE from "three";
import { SUN_DIR } from "../world/sky.js";
import { makeRng } from "../core/noise.js";

export function createAtmosphere(scene) {
  // Diamond dust: points in a box around the camera, wrapped as it moves.
  const N = 700;
  const BOX = 28;
  const rng = makeRng(77);
  const base = new Float32Array(N * 3);
  const phase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    base[i * 3] = (rng() - 0.5) * BOX;
    base[i * 3 + 1] = (rng() - 0.5) * BOX * 0.6;
    base[i * 3 + 2] = (rng() - 0.5) * BOX;
    phase[i] = rng() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(base, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uSun: { value: SUN_DIR.clone() }, uBox: { value: BOX } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform vec3 uCam;
      uniform float uTime;
      uniform vec3 uSun;
      uniform float uBox;
      varying float vGlint;
      void main() {
        // Drift down and with the breeze, wrapped into a box that follows the camera.
        vec3 p = position + vec3(uTime * 0.35, -uTime * 0.25, uTime * 0.18);
        p.y += sin(uTime * 0.7 + aPhase) * 0.4;
        vec3 rel = mod(p - uCam + uBox * 0.5, vec3(uBox, uBox * 0.6, uBox)) - vec3(uBox * 0.5, uBox * 0.3, uBox * 0.5);
        vec3 world = uCam + rel;
        vec4 mv = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        // Crystals glint when their (random) facet lines up between the sun and the eye.
        vec3 view = normalize(world - uCam);
        float facing = max(0.0, dot(view, uSun));
        float tw = 0.5 + 0.5 * sin(uTime * 9.0 + aPhase * 7.0);
        vGlint = (0.25 + 1.6 * pow(facing, 3.0)) * tw;
        gl_PointSize = clamp((1.0 + 2.2 * vGlint) * 22.0 / max(1.0, -mv.z), 1.0, 4.5);
      }`,
    fragmentShader: /* glsl */ `
      varying float vGlint;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vec3(1.15, 1.1, 1.0) * (0.35 + vGlint), a * min(1.0, 0.2 + vGlint * 0.55));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(geo, mat);
  dust.frustumCulled = false;
  dust.userData.tag = "diamond-dust";
  scene.add(dust);

  const sunPos = new THREE.Vector3();
  let vis = 0;
  return {
    /**
     * Per frame. `occluded(origin, dir)` → true when terrain/trees block the sun. Returns the
     * sun's screen position (uv) and a smoothed visibility for the lens flare in the final pass.
     */
    update(camera, time, dt, occluded) {
      mat.uniforms.uCam.value.copy(camera.position);
      mat.uniforms.uTime.value = time;
      sunPos.copy(camera.position).addScaledVector(SUN_DIR, 1000).project(camera);
      const onScreen = sunPos.z < 1 && Math.abs(sunPos.x) < 1.3 && Math.abs(sunPos.y) < 1.3;
      const target = onScreen && !occluded(camera.position, SUN_DIR) ? 1 : 0;
      vis += (target - vis) * Math.min(1, dt * 10);
      return { u: sunPos.x * 0.5 + 0.5, v: sunPos.y * 0.5 + 0.5, vis: onScreen ? vis : 0 };
    },
  };
}
