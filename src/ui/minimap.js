/**
 * The trail-map minimap: a circular, north-up shaded-relief map of the playable mountain with
 * the runs, forest, lift line and base drawn in, rendered once to a data URL for the HUD.
 */
import { MAP } from "../world/mountain.js";
import { LIFT } from "../world/world.js";

export function renderMinimap(mountain, sampler, forest, size = 320) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const b = MAP.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.04;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const toMap = (x, z) => [((x - cx) / span + 0.5) * size, ((z - cz) / span + 0.5) * size];
  const img = g.createImageData(size, size);
  const n = { x: 0, y: 1, z: 0 };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = cx + (px / size - 0.5) * span;
      const z = cz + (py / size - 0.5) * span;
      const o = (py * size + px) * 4;
      sampler.normalAt(x, z, n);
      // Light from the south-west, like the game's sun.
      const shade = Math.max(0.15, Math.min(1, 0.55 + n.x * -0.9 + n.z * 0.9));
      let r = 150 + 90 * shade;
      let gg = 162 + 85 * shade;
      let bb = 185 + 70 * shade;
      const tw = sampler.field(mountain.trailW, x, z);
      if (tw > 0.45) {
        r = r * 0.55 + 255 * 0.45;
        gg = gg * 0.55 + 255 * 0.45;
        bb = bb * 0.55 + 255 * 0.45;
      }
      img.data[o] = r * 0.62;
      img.data[o + 1] = gg * 0.66;
      img.data[o + 2] = bb * 0.78;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Forest: darken around trees.
  g.fillStyle = "rgba(20,48,40,0.35)";
  const t = forest.trees;
  const dot = Math.max(1, (14 / span) * size);
  for (let i = 0; i < t.count; i += 2) {
    const [mx, mz] = toMap(t.x[i], t.z[i]);
    g.fillRect(mx - dot / 2, mz - dot / 2, dot, dot);
  }
  // Runs: groomers blue, ungroomed black, cat tracks green.
  for (const trail of mountain.trails) {
    g.strokeStyle = trail.color === "#1a1a1a" ? "rgba(15,15,20,0.85)" : trail.color;
    g.lineWidth = Math.max(1.5, (trail.groomed ? 10 : 12) / span * size);
    g.lineCap = "round";
    g.beginPath();
    trail.path.forEach((p, i) => {
      const [mx, mz] = toMap(p.x, p.z);
      if (i === 0) g.moveTo(mx, mz);
      else g.lineTo(mx, mz);
    });
    g.stroke();
  }
  // Lift line.
  g.strokeStyle = "rgba(25,25,30,0.9)";
  g.lineWidth = 1.5;
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(...toMap(LIFT.base.x, LIFT.base.z));
  g.lineTo(...toMap(LIFT.top.x, LIFT.top.z));
  g.stroke();
  g.setLineDash([]);
  // Circle mask + rim.
  g.globalCompositeOperation = "destination-in";
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  // Subtle vignette inside the rim.
  const vg = g.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size / 2);
  vg.addColorStop(0, "rgba(0,10,30,0)");
  vg.addColorStop(1, "rgba(0,10,30,0.45)");
  g.fillStyle = vg;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  g.fill();
  return {
    url: c.toDataURL("image/png"),
    /** World (x, z) → fraction of the minimap box (0..1), clamped to the circle. */
    project(x, z) {
      let u = (x - cx) / span;
      let v = (z - cz) / span;
      const d = Math.hypot(u, v);
      if (d > 0.47) {
        u *= 0.47 / d;
        v *= 0.47 / d;
      }
      return [u + 0.5, v + 0.5];
    },
  };
}
