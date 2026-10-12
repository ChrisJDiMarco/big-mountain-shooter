/** Empty project: renderer + studio instrumentation, with no game content or controls. */
import * as THREE from "three";
import { installStudio } from "./studio.js";

// ── FACET WIRING ──
// (facet imports and initialization go here)
// ── END FACET WIRING ──

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const renderStats = { calls: 0, triangles: 0 };

function resize() {
  const width = Math.max(1, innerWidth);
  const height = Math.max(1, innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const cameras = {
  default() {
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
  },
};

installStudio({
  canvas: renderer.domElement,
  scene,
  renderer,
  camera,
  input: { pointerLock: false },
  reset() {
    cameras.default();
  },
  update() {},
  render() {
    renderer.render(scene, camera);
    renderStats.calls = renderer.info.render.calls;
    renderStats.triangles = renderer.info.render.triangles;
  },
  probes() {
    return { phase: "empty", drawCalls: renderStats.calls, triangles: renderStats.triangles };
  },
  cameras,
});
