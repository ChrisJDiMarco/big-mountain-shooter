# Big Mountain Shooter - rider gear: Ski, Snowboard, Pole and first-person arms.
# Blender metres, +Z up, forward is +Y, right is +X. Each item is its own mesh whose origin sits
# on its attachment point (see notes at each builder). Items are laid out side by side in the
# scene only so the preview renders are readable - the game re-parents them and zeroes position.
import bpy, bmesh, math
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

TAU = 2.0 * math.pi

# ============================================================================
# math helpers
# ============================================================================
def clamp(x, a, b):
    return a if x < a else b if x > b else x

def lerp(a, b, t):
    return a + (b - a) * t

def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)

def sgnpow(v, e):
    return math.copysign(abs(v) ** e, v)

def V(x, y, z):
    return Vector((x, y, z))

def pchip(xs, ys):
    """Monotone cubic interpolation (no overshoot)."""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = 0
        while xs[i + 1] < x:
            i += 1
        t = (x - xs[i]) / h[i]
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
                + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])
    return f

class Prof:
    """Keyed profile: rows (x, v1, v2, ...) -> f(x) = [v1, v2, ...] (monotone cubic)."""
    def __init__(self, rows):
        xs = [r[0] for r in rows]
        self.fs = [pchip(xs, [r[k] for r in rows]) for k in range(1, len(rows[0]))]

    def __call__(self, x):
        return [f(x) for f in self.fs]

def perp_frame(d, hint):
    d = d.normalized()
    e1 = hint - d * hint.dot(d)
    if e1.length < 1e-6:
        e1 = Vector((1, 0, 0)) - d * d.x
    e1.normalize()
    e2 = d.cross(e1)
    return e1, e2  # e1 x e2 = d -> rings built (e1 cos, e2 sin) are CCW about d

def catmull(pts, samples_per_seg=6, closed=False):
    out = []
    n = len(pts)
    segs = n if closed else n - 1
    for i in range(segs):
        p0 = pts[(i - 1) % n] if (closed or i > 0) else pts[0] * 2 - pts[1]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        p3 = pts[(i + 2) % n] if (closed or i + 2 < n) else pts[-1] * 2 - pts[-2]
        for k in range(samples_per_seg):
            t = k / samples_per_seg
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    if not closed:
        out.append(pts[-1].copy())
    return out

# ============================================================================
# materials
# ============================================================================
MATDEF = {
    "SkiTop": ((0.02, 0.04, 0.10), 0.0, 0.3),
    "SkiBase": ((0.02, 0.02, 0.02), 0.0, 0.5),
    "SkiEdge": ((0.62, 0.62, 0.64), 1.0, 0.25),
    "Binding": ((0.05, 0.05, 0.05), 0.0, 0.5),
    "BindingAccent": ((0.90, 0.35, 0.05), 0.0, 0.45),
    "BoardTop": ((0.85, 0.85, 0.85), 0.0, 0.3),
    "BoardBase": ((0.02, 0.02, 0.02), 0.0, 0.5),
    "SnowboardBinding": ((0.05, 0.05, 0.05), 0.0, 0.5),
    "PoleShaft": ((0.60, 0.60, 0.60), 1.0, 0.3),
    "PoleGrip": ((0.02, 0.02, 0.02), 0.0, 0.8),
    "PoleBasket": ((0.03, 0.03, 0.03), 0.0, 0.6),
    "Jacket": ((0.85, 0.85, 0.85), 0.0, 0.75),
    "JacketTrim": ((0.04, 0.04, 0.04), 0.0, 0.6),
    "Glove": ((0.03, 0.03, 0.03), 0.0, 0.7),
}
MAT = {}

def get_mat(name):
    if name in MAT:
        return MAT[name]
    col, met, rough = MATDEF[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    bsdf = None
    if m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                bsdf = n
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (col[0], col[1], col[2], 1.0)
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
    m.diffuse_color = (col[0], col[1], col[2], 1.0)
    m.metallic = met
    m.roughness = rough
    MAT[name] = m
    return m

# ============================================================================
# mesh builder
# ============================================================================
class MB:
    def __init__(self):
        self.V = []
        self.F = []
        self.M = []
        self.mats = []
        self.sharp = set()

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def add(self, p):
        self.V.append(Vector(p))
        return len(self.V) - 1

    def ring(self, pts):
        return [self.add(p) for p in pts]

    def face(self, idx, mat):
        self.F.append(list(idx))
        self.M.append(self.mi(mat))

    def bridge(self, r0, r1, mat, closed=True):
        n = len(r0)
        for j in range(n if closed else n - 1):
            j1 = (j + 1) % n
            m = mat(j) if callable(mat) else mat
            self.face([r0[j], r0[j1], r1[j1], r1[j]], m)

    def fan(self, r, c, mat, end=False):
        ci = self.add(c)
        n = len(r)
        for j in range(n):
            j1 = (j + 1) % n
            self.face([ci, r[j], r[j1]] if end else [ci, r[j1], r[j]], mat)

    def loft(self, rings, mats, cap0=None, cap1=None, closed=True, sharp_cols=()):
        """rings CCW about the advance direction -> outward normals.
        mats: str | list per band | callable(i, j). cap0/cap1: (centre, mat) fans."""
        R = [self.ring(r) for r in rings]
        for i in range(len(R) - 1):
            if isinstance(mats, str):
                m = mats
            elif isinstance(mats, list):
                m = mats[i]
            else:
                m = (lambda j, i=i: mats(i, j))
            self.bridge(R[i], R[i + 1], m, closed)
            for j in sharp_cols:
                self.sharp.add((R[i][j], R[i + 1][j]))
        if cap0 is not None:
            self.fan(R[0], cap0[0], cap0[1], end=False)
            if sharp_cols:
                n = len(R[0])
                for j in range(n):
                    self.sharp.add((R[0][j], R[0][(j + 1) % n]))
        if cap1 is not None:
            self.fan(R[-1], cap1[0], cap1[1], end=True)
            if sharp_cols:
                n = len(R[-1])
                for j in range(n):
                    self.sharp.add((R[-1][j], R[-1][(j + 1) % n]))
        return R

    def extend(self, other):
        off = len(self.V)
        self.V.extend(v.copy() for v in other.V)
        for f, m in zip(other.F, other.M):
            self.F.append([i + off for i in f])
            self.M.append(self.mi(other.mats[m]))
        for a, b in other.sharp:
            self.sharp.add((a + off, b + off))

    def tris(self):
        return sum(len(f) - 2 for f in self.F)

    def bvh(self):
        return BVHTree.FromPolygons([tuple(v) for v in self.V], self.F)

def mirror_mb(mb):
    """Mirror across the YZ plane (x -> -x) with corrected winding."""
    out = MB()
    out.mats = list(mb.mats)
    out.V = [Vector((-v.x, v.y, v.z)) for v in mb.V]
    out.F = [list(reversed(f)) for f in mb.F]
    out.M = list(mb.M)
    out.sharp = set(mb.sharp)
    return out

def make_object(name, mb, origin, smooth=True):
    origin = Vector(origin)
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v - origin) for v in mb.V], [], mb.F)
    for mname in mb.mats:
        me.materials.append(get_mat(mname))
    for poly, m in zip(me.polygons, mb.M):
        poly.material_index = m
    me.validate()
    me.update()
    for p in me.polygons:
        p.use_smooth = smooth
    if mb.sharp:
        attr = me.attributes.get("sharp_edge") or me.attributes.new("sharp_edge", 'BOOLEAN', 'EDGE')
        lookup = {}
        for e in me.edges:
            a, b = e.vertices
            lookup[(min(a, b), max(a, b))] = e.index
        vals = [False] * len(me.edges)
        for a, b in mb.sharp:
            k = (min(a, b), max(a, b))
            if k in lookup:
                vals[lookup[k]] = True
        attr.data.foreach_set("value", vals)
    me.update()
    box_uv(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = origin
    return ob

UV_SCALE = 4.0   # 1 UV unit = 0.25 m: uniform texel density for tiling baked textures

def box_uv(me):
    """Per-face box projection in object space (no stretching on any part; works for tiling maps)."""
    uv = me.uv_layers.new(name="UVMap")
    co = [v.co for v in me.vertices]
    data = [0.0] * (2 * len(me.loops))
    for poly in me.polygons:
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            c = co[me.loops[li].vertex_index]
            if ax >= ay and ax >= az:
                u, v = (c.y if n.x > 0 else -c.y), c.z
            elif ay >= az:
                u, v = (-c.x if n.y > 0 else c.x), c.z
            else:
                u, v = c.x, (c.y if n.z > 0 else -c.y)
            data[2 * li] = u * UV_SCALE
            data[2 * li + 1] = v * UV_SCALE
    uv.data.foreach_set("uv", data)

# ---------------------------------------------------------------------------
# primitive helpers
# ---------------------------------------------------------------------------
def ribbon(mb, pts, nrms, hw, ht, mat, sharp=True, caps=True, hws=None, hts=None, profile=4):
    """Flat strip along pts lying on a surface with normals nrms (width hw, thickness ht)."""
    rings = []
    n = len(pts)
    for i, p in enumerate(pts):
        if i == 0:
            tng = pts[1] - p
        elif i == n - 1:
            tng = p - pts[i - 1]
        else:
            tng = pts[i + 1] - pts[i - 1]
        nr = nrms[i].normalized()
        tng = (tng - nr * tng.dot(nr)).normalized()
        b = tng.cross(nr).normalized()
        w = hws[i] if hws else hw
        t = hts[i] if hts else ht
        if profile == 4:
            pp = [(-w, -t), (w, -t), (w, t), (-w, t)]
        else:  # 6-point padded profile
            pp = [(-w * 0.85, -t), (w * 0.85, -t), (w, 0.0), (w * 0.85, t), (-w * 0.85, t), (-w, 0.0)]
        ring = [p + b * u + nr * v for (u, v) in pp]
        # (b, n) CCW is about b x n = -tng -> reverse to get CCW about tng
        ring.reverse()
        rings.append(ring)
    cols = tuple(range(len(rings[0]))) if sharp else ()
    cap0 = (sum(rings[0], Vector()) / len(rings[0]), mat) if caps else None
    cap1 = (sum(rings[-1], Vector()) / len(rings[-1]), mat) if caps else None
    mb.loft(rings, mat, cap0=cap0, cap1=cap1, sharp_cols=cols)

def obox(mb, c, ax, ay, az, sx, sy, sz, mat, bevel=0.3, n=8):
    """Rounded box centred at c with unit axes ax, ay, az (az = loft axis), full sizes."""
    ax, ay, az = ax.normalized(), ay.normalized(), az.normalized()
    if ax.cross(ay).dot(az) < 0:
        ay = -ay
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    rings = []
    for z, k in ((-hz, 1 - bevel), (-hz * (1 - bevel * 0.6), 1.0), (hz * (1 - bevel * 0.6), 1.0), (hz, 1 - bevel)):
        ring = []
        for j in range(n):
            t = TAU * j / n + TAU / (2 * n)
            ring.append(c + ax * (hx * k * sgnpow(math.cos(t), 0.6)) + ay * (hy * k * sgnpow(math.sin(t), 0.6)) + az * z)
        rings.append(ring)
    mb.loft(rings, mat, cap0=(c - az * hz, mat), cap1=(c + az * hz, mat))

def remesh_to_mb(verts, faces, mat, voxel, target, smooth_iter=4, name="tmp", mode="qf"):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    m = ob.modifiers.new("vox", 'REMESH'); m.mode = 'VOXEL'; m.voxel_size = voxel
    bpy.ops.object.modifier_apply(modifier="vox")
    if smooth_iter:
        m = ob.modifiers.new("sm", 'SMOOTH'); m.factor = 0.6; m.iterations = smooth_iter
        bpy.ops.object.modifier_apply(modifier="sm")
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    # keep only the largest shell (drops internal voids and specks left by the voxel union)
    bm.faces.ensure_lookup_table()
    seen, comps = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    for comp in comps[1:]:
        bmesh.ops.delete(bm, geom=comp, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data); bm.free()
    if target and mode == "qf":
        # QuadriFlow's pre-check rejects edges shorter than ~0.35 mm (absolute epsilon): work at 10x scale
        ob.data.transform(Matrix.Scale(10.0, 4))
        for seed in (7, 11, 23):
            res = bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=target, use_mesh_symmetry=False,
                                                   use_preserve_sharp=False, use_preserve_boundary=False, seed=seed)
            if 'FINISHED' in res and len(ob.data.polygons) < target * 2:
                break
        ob.data.transform(Matrix.Scale(0.1, 4))
        if len(ob.data.polygons) > target * 2:   # QuadriFlow refused: fall back to decimation
            mode, target = "dec", target * 2
    if target and mode != "qf":  # collapse-decimate to `target` triangles (keeps finger grooves at low counts)
        ntri = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        m = ob.modifiers.new("dec", 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = target / ntri
        bpy.ops.object.modifier_apply(modifier="dec")
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data); bm.free()
    out = MB()
    out.V = [v.co.copy() for v in ob.data.vertices]
    for p in ob.data.polygons:
        out.face(list(p.vertices), mat)
    msh = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(msh)
    return out


def slab(mb, F, Bk, out_hint, mat):
    """Closed slab from two point grids (rows x cols); F is the side facing out_hint."""
    R, C = len(F), len(F[0])
    fi = [[mb.add(p) for p in r] for r in F]
    bi = [[mb.add(p) for p in r] for r in Bk]
    i0, j0 = R // 2, C // 2
    du = F[i0][min(j0 + 1, C - 1)] - F[i0][max(j0 - 1, 0)]
    dv = F[min(i0 + 1, R - 1)][j0] - F[max(i0 - 1, 0)][j0]
    sgn = 1 if du.cross(dv).dot(out_hint) > 0 else -1

    def face(idx):
        mb.face(idx if sgn > 0 else list(reversed(idx)), mat)
    for i in range(R - 1):
        for j in range(C - 1):
            face([fi[i][j], fi[i][j + 1], fi[i + 1][j + 1], fi[i + 1][j]])
            face([bi[i][j], bi[i + 1][j], bi[i + 1][j + 1], bi[i][j + 1]])
    border = [(0, j) for j in range(C)] + [(i, C - 1) for i in range(1, R)] + \
             [(R - 1, j) for j in range(C - 2, -1, -1)] + [(i, 0) for i in range(R - 2, 0, -1)]
    for k in range(len(border)):
        a, b = border[k], border[(k + 1) % len(border)]
        face([fi[a[0]][a[1]], bi[a[0]][a[1]], bi[b[0]][b[1]], fi[b[0]][b[1]]])

def translate_mb(mb, off):
    for v in mb.V:
        v += off
    return mb

def ribbon_loop(mb, pts, nrms, hw, ht, mat):
    """Closed band (torus topology) through pts lying on a surface with normals nrms."""
    n = len(pts)
    rings = []
    for i in range(n):
        tng = (pts[(i + 1) % n] - pts[i - 1])
        nr = nrms[i].normalized()
        tng = (tng - nr * tng.dot(nr)).normalized()
        b = tng.cross(nr).normalized()
        ring = [pts[i] + b * u + nr * v for (u, v) in ((-hw, -ht), (hw, -ht), (hw, ht), (-hw, ht))]
        ring.reverse()
        rings.append(ring)
    R = [mb.ring(r) for r in rings]
    for i in range(n):
        mb.bridge(R[i], R[(i + 1) % n], mat)
        for j in range(4):
            mb.sharp.add((R[i][j], R[(i + 1) % n][j]))

def revolve(mb, prof, n, mats, centre=V(0, 0, 0), cap_top=None, cap_bot=None, sharp_rows=()):
    """Surface of revolution about +Z. prof: list of (r, z) from top to bottom (advance -Z)."""
    rings = []
    for r, z in prof:
        # clockwise about +Z (seen from above) == CCW about the downward advance
        rings.append([centre + V(r * math.cos(-TAU * j / n), r * math.sin(-TAU * j / n), z) for j in range(n)])
    R = mb.loft(rings, mats, cap0=cap_top, cap1=cap_bot)
    for i in sharp_rows:
        for j in range(n):
            mb.sharp.add((R[i][j], R[i][(j + 1) % n]))
    return R

# ============================================================================
# SKI (tip toward +Y, origin = binding centre on the top surface)
# Place the ski origin directly under the rider's ankle (Boot origin minus 0.10 m in Z): the Boot sole
# then sits on the origin and the toe / heel pieces clamp its toe and heel lugs.
# ============================================================================
SKI_HW = pchip([-0.800, -0.7975, -0.790, -0.775, -0.750, -0.700, -0.640, -0.450, -0.250, -0.050, 0.050, 0.250, 0.450,
                0.650, 0.730, 0.780, 0.830, 0.880, 0.915, 0.937, 0.947, 0.9505],
               [0.004, 0.026, 0.039, 0.046, 0.049, 0.050, 0.0495, 0.045, 0.0395, 0.0355, 0.035, 0.0385, 0.0455,
                0.054, 0.0572, 0.0575, 0.055, 0.048, 0.038, 0.026, 0.014, 0.004])
SKI_H = pchip([-0.80, -0.70, -0.45, -0.25, 0.25, 0.50, 0.75, 0.95], [0.0065, 0.010, 0.016, 0.020, 0.020, 0.015, 0.009, 0.006])

def ski_base_z(y):
    z = 0.0
    if y > 0.70:
        z += 0.070 * ((y - 0.70) / 0.25) ** 2.0
    if y < -0.65:
        z += 0.025 * ((-0.65 - y) / 0.15) ** 2.2
    if abs(y) < 0.65:
        z += 0.003 * (1 - (y / 0.65) ** 2) ** 2
    return z - 0.023   # top surface at the binding centre sits at z = 0

def ski_frame(y):
    e = 1e-4
    t = V(0, 2 * e, ski_base_z(y + e) - ski_base_z(y - e)).normalized()
    n = V(0, -t.z, t.y)
    return V(0, y, ski_base_z(y)), t, n

def build_ski():
    mb = MB()
    ys = [-0.7995, -0.7975, -0.794, -0.788, -0.779, -0.767, -0.751, -0.731, -0.707, -0.68, -0.65, -0.60, -0.54, -0.47,
          -0.40, -0.33, -0.26, -0.19, -0.12, -0.05, 0.02, 0.09, 0.16, 0.23, 0.30, 0.37, 0.44, 0.51, 0.58, 0.64, 0.69,
          0.73, 0.765, 0.80, 0.83, 0.86, 0.885, 0.905, 0.922, 0.935, 0.944, 0.9495]
    mats = ["SkiTop", "SkiTop", "SkiTop", "SkiTop", "SkiTop", "SkiEdge", "SkiEdge", "SkiBase", "SkiBase", "SkiEdge",
            "SkiEdge", "SkiTop", "SkiTop", "SkiTop", "SkiTop", "SkiTop"]
    rings = []
    for y in ys:
        c, t, nrm = ski_frame(y)
        w = SKI_HW(y)
        h = SKI_H(y)
        k = min(1.0, w / 0.02)
        e, bv, cr = 0.002 * k, 0.0015 * k, 0.0012 * k
        prof = [(0, h + cr), (0.45 * w, h + 0.8 * cr), (0.82 * w, h), (w - bv, h - 0.0012 * k), (w, h * 0.55),
                (w, 0.0022 * k), (w, 0.0), (w - e, 0.0), (0, -0.0003), (-(w - e), 0.0), (-w, 0.0), (-w, 0.0022 * k),
                (-w, h * 0.55), (-(w - bv), h - 0.0012 * k), (-0.82 * w, h), (-0.45 * w, h + 0.8 * cr)]
        rings.append([c + V(px, 0, 0) + nrm * pz for px, pz in prof])
    c0, t0, n0 = ski_frame(ys[0])
    c1, t1, n1 = ski_frame(ys[-1])
    mb.loft(rings, lambda i, j: mats[j], cap0=(c0 - t0 * 0.0006 + n0 * 0.003, "SkiTop"),
            cap1=(c1 + t1 * 0.0006 + n1 * 0.003, "SkiTop"), sharp_cols=(3, 5, 6, 7, 9, 10, 11, 13))
    build_binding(mb)
    return mb

def loft_box_y(mb, y0, y1, prof_fn, mat, n=12, steps=5, sharp=False):
    """Loft along +Y of rounded cross-sections: prof_fn(y) -> (xc, half_w, z0, z1, pexp)."""
    rings = []
    for k in range(steps + 1):
        y = lerp(y0, y1, k / steps)
        xc, hw, z0, z1, p = prof_fn(y)
        zc, hh = (z0 + z1) / 2, (z1 - z0) / 2
        rings.append([V(xc + hw * sgnpow(math.sin(TAU * j / n), 2 / p), y, zc + hh * sgnpow(math.cos(TAU * j / n), 2 / p))
                      for j in range(n)])
    cs = sum(rings[0], Vector()) / n
    ce = sum(rings[-1], Vector()) / n
    mb.loft(rings, mat, cap0=(cs - V(0, 0.001, 0), mat), cap1=(ce + V(0, 0.001, 0), mat))

BOOT_HEEL, BOOT_TOE = -0.131, 0.221   # rider Boot sole ends relative to the ankle (origin)

def build_binding(mb):
    """Alpine binding that clamps the rider Boot when the ski origin sits directly under the ankle."""
    T, H = BOOT_TOE, BOOT_HEEL
    # ---- toe piece ----
    loft_box_y(mb, T + 0.001, T + 0.096, lambda y: (0, 0.031 - 0.004 * smoothstep(T + 0.064, T + 0.096, y), -0.0025, 0.007, 4.0),
               "Binding", steps=3)
    loft_box_y(mb, T + 0.010, T + 0.086, lambda y: (0, 0.025 - 0.004 * smoothstep(T + 0.054, T + 0.086, y), 0.003,
                                                    lerp(0.050, 0.024, smoothstep(T + 0.014, T + 0.086, y)), 3.0), "Binding", steps=5)
    for sx in (1, -1):   # toe wings clamping the boot's toe lug
        obox(mb, V(sx * 0.031, T + 0.007, 0.024), V(0, 1, 0), V(sx * 1, 0, 0), V(0, 0, 1), 0.030, 0.016, 0.028, "Binding")
    obox(mb, V(0, T + 0.005, 0.0295), V(1, 0, 0), V(0, 1, 0), V(0, 0, 1), 0.064, 0.016, 0.009, "Binding")   # toe height bar
    loft_box_y(mb, T + 0.022, T + 0.069, lambda y: (0, 0.017, lerp(0.041, 0.030, smoothstep(T + 0.022, T + 0.069, y)) - 0.002,
                                                    lerp(0.052, 0.034, smoothstep(T + 0.022, T + 0.069, y)), 3.0), "BindingAccent", steps=3)
    # AFD anti-friction pad under the boot toe
    loft_box_y(mb, T - 0.045, T + 0.002, lambda y: (0, 0.030, -0.003, 0.0015, 4.0), "BindingAccent", steps=1)
    # ---- heel piece ----
    loft_box_y(mb, H - 0.128, H, lambda y: (0, 0.032, -0.0025, 0.004, 4.0), "Binding", steps=3)
    loft_box_y(mb, H - 0.115, H - 0.015, lambda y: (0, 0.030, 0.004, lerp(0.066, 0.056, smoothstep(H - 0.115, H - 0.015, y)), 3.0),
               "Binding", steps=4)
    loft_box_y(mb, H - 0.031, H + 0.011, lambda y: (0, 0.029 - 0.006 * smoothstep(H - 0.008, H + 0.011, y),
                                                    lerp(0.024, 0.027, smoothstep(H - 0.031, H + 0.011, y)),
                                                    lerp(0.056, 0.041, smoothstep(H - 0.023, H + 0.011, y)), 3.0), "Binding", steps=3)
    # step-in / release lever (accent colour)
    pts = [V(0, H - 0.085, 0.064), V(0, H - 0.115, 0.072), V(0, H - 0.141, 0.074), V(0, H - 0.157, 0.068)]
    ribbon(mb, pts, [V(0, 0.2, 1).normalized()] * 4, 0.017, 0.0045, "BindingAccent", sharp=False, profile=6)
    loft_box_y(mb, H - 0.069, H - 0.023, lambda y: (0, 0.0305, 0.034, 0.050, 3.0), "BindingAccent", steps=2)
    # brakes (retracted): arms beside the heel piece, pads just outside the ski edges
    for sx in (1, -1):
        a = V(sx * 0.031, H - 0.028, 0.012)
        b = V(sx * 0.047, H - 0.085, 0.010)
        c = V(sx * 0.054, H - 0.121, 0.008)
        ribbon(mb, [a, b, c], [V(0, 0, 1)] * 3, 0.0032, 0.0024, "Binding", sharp=False, profile=6)
        obox(mb, V(sx * 0.055, H - 0.123, 0.007), V(0, 1, 0), V(1, 0, 0), V(0, 0, 1), 0.024, 0.010, 0.012, "Binding")

# ============================================================================
# SNOWBOARD (nose toward +Y, origin = board centre on the top surface)
# ============================================================================
SB_L = 0.775
def sb_hw(y):
    ay = abs(y)
    if ay <= 0.58:
        return 0.120 + 0.005 * (ay / 0.58) ** 2
    u = clamp((ay - 0.58) / 0.195, 0.0, 1.0)
    return max(0.004, 0.125 * (1 - u ** 2.6) ** (1 / 2.6))

def sb_base_z(y):
    ay = abs(y)
    z = 0.0
    if ay > 0.58:
        z = 0.064 * ((ay - 0.58) / 0.195) ** 2.0
    return z - 0.015

def sb_h(y):
    return lerp(0.015, 0.008, smoothstep(0.50, 0.775, abs(y)))

def sb_frame(y):
    e = 1e-4
    t = V(0, 2 * e, sb_base_z(y + e) - sb_base_z(y - e)).normalized()
    return V(0, y, sb_base_z(y)), t, V(0, -t.z, t.y)

def build_snowboard():
    mb = MB()
    tip = [0.580, 0.615, 0.645, 0.672, 0.695, 0.715, 0.732, 0.746, 0.757, 0.765, 0.7705, 0.7738, 0.7748]
    mid = [-0.50, -0.40, -0.30, -0.20, -0.10, 0.0, 0.10, 0.20, 0.30, 0.40, 0.50]
    ys = [-t for t in reversed(tip)] + mid + tip
    mats = ["BoardTop", "BoardTop", "BoardTop", "SkiEdge", "SkiEdge", "BoardBase", "BoardBase", "SkiEdge", "SkiEdge",
            "BoardTop", "BoardTop", "BoardTop"]
    rings = []
    for y in ys:
        c, t, nrm = sb_frame(y)
        w = sb_hw(y)
        h = sb_h(y)
        k = min(1.0, w / 0.03)
        prof = [(0, h), (w - 0.003 * k, h), (w, h - 0.003 * k), (w, 0.0022 * k), (w, 0.0), (w - 0.0025 * k, 0.0),
                (0, 0.0), (-(w - 0.0025 * k), 0.0), (-w, 0.0), (-w, 0.0022 * k), (-w, h - 0.003 * k), (-(w - 0.003 * k), h)]
        rings.append([c + V(px, 0, 0) + nrm * pz for px, pz in prof])
    c0, t0, n0 = sb_frame(ys[0])
    c1, t1, n1 = sb_frame(ys[-1])
    mb.loft(rings, lambda i, j: mats[j], cap0=(c0 - t0 * 0.0004 + n0 * 0.004, "BoardTop"),
            cap1=(c1 + t1 * 0.0004 + n1 * 0.004, "BoardTop"), sharp_cols=(1, 2, 3, 4, 5, 7, 8, 9, 10, 11))
    # duck stance: binding at y=-0.27 turned +15deg, at y=+0.27 turned -15deg about +Z. Toes point to -X
    # (toe edge = -X), highbacks on the +X heel edge, so a rider standing on it faces -X with the right
    # foot toward the +Y nose (twin tip: rotate the board 180deg about Z for the other stance).
    for y0, ang in ((-0.27, 15.0), (0.27, -15.0)):
        build_sb_binding(mb, V(0, y0, 0), math.radians(ang))
    return mb

def build_sb_binding(mb, centre, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    U = V(-ca, -sa, 0)          # toe direction
    W = V(sa, -ca, 0)           # across the foot (to the left of the toe direction)
    if U.cross(W).z < 0:
        W = -W
    Z = V(0, 0, 1)
    def P(u, w, z):
        return centre + U * u + W * w + Z * z
    # baseplate (boot sole rests on z = 0.0045)
    n = 16
    rings = []
    for z, k in ((-0.0015, 0.97), (0.002, 1.0), (0.0045, 0.975)):
        rings.append([P(0.135 * k * sgnpow(math.cos(TAU * j / n), 2 / 4.0), 0.064 * k * sgnpow(math.sin(TAU * j / n), 2 / 4.0), z)
                      for j in range(n)])
    if (rings[0][1] - rings[0][0]).cross(rings[0][2] - rings[0][1]).z < 0:
        rings = [list(reversed(r)) for r in rings]
    mb.loft(rings, "SnowboardBinding", cap0=(P(0, 0, -0.0015), "SnowboardBinding"), cap1=(P(0, 0, 0.0045), "SnowboardBinding"))
    # heel cup + side rails: a wall along a U path around the heel
    path, hts = [], []
    for k in range(17):
        s = k / 16
        if s < 0.3:
            u, w = lerp(0.03, -0.085, s / 0.3), 0.069
        elif s > 0.7:
            u, w = lerp(-0.085, 0.03, (s - 0.7) / 0.3), -0.069
        else:
            a = math.pi / 2 + math.pi * (s - 0.3) / 0.4
            u, w = -0.085 + 0.069 * math.cos(a) * 0.75, 0.069 * math.sin(a)
        path.append((u, w))
        hts.append(lerp(0.040, 0.078, smoothstep(0.03, -0.12, u)))
    srings = []
    for i, (u, w) in enumerate(path):
        u0, w0 = path[max(0, i - 1)]
        u1, w1 = path[min(len(path) - 1, i + 1)]
        tng = (U * (u1 - u0) + W * (w1 - w0)).normalized()
        out = tng.cross(Z).normalized()
        if out.dot(U * u + W * w - U * (-0.03)) < 0:
            out = -out
        base = P(u, w, 0.0)
        th = 0.0045
        srings.append([base - out * th + Z * 0.002, base + out * th + Z * 0.002, base + out * th + Z * hts[i],
                       base - out * th + Z * hts[i]])
    tmp = srings[8]
    tg = (P(*path[9], 0) - P(*path[7], 0))
    if (tmp[1] - tmp[0]).cross(tmp[2] - tmp[1]).dot(tg) < 0:
        srings = [list(reversed(r)) for r in srings]
    mb.loft(srings, "SnowboardBinding", cap0=(sum(srings[0], Vector()) / 4, "SnowboardBinding"),
            cap1=(sum(srings[-1], Vector()) / 4, "SnowboardBinding"), sharp_cols=(0, 1, 2, 3))
    # highback: curved plate behind the calf, leaning 15 deg toward the toes
    cols, rows_ = 7, 7
    front, back = [], []
    for i in range(rows_):
        v = i / (rows_ - 1)
        z = lerp(0.030, 0.285, v) - 0.012 * smoothstep(0.8, 1.0, v)
        lean = (z - 0.030) * math.tan(math.radians(15))
        half = lerp(0.064, 0.058, v) * (1 - 0.30 * smoothstep(0.75, 1.0, v) ** 1.5)
        fr, bk = [], []
        for j in range(cols):
            x = lerp(-1.0, 1.0, j / (cols - 1))
            wv = half * x
            zz = z - 0.022 * smoothstep(0.7, 1.0, v) * x * x       # rounded top corners
            u = -0.129 + lean + 0.040 * x * x
            fr.append(P(u + 0.003, wv, zz))
            bk.append(P(u - 0.003, wv, zz))
        front.append(fr)
        back.append(bk)
    slab(mb, front, back, U, "SnowboardBinding")
    # ankle strap (padded arch over the instep) and toe strap
    def arch(u0, half_w, z0, z1, pexp, samples):
        pts, nrms = [], []
        for k in range(samples):
            a = math.pi * k / (samples - 1)
            c, s = math.cos(a), math.sin(a)
            w = half_w * sgnpow(c, 2 / pexp)
            z = z0 + (z1 - z0) * abs(s) ** (2 / pexp)
            pts.append(P(u0, w, z))
            nr = (W * (sgnpow(c, 2 / pexp) / half_w) + Z * (abs(s) ** (2 / pexp) / (z1 - z0) + 1e-4)).normalized()
            nrms.append(nr)
        return pts, nrms
    pts, nrms = arch(0.005, 0.072, 0.035, 0.188, 4.0, 13)
    ribbon(mb, pts, nrms, 0.024, 0.006, "SnowboardBinding", sharp=False, profile=6)
    pts, nrms = arch(0.118, 0.068, 0.025, 0.108, 3.0, 10)
    ribbon(mb, pts, nrms, 0.015, 0.004, "SnowboardBinding")
    # ratchets on the strap ends (medial side)
    obox(mb, P(0.005, -0.071, 0.075), U, Z, -W, 0.026, 0.040, 0.012, "SnowboardBinding")
    obox(mb, P(0.118, -0.066, 0.048), U, Z, -W, 0.020, 0.032, 0.011, "SnowboardBinding")

# ============================================================================
# POLE (origin at the grip centre, shaft down -Z). The rider Hand fist holds a 32 mm cylinder whose
# centre is at the Hand origin + (0, -0.0335, -0.069) in Blender (rest pose), axis along X.
# ============================================================================
def build_pole():
    mb = MB()
    # moulded grip with top knob, finger swells and a bottom flare
    grip = [(0.006, 0.0755), (0.0145, 0.0738), (0.0178, 0.068), (0.0178, 0.060), (0.0150, 0.052), (0.0132, 0.044),
            (0.0128, 0.024), (0.0126, 0.002), (0.0129, -0.022), (0.0131, -0.042), (0.0150, -0.056), (0.0168, -0.068),
            (0.0170, -0.078), (0.0110, -0.086)]
    revolve(mb, grip, 14, "PoleGrip", cap_top=(V(0, 0, 0.0758), "PoleGrip"), cap_bot=(V(0, 0, -0.087), "PoleGrip"))
    # tapered aluminium shaft
    shaft = [(0.0090, -0.080), (0.0088, -0.30), (0.0076, -0.80), (0.0062, -1.135)]
    revolve(mb, shaft, 12, "PoleShaft", cap_top=(V(0, 0, -0.079), "PoleShaft"), cap_bot=(V(0, 0, -1.136), "PoleShaft"))
    # basket ~0.10 m across, slightly dished, with hub
    basket = [(0.0072, -1.083), (0.0125, -1.0865), (0.0505, -1.0835), (0.0515, -1.0872), (0.0490, -1.0915),
              (0.0125, -1.0975), (0.0072, -1.104)]
    revolve(mb, basket, 16, "PoleBasket", cap_top=(V(0, 0, -1.0825), "PoleBasket"), cap_bot=(V(0, 0, -1.1045), "PoleBasket"),
            sharp_rows=(2, 3, 4))
    # ferrule + carbide tip (tip at z = -1.175: 1.25 m overall)
    revolve(mb, [(0.0068, -1.128), (0.0066, -1.150), (0.0046, -1.162)], 10, "PoleBasket",
            cap_top=(V(0, 0, -1.127), "PoleBasket"), cap_bot=(V(0, 0, -1.163), "PoleBasket"))
    revolve(mb, [(0.0030, -1.161), (0.0024, -1.170), (0.0008, -1.1748)], 8, "PoleShaft",
            cap_top=(V(0, 0, -1.1605), "PoleShaft"), cap_bot=(V(0, 0, -1.175), "PoleShaft"))
    # wrist strap: flat webbing loop hanging from the top of the grip (behind it, -Y side)
    ctrl = [V(0, -0.004, 0.070), V(0, -0.020, 0.064), V(0, -0.040, 0.035), V(0, -0.052, -0.020), V(0, -0.048, -0.075),
            V(0, -0.032, -0.100), V(0, -0.016, -0.080), V(0, -0.017, -0.020), V(0, -0.012, 0.035), V(0, -0.004, 0.062)]
    pts = catmull(ctrl, 2)
    nrms = []
    for i in range(len(pts)):
        tg = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        nrms.append(V(1, 0, 0).cross(tg).normalized())
    ribbon(mb, pts, nrms, 0.0105, 0.0012, "PoleGrip", sharp=False)
    return mb

# ============================================================================
# FIRST-PERSON ARMS: fused glove + quilted sleeve
# ============================================================================
def _capsule(verts, faces, A, B, rA, rB, n=12):
    d = B - A
    d.normalize()
    e1, e2 = perp_frame(d, Vector((0.31, 0.52, 0.79)))
    rings = []
    for k in range(1, 4):
        psi = math.pi / 2 * k / 4
        rings.append((A - d * rA * math.cos(psi), rA * math.sin(psi)))
    rings += [(A, rA), (B, rB)]
    for k in range(3, 0, -1):
        psi = math.pi / 2 * k / 4
        rings.append((B + d * rB * math.cos(psi), rB * math.sin(psi)))
    base = len(verts)
    for c, r in rings:
        for j in range(n):
            t = TAU * j / n
            verts.append(c + e1 * (r * math.cos(t)) + e2 * (r * math.sin(t)))
    R = len(rings)
    for i in range(R - 1):
        for j in range(n):
            j1 = (j + 1) % n
            faces.append([base + i * n + j, base + i * n + j1, base + (i + 1) * n + j1, base + (i + 1) * n + j])
    p0 = len(verts); verts.append(A - d * rA)
    p1 = len(verts); verts.append(B + d * rB)
    for j in range(n):
        j1 = (j + 1) % n
        faces.append([p0, base + j1, base + j])
        faces.append([p1, base + (R - 1) * n + j, base + (R - 1) * n + j1])

def _loft_closed(verts, faces, rings):
    base = len(verts)
    n = len(rings[0])
    for r in rings:
        verts.extend(r)
    for i in range(len(rings) - 1):
        for j in range(n):
            j1 = (j + 1) % n
            faces.append([base + i * n + j, base + i * n + j1, base + (i + 1) * n + j1, base + (i + 1) * n + j])
    c0 = len(verts); verts.append(sum(rings[0], Vector()) / n)
    c1 = len(verts); verts.append(sum(rings[-1], Vector()) / n)
    last = base + (len(rings) - 1) * n
    for j in range(n):
        j1 = (j + 1) % n
        faces.append([c0, base + j1, base + j])
        faces.append([c1, last + j, last + j1])

def _ellipsoid(verts, faces, C, ax, ay, az, U, Vv, W, n=16, m=10):
    rings = []
    for i in range(1, m):
        th = math.pi * i / m
        ring = []
        for j in range(n):
            ph = TAU * j / n
            ring.append(C + U * (ax * math.cos(th)) + Vv * (ay * math.sin(th) * math.cos(ph)) + W * (az * math.sin(th) * math.sin(ph)))
        rings.append(ring)
    _loft_closed(verts, faces, rings)

def rounded_rect_poly(a0, a1, c0, c1, r, n_corner=6):
    pts = []
    corners = [(a1 - r, c0 + r, -90), (a1 - r, c1 - r, 0), (a0 + r, c1 - r, 90), (a0 + r, c0 + r, 180)]
    for ca, cc, start in corners:
        for k in range(n_corner + 1):
            ang = math.radians(start + 90 * k / n_corner)
            pts.append(Vector((ca + r * math.cos(ang), cc + r * math.sin(ang))))
    return pts

def circle_poly(ca, cc, r, n=48):
    return [Vector((ca + r * math.cos(TAU * k / n), cc + r * math.sin(TAU * k / n))) for k in range(n)]

def wrap_poly(P0, poly, lengths):
    """Finger joints (2D a,c) wrapping counter-clockwise around a convex obstacle polygon."""
    pts = [P0.copy()]
    P = P0.copy()
    cen = sum(poly, Vector((0, 0))) / len(poly)
    for L in lengths:
        d0 = (cen - P).normalized()
        amin = None
        for Q in poly:
            q = Q - P
            ang = math.atan2(d0.x * q.y - d0.y * q.x, d0.dot(q))
            if amin is None or ang < amin:
                amin = ang
        if amin is None or amin < -math.pi / 2 - 0.2:
            amin = -math.pi / 2
        c, s = math.cos(amin), math.sin(amin)
        d = Vector((d0.x * c - d0.y * s, d0.x * s + d0.y * c))
        P = P + d * L
        pts.append(P.copy())
    return pts

PALM_ROWS = [(0.000, 0.039, -0.021, 0.019), (0.030, 0.045, -0.023, 0.021), (0.060, 0.049, -0.023, 0.020),
             (0.082, 0.051, -0.022, 0.017), (0.095, 0.045, -0.017, 0.009)]
FINGERS = [  # b, a_mcp, radius, phalanx lengths  (index, middle, ring, pinky)
    (0.0375, 0.090, 0.0130, (0.046, 0.028, 0.025)),
    (0.0125, 0.094, 0.0134, (0.050, 0.031, 0.026)),
    (-0.0125, 0.091, 0.0128, (0.047, 0.029, 0.025)),
    (-0.0355, 0.084, 0.0116, (0.038, 0.023, 0.022)),
]

def fp_glove_prims(frame, obstacle, index_joints=None, thumb_joints=None, extra=None, gaunt_len=0.078, fdir=None):
    """Right-hand glove primitives. frame = (Wp, U, V, W); obstacle(rf) = 2D polygon (a,c) the fingers wrap."""
    Wp, U, Vv, Wn = frame
    verts, faces = [], []
    def L(a, b, c):
        return Wp + U * a + Vv * b + Wn * c
    fd = fdir if fdir is not None else -U
    g1, g2 = perp_frame(fd, Vv)
    rings = []
    for t, rb, rc in ((gaunt_len, 0.0392, 0.0345), (0.045, 0.0390, 0.0335), (0.015, 0.0383, 0.0312), (-0.004, 0.0382, 0.0302)):
        rings.append([Wp + fd * t + g1 * (rb * math.cos(TAU * j / 20)) + g2 * (rc * math.sin(TAU * j / 20)) for j in range(20)])
    rings.append([L(0.016, 0.0385 * math.cos(TAU * j / 20), -0.002 + 0.030 * math.sin(TAU * j / 20)) for j in range(20)])
    _loft_closed(verts, faces, rings)
    rings = []
    for a, hb, c0, c1 in PALM_ROWS:
        cm, hc = (c0 + c1) / 2, (c1 - c0) / 2
        rings.append([L(a, hb * sgnpow(math.cos(TAU * j / 24), 2 / 3.0), cm + hc * sgnpow(math.sin(TAU * j / 24), 2 / 3.0)) for j in range(24)])
    _loft_closed(verts, faces, rings)
    _ellipsoid(verts, faces, L(0.036, 0.027, 0.012), 0.032, 0.020, 0.018, U, Vv, Wn, n=16, m=10)
    joints_all = []
    for fi, (b, am, rfn, lens) in enumerate(FINGERS):
        if fi == 0 and index_joints is not None:
            js = index_joints
        else:
            poly = obstacle(rfn)
            pts = wrap_poly(Vector((am, -0.003)), poly, lens)
            js = [(p.x, b, p.y) for p in pts]
        joints_all.append(js)
        for k in range(3):
            A, B = L(*js[k]), L(*js[k + 1])
            _capsule(verts, faces, A, B, rfn * (1.0 if k == 0 else 0.98), rfn * (0.98 if k < 2 else 0.90), n=14)
    tj = thumb_joints
    trad = (0.0160, 0.0146, 0.0138, 0.0126)
    for k in range(3):
        _capsule(verts, faces, L(*tj[k]), L(*tj[k + 1]), trad[k], trad[k + 1], n=14)
    if extra:
        extra(verts, faces, L)
    return verts, faces, joints_all

def fp_sleeve(mb, Wp, fdir, hint, length=0.32):
    """Quilted puffy sleeve from the wrist cuff back along fdir (unit, wrist -> elbow)."""
    n = 28
    e1, e2 = perp_frame(fdir, hint)
    def ring(t, r1, r2, wob=0.0):
        pts = []
        for j in range(n):
            th = TAU * j / n
            k = 1.0 + wob * (0.5 * math.sin(2 * th + 9.0 * t) + 0.3 * math.sin(3 * th - 23.0 * t + 1.3)
                             + 0.2 * math.sin(5 * th + 31.0 * t + 0.4))
            pts.append(Wp + fdir * t + e1 * (r1 * k * math.cos(th)) + e2 * (r2 * k * math.sin(th)))
        return pts
    rows = []   # (t, r1, r2, kind, wobble)
    rows += [(0.064, 0.0402, 0.0396, "c", 0.0), (0.031, 0.0414, 0.0408, "c", 0.0), (0.0265, 0.0448, 0.0442, "c", 0.0),
             (0.0285, 0.0488, 0.0480, "o", 0.0), (0.036, 0.0522, 0.0512, "o", 0.004), (0.050, 0.0540, 0.0530, "o", 0.006),
             (0.064, 0.0528, 0.0518, "o", 0.006)]
    seams = [0.078, 0.142, 0.206, 0.270]
    def rb(t):
        r = lerp(0.0505, 0.0600, smoothstep(0.07, length, t))
        return r, r * 0.97
    edges = seams + [length]
    for k in range(len(edges) - 1):
        a, b = edges[k], edges[k + 1]
        r1, r2 = rb(a)
        rows.append((a - 0.0014, r1 * 0.992, r2 * 0.992, "s", 0.006))
        rows.append((a + 0.0014, r1 * 0.992, r2 * 0.992, "s", 0.006))
        for u in (0.22, 0.5, 0.78):
            t = a + (b - a) * u
            kp = 1.0 + 0.030 * math.sin(math.pi * u) ** 0.7
            r1, r2 = rb(t)
            rows.append((t, r1 * kp, r2 * kp, "b", 0.020))
    r1, r2 = rb(length)
    rows.append((length, r1 * 1.0, r2 * 1.0, "b", 0.008))
    rings = [ring(t, r1, r2, w) for (t, r1, r2, kd, w) in rows]
    # the first rows run back toward the wrist (inner lining), then the outer surface runs to the elbow
    def bm(i, j):
        k0, k1 = rows[i][3], rows[i + 1][3]
        if k0 == "c" or k1 == "c":
            return "JacketTrim"
        if k0 == "s" and k1 == "s":
            return "JacketTrim"
        return "Jacket"
    mb.loft(rings, bm, cap0=(Wp + fdir * 0.068, "JacketTrim"), cap1=(Wp + fdir * (length + 0.004), "Jacket"))

def drape_patch(mb, bvh, origin_fn, ray_dir, nu, nv, thick, mat, embed=0.0012, erode=True):
    """Padded slab laid over a surface: rays from origin_fn(u, v) along ray_dir find the surface;
    depths are eroded (the pad bridges valleys between fingers) and smoothed, like a rigid pad."""
    T, O = [], []
    for i in range(nv + 1):
        rowt, rowo = [], []
        for j in range(nu + 1):
            o = origin_fn(j / nu, i / nv)
            hit = bvh.ray_cast(o, ray_dir, 0.2)
            rowt.append((hit[0] - o).dot(ray_dir) if hit[0] is not None else 0.2)
            rowo.append(o)
        T.append(rowt)
        O.append(rowo)
    def nb(G, i, j):
        return [G[a][b] for a in range(max(0, i - 1), min(nv, i + 1) + 1) for b in range(max(0, j - 1), min(nu, j + 1) + 1)]
    if erode:
        T = [[min(nb(T, i, j)) for j in range(nu + 1)] for i in range(nv + 1)]      # erode: bridge valleys
    for _ in range(2 if erode else 1):                                               # smooth
        T = [[sum(nb(T, i, j)) / len(nb(T, i, j)) for j in range(nu + 1)] for i in range(nv + 1)]
    nr = -ray_dir.normalized()
    top, bot = [], []
    for i in range(nv + 1):
        rt, rb_ = [], []
        for j in range(nu + 1):
            u, v = j / nu, i / nv
            p = O[i][j] + ray_dir * T[i][j]
            e = 1.0 - (abs(2 * u - 1) ** 4 + abs(2 * v - 1) ** 4) ** 0.25   # rounded-rectangle falloff
            rt.append(p + nr * (thick * smoothstep(0.0, 0.30, e) - embed))
            rb_.append(p - nr * 0.006)
        top.append(rt)
        bot.append(rb_)
    slab(mb, top, bot, nr, mat)

def finger_seams(mb, bvh, frame, joints):
    """Raised stitched seams along the back of each finger, draped on the glove surface."""
    Wp, U, Vv, Wn = frame
    def L(p):
        return Wp + U * p[0] + Vv * p[1] + Wn * p[2]
    for js in joints:
        P = [Vector(j) for j in js]
        samples = []
        for k, ts in ((0, (0.2, 0.5, 0.8)), (1, (0.2, 0.5, 0.8)), (2, (0.25, 0.55))):
            a, b = P[k], P[k + 1]
            seg = b - a
            n2 = Vector((seg.z, -seg.x))          # perpendicular in the (a, c) plane
            if n2.dot(Vector((-(a.x + b.x) / 2 + 0.0, -(a.z + b.z) / 2))) > 0:
                n2 = -n2
            for t in ts:
                samples.append((a + seg * t, n2.normalized()))
        pts, nrms = [], []
        for q, n2 in samples:
            out = (U * n2.x + Wn * n2.y)
            # dorsal side = away from the palm: palm normal is +Wn, so the dorsal side has -Wn component
            if out.dot(-Wn) < 0 and abs(out.dot(Wn)) > 0.3:
                out = -out
            out.normalize()
            o = L(q) + out * 0.035
            hit = bvh.ray_cast(o, -out, 0.06)
            if hit[0] is None:
                continue
            pts.append(hit[0] + hit[1] * 0.0004)
            nrms.append(hit[1])
        if len(pts) >= 3:
            ribbon(mb, pts, nrms, 0.0012, 0.0008, "JacketTrim", sharp=False)

def glove_details(mb, glove_mb, frame, fdir, joints=None):
    """Knuckle padding panels + wrist cinch strap, draped on the remeshed glove."""
    Wp, U, Vv, Wn = frame
    bvh = glove_mb.bvh()
    def L(a, b, c):
        return Wp + U * a + Vv * b + Wn * c
    pad = MB()
    # knuckle bar over the MCP joints and a padded panel on the back of the hand
    drape_patch(pad, bvh, lambda u, v: L(lerp(0.070, 0.097, v), lerp(-0.043, 0.046, u), -0.09), Wn, 10, 3, 0.0060, "Glove")
    drape_patch(pad, bvh, lambda u, v: L(lerp(0.018, 0.064, v), lerp(-0.034, 0.036, u), -0.09), Wn, 7, 4, 0.0046, "Glove",
                erode=False)
    mb.extend(pad)
    if joints:
        finger_seams(mb, bvh, frame, joints)
    # wrist cinch strap: band around the wrist plus a tab with a pull on the back of the wrist
    pts, nrms = [], []
    a_s = 0.002
    g1, g2 = perp_frame(fdir, Vv)
    ctr = Wp + fdir * 0.004
    for k in range(24):
        th = TAU * k / 24
        dirv = g1 * math.cos(th) + g2 * math.sin(th)
        hit = bvh.ray_cast(ctr + dirv * 0.08, -dirv, 0.2)
        p, nr = (hit[0], hit[1]) if hit[0] is not None else (ctr + dirv * 0.038, dirv)
        pts.append(p + nr * 0.0012)
        nrms.append(nr)
    band = MB()
    ribbon_loop(band, pts, nrms, 0.0075, 0.0018, "JacketTrim")
    mb.extend(band)
    hit = bvh.ray_cast(ctr - Vv * 0.016 - Wn * 0.09, Wn, 0.2)
    if hit[0] is not None:
        tab_c = hit[0] + hit[1] * 0.004
        obox(mb, tab_c, fdir, Vv, hit[1], 0.017, 0.030, 0.006, "JacketTrim")

def build_fp_arm(kind):
    """Returns (MB) in construction (right-hand) space; caller mirrors left arms."""
    if kind == "R":
        s20, c20 = math.sin(math.radians(20)), math.cos(math.radians(20))
        U = V(0, c20, s20)            # knuckles point forward (grip axis tilted 20 deg, bottom forward)
        Vv = V(0, -s20, c20)          # thumb side = up along the grip axis
        Wn = V(-1, 0, 0)              # palm faces the grip (left)
        # grip top-back point sits at hand coords (0.045, 0.0325, 0.037) -> world origin
        Wp = -(U * 0.045 + Vv * 0.0325 + Wn * 0.037)
        def obstacle(rf):
            return rounded_rect_poly(0.045 - rf, 0.100 + rf, 0.020 - rf, 0.050 + rf, 0.008 + rf)
        def hand_dir(w):   # world direction -> hand coords (a, b, c)
            w = w.normalized()
            return Vector((w.dot(U), w.dot(Vv), w.dot(Wn)))
        index = [Vector((0.090, 0.0375, -0.003))]
        for L_, wdir in ((0.046, V(-0.10, 0.99, -0.03)), (0.028, V(-0.12, 0.99, -0.07)), (0.025, V(-0.08, 0.99, -0.14))):
            index.append(index[-1] + hand_dir(wdir) * L_)
        index = [tuple(p) for p in index]
        thumb = [(0.012, 0.030, 0.008), (0.034, 0.050, 0.050), (0.070, 0.037, 0.064), (0.096, 0.028, 0.066)]
        def extra(verts, faces, L):
            _ellipsoid(verts, faces, L(0.037, 0.040, 0.023), 0.021, 0.016, 0.025, U, Vv, Wn, n=16, m=10)  # web of the hand
        fdir = V(0.12, -0.94, -0.33).normalized()
    elif kind == "L":
        U, Vv = V(0, 1, 0), V(0, 0, 1)
        Wn = Vv.cross(U)              # = -X in construction space
        O2 = (0.067, 0.0295)
        Wp = -(U * O2[0] + Vv * 0.001 + Wn * O2[1])
        def obstacle(rf):
            return circle_poly(O2[0], O2[1], 0.0125 + rf)
        index = None
        thumb = [(0.012, 0.030, 0.008), (0.040, 0.050, 0.052), (0.075, 0.050, 0.060), (0.095, 0.044, 0.060)]
        def extra(verts, faces, L):
            _ellipsoid(verts, faces, L(0.030, 0.040, 0.029), 0.020, 0.013, 0.016, U, Vv, Wn, n=16, m=10)  # thumb web
        fdir = V(0.18, -0.95, -0.25).normalized()
    else:  # support hand under a 45 mm handguard
        U = V(-0.995, 0, -0.0995)
        Vv = V(0, 1, 0)
        Wn = Vv.cross(U)
        O2 = (0.060, 0.0395)
        Wp = -(U * O2[0] + Wn * O2[1])
        def obstacle(rf):
            return circle_poly(O2[0], O2[1], 0.0225 + rf)
        index = None
        # thumb along the (construction +X == world -X) side of the handguard, pointing forward
        thumb = [(0.012, 0.030, 0.008), (0.030, 0.062, 0.020), (0.026, 0.094, 0.030), (0.025, 0.118, 0.036)]
        extra = None
        fdir = V(0.60, -0.55, -0.58).normalized()
    frame = (Wp, U, Vv, Wn)
    verts, faces, joints = fp_glove_prims(frame, obstacle, index, thumb, extra, fdir=fdir)
    glove = remesh_to_mb(verts, faces, "Glove", voxel=0.0012, target=1550, smooth_iter=6, name="fpglove", mode="qf")
    mb = MB()
    mb.extend(glove)
    glove_details(mb, glove, frame, fdir, joints)
    fp_sleeve(mb, Wp, fdir, Wn * -1.0 if kind != "S" else V(0, 0, 1))
    return mb, frame, fdir

# ============================================================================
# main
# ============================================================================
LAYOUT = {   # scene placement of each origin (layout only)
    "Ski": V(0.0, 0.0, 0.0),
    "Snowboard": V(0.55, 0.0, 0.0),
    "Pole": V(-0.30, 0.0, 1.175),
    "FP_ArmR": V(-0.75, -0.35, 1.0),
    "FP_ArmL": V(-0.75, 0.15, 1.0),
    "FP_ArmL_Support": V(-0.75, 0.65, 1.0),
}

def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    items = [("Ski", build_ski()), ("Snowboard", build_snowboard()), ("Pole", build_pole())]
    arm_r, _, _ = build_fp_arm("R")
    arm_l, _, _ = build_fp_arm("L")
    arm_s, _, _ = build_fp_arm("S")
    items += [("FP_ArmR", arm_r), ("FP_ArmL", mirror_mb(arm_l)), ("FP_ArmL_Support", mirror_mb(arm_s))]
    for name, mb in items:
        loc = LAYOUT[name]
        translate_mb(mb, loc)
        make_object(name, mb, loc)
        print("ITEM %-16s tris %5d  origin (%.3f, %.3f, %.3f)" % (name, mb.tris(), loc.x, loc.y, loc.z))

main()
