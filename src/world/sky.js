/**
 * Golden-hour sky: gradient, sun disk + glow, lit cumulus clouds. One shader used twice — the
 * visible dome (follows the camera) and an offline cube render that becomes the PBR environment
 * (so snow in shadow picks up the blue sky and metal picks up the warm horizon).
 */
import * as THREE from "three";

/** Direction TOWARD the sun: low in the south-west, so it hangs front-right when skiing down (+z). */
export const SUN_DIR = new THREE.Vector3(-0.62, 0.2, 0.76).normalize();
export const SUN_COLOR = new THREE.Color(1.0, 0.74, 0.5);

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // pin to the far plane
}`;

const skyFragment = /* glsl */ `
uniform vec3 sunDir;
uniform float time;
uniform float showSun;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  float sd = max(dot(d, sunDir), 0.0);
  // Azimuthal closeness to the sun (ignoring height) warms that side of the horizon.
  vec2 dh = normalize(d.xz + 1e-5);
  vec2 sh = normalize(sunDir.xz);
  float az = dot(dh, sh) * 0.5 + 0.5;

  vec3 zenith = vec3(0.075, 0.2, 0.52);
  vec3 upper = vec3(0.2, 0.4, 0.78);
  vec3 horizonCool = vec3(0.5, 0.63, 0.82);
  vec3 horizonWarm = vec3(1.05, 0.74, 0.5);
  vec3 horizon = mix(horizonCool, horizonWarm, pow(az, 3.0));
  float h = clamp(e, 0.0, 1.0);
  vec3 col = mix(horizon, upper, smoothstep(0.0, 0.28, h));
  col = mix(col, zenith, smoothstep(0.25, 0.95, h));
  // Below the horizon: a hazy continuation (mostly hidden by terrain).
  col = mix(col, horizon * 0.92, smoothstep(0.0, -0.08, e));

  // Sun glow (forward scattering) and disk.
  col += vec3(1.0, 0.6, 0.3) * (0.22 * pow(sd, 8.0) + 0.5 * pow(sd, 64.0));
  col += vec3(1.0, 0.8, 0.55) * 1.6 * pow(sd, 700.0);
  float disk = smoothstep(0.99955, 0.99975, sd);
  col += showSun * disk * vec3(40.0, 30.0, 20.0);

  // Clouds on a plane above the camera.
  if (e > 0.005) {
    vec2 uv = d.xz / (e + 0.08) * 1.4;
    uv += vec2(time * 0.004, time * 0.0015);
    float n = fbm(uv * 0.9);
    float n2 = fbm(uv * 2.4 + 3.1);
    float cov = smoothstep(0.5, 0.78, n * 0.75 + n2 * 0.35);
    // Fewer clouds high overhead and right at the horizon line.
    cov *= smoothstep(0.005, 0.07, e) * (1.0 - smoothstep(0.35, 0.8, e) * 0.7);
    // Light: sample toward the sun; denser there means a darker underside.
    vec2 toSun = normalize(sunDir.xz) * 0.06;
    float nl = fbm((uv + toSun) * 0.9) * 0.75 + fbm((uv + toSun) * 2.4 + 3.1) * 0.35;
    float lit = clamp(1.0 - (nl - (n * 0.75 + n2 * 0.35)) * 6.0, 0.0, 1.0);
    vec3 shadowCol = mix(vec3(0.42, 0.45, 0.58), vec3(0.6, 0.52, 0.55), az);
    vec3 litCol = mix(vec3(1.0, 0.92, 0.85), vec3(1.4, 0.9, 0.55), pow(az, 2.0));
    vec3 cloud = mix(shadowCol, litCol, lit * 0.8 + 0.2 * pow(sd, 4.0));
    cloud += vec3(1.2, 0.75, 0.4) * pow(sd, 12.0) * (1.0 - cov) * 2.0; // silver lining
    col = mix(col, cloud, cov * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function makeSkyMaterial({ showSun = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      sunDir: { value: SUN_DIR.clone() },
      time: { value: 0 },
      showSun: { value: showSun },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

/** The visible sky dome: centred on the camera each frame (see `update`). */
export function createSky(scene) {
  const material = makeSkyMaterial();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), material);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.userData.tag = "sky";
  scene.add(dome);
  return {
    dome,
    material,
    update(camera, time) {
      dome.position.copy(camera.position);
      material.uniforms.time.value = time;
    },
  };
}

/** Bake the sky into a PMREM environment (once, at boot). */
export function bakeEnvironment(renderer) {
  const envScene = new THREE.Scene();
  const material = makeSkyMaterial({ showSun: 0 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), material);
  envScene.add(dome);
  // A snowy "ground" hemisphere so downward reflections are bright snow, not sky.
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(90, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.62, 0.66, 0.74), side: THREE.BackSide }),
  );
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
  pmrem.dispose();
  material.dispose();
  return rt.texture;
}

/** Sun + fill lights; the sun's shadow camera follows a focus point (the player). */
export function createLights(scene) {
  const sun = new THREE.DirectionalLight(SUN_COLOR, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const ext = 85;
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.userData.tag = "light-sun";
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.68, 0.95), new THREE.Color(0.45, 0.42, 0.42), 0.12);
  hemi.userData.tag = "light-fill";
  scene.add(hemi);
  const snap = new THREE.Vector3();
  return {
    sun,
    hemi,
    /** Keep the shadow frustum centred just ahead of the focus, snapped to texels to stop shimmer. */
    follow(focus, ahead) {
      const texel = (ext * 2) / sun.shadow.mapSize.x;
      snap.copy(focus).addScaledVector(ahead, 25);
      // Snap in light space.
      const lightDir = SUN_DIR;
      const up = Math.abs(lightDir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, lightDir).normalize();
      const up2 = new THREE.Vector3().crossVectors(lightDir, right).normalize();
      const r = Math.round(snap.dot(right) / texel) * texel;
      const u = Math.round(snap.dot(up2) / texel) * texel;
      const f = snap.dot(lightDir);
      snap.copy(right).multiplyScalar(r).addScaledVector(up2, u).addScaledVector(lightDir, f);
      sun.target.position.copy(snap);
      sun.position.copy(snap).addScaledVector(lightDir, 450);
      sun.target.updateMatrixWorld();
    },
  };
}
