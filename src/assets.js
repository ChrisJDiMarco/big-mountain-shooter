/**
 * Assets — harness-owned like `materials.js`, never a facet's file (AG-930). The door through
 * which files made by studio tools (Blender first) enter a game. Nothing here downloads:
 * `assets/<name>.glb` is committed with the game, served by the studio and copied by export.
 *
 *   import { loadAsset } from "./assets.js";
 *   const dog = await loadAsset("dog", { tag: "dog", scale: 0.6 });   // a Group tagged "dog"
 *   scene.add(dog);
 *
 * Every mesh inside carries `userData.asset = name`, so a scene check can tell a modelled
 * object from one built out of primitives; every material carries it too. A Blender material
 * is usually a Principled colour with no texture, and a mesh with no `map` is an untextured
 * box to the materials checks — so `loadAsset` gives every asset material without a map a
 * baked one from `materials.js` (the GLB's own colour as the palette, seeded by the asset
 * name), or the `material` you ask for. Deterministic: the same file gives the same scene.
 * Load before the first frame (`await preloadAssets([...])` in your setup) so checks never see
 * a half-built world.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { KINDS, bakeTexture } from "./materials.js";

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
/** Call once after creating the renderer before loading Genex KTX2 desktop variants. */
export function configureAssetLoader(renderer) {
  const textures = new KTX2Loader()
    .setTranscoderPath("./vendor/three/examples/jsm/libs/basis/")
    .detectSupport(renderer);
  loader.setKTX2Loader(textures);
  return loader;
}
const cache = new Map();

/** `assets/<name>.glb`, or a thrown error for a name that is not an asset slug. */
export function assetUrl(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(name)))
    throw new Error(`assets: "${name}" is not an asset slug (lowercase letters, digits, dashes)`);
  return `assets/${name}.glb`;
}

/** A stable 32-bit seed from a string — the asset name, so two loads bake the same texture. */
export function seedFrom(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

/** The grain a material gets: the kind you named, else `metal` for a metallic material, `plaster` otherwise. */
function grainFor(material, kind) {
  if (kind && KINDS.includes(kind)) return kind;
  return (material.metalness ?? 0) >= 0.5 ? "metal" : "plaster";
}

/**
 * One material slot of an asset's mesh: yours when `material` is a function that returns one,
 * otherwise the file's own, with a baked map when it has none.
 */
function dressSlot(mesh, slot, name, index, material) {
  if (typeof material === "function") {
    const own = material(mesh, slot);
    if (own) {
      own.userData.asset = name;
      return own;
    }
  }
  if (!slot) return slot;
  slot.userData.asset = name;
  const untextured = !slot.map && !slot.userData.triplanar && !slot.userData.baked;
  if (untextured) bakeOnto(slot, name, index, typeof material === "string" ? material : null);
  return slot;
}

/**
 * Bake a map onto one asset material that has none. The GLB's colour becomes a two-tone
 * palette (a darker and a lighter tone of it) so the surface keeps its colour and gains grain;
 * the kind is `metal` for a metallic material, `plaster` (the quietest grain) otherwise, or
 * the kind you name. The material's own `color` goes to white because the map now carries it.
 */
function bakeOnto(material, name, index, kind = null) {
  const base = material.color ? material.color.clone() : new THREE.Color(0xbbbbbb);
  const dark = base.clone().multiplyScalar(0.82);
  const light = base.clone().multiplyScalar(1.12);
  const chosen = grainFor(material, kind);
  const seed = seedFrom(`${name}#${index}`) % 100000;
  const baked = bakeTexture({
    kind: chosen,
    seed,
    size: 256,
    palette: [dark.getHex(), base.getHex(), light.getHex()],
    repeat: 2,
  });
  material.map = baked.map;
  if (material.roughnessMap === undefined || material.roughnessMap === null) material.roughnessMap = baked.roughnessMap;
  if ("bumpMap" in material && !material.bumpMap) {
    material.bumpMap = baked.bumpMap;
    material.bumpScale = 0.15;
  }
  if (material.color) material.color.set(0xffffff);
  material.userData.baked = chosen;
  material.needsUpdate = true;
}

/**
 * Resolves to a fresh `THREE.Group` for this asset. The parsed file is cached; every call
 * clones it, so two dogs are two objects with one geometry and one set of materials.
 *
 * Options: `tag` (default the asset name), `scale` (uniform), `position` ([x, y, z]),
 * `shadows` (default true), `material` — how a mesh with an untextured material gets one:
 * omitted → a baked map in the GLB's own colour (`plaster` grain, `metal` for metallic);
 * a kind from `materials.js` (`"wood"`, `"metal"`, `"cloth"`, …) → that grain in the GLB's
 * colour; a function `(mesh, material) => THREE.Material | null` → your material for that
 * mesh (return null to keep the file's). Materials that already carry a `map` are left alone.
 */
export async function loadAsset(
  name,
  { tag = name, scale = 1, position = null, shadows = true, material = null } = {},
) {
  let parsed = cache.get(name);
  if (!parsed) {
    parsed = loader.loadAsync(assetUrl(name));
    cache.set(name, parsed);
  }
  const gltf = await parsed;
  const group = gltf.scene.clone(true);
  group.userData.tag = tag;
  group.userData.asset = name;
  let index = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.asset = name;
    if (!o.userData.tag) o.userData.tag = `${tag}-part`;
    o.castShadow = shadows;
    o.receiveShadow = shadows;
    const slots = Array.isArray(o.material) ? o.material : [o.material];
    const replaced = slots.map((m) => {
      index += 1;
      return dressSlot(o, m, name, index, material);
    });
    o.material = Array.isArray(o.material) ? replaced : replaced[0];
  });
  if (scale !== 1) group.scale.setScalar(scale);
  if (position) group.position.set(position[0], position[1], position[2]);
  return group;
}

/** Load several before the first frame; resolves when every file is parsed. */
export function preloadAssets(names) {
  return Promise.all(names.map((n) => loadAsset(n)));
}
