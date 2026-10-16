/**
 * What the physics stands on: the terrain plus the park features (kickers, boxes) that are
 * analytic height bumps on top of it. Riders, bullets and particles all ask this.
 */
export function makeGround(world, features) {
  const { sampler, mountain } = world;
  const tmp = { x: 0, y: 1, z: 0 };
  function ground(x, z) {
    let h = sampler.heightAt(x, z);
    if (features) h += features.heightAt(x, z, h);
    return h;
  }
  function groundNormal(x, z, out) {
    if (features && features.near(x, z)) {
      // Finite differences over the combined surface (features have sharp lips).
      const e = 0.25;
      const hl = ground(x - e, z);
      const hr = ground(x + e, z);
      const hd = ground(x, z - e);
      const hu = ground(x, z + e);
      const dx = (hr - hl) / (2 * e);
      const dz = (hu - hd) / (2 * e);
      const inv = 1 / Math.hypot(dx, 1, dz);
      out.x = -dx * inv;
      out.y = inv;
      out.z = -dz * inv;
      return out;
    }
    return sampler.normalAt(x, z, out);
  }
  /** 1 on groomed corduroy, more in ungroomed snow and deep powder off-piste. */
  function snowFriction(x, z) {
    const w = sampler.field(mountain.trailW, x, z);
    const ti = mountain.trailIndex[
      Math.round((z - mountain.minZ) / mountain.cell) * mountain.nx + Math.round((x - mountain.minX) / mountain.cell)
    ];
    const groomed = ti >= 0 && mountain.trails[ti]?.groomed;
    const onRun = groomed ? 1 : 1.35;
    return onRun * w + 2.3 * (1 - w);
  }
  /** March a ray against the ground; returns distance or Infinity. */
  function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let t = 0.2;
    let prevT = 0;
    let prevGap = oy - ground(ox, oz);
    if (prevGap < 0) return 0;
    while (t < maxDist) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      const gap = y - ground(x, z);
      if (gap <= 0) {
        // Refine between prevT and t.
        let a = prevT;
        let b = t;
        for (let i = 0; i < 6; i++) {
          const m = (a + b) / 2;
          const g = oy + dy * m - ground(ox + dx * m, oz + dz * m);
          if (g > 0) a = m;
          else b = m;
        }
        return (a + b) / 2;
      }
      prevT = t;
      prevGap = gap;
      // Step size adapts to the clearance (never more than 6 m, never less than 0.4 m).
      t += Math.max(0.4, Math.min(6, gap * 0.6));
    }
    return Infinity;
  }
  /** The bare terrain (no park features): jib tops ride on it. */
  const terrain = (x, z) => sampler.heightAt(x, z);
  return { ground, groundNormal, snowFriction, raycast, terrain, tmp };
}
