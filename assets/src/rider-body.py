# Big Mountain Shooter - rider body as rigid, procedurally posed parts.
# Blender metres, +Z up, the character faces +Y, its right side is +X.
# Each part is its own mesh object whose ORIGIN sits exactly on its joint pivot.
# Joints get spherical / rounded overlapping ends so parts stay continuous when posed.
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
    "Jacket": ((0.85, 0.85, 0.85), 0.0, 0.75),
    "JacketTrim": ((0.04, 0.04, 0.04), 0.0, 0.6),
    "Pants": ((0.70, 0.70, 0.70), 0.0, 0.8),
    "Helmet": ((0.85, 0.85, 0.85), 0.0, 0.35),
    "GoggleFrame": ((0.03, 0.03, 0.03), 0.0, 0.5),
    "GoggleLens": ((0.95, 0.55, 0.12), 1.0, 0.06),
    "Gaiter": ((0.08, 0.08, 0.08), 0.0, 0.95),
    "Glove": ((0.03, 0.03, 0.03), 0.0, 0.7),
    "Boot": ((0.75, 0.75, 0.75), 0.0, 0.4),
    "Buckle": ((0.60, 0.60, 0.60), 1.0, 0.3),
    "Backpack": ((0.06, 0.06, 0.06), 0.0, 0.85),
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

def axis_ring(P, d, e1, e2, t, r1, r2, n, off1=0.0, off2=0.0):
    c = P + d * t + e1 * off1 + e2 * off2
    return [c + e1 * (r1 * math.cos(TAU * j / n)) + e2 * (r2 * math.sin(TAU * j / n)) for j in range(n)]

def limb(mb, P, Q, rows, n, hint, dome0, dome1, mat_of_band, end_cap=None):
    """Tube along P->Q. rows: list of (t, r1, r2, kind). dome0/dome1: (R1, R2, [psi...]) or None.
    Domes are centred exactly on P / Q (ball-joint ends)."""
    d = (Q - P).normalized()
    L = (Q - P).length
    e1, e2 = perp_frame(d, hint)
    rings, kinds = [], []
    if dome0:
        R1, R2, psis = dome0
        for psi in psis:
            rings.append(axis_ring(P, d, e1, e2, -max(R1, R2) * math.cos(psi), R1 * math.sin(psi), R2 * math.sin(psi), n))
            kinds.append("d")
    for row in rows:
        t, r1, r2, kd = row[:4]
        off1 = row[4] if len(row) > 4 else 0.0
        rings.append(axis_ring(P, d, e1, e2, t, r1, r2, n, off1))
        kinds.append(kd)
    if dome1:
        R1, R2, psis = dome1
        for psi in reversed(psis):
            rings.append(axis_ring(P, d, e1, e2, L + max(R1, R2) * math.cos(psi), R1 * math.sin(psi), R2 * math.sin(psi), n))
            kinds.append("d")
    cap0 = (P - d * max(dome0[0], dome0[1]), mat_of_band(kinds[0], kinds[0])) if dome0 else None
    if dome1:
        cap1 = (Q + d * max(dome1[0], dome1[1]), mat_of_band(kinds[-1], kinds[-1]))
    else:
        cap1 = end_cap
    mats = [mat_of_band(kinds[i], kinds[i + 1]) for i in range(len(rings) - 1)]
    mb.loft(rings, mats, cap0=cap0, cap1=cap1)
    return d, e1, e2

def quilt_rows(t0, t1, seams, rfun, puff, seam_w=0.0022, mids=1):
    """Rows (t, r1, r2, kind) between t0..t1 with pinched dark seams and puffy baffles."""
    rows = []
    edges = [t0] + list(seams) + [t1]
    for k in range(len(edges) - 1):
        a, b = edges[k], edges[k + 1]
        if k == 0:
            r1, r2 = rfun(a)
            rows.append((a, r1, r2, "j"))
        else:
            r1, r2 = rfun(a + seam_w)
            rows.append((a + seam_w, r1 * 0.992, r2 * 0.992, "s"))
        for m in range(mids):
            t = a + (b - a) * (m + 1) / (mids + 1)
            u = (t - a) / (b - a)
            k_p = 1.0 + puff * math.sin(math.pi * u) ** 0.6
            r1, r2 = rfun(t)
            rows.append((t, r1 * k_p, r2 * k_p, "b"))
        if k < len(edges) - 2:
            r1, r2 = rfun(b - seam_w)
            rows.append((b - seam_w, r1 * 0.992, r2 * 0.992, "s"))
        else:
            r1, r2 = rfun(b)
            rows.append((b, r1, r2, "j"))
    return rows

def sleeve_mat(k0, k1):
    if k0 == "s" and k1 == "s":
        return "JacketTrim"
    if k0 == "c" or k1 == "c":
        return "JacketTrim"
    return "Jacket"

# ============================================================================
# skeleton pivots (right side; left side mirrors x)
# ============================================================================
PELVIS = V(0, 0, 0.95)
TORSO = V(0, 0, 1.02)
HEAD = V(0, 0, 1.50)
SHOULDER = V(0.20, 0, 1.42)
ELBOW = V(0.235, 0, 1.13)
WRIST = V(0.26, 0, 0.88)
HIP = V(0.10, 0, 0.92)
KNEE = V(0.11, 0, 0.50)
ANKLE = V(0.12, 0, 0.10)

# ============================================================================
# TORSO (puffy jacket)
# ============================================================================
TORSO_PROF = Prof([
    # z      a      f      b      p
    (0.935, 0.060, 0.045, 0.045, 2.0),
    (0.950, 0.118, 0.082, 0.080, 2.1),
    (0.975, 0.148, 0.103, 0.099, 2.25),
    (1.005, 0.160, 0.112, 0.106, 2.35),
    (1.050, 0.165, 0.117, 0.110, 2.4),
    (1.130, 0.164, 0.117, 0.111, 2.4),
    (1.215, 0.167, 0.123, 0.116, 2.4),
    (1.300, 0.173, 0.128, 0.120, 2.45),
    (1.360, 0.180, 0.127, 0.121, 2.5),
    (1.400, 0.189, 0.122, 0.119, 2.6),
    (1.435, 0.192, 0.113, 0.112, 2.6),
    (1.460, 0.178, 0.102, 0.104, 2.4),
    (1.480, 0.147, 0.095, 0.096, 2.2),
    (1.497, 0.112, 0.092, 0.091, 2.0),
    (1.515, 0.094, 0.092, 0.089, 2.0),
    (1.545, 0.091, 0.093, 0.089, 2.0),
    (1.570, 0.093, 0.095, 0.091, 2.0),
])
T_SEAMS = [1.05, 1.13, 1.215, 1.30, 1.385]
T_BAFFLES = [(0.975, 1.05), (1.05, 1.13), (1.13, 1.215), (1.215, 1.30), (1.30, 1.385), (1.385, 1.475)]
PUFF_T = 0.055
N_T = 24
COLLAR_TOP = 1.562

def torso_puff(z):
    for s0, s1 in T_BAFFLES:
        if s0 <= z <= s1:
            u = (z - s0) / (s1 - s0)
            amp = PUFF_T * (0.8 if s1 > 1.4 else 1.0)
            return amp * (math.sin(math.pi * u) ** 0.6)
    return 0.0

def collar_tilt(th):
    return -0.010 * math.sin(th)  # collar lower at the front

def torso_point(th, z, puff=None, pinch=0.0):
    a, f, b, p = TORSO_PROF(z)
    c, s = math.cos(th), math.sin(th)
    x = a * sgnpow(c, 2.0 / p)
    y = (f if s >= 0 else b) * sgnpow(s, 2.0 / p)
    pf = torso_puff(z) if puff is None else puff
    w = 1.0
    if s > 0:
        w = smoothstep(0.012, 0.05, abs(x))  # flat placket under the front zip
    k = 1.0 + pf * w - pinch
    return Vector((x * k, y * k, z))

def torso_front_pt(x, z, puff=True):
    """Point on the torso front surface at lateral x (bisection on the angle)."""
    ax = abs(x)
    lo, hi = 0.0, math.pi / 2
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        p = torso_point(mid, z, None if puff else 0.0)
        if p.x > ax:
            lo = mid
        else:
            hi = mid
    p = torso_point(0.5 * (lo + hi), z, None if puff else 0.0)
    return Vector((math.copysign(p.x, x) if x != 0 else 0.0, p.y, p.z))

def torso_back_y(x, z):
    a, f, b, p = TORSO_PROF(z)
    u = clamp(abs(x) / a, 0.0, 0.999)
    return -b * (1 - u ** p) ** (1.0 / p)

def build_torso():
    mb = MB()
    TH = [TAU * j / N_T for j in range(N_T)]
    zs = [0.941, 0.955, 0.975, 1.0, 1.025]
    kinds = ["b"] * len(zs)
    for s in T_SEAMS:
        zs += [s - 0.0022, s + 0.0022]
        kinds += ["s", "s"]
        nxt = [t for t in T_SEAMS if t > s]
        top = nxt[0] if nxt else 1.475
        for u in ((0.33, 0.67) if nxt else (0.33, 0.66)):
            zs.append(s + (top - s) * u)
            kinds.append("b")
    zs += [1.458, 1.473, 1.487, 1.499, 1.516, 1.540]
    kinds += ["b"] * 6
    rings = []
    for z, kd in zip(zs, kinds):
        blend = smoothstep(1.50, 1.56, z)
        rings.append([torso_point(th, z + collar_tilt(th) * blend, pinch=0.007 if kd == "s" else 0.0) for th in TH])

    def coll(th, shrink, dz):
        a, f, b, p = TORSO_PROF(1.57)
        c, s = math.cos(th), math.sin(th)
        x = (a - shrink) * sgnpow(c, 2.0 / p)
        y = ((f if s >= 0 else b) - shrink) * sgnpow(s, 2.0 / p)
        return Vector((x, y, COLLAR_TOP + collar_tilt(th) + dz))
    for shrink, dz in ((0.0, 0.0), (0.004, 0.005), (0.010, 0.004), (0.0135, -0.006)):
        rings.append([coll(th, shrink, dz) for th in TH])
        kinds.append("c")
    rings.append([V(*(coll(th, 0.016, 0.0).xy), 1.505) for th in TH])
    kinds.append("c")

    def bandmat(i, j):
        if kinds[i] == "s" and kinds[i + 1] == "s":
            return "JacketTrim"
        if kinds[i] == "c" and kinds[i + 1] == "c" and i >= len(rings) - 4:
            return "JacketTrim"
        return "Jacket"
    mb.loft(rings, bandmat, cap0=(V(0, 0, 0.935), "Jacket"), cap1=(V(0, 0, 1.495), "JacketTrim"))

    # front zip strip on the placket, hem seam -> collar top
    zr = []
    ztop_front = COLLAR_TOP + collar_tilt(math.pi / 2)
    for i in range(15):
        z = lerp(1.046, ztop_front - 0.002, i / 14)
        blend = smoothstep(1.50, 1.56, z)
        p = torso_point(math.pi / 2, z, puff=0.0)
        if z > 1.50:
            p = Vector((0, coll(math.pi / 2, 0, 0).y * (1 - blend) + p.y * blend, z))
        y0 = p.y - 0.001
        zr.append([V(-0.0055, y0, z), V(0.0055, y0, z), V(0.0055, y0 + 0.0045, z), V(-0.0055, y0 + 0.0045, z)])
    mb.loft(zr, "JacketTrim", cap0=(sum(zr[0], Vector()) / 4, "JacketTrim"),
            cap1=(sum(zr[-1], Vector()) / 4, "JacketTrim"), sharp_cols=(0, 1, 2, 3))
    # zip pull hanging at the collar top
    yp = coll(math.pi / 2, 0, 0).y + 0.006
    obox(mb, V(0, yp, ztop_front - 0.016), V(1, 0, 0), V(0, 1, 0), V(0, 0, 1), 0.011, 0.004, 0.026, "JacketTrim")

    # chest pocket (left chest, upper chest baffle) + zip along its top edge
    pk = MB()
    xs = [-0.102 + i * 0.066 / 6 for i in range(7)]
    zz = [1.312 + i * 0.058 / 4 for i in range(5)]
    grid = []
    for z in zz:
        row = []
        for x in xs:
            p = torso_front_pt(x, z)
            ex = min(abs(x - xs[0]), abs(x - xs[-1])) / 0.011
            ez = min(abs(z - zz[0]), abs(z - zz[-1])) / 0.011
            t = 0.0055 * smoothstep(0.0, 1.0, min(ex, ez, 1.0)) - 0.0015
            row.append(V(p.x, p.y + t, z))
        grid.append(row)
    top = [[pk.add(p) for p in row] for row in grid]
    bot = [[pk.add(V(p.x, p.y - 0.006, p.z)) for p in row] for row in grid]
    R, C = len(grid), len(grid[0])
    for i in range(R - 1):
        for j in range(C - 1):
            pk.face([top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]], "Jacket")
            pk.face([bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]], "Jacket")
    border = [(0, j) for j in range(C)] + [(i, C - 1) for i in range(1, R)] + \
             [(R - 1, j) for j in range(C - 2, -1, -1)] + [(i, 0) for i in range(R - 2, 0, -1)]
    for k in range(len(border)):
        a, b = border[k], border[(k + 1) % len(border)]
        pk.face([top[a[0]][a[1]], top[b[0]][b[1]], bot[b[0]][b[1]], bot[a[0]][a[1]]], "Jacket")
    mb.extend(pk)
    zr = []
    for x in [xs[0] + 0.006 + i * (xs[-1] - xs[0] - 0.012) / 4 for i in range(5)]:
        p = torso_front_pt(x, 1.362)
        y0 = p.y + 0.0035
        zr.append([V(x, y0 + 0.0025, 1.3595), V(x, y0 + 0.0025, 1.3645), V(x, y0 - 0.004, 1.3645), V(x, y0 - 0.004, 1.3595)])
    mb.loft(zr, "JacketTrim", cap0=(sum(zr[0], Vector()) / 4, "JacketTrim"), cap1=(sum(zr[-1], Vector()) / 4, "JacketTrim"))
    return mb

def build_torso_base_mesh():
    """Smooth no-puff torso surface (not exported) used to drape straps."""
    mb = MB()
    n = 40
    TH = [TAU * j / n for j in range(n)]
    rings = []
    for k in range(60):
        z = lerp(1.0, 1.55, k / 59)
        rings.append([torso_point(th, z, puff=0.0) for th in TH])
    mb.loft(rings, "Jacket")
    return mb

# ============================================================================
# PELVIS (pants seat + hips) with the jacket hem
# ============================================================================
PANTS_PROF = Prof([
    # z      a      f      b      p
    (0.792, 0.040, 0.030, 0.035, 2.0),
    (0.805, 0.085, 0.050, 0.070, 2.2),
    (0.825, 0.125, 0.048, 0.080, 2.3),
    (0.855, 0.160, 0.060, 0.106, 2.4),
    (0.880, 0.175, 0.076, 0.122, 2.5),
    (0.900, 0.182, 0.094, 0.131, 2.5),
    (0.950, 0.184, 0.117, 0.129, 2.5),
    (1.000, 0.171, 0.114, 0.116, 2.4),
    (1.040, 0.158, 0.110, 0.107, 2.4),
    (1.070, 0.150, 0.105, 0.102, 2.3),
])
HEM_PROF = Prof([
    (0.912, 0.195, 0.123, 0.140, 2.5),
    (0.930, 0.196, 0.126, 0.141, 2.5),
    (0.950, 0.196, 0.127, 0.139, 2.5),
    (0.968, 0.192, 0.127, 0.135, 2.5),
    (1.000, 0.181, 0.125, 0.124, 2.45),
    (1.035, 0.169, 0.120, 0.114, 2.4),
    (1.050, 0.1635, 0.1155, 0.109, 2.4),
    (1.066, 0.158, 0.111, 0.105, 2.4),
])

def se_xy(th, a, f, b, p, k=1.0):
    c, s = math.cos(th), math.sin(th)
    return (a * sgnpow(c, 2.0 / p) * k, (f if s >= 0 else b) * sgnpow(s, 2.0 / p) * k)

def build_pelvis():
    mb = MB()
    n = 24
    TH = [TAU * j / n for j in range(n)]
    zs = [0.797, 0.81, 0.828, 0.852, 0.88, 0.915, 0.955, 1.0, 1.04, 1.07]
    rings = []
    for z in zs:
        a, f, b, p = PANTS_PROF(z)
        rings.append([V(*se_xy(th, a, f, b, p), z) for th in TH])
    mb.loft(rings, "Pants", cap0=(V(0, -0.004, 0.790), "Pants"), cap1=(V(0, 0, 1.072), "Pants"))

    # jacket hem: closed shell (outer surface down, rolled elastic band, inner surface up)
    n2 = 24
    TH2 = [-TAU * j / n2 for j in range(n2)]   # CW about +Z for the downward outer surface

    def drop(th):
        return -0.018 * max(0.0, -math.sin(th))  # dropped back hem

    def hem_pt(th, z, dk=0.0):
        zz = z + drop(th) * smoothstep(1.02, 0.94, z)
        a, f, b, p = HEM_PROF(z)
        x, y = se_xy(th, a - dk, f - dk, b - dk, p)
        return V(x, y, zz)
    rings, kinds = [], []
    for z in (1.066, 1.05, 1.022, 0.99, 0.958, 0.935):
        rings.append([hem_pt(th, z) for th in TH2]); kinds.append("o")
    for z, dk in ((0.921, 0.0015), (0.915, 0.005), (0.919, 0.0095)):
        rings.append([hem_pt(th, z, dk) for th in TH2]); kinds.append("t")
    for z, dk in ((0.943, 0.0105), (1.060, 0.007)):
        rings.append([hem_pt(th, z, dk) for th in TH2]); kinds.append("i")

    def hm(i, j):
        return "JacketTrim" if (kinds[i] == "t" or kinds[i + 1] == "t") else "Jacket"
    R = mb.loft(rings, hm)
    mb.bridge(R[-1], R[0], "Jacket")
    return mb

# ============================================================================
# HEAD: helmet + goggles + strap + gaiter (origin at the neck base)
# ============================================================================
HC = V(0, -0.010, 1.655)
HAX, HAZ = 0.111, 0.125
HPLAN = 2.4

def h_ay(cphi):
    return 0.129 if cphi >= 0 else 0.141

RIM = pchip([0, 30, 55, 75, 95, 120, 150, 180],
            [1.697, 1.690, 1.664, 1.622, 1.597, 1.600, 1.611, 1.617])

def helmet_pt(phi, theta, scale=1.0, dz=0.0):
    sp, cp = math.sin(phi), math.cos(phi)
    st, ct = math.sin(theta), math.cos(theta)
    px, py = sgnpow(sp, 2.0 / HPLAN), sgnpow(cp, 2.0 / HPLAN)
    z = HAZ * ct
    zz = HC.z + z
    tuck = smoothstep(1.665, 1.597, zz)
    x = HAX * st * px * (1.0 - 0.15 * tuck * abs(sp))
    y = h_ay(cp) * st * py * (1.0 - (0.05 * tuck * abs(cp) if cp < 0 else 0.0))
    if cp > 0:  # brow lip comes forward over the goggles
        y += 0.010 * math.exp(-(math.degrees(phi) / 38.0) ** 2) * smoothstep(1.735, 1.70, zz)
    return V(x * scale, HC.y + y * scale, HC.z + z * scale + dz)

def helmet_theta_at(z):
    return math.acos(clamp((z - HC.z) / HAZ, -1, 1))

def helmet_normal(phi, theta):
    p = helmet_pt(phi, theta)
    e = 1e-4
    dt = helmet_pt(phi, theta + e) - helmet_pt(phi, theta - e)
    dp = helmet_pt(phi + e, theta) - helmet_pt(phi - e, theta)
    n = dt.cross(dp)
    if n.length < 1e-12:
        n = p - HC
    n.normalize()
    if n.dot(p - HC) < 0:
        n = -n
    return n

GC = V(0, -0.006, 1.655)   # goggle sphere centre
GR = 0.126
GA = math.radians(57.0)
GB = math.radians(15.5)

def goggle_outline(j, n):
    t = TAU * j / n
    c, s = math.cos(t), math.sin(t)
    al = GA * sgnpow(c, 2.0 / 3.2)
    be = GB * sgnpow(s, 2.0 / 3.2)
    if be < 0:
        be *= (1.0 - 0.55 * math.exp(-(al / math.radians(13.0)) ** 2))  # nose notch
    return al, be

def gpt(al, be, r):
    return V(GC.x + r * math.sin(al) * math.cos(be), GC.y + r * math.cos(al) * math.cos(be), GC.z + r * math.sin(be))

GAITER_PROF = Prof([
    # z      a      f      b      p
    (1.450, 0.058, 0.064, 0.060, 2.0),
    (1.500, 0.061, 0.067, 0.061, 2.0),
    (1.535, 0.063, 0.071, 0.064, 2.0),
    (1.555, 0.067, 0.080, 0.068, 2.1),
    (1.575, 0.072, 0.090, 0.074, 2.2),
    (1.600, 0.076, 0.097, 0.082, 2.3),
    (1.630, 0.078, 0.098, 0.092, 2.3),
    (1.660, 0.080, 0.096, 0.101, 2.3),
    (1.695, 0.080, 0.090, 0.106, 2.3),
    (1.725, 0.076, 0.082, 0.103, 2.2),
    (1.748, 0.062, 0.066, 0.088, 2.1),
    (1.760, 0.040, 0.044, 0.062, 2.0),
])

def build_head():
    mb = MB()
    # ---- helmet shell (rings advance downward from the crown; azimuth runs clockwise from above) ----
    n = 28
    PHI = [math.atan2(math.sin(TAU * j / n), math.cos(TAU * j / n)) for j in range(n)]
    rings = []
    for t in (0.17, 0.35, 0.52, 0.67, 0.79, 0.89, 0.96, 1.0):
        rings.append([helmet_pt(ph, helmet_theta_at(RIM(abs(math.degrees(ph)))) * t) for ph in PHI])
    for scale, dz in ((0.985, -0.005), (0.945, -0.004), (0.86, 0.012), (0.80, 0.04)):
        rings.append([helmet_pt(ph, helmet_theta_at(RIM(abs(math.degrees(ph)))), scale, dz) for ph in PHI])
    mb.loft(rings, "Helmet", cap0=(V(0, HC.y, HC.z + HAZ), "Helmet"), cap1=(V(0, HC.y + 0.005, 1.735), "Helmet"))

    # ---- vents: 4 dark slots on the crown ----
    for sx in (-1, 1):
        for (lat, f0, f1) in ((0.30, -0.36, 0.06), (0.30, 0.22, 0.60)):
            pts, nrms = [], []
            for k in range(5):
                u = lerp(f0, f1, k / 4)
                dx, dy = sx * lat, u
                dz = math.sqrt(max(0.0, 1 - dx * dx - dy * dy))
                th, ph = math.acos(dz), math.atan2(dx, dy)
                pts.append(helmet_pt(ph, th))
                nrms.append(helmet_normal(ph, th))
            hws = [0.003, 0.0055, 0.0055, 0.0055, 0.003]
            ribbon(mb, [p - nr * 0.001 for p, nr in zip(pts, nrms)], nrms, 0.0055, 0.0022, "GoggleFrame",
                   sharp=False, hws=hws)

    # ---- goggles: lens + frame (one closed solid) ----
    ng = 32
    outline = [goggle_outline(j, ng) for j in range(ng)]
    spec = [  # (outline scale, sphere radius, material of the band beyond this ring)
        (0.45, GR, "GoggleLens"),
        (0.86, GR, "GoggleLens"),
        (0.955, GR - 0.0005, "GoggleFrame"),
        (0.975, GR + 0.0032, "GoggleFrame"),
        (1.010, GR + 0.0030, "GoggleFrame"),
        (1.040, GR - 0.006, "GoggleFrame"),
        (1.050, GR - 0.026, "GoggleFrame"),
        (1.000, GR - 0.045, "GoggleFrame"),
    ]
    gm = MB()
    R = gm.loft([[gpt(al * s, be * s, r) for (al, be) in outline] for s, r, _ in spec], [sp[2] for sp in spec[:-1]])
    centre = gm.add(gpt(0, 0, GR))
    back = gm.add(gpt(0, 0, GR - 0.05))
    for j in range(ng):
        j1 = (j + 1) % ng
        gm.face([centre, R[0][j], R[0][j1]], "GoggleLens")
        gm.face([back, R[-1][j1], R[-1][j]], "GoggleFrame")
    fix_winding(gm, gpt(0, 0, GR - 0.02))
    mb.extend(gm)

    # ---- goggle strap around the helmet (flat, crisp edges) ----
    side_end = gpt(GA * 0.96, 0.0, GR - 0.016)
    pts, nrms = [side_end.copy()], [V(side_end.x, side_end.y - HC.y, 0).normalized()]
    angs = list(range(68, 180, 14)) + [180] + [360 - a for a in reversed(range(68, 180, 14))]
    for a in angs:
        ph = math.atan2(math.sin(math.radians(a)), math.cos(math.radians(a)))
        zst = 1.657 + 0.013 * smoothstep(70.0, 160.0, abs(math.degrees(ph)))
        th = helmet_theta_at(zst)
        pts.append(helmet_pt(ph, th) + helmet_normal(ph, th) * 0.0016)
        nrms.append(helmet_normal(ph, th))
    pts.append(V(-side_end.x, side_end.y, side_end.z))
    nrms.append(V(-nrms[0].x, nrms[0].y, nrms[0].z))
    # strap width runs along +Z: build with an explicit frame
    srings = []
    for i, p in enumerate(pts):
        nr = nrms[i]
        up = V(0, 0, 1)
        up = (up - nr * up.dot(nr)).normalized()
        hw, t0, t1 = 0.019, -0.0012, 0.0022
        srings.append([p + nr * t0 - up * hw, p + nr * t1 - up * hw, p + nr * t1 + up * hw, p + nr * t0 + up * hw])
    # orientation: (n, up) CCW is about n x up; path runs from +X side around the back to -X side
    tmp = srings[len(srings) // 2]
    tng = pts[len(pts) // 2 + 1] - pts[len(pts) // 2 - 1]
    if (tmp[1] - tmp[0]).cross(tmp[2] - tmp[1]).dot(tng) < 0:
        srings = [list(reversed(r)) for r in srings]
    mb.loft(srings, "GoggleFrame", cap0=(sum(srings[0], Vector()) / 4, "GoggleFrame"),
            cap1=(sum(srings[-1], Vector()) / 4, "GoggleFrame"), sharp_cols=(0, 1, 2, 3))

    # ---- gaiter / head volume (no skin anywhere) ----
    n3 = 20
    TH3 = [TAU * j / n3 for j in range(n3)]
    rings = []
    for z in (1.452, 1.475, 1.50, 1.525, 1.548, 1.567, 1.585, 1.603, 1.621, 1.64, 1.662, 1.69, 1.718, 1.742, 1.756):
        a, f, b, p = GAITER_PROF(z)
        ring = []
        for th in TH3:
            x, y = se_xy(th, a, f, b, p)
            if y > 0:
                y += 0.010 * math.exp(-((z - 1.622) / 0.016) ** 2) * math.exp(-(x / 0.02) ** 2)  # nose
            fold = 0.0022 * math.sin((z - 1.47) / 0.026 * math.pi) * smoothstep(1.555, 1.47, z)
            ring.append(V(x * (1 + fold / a), y * (1 + fold / max(f, b)), z))
        rings.append(ring)
    mb.loft(rings, "Gaiter", cap0=(V(0, 0, 1.447), "Gaiter"), cap1=(V(0, -0.006, 1.762), "Gaiter"))
    return mb

def fix_winding(mb, inside_point):
    """Orient faces of a star-shaped closed solid away from inside_point."""
    for k, f in enumerate(mb.F):
        pts = [mb.V[i] for i in f]
        c = sum(pts, Vector()) / len(pts)
        nrm = Vector()
        for i in range(len(pts)):
            nrm += pts[i].cross(pts[(i + 1) % len(pts)])
        if nrm.dot(c - inside_point) < 0:
            mb.F[k] = list(reversed(f))

# ============================================================================
# BACKPACK (+ shoulder straps, sternum strap); origin = torso pivot
# ============================================================================
def build_backpack(base_bvh):
    mb = MB()
    n = 18
    zs = [1.087, 1.098, 1.12, 1.16, 1.22, 1.28, 1.34, 1.39, 1.425, 1.445, 1.455]
    W = pchip([1.085, 1.10, 1.14, 1.30, 1.40, 1.44, 1.455], [0.085, 0.112, 0.122, 0.124, 0.118, 0.098, 0.06])
    D = pchip([1.085, 1.10, 1.14, 1.30, 1.40, 1.44, 1.455], [0.035, 0.058, 0.070, 0.070, 0.062, 0.045, 0.02])

    def pocket(x, z):
        return 0.013 * smoothstep(1.10, 1.15, z) * smoothstep(1.31, 1.25, z) * smoothstep(0.115, 0.05, abs(x))
    rings = []
    for z in zs:
        w, d = W(z), D(z)
        ring = []
        for j in range(n):
            t = TAU * j / n
            c, s = math.cos(t), math.sin(t)
            x = w * sgnpow(c, 2 / 3.2)
            yb = torso_back_y(x * 0.95, z) + 0.006
            if s <= 0:
                y = yb - (d + pocket(x, z)) * abs(sgnpow(s, 2 / 3.2))
            else:
                y = yb + 0.010 * sgnpow(s, 2 / 3.2) * max(0.0, 1 - abs(x) / (w + 1e-6)) ** 0.5
            ring.append(V(x, y, z))
        rings.append(ring)
    mb.loft(rings, "Backpack", cap0=(V(0, torso_back_y(0, 1.087) - 0.02, 1.083), "Backpack"),
            cap1=(V(0, torso_back_y(0, 1.455) - 0.004, 1.457), "Backpack"))

    def pack_back_pt(x, z):
        w, d = W(z), D(z)
        u = clamp(abs(x) / w, 0, 0.999)
        s = (1 - u ** 3.2) ** (1 / 3.2)
        return V(x, torso_back_y(x * 0.95, z) + 0.006 - (d + pocket(x, z)) * s, z)
    # two vertical compression straps
    for sx in (-0.068, 0.068):
        pts = [pack_back_pt(sx, lerp(1.115, 1.43, k / 5)) for k in range(6)]
        nrms = [V(0, -1, 0)] * len(pts)
        ribbon(mb, [p + V(0, 0.001, 0) for p in pts], nrms, 0.010, 0.0025, "JacketTrim")
    # shoulder straps: padded over the shoulder and chest, thin webbing under the arm
    for sx in (1, -1):
        ctrl = [V(0.066, -0.135, 1.43), V(0.088, -0.104, 1.47), V(0.100, -0.045, 1.498), V(0.106, 0.030, 1.49),
                V(0.112, 0.098, 1.432), V(0.118, 0.129, 1.345), V(0.130, 0.126, 1.262), V(0.152, 0.092, 1.19),
                V(0.166, 0.018, 1.135), V(0.150, -0.070, 1.110), V(0.110, -0.126, 1.104)]
        ctrl = [V(sx * c.x, c.y, c.z) for c in ctrl]
        raw = catmull(ctrl, 2)
        pts, nrms, hws, hts = [], [], [], []
        for i, p in enumerate(raw):
            loc, nr, idx, dist = base_bvh.find_nearest(p)
            u = i / (len(raw) - 1)
            pad = smoothstep(0.80, 0.62, u)  # 1 = padded part
            hw = lerp(0.011, 0.023, pad)
            ht = lerp(0.0022, 0.0058, pad)
            pts.append(loc + nr * (0.0075 + ht))
            nrms.append(nr)
            hws.append(hw)
            hts.append(ht)
        ribbon(mb, pts, nrms, 0.02, 0.005, "JacketTrim", sharp=False, hws=hws, hts=hts, profile=6)
    # sternum strap with a buckle
    pts, nrms = [], []
    for k in range(7):
        x = lerp(-0.124, 0.124, k / 6)
        loc, nr, idx, dist = base_bvh.find_nearest(V(x, 0.2, 1.335))
        pts.append(loc + nr * 0.0165)
        nrms.append(nr)
    ribbon(mb, pts, nrms, 0.009, 0.0025, "JacketTrim")
    loc, nr, idx, dist = base_bvh.find_nearest(V(0, 0.2, 1.335))
    obox(mb, loc + nr * 0.020, V(1, 0, 0), V(0, 0, 1), nr, 0.034, 0.024, 0.008, "Backpack")
    return mb

# ============================================================================
# ARMS
# ============================================================================
def build_upper_arm():
    mb = MB()
    L = (ELBOW - SHOULDER).length
    def rf(t):
        r = lerp(0.060, 0.0515, smoothstep(0.0, L, t))
        return r, r * 0.97
    rows = quilt_rows(0.0, L, [0.098, 0.196], rf, 0.045)
    limb(mb, SHOULDER, ELBOW, rows, 16, V(0, 1, 0), (0.060, 0.0582, [math.radians(35), math.radians(65)]),
         (0.0515, 0.050, [math.radians(35), math.radians(65)]), sleeve_mat)
    return mb

def build_forearm():
    mb = MB()
    L = (WRIST - ELBOW).length
    def rf(t):
        r = lerp(0.0495, 0.0455, smoothstep(0.0, 0.17, t))
        return r, r * 0.97
    rows = quilt_rows(0.0, 0.17, [0.085], rf, 0.045)
    rows[-1] = (0.17, 0.0455 * 0.985, 0.0455 * 0.985 * 0.97, "s1")
    rows += [(0.196, 0.0530, 0.0515, "b"), (0.220, 0.0535, 0.0520, "b"), (0.2335, 0.0498, 0.0485, "b"),
             (0.2368, 0.0457, 0.0445, "c"), (0.2345, 0.0428, 0.0418, "c"), (0.206, 0.0418, 0.0408, "c")]
    d = (WRIST - ELBOW).normalized()
    limb(mb, ELBOW, WRIST, rows, 16, V(0, 1, 0), (0.0495, 0.048, [math.radians(35), math.radians(65)]), None,
         sleeve_mat, end_cap=(ELBOW + d * 0.201, "JacketTrim"))
    return mb

# ---------------------------------------------------------------------------
# GLOVE (voxel-fused primitives -> quad remesh)
# ---------------------------------------------------------------------------
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

def wrap_finger(P0, O, R, lengths):
    """Joint positions (2D a,c) of a finger wrapping CCW around circle (O, R) from P0."""
    pts = [P0]
    P = P0
    for L in lengths:
        D = P - O
        dist = D.length
        if dist > R * 1.0001:
            beta = math.asin(R / dist)
            to_o = -D / dist
            cb, sb = math.cos(-beta), math.sin(-beta)
            dirv = Vector((to_o.x * cb - to_o.y * sb, to_o.x * sb + to_o.y * cb))
        else:
            dirv = Vector((-D.y, D.x)).normalized()
        P = P + dirv * L
        pts.append(P)
    return pts

def glove_primitives(Wp, U, Vv, Wn, rcyl=0.016, gauntlet=(-0.058, 0.0405, 0.0355)):
    """Right-hand glove fist primitives in world space. Local (a,b,c) = along U, toward thumb V, palm normal Wn."""
    verts, faces = [], []
    def L(a, b, c):
        return Wp + U * a + Vv * b + Wn * c
    # gauntlet / wrist
    rings = []
    for a, rb, rc in ((gauntlet[0], gauntlet[1], gauntlet[2]), (-0.03, 0.040, 0.034), (-0.004, 0.0385, 0.031), (0.012, 0.038, 0.030)):
        rings.append([L(a, rb * math.cos(TAU * j / 16), -0.002 + rc * math.sin(TAU * j / 16)) for j in range(16)])
    _loft_closed(verts, faces, rings)
    # palm / back of the hand block (rounded rectangle sections)
    rows = [(0.000, 0.039, -0.021, 0.019), (0.030, 0.045, -0.023, 0.021), (0.060, 0.049, -0.023, 0.020),
            (0.082, 0.051, -0.022, 0.017), (0.095, 0.045, -0.017, 0.009)]
    rings = []
    for a, hb, c0, c1 in rows:
        cm, hc = (c0 + c1) / 2, (c1 - c0) / 2
        rings.append([L(a, hb * sgnpow(math.cos(TAU * j / 20), 2 / 3.0), cm + hc * sgnpow(math.sin(TAU * j / 20), 2 / 3.0)) for j in range(20)])
    _loft_closed(verts, faces, rings)
    # thenar (thumb base pad)
    _ellipsoid(verts, faces, L(0.036, 0.027, 0.012), 0.032, 0.020, 0.018, U, Vv, Wn, n=14, m=8)
    # fingers wrapping the cylinder
    O = Vector((0.069, 0.0335))
    fingers = [(0.0375, 0.090, 0.0130, (0.046, 0.028, 0.025)),
               (0.0125, 0.094, 0.0134, (0.050, 0.031, 0.026)),
               (-0.0125, 0.091, 0.0128, (0.047, 0.029, 0.025)),
               (-0.0355, 0.084, 0.0116, (0.038, 0.023, 0.022))]
    joints = []
    for b, am, rfn, lens in fingers:
        pts = wrap_finger(Vector((am, -0.003)), O, rcyl + rfn, lens)
        joints.append(pts)
        for k in range(3):
            _capsule(verts, faces, L(pts[k].x, b, pts[k].y), L(pts[k + 1].x, b, pts[k + 1].y),
                     rfn * (1.0 if k == 0 else 0.98), rfn * (0.98 if k < 2 else 0.92), n=12)
    # thumb pressed along the index finger
    _ellipsoid(verts, faces, L(0.030, 0.040, 0.029), 0.020, 0.013, 0.016, U, Vv, Wn, n=12, m=8)  # thumb web
    _capsule(verts, faces, L(0.012, 0.030, 0.008), L(0.042, 0.050, 0.050), 0.0160, 0.0145, n=12)
    _capsule(verts, faces, L(0.042, 0.050, 0.050), L(0.074, 0.052, 0.066), 0.0145, 0.0138, n=12)
    _capsule(verts, faces, L(0.074, 0.052, 0.066), L(0.094, 0.046, 0.068), 0.0138, 0.0125, n=12)
    return verts, faces

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

# hanging right hand: fingers point down, palm faces back (-Y), thumb toward the body (-X);
# the gripped 32 mm cylinder runs along X
HAND_U, HAND_V, HAND_W = V(0, 0, -1), V(-1, 0, 0), V(0, -1, 0)

def build_hand():
    verts, faces = glove_primitives(WRIST, HAND_U, HAND_V, HAND_W)
    return remesh_to_mb(verts, faces, "Glove", voxel=0.002, target=600, smooth_iter=8, name="hand_tmp", mode="dec")

# ============================================================================
# LEGS
# ============================================================================
def pants_mat(k0, k1):
    if k0 == "t" and k1 == "t":
        return "JacketTrim"
    if k0 == "c" or k1 == "c":
        return "JacketTrim"
    return "Pants"

def build_thigh():
    mb = MB()
    L = (KNEE - HIP).length
    rows = [(0.0, 0.092, 0.092, "p"), (0.08, 0.0925, 0.0905, "p"), (0.16, 0.0895, 0.0865, "p"), (0.24, 0.0855, 0.0815, "p"),
            (0.31, 0.0805, 0.0772, "p"), (0.37, 0.0768, 0.0738, "p"), (L, 0.0752, 0.0730, "p")]
    limb(mb, HIP, KNEE, rows, 16, V(0, 1, 0), (0.092, 0.092, [math.radians(35), math.radians(65)]),
         (0.0752, 0.0730, [math.radians(35), math.radians(65)]), pants_mat)
    return mb

def cuff_frame():
    d = (ANKLE - KNEE).normalized()
    e1, e2 = perp_frame(d, V(0, 1, 0))  # e1 ~ +Y (front), e2 ~ +X (outer side of the right leg)
    return d, e1, e2

CUFF_PROF = Prof([
    # z      rf     rb     rs
    (0.095, 0.080, 0.092, 0.068),
    (0.125, 0.080, 0.092, 0.0675),
    (0.15, 0.079, 0.088, 0.067),
    (0.175, 0.076, 0.080, 0.066),
    (0.20, 0.073, 0.075, 0.064),
    (0.24, 0.068, 0.068, 0.061),
    (0.31, 0.060, 0.062, 0.056),
])

def cuff_pt(th, z, shrink=0.0):
    """Ski-boot cuff surface (rides on the shin). th=0 front, +90deg outer side."""
    d, e1, e2 = cuff_frame()
    rf, rb, rs = CUFF_PROF(z)
    c, s = math.cos(th), math.sin(th)
    r1 = (rf if c >= 0 else rb) - shrink
    r2 = rs - shrink
    t = (KNEE.z - z) / (-d.z)
    base = KNEE + d * t - e1 * 0.006
    return base + e1 * (r1 * sgnpow(c, 2 / 2.2)) + e2 * (r2 * sgnpow(s, 2 / 2.2))

def cuff_bottom(th):
    return 0.096 + 0.040 * abs(math.cos(th)) ** 1.4

def build_shin():
    mb = MB()
    L = (ANKLE - KNEE).length
    rows = [(0.0, 0.0715, 0.0705, "p"), (0.07, 0.0712, 0.0698, "p"), (0.14, 0.0718, 0.0703, "p"), (0.20, 0.0735, 0.0710, "p"),
            (0.237, 0.0775, 0.0735, "p"), (0.262, 0.0845, 0.0795, "p"), (0.281, 0.0915, 0.0862, "t"),
            (0.291, 0.0935, 0.0882, "t"), (0.2945, 0.0905, 0.0852, "c"), (0.2915, 0.0862, 0.0812, "c"),
            (0.265, 0.0780, 0.0740, "c")]
    d = (ANKLE - KNEE).normalized()
    limb(mb, KNEE, ANKLE, rows, 16, V(0, 1, 0), (0.0715, 0.0705, [math.radians(35), math.radians(65)]), None,
         pants_mat, end_cap=(KNEE + d * 0.255, "Pants"))

    # ---- boot cuff (hinges with the shin at the ankle) ----
    n = 16
    TH = [TAU * j / n for j in range(n)]   # CCW about d (pointing down) with e1 front / e2 side
    rings = []
    for u in (0.0, 0.3, 0.55, 0.75, 0.88, 0.97):
        rings.append([cuff_pt(th, lerp(0.31, cuff_bottom(th), u)) for th in TH])
    rings.append([cuff_pt(th, cuff_bottom(th) - 0.002, -0.0015) for th in TH])
    rings.append([cuff_pt(th, cuff_bottom(th) - 0.004, 0.003) for th in TH])
    rings.append([cuff_pt(th, cuff_bottom(th) + 0.002, 0.007) for th in TH])
    rings.append([cuff_pt(th, 0.20, 0.008) for th in TH])
    dd, e1, e2 = cuff_frame()
    mb.loft(rings, "Boot", cap0=(cuff_pt(0, 0.31) - e1 * 0.056 + dd * 0.0, "Boot"),
            cap1=(KNEE + dd * ((KNEE.z - 0.205) / -dd.z), "Boot"))
    # cuff buckle: strap across the front + lever on the outer side
    pts, nrms = [], []
    for k in range(9):
        th = math.radians(lerp(-70, 48, k / 8))
        p = cuff_pt(th, 0.172)
        pn = cuff_pt(th, 0.172) - cuff_pt(th, 0.172, 0.01)
        pts.append(p + pn.normalized() * 0.0015)
        nrms.append(pn.normalized())
    ribbon(mb, pts, nrms, 0.0075, 0.0022, "Buckle")
    th = math.radians(64)
    p = cuff_pt(th, 0.174)
    nr = (p - cuff_pt(th, 0.174, 0.01)).normalized()
    tg = (cuff_pt(th + 0.05, 0.174) - cuff_pt(th - 0.05, 0.174)).normalized()
    obox(mb, p + nr * 0.0055, tg, V(0, 0, 1), nr, 0.046, 0.016, 0.010, "Buckle")
    # cuff pivot rivets on both sides, centred on the ankle axis (the cuff hinges here)
    for side in (1, -1):
        c = V(ANKLE.x + side * 0.0695, ANKLE.y - 0.004, ANKLE.z + 0.006)
        rr = []
        for dx, r in ((-0.003, 0.0125), (0.0035, 0.0115), (0.0045, 0.008)):
            rr.append([c + V(side * dx, r * math.cos(TAU * j / 10), r * math.sin(TAU * j / 10)) for j in range(10)])
        if side < 0:
            rr = [list(reversed(r)) for r in rr]
        mb.loft(rr, "Buckle", cap0=(c + V(-side * 0.003, 0, 0), "Buckle"), cap1=(c + V(side * 0.005, 0, 0), "Buckle"))
    return mb

# ---------------------------------------------------------------------------
# BOOT lower shell (+ sole, toe/heel lugs, two buckles); origin at the ankle
# ---------------------------------------------------------------------------
BOOT_PROF = Prof([
    # y       w      zt     xoff
    (-0.1225, 0.022, 0.062, 0.0),
    (-0.118, 0.039, 0.095, 0.0),
    (-0.108, 0.048, 0.125, 0.0),
    (-0.095, 0.052, 0.143, 0.0),
    (-0.080, 0.055, 0.158, 0.0),
    (-0.060, 0.057, 0.168, 0.0),
    (-0.030, 0.058, 0.175, 0.0),
    (0.000, 0.059, 0.176, 0.0),
    (0.030, 0.060, 0.168, 0.0),
    (0.060, 0.061, 0.150, 0.0),
    (0.090, 0.061, 0.127, -0.002),
    (0.120, 0.060, 0.106, -0.004),
    (0.150, 0.057, 0.094, -0.006),
    (0.175, 0.051, 0.087, -0.007),
    (0.193, 0.041, 0.080, -0.008),
    (0.2045, 0.026, 0.071, -0.008),
])
BOOT_ZB = 0.016

def shell_pt(y, t, grow=0.0):
    """Shell cross-section at y; t=0 top (+Z), t=90deg outer (+X)."""
    w, zt, xo = BOOT_PROF(y)
    zc, h = (zt + BOOT_ZB) / 2, (zt - BOOT_ZB) / 2
    s, c = math.sin(t), math.cos(t)
    p = 2.8 if c >= 0 else 4.5
    return V(ANKLE.x + xo + (w + grow) * sgnpow(s, 2 / p), y, zc + (h + grow) * sgnpow(c, 2 / p))

def build_boot():
    mb = MB()
    n = 14
    TS = [TAU * j / n for j in range(n)]
    ys = [-0.1225, -0.118, -0.108, -0.095, -0.08, -0.06, -0.03, 0.0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.175, 0.193, 0.2045]
    rings = [[shell_pt(y, t) for t in TS] for y in ys]
    mb.loft(rings, "Boot", cap0=(V(ANKLE.x, -0.1245, 0.045), "Boot"), cap1=(V(ANKLE.x - 0.008, 0.2075, 0.045), "Boot"))
    # sole with DIN toe/heel lugs (flat bottom at z = 0)
    SOLE = Prof([(-0.131, 0.016), (-0.127, 0.027), (-0.121, 0.032), (-0.117, 0.044), (-0.108, 0.052), (-0.08, 0.058),
                 (0.0, 0.0625), (0.09, 0.0655), (0.15, 0.062), (0.185, 0.052), (0.199, 0.036), (0.212, 0.033),
                 (0.218, 0.025), (0.221, 0.012)])
    XO = pchip([-0.13, 0.06, 0.12, 0.2, 0.222], [0.0, 0.0, -0.004, -0.008, -0.008])
    rings = []
    for y in (-0.131, -0.127, -0.121, -0.115, -0.1, -0.06, 0.0, 0.06, 0.12, 0.16, 0.19, 0.205, 0.215, 0.221):
        w = SOLE(y)[0]
        xc = ANKLE.x + XO(y)
        prof = [(w - 0.003, 0.022), (w, 0.018), (w, 0.004), (w - 0.003, 0.0), (-w + 0.003, 0.0), (-w, 0.004),
                (-w, 0.018), (-w + 0.003, 0.022)]
        rings.append([V(xc + px, y, pz) for px, pz in prof])
    mb.loft(rings, "JacketTrim", cap0=(V(ANKLE.x, -0.132, 0.011), "JacketTrim"), cap1=(V(ANKLE.x - 0.008, 0.2215, 0.011), "JacketTrim"))
    # two shell buckles (forefoot, instep): bail strap over the top + lever on the outer side
    for yb, t0, t1, lev in ((0.118, -62, 56, 68), (0.058, -66, 58, 72)):
        pts, nrms = [], []
        for k in range(9):
            t = math.radians(lerp(t0, t1, k / 8))
            p = shell_pt(yb, t)
            nr = (shell_pt(yb, t, 0.01) - p).normalized()
            pts.append(p + nr * 0.0015)
            nrms.append(nr)
        ribbon(mb, pts, nrms, 0.0075, 0.0022, "Buckle")
        t = math.radians(lev)
        p = shell_pt(yb, t)
        nr = (shell_pt(yb, t, 0.01) - p).normalized()
        tg = (shell_pt(yb, t + 0.05) - shell_pt(yb, t - 0.05)).normalized()
        obox(mb, p + nr * 0.0055, tg, V(0, 1, 0), nr, 0.046, 0.016, 0.010, "Buckle")
    return mb

# ============================================================================
# main
# ============================================================================
def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    parts = []
    parts.append(("Pelvis", build_pelvis(), PELVIS))
    parts.append(("Torso", build_torso(), TORSO))
    parts.append(("Head", build_head(), HEAD))
    parts.append(("Backpack", build_backpack(build_torso_base_mesh().bvh()), TORSO))
    mirror = lambda p: V(-p.x, p.y, p.z)
    for name, fn, piv in (("UpperArm", build_upper_arm, SHOULDER), ("Forearm", build_forearm, ELBOW),
                          ("Hand", build_hand, WRIST), ("Thigh", build_thigh, HIP),
                          ("Shin", build_shin, KNEE), ("Boot", build_boot, ANKLE)):
        mb = fn()
        parts.append((name + ".R", mb, piv))
        parts.append((name + ".L", mirror_mb(mb), mirror(piv)))
    total = 0
    for name, mb, origin in parts:
        make_object(name, mb, origin)
        total += mb.tris()
        print("PART %-12s tris %5d  origin (%.3f, %.3f, %.3f)" % (name, mb.tris(), origin.x, origin.y, origin.z))
    print("TOTAL TRIS", total)

main()
