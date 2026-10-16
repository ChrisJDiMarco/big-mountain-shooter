/**
 * Rendering pipeline: world (MSAA, HDR) → first-person viewmodel on top (depth cleared) →
 * bloom → final grade (ACES, split toning, vignette, speed blur, damage edges) to the screen.
 *
 * Also installs the aerial-perspective fog for every built-in material: exponential height fog
 * whose colour warms toward the low sun, so distant ridges melt into the golden-hour haze.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SUN_DIR } from "../world/sky.js";

/** Replace three's fog chunks with height + sun-scattering haze (call before any material compiles). */
export function installAtmosphereFog() {
  const v = (x) => x.toFixed(5);
  const sunDir = `vec3(${v(SUN_DIR.x)}, ${v(SUN_DIR.y)}, ${v(SUN_DIR.z)})`;
  THREE.ShaderChunk.fog_pars_vertex = "#ifdef USE_FOG\n varying vec3 vFogView;\n#endif";
  THREE.ShaderChunk.fog_vertex = "#ifdef USE_FOG\n vFogView = mvPosition.xyz;\n#endif";
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3 vFogView;
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  {
    float fDist = length(vFogView);
    vec3 fDir = (transpose(mat3(viewMatrix)) * vFogView) / max(fDist, 1e-4);
    float fb = fogFar;
    float fa = fogNear * exp(-fb * cameraPosition.y);
    float fy = fDir.y * fDist * fb;
    float integ = abs(fy) > 1e-4 ? (1.0 - exp(-fy)) / fy : 1.0;
    float fogAmt = fa * fDist * integ;
    float fogFactor = 1.0 - exp(-fogAmt);
    float sunAmt = pow(max(dot(fDir, ${sunDir}), 0.0), 8.0);
    vec3 fCol = mix(fogColor, vec3(1.0, 0.74, 0.5), sunAmt * 0.7);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fCol, fogFactor);
  }
#endif`;
}

/** THREE.Fog repurposed: near = density per metre at y=0, far = height falloff per metre. */
export function makeFog() {
  return new THREE.Fog(new THREE.Color(0.5, 0.62, 0.8), 1 / 30000, 1 / 1900);
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 0.62 },
    saturation: { value: 1.08 },
    contrast: { value: 1.06 },
    vignette: { value: 0.28 },
    speedBlur: { value: 0 },
    damage: { value: 0 },
    time: { value: 0 },
    scope: { value: 0 },
    aspect: { value: 1.6 },
    sunUv: { value: new THREE.Vector2(0.5, 0.5) },
    sunVis: { value: 0 },
    tRays: { value: null },
    rays: { value: 0 },
    lowHealth: { value: 0 },
    texel: { value: new THREE.Vector2(1 / 1600, 1 / 1000) },
    lensSnow: { value: 0 },
    lensSeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float exposure, saturation, contrast, vignette, speedBlur, damage, time, scope, aspect;
    uniform vec2 sunUv;
    uniform float sunVis;
    uniform sampler2D tRays;
    uniform float rays;
    uniform float lowHealth;
    uniform vec2 texel;
    uniform float lensSnow, lensSeed;
    // Soft round blobs scattered on a jittered grid (one per cell, some cells empty): snow clumps
    // stuck to the goggles, or the smudges on the lens that light up against the sun.
    vec2 blobHash(vec2 c, float seed) {
      return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3))) + seed) * 43758.5453);
    }
    float blobs(vec2 p, float seed, float fill, float rMin, float rMax) {
      vec2 cell = floor(p);
      float acc = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = cell + vec2(float(i), float(j));
          vec2 h = blobHash(c, seed);
          if (fract(h.x * 13.7 + h.y * 7.1) > fill) continue;
          float r = mix(rMin, rMax, fract(h.y * 5.3));
          float d = length(p - (c + 0.2 + h * 0.6));
          acc = max(acc, smoothstep(r, r * 0.35, d) * (0.6 + 0.4 * fract(h.x * 3.1)));
        }
      }
      return acc;
    }
    // Snow clumps: a few metaballs per cell merge into organic lumps, with a faint refraction rim.
    vec2 clumps(vec2 p, float seed, float fill, float rMin, float rMax) {
      vec2 cell = floor(p);
      float field = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = cell + vec2(float(i), float(j));
          vec2 h = blobHash(c, seed);
          if (fract(h.x * 13.7 + h.y * 7.1) > fill) continue;
          float r = mix(rMin, rMax, fract(h.y * 5.3));
          vec2 o = c + 0.25 + h * 0.5;
          for (int k = 0; k < 3; k++) {
            vec2 hk = blobHash(c + float(k) * 17.0, seed + 1.7);
            vec2 ok = o + (k == 0 ? vec2(0.0) : (hk - 0.5) * r * 1.5);
            float rk = r * (k == 0 ? 1.0 : 0.4 + 0.35 * hk.x);
            vec2 q = p - ok;
            float f = rk * rk / (dot(q, q) + 1e-4);
            field += f * f;
          }
        }
      }
      float core = smoothstep(1.0, 3.0, field);
      float rim = smoothstep(0.55, 1.0, field) * (1.0 - core);
      return vec2(core, rim);
    }
    vec3 lensFlare(vec2 uv) {
      if (sunVis < 0.01) return vec3(0.0);
      vec2 d = (uv - sunUv) * vec2(aspect, 1.0);
      float r = length(d);
      vec3 col = vec3(1.0, 0.75, 0.45) * (0.5 * exp(-r * 9.0) + 0.12 * exp(-r * 2.5));
      // Six-point starburst.
      float ang = atan(d.y, d.x);
      float star = pow(abs(cos(ang * 3.0)), 60.0) * exp(-r * 5.0) * 0.6;
      col += vec3(1.0, 0.85, 0.65) * star;
      // Ghosts mirrored through the screen centre.
      vec2 axis = vec2(0.5) - sunUv;
      for (int i = 0; i < 4; i++) {
        float t = 0.45 + float(i) * 0.38;
        float size = 0.03 + 0.025 * float(i % 3);
        vec2 gp = sunUv + axis * t * 2.0;
        float gd = length((uv - gp) * vec2(aspect, 1.0));
        float ring = smoothstep(size, size * 0.8, gd) * (0.35 + 0.65 * smoothstep(0.0, size, gd));
        vec3 tint = i == 1 ? vec3(0.45, 0.65, 1.0) : i == 2 ? vec3(1.0, 0.55, 0.3) : vec3(0.9, 0.8, 0.6);
        col += tint * ring * 0.08;
      }
      return col * sunVis;
    }
    varying vec2 vUv;
    vec3 aces(vec3 x) {
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 vc0 = (uv - 0.5) * vec2(aspect, 1.0);
      // Lens chromatic aberration toward the edges (more when hurt).
      float ca = (0.0012 + damage * 0.004) * dot(vc0, vc0);
      vec3 col = vec3(texture2D(tDiffuse, uv + vc0 * ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - vc0 * ca).b);
      // Crisp it up: a light unsharp mask.
      // Done on Reinhard-compressed values so a hot pixel (a sun glint) can't carve a black halo.
      vec3 s1 = texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb;
      vec3 s2 = texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb;
      vec3 s3 = texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb;
      vec3 s4 = texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
      vec3 nbc = (s1 / (1.0 + s1) + s2 / (1.0 + s2) + s3 / (1.0 + s3) + s4 / (1.0 + s4)) * 0.25;
      col = max(col, vec3(0.0));
      vec3 cc = col / (1.0 + col);
      cc = clamp(cc + (cc - nbc) * 0.3, 0.0, 0.995);
      col = cc / (1.0 - cc);
      if (speedBlur > 0.001) {
        vec2 dir = uv - vec2(0.5, 0.52);
        float m = smoothstep(0.12, 0.75, length(dir * vec2(aspect, 1.0)) * 0.7) * speedBlur;
        vec3 acc = col;
        for (int i = 1; i < 8; i++) acc += texture2D(tDiffuse, uv - dir * m * float(i) * 0.011).rgb;
        col = acc / 8.0;
      }
      // Light shafts (sun rays through trees and over ridges), warm.
      col += texture2D(tRays, uv).rgb * rays * vec3(1.0, 0.78, 0.55);
      col += lensFlare(uv) / max(exposure, 0.05);
      // Lens dirt: faint smudges that only show when the sun shines across the glass.
      if (sunVis > 0.01) {
        vec2 sd = (uv - sunUv) * vec2(aspect, 1.0);
        float glow = sunVis * exp(-length(sd) * 3.0);
        if (glow > 0.01) {
          float dirt = blobs(uv * vec2(aspect, 1.0) * 7.0, 3.7, 0.55, 0.12, 0.42) * 0.7 + blobs(uv * vec2(aspect, 1.0) * 17.0, 9.1, 0.4, 0.1, 0.35) * 0.4;
          col += vec3(1.0, 0.82, 0.6) * dirt * glow * 0.45 / max(exposure, 0.05);
        }
      }
      col *= exposure;
      col = aces(col);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col = clamp((col - 0.5) * contrast + 0.5, 0.0, 1.0);
      // Split toning: warm highlights, cool shadows.
      col += vec3(0.025, 0.012, -0.012) * smoothstep(0.45, 1.0, l);
      col += vec3(-0.012, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.45, l));
      vec2 vc = (uv - 0.5) * vec2(aspect, 1.0);
      // Snow on the goggles after a wipe-out or a deep-powder landing: clumps, heavier at the edges.
      if (lensSnow > 0.001) {
        // Mostly round the edges of the goggles; the centre stays (nearly) clear to aim through.
        float edge = smoothstep(0.22, 0.85, length(vc));
        vec2 big = clumps(uv * vec2(aspect, 1.0) * 4.0, lensSeed, 0.55, 0.2, 0.48);
        vec2 small = clumps(uv * vec2(aspect, 1.0) * 11.0, lensSeed + 4.3, 0.4, 0.15, 0.42);
        float w = mix(0.06, 1.0, edge);
        // As it melts, the clumps shrink (threshold rises) rather than just fading.
        float melt = 1.0 - lensSnow;
        float sn = clamp((max(big.x, small.x * 0.8) * w - melt * 0.55) / max(0.2, 1.0 - melt * 0.55), 0.0, 1.0);
        float rim = max(big.y, small.y * 0.7) * w * lensSnow;
        col *= 1.0 - rim * 0.18;
        col = mix(col, vec3(0.92, 0.95, 1.0), sn * 0.88);
      }
      float vig = smoothstep(1.05, 0.25, length(vc) * 0.9);
      col *= mix(1.0 - vignette, 1.0, vig);
      col = mix(col, vec3(0.5, 0.02, 0.02), clamp(damage, 0.0, 1.0) * (1.0 - vig) * 0.85);
      // Low health drains the colour.
      float lg = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(lg), clamp(lowHealth, 0.0, 1.0) * 0.6);
      // Sniper scope: black outside a circle.
      if (scope > 0.001) {
        float r = length(vc);
        float ring = smoothstep(0.43, 0.425, r);
        col *= mix(1.0, ring, scope);
      }
      col = clamp(col, 0.0, 1.0);
      col = toSRGB(col);
      col += (rand(uv * 711.0 + time) - 0.5) * 0.012;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/**
 * Screen-space light shafts (GPU Gems 3, ch. 13): sky pixels around the sun (depth = far plane)
 * are marched toward the sun's screen position at quarter resolution, so ridges and tree
 * silhouettes cut warm beams through the haze. Runs right after the world render, before the
 * viewmodel pass clears the depth.
 */
class GodRayPass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width >> 2), Math.max(1, height >> 2), { type: THREE.HalfFloatType });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        sunUv: { value: new THREE.Vector2(0.5, 0.5) },
        aspect: { value: 1.6 },
        strength: { value: 0 },
      },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 sunUv;
        uniform float aspect;
        uniform float strength;
        varying vec2 vUv;
        float occ(vec2 uv) {
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
          float d = texture2D(tDepth, uv).x;
          if (d < 0.99999) return 0.0;
          // Only bright sky near the sun feeds the beams.
          float r = length((uv - sunUv) * vec2(aspect, 1.0));
          vec3 c = texture2D(tColor, uv).rgb;
          return smoothstep(0.55, 0.0, r) * min(dot(c, vec3(0.3333)), 4.0);
        }
        void main() {
          if (strength <= 0.001) { gl_FragColor = vec4(0.0); return; }
          vec2 delta = (vUv - sunUv) / 48.0;
          vec2 p = vUv;
          float illum = 1.0;
          float acc = 0.0;
          for (int i = 0; i < 48; i++) {
            p -= delta;
            acc += occ(p) * illum;
            illum *= 0.955;
          }
          gl_FragColor = vec4(vec3(acc / 48.0) * strength, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  setSize(width, height) {
    this.target.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
  }
  render(renderer, writeBuffer, readBuffer) {
    if (!readBuffer.depthTexture) return;
    this.material.uniforms.tColor.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    // The next pass (the viewmodel) clears depth on whatever target is bound: hand it back.
    renderer.setRenderTarget(readBuffer);
  }
}

/** Records the world render's draw counts the moment it finishes (before later passes reset them). */
class WorldPass extends RenderPass {
  constructor(scene, camera, stats) {
    super(scene, camera);
    this.stats = stats;
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.stats.calls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
  }
}

export function createPipeline(renderer, scene, camera, viewScene, viewCamera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const depth = new THREE.DepthTexture(size.x, size.y);
  depth.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: depth,
  });
  const composer = new EffectComposer(renderer, rt);
  const stats = { calls: 0, triangles: 0 };
  const world = new WorldPass(scene, camera, stats);
  composer.addPass(world);
  const godRays = new GodRayPass(size.x, size.y);
  composer.addPass(godRays);
  const vm = new RenderPass(viewScene, viewCamera);
  vm.clear = false;
  vm.clearDepth = true;
  composer.addPass(vm);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.22, 0.4, 2.2);
  composer.addPass(bloom);
  const final = new ShaderPass(FinalShader);
  final.uniforms.tRays.value = godRays.target.texture;
  composer.addPass(final);
  return {
    composer,
    stats,
    final,
    bloom,
    godRays,
    setSize(w, h) {
      composer.setSize(w, h);
      final.uniforms.aspect.value = w / Math.max(1, h);
      godRays.material.uniforms.aspect.value = w / Math.max(1, h);
      const px = renderer.getPixelRatio();
      final.uniforms.texel.value.set(1 / (w * px), 1 / (h * px));
    },
    /** Sun screen position (uv) and visibility for the shafts. */
    setSun(u, v, strength) {
      godRays.material.uniforms.sunUv.value.set(u, v);
      godRays.material.uniforms.strength.value = strength;
      final.uniforms.rays.value = strength > 0 ? 1 : 0;
    },
    render(dt) {
      composer.render(dt);
    },
  };
}
