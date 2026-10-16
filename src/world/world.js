/**
 * Builds the whole static world once at boot: mountain + runs, terrain chunks, far ranges,
 * forest, sky, sun, baked shadows, fog, park features, lift, props.
 */
import * as THREE from "three";
import { buildMountain, makeSampler, landscapeHeight, MAP } from "./mountain.js";
import { createTerrain } from "./terrain.js";
import { createFarTerrain } from "./far.js";
import { createFarTrees } from "./farTrees.js";
import { scatterTrees, createForest } from "./trees.js";
import { createSky, createLights, bakeEnvironment } from "./sky.js";
import { bakeSunVisibility, SUNVIS } from "./shading.js";
import { makeFog } from "../fx/post.js";

/** The chairlift line (base → summit), used to clear trees now and to build the lift later. */
export const LIFT = {
  base: { x: 135, z: 1085 },
  top: { x: 88, z: -1175 },
  distance(x, z) {
    const ax = this.base.x;
    const az = this.base.z;
    const bx = this.top.x - ax;
    const bz = this.top.z - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz)));
    return Math.hypot(x - (ax + bx * t), z - (az + bz * t));
  },
};

export function buildWorld(scene, renderer) {
  const t0 = performance.now();
  const timings = {};
  const mark = (name) => {
    timings[name] = Math.round(performance.now() - t0);
  };
  const mountain = buildMountain();
  mark("mountain");
  const sampler = makeSampler(mountain);
  const treeData = scatterTrees(mountain, sampler, { liftLine: LIFT });
  mark("scatter");
  bakeSunVisibility(mountain, landscapeHeight, treeData);
  mark("bake");
  const terrain = createTerrain(scene, mountain);
  mark("terrain");
  const far = createFarTerrain(scene);
  mark("far");
  const farTrees = createFarTrees(scene);
  mark("farTrees");
  const forest = createForest(scene, treeData);
  mark("forest");
  const sky = createSky(scene);
  const lights = createLights(scene);
  scene.environment = bakeEnvironment(renderer);
  scene.environmentIntensity = 0.6;
  scene.fog = makeFog();
  mark("sky");

  const ahead = new THREE.Vector3();
  return {
    mountain,
    sampler,
    terrain,
    far,
    forest,
    sky,
    lights,
    timings,
    treeCount: treeData.count,
    farTreeCount: farTrees.count,
    /** Per-frame: LODs, shadow frustum, shared uniforms. */
    update(camera, time) {
      terrain.update(camera);
      forest.fill(camera);
      sky.update(camera, time);
      camera.getWorldDirection(ahead);
      ahead.y = 0;
      ahead.normalize();
      lights.follow(camera.position, ahead);
      const sc = lights.sun.shadow.camera;
      SUNVIS.rtShadowCenter.value.copy(lights.sun.target.position);
      SUNVIS.rtShadowExtent.value = sc.right;
      // Light-space axes for the "inside the realtime shadow" test.
      const dir = lights.sun.position.clone().sub(lights.sun.target.position).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, dir).normalize();
      SUNVIS.rtShadowRight.value.copy(right);
      SUNVIS.rtShadowUp.value.crossVectors(dir, right).normalize();
      SUNVIS.uTime.value = time;
    },
    inBounds(x, z) {
      const b = MAP.bounds;
      return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
    },
  };
}
