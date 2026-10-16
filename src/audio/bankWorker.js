/**
 * Module worker: renders sound-bank entries off the main thread so the post-start() warm-up never
 * costs a frame. Protocol: { name, rate } → { name, rate, data: Float32Array[] | null } (the
 * channel buffers are transferred, not copied). If this worker cannot load (no module-worker
 * support, CSP, file://), the engine falls back to rendering in ~3 ms main-thread slices.
 */
import { generate } from "./sounds.js";

self.onmessage = (e) => {
  const { name, rate } = e.data || {};
  let data = null;
  try {
    data = generate(name, rate);
  } catch (err) {
    data = null;
  }
  if (data) self.postMessage({ name, rate, data }, data.map((c) => c.buffer));
  else self.postMessage({ name, rate, data: null });
};
