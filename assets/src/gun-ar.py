# Ridgeline AR - M4 / AR-15 style carbine with EOTech-style holographic sight.
# Blender +Y = barrel/forward, +Z = up, +X = right (ejection side). Metres. Origin = GripR.
import bpy, bmesh, math
from mathutils import Vector, Matrix, Euler

# =====================================================================================
# Hard-surface helper library (shared verbatim by every gun-*.py script)
# =====================================================================================
R = math.radians
GROUPS = {}


def make_mat(name, rgb, metallic, rough):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None) or nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = rough
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    m.metallic = metallic
    m.roughness = rough
    return m


def std_materials(accent):
    make_mat("Metal", (0.03, 0.03, 0.03), 0.85, 0.38)
    make_mat("Polymer", (0.035, 0.035, 0.035), 0.0, 0.62)
    make_mat("Steel", (0.35, 0.35, 0.35), 1.0, 0.3)
    make_mat("Accent", accent, 0.0, 0.6)
    make_mat("Lens", (0.02, 0.05, 0.06), 0.9, 0.05)
    make_mat("Rubber", (0.02, 0.02, 0.02), 0.0, 0.85)
    make_mat("Marker", (1.0, 0.05, 0.6), 0.0, 0.5)


# ---------- 2D outlines ----------
def rrect(w, h, r, n=3, cx=0.0, cy=0.0):
    """Rounded rectangle (CCW), n segments per corner."""
    r = max(1e-5, min(r, w / 2 - 1e-5, h / 2 - 1e-5))
    pts = []
    for ox, oy, a0 in ((w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180)):
        for i in range(n + 1):
            a = R(a0 + 90.0 * i / n)
            pts.append((cx + ox + r * math.cos(a), cy + oy + r * math.sin(a)))
    return pts


def circle(r, n=24, cx=0.0, cy=0.0, phase=0.0):
    return [(cx + r * math.cos(phase + 2 * math.pi * i / n), cy + r * math.sin(phase + 2 * math.pi * i / n)) for i in range(n)]


def stadium(L, W, n=4, cx=0.0, cy=0.0):
    """Slot outline along u: overall length L, width W."""
    r = W / 2
    a = max(0.0, L / 2 - r)
    pts = []
    for i in range(n + 1):
        t = R(-90 + 180.0 * i / n)
        pts.append((cx + a + r * math.cos(t), cy + r * math.sin(t)))
    for i in range(n + 1):
        t = R(90 + 180.0 * i / n)
        pts.append((cx - a + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def offset_poly(poly, d):
    """Inward offset of a CCW convex polygon (same vertex count)."""
    n = len(poly)
    lines = []
    for i in range(n):
        p = Vector(poly[i]); q = Vector(poly[(i + 1) % n])
        e = (q - p).normalized()
        lines.append((p + Vector((-e.y, e.x)) * d, e))
    out = []
    for i in range(n):
        p1, e1 = lines[i - 1]; p2, e2 = lines[i]
        den = e1.x * e2.y - e1.y * e2.x
        if abs(den) < 1e-9:
            out.append((p2.x, p2.y))
        else:
            t = ((p2.x - p1.x) * e2.y - (p2.y - p1.y) * e2.x) / den
            q = p1 + e1 * t
            out.append((q.x, q.y))
    return out


def mirror_x(half):
    """Half outline listed from bottom (x>0) to top -> full CCW outline in (x, z)."""
    return [(x, z) for (x, z) in half] + [(-x, z) for (x, z) in reversed(half)]


# ---------- 3D builders (all add into a bmesh) ----------
def map2(axis, u, v, a):
    if axis == 'Y':
        return Vector((u, a, v))      # outline in XZ, extruded along Y
    if axis == 'X':
        return Vector((a, u, v))      # outline in YZ (side profile), extruded along X
    return Vector((u, v, a))          # outline in XY, extruded along Z


def add_loops(bm, loops, closed=False, caps=True):
    vl = [[bm.verts.new(p) for p in loop] for loop in loops]
    n = len(vl[0])
    for i in range(len(vl) if closed else len(vl) - 1):
        A = vl[i]; B = vl[(i + 1) % len(vl)]
        for j in range(n):
            bm.faces.new((A[j], A[(j + 1) % n], B[(j + 1) % n], B[j]))
    if caps and not closed:
        bm.faces.new(vl[0])
        bm.faces.new(list(reversed(vl[-1])))
    return vl


def prism(bm, poly, a0, a1, axis='X'):
    return add_loops(bm, [[map2(axis, u, v, a0) for u, v in poly], [map2(axis, u, v, a1) for u, v in poly]])


def loft(bm, sections, axis='Y'):
    return add_loops(bm, [[map2(axis, u, v, a) for u, v in poly] for poly, a in sections])


def tube_loft(bm, outer, inner, axis='Y'):
    """outer/inner: lists of (poly, a) with equal vertex counts -> closed hollow solid."""
    loops = [[map2(axis, u, v, a) for u, v in p] for p, a in outer]
    loops += [[map2(axis, u, v, a) for u, v in p] for p, a in reversed(inner)]
    return add_loops(bm, loops, closed=True)


def tube_prism(bm, outer, inner, a0, a1, axis='Y'):
    return tube_loft(bm, [(outer, a0), (outer, a1)], [(inner, a0), (inner, a1)], axis)


def lathe(bm, prof, axis='Y', n=24, c=(0, 0, 0), closed=False, phase=0.0):
    """prof: list of (radius, position-along-axis) relative to c."""
    c = Vector(c)
    loops = []
    for r, a in prof:
        ring = []
        for j in range(n):
            t = phase + 2 * math.pi * j / n
            cu, sv = r * math.cos(t), r * math.sin(t)
            if axis == 'Y':
                p = Vector((cu, a, sv))
            elif axis == 'X':
                p = Vector((a, cu, sv))
            else:
                p = Vector((cu, sv, a))
            ring.append(c + p)
        loops.append(ring)
    return add_loops(bm, loops, closed=closed)


def cyl(bm, c, r, length, axis='Y', n=24, r2=None, phase=0.0):
    return lathe(bm, [(r, -length / 2), (r if r2 is None else r2, length / 2)], axis, n, c, phase=phase)


def box(bm, c, s, rot=None):
    M = Matrix.Translation(Vector(c))
    if rot:
        M = M @ Euler(tuple(R(a) for a in rot), 'XYZ').to_matrix().to_4x4()
    M = M @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=M)


def frame_poly(bm, poly, c, u, v, w, d0, d1):
    """Extrude 2D poly drawn in an arbitrary frame (u, v axes) along w from d0 to d1."""
    c = Vector(c); u = Vector(u).normalized(); v = Vector(v).normalized(); w = Vector(w).normalized()
    return add_loops(bm, [[c + u * a + v * b + w * d for a, b in poly] for d in (d0, d1)])


def sweep(bm, section, path, up=(1, 0, 0), scales=None):
    """Sweep a 2D section (u along `up`, v along in-plane normal) along a 3D polyline."""
    up = Vector(up).normalized()
    pts = [Vector(p) for p in path]
    loops = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        nrm = up.cross(t).normalized()
        su, sv = scales[i] if scales else (1.0, 1.0)
        loops.append([p + up * (a * su) + nrm * (b * sv) for a, b in section])
    return add_loops(bm, loops)


def slot_cutter(bm, center, nrm, along, L, W, depth, n=4, ch=0.0):
    """Stadium cutter through a surface at `center` (normal `nrm`). With ch>0 the rim gets a 45 deg chamfer."""
    c = Vector(center); nn = Vector(nrm).normalized(); al = Vector(along).normalized()
    side = nn.cross(al).normalized()
    if ch > 0:
        big = stadium(L + 2 * ch, W + 2 * ch, n); poly = stadium(L, W, n)
        loops = [(big, 0.004), (big, 0.0), (poly, -ch), (poly, -depth)]
    else:
        poly = stadium(L, W, n)
        loops = [(poly, depth), (poly, -depth)]
    add_loops(bm, [[c + al * a + side * b + nn * d for a, b in p] for p, d in loops])


def transform_bm(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)


def ring_x(bm, x_face, sx, y, z, r_out, r_in, h, n=20):
    """Raised ring (e.g. QD cup) on a side face at x_face, standing out toward sx."""
    lathe(bm, [(r_out, -sx * 0.0006), (r_out, sx * h), (r_in, sx * h), (r_in, -sx * 0.0006)], 'X', n, (x_face, y, z), closed=True)


# ---------- objects, modifiers, groups ----------
def _link(ob):
    bpy.context.scene.collection.objects.link(ob)


def apply_all(ob):
    if not ob.modifiers:
        return
    try:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            for m in list(ob.modifiers):
                bpy.ops.object.modifier_apply(modifier=m.name)
    except Exception:
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        ob.modifiers.clear()
        old = ob.data
        ob.data = me
        bpy.data.meshes.remove(old)


def clean_mesh(ob):
    """Tidy a boolean result before bevelling: merge doubles, drop degenerate geometry and coplanar slivers."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    bmesh.ops.dissolve_limit(bm, angle_limit=R(0.5), verts=bm.verts, edges=bm.edges)
    bm.to_mesh(ob.data)
    bm.free()


def _bool(ob, cob, solver):
    b = ob.modifiers.new("Cut", 'BOOLEAN')
    b.operation = 'DIFFERENCE'
    b.object = cob
    b.solver = solver
    if solver == 'EXACT':
        b.use_self = True
    return b


def finish(name, bm, mat, group, bevel=0.001, seg=2, angle=30, cut=None, smooth=True, wn=True, solver='EXACT',
           cut_late=False, recalc=True):
    """Make an object from bm: [boolean cut + cleanup] -> bevel (angle limited) -> [late boolean] -> weighted normals; all applied."""
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    _link(ob)
    me.materials.append(bpy.data.materials[mat])
    if smooth:
        me.shade_smooth()
    cob = None
    if cut is not None:
        bmesh.ops.recalc_face_normals(cut, faces=cut.faces)
        cme = bpy.data.meshes.new(name + "_cut")
        cut.to_mesh(cme)
        cut.free()
        if smooth:
            cme.shade_smooth()
        cob = bpy.data.objects.new(name + "_cut", cme)
        _link(cob)
        if not cut_late:
            _bool(ob, cob, solver)
            apply_all(ob)
            clean_mesh(ob)
    if bevel:
        b = ob.modifiers.new("Bevel", 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
        b.angle_limit = R(angle)
        b.use_clamp_overlap = True
        b.miter_outer = 'MITER_SHARP'
    if cob is not None and cut_late:
        _bool(ob, cob, solver)
    if smooth and wn:
        w = ob.modifiers.new("WN", 'WEIGHTED_NORMAL')
        w.keep_sharp = True
        w.weight = 50
        w.mode = 'FACE_AREA'
    apply_all(ob)
    if cob is not None:
        cme = cob.data
        bpy.data.objects.remove(cob, do_unlink=True)
        bpy.data.meshes.remove(cme)
    GROUPS.setdefault(group, []).append(ob)
    return ob


def set_origin(ob, p):
    p = Vector(p)
    ob.data.transform(Matrix.Translation(-p))
    ob.location = p


def join_group(group, name, origin=None):
    obs = GROUPS.get(group, [])
    if not obs:
        return None
    if len(obs) > 1:
        with bpy.context.temp_override(active_object=obs[0], object=obs[0], selected_objects=obs, selected_editable_objects=obs):
            bpy.ops.object.join()
    ob = obs[0]
    ob.name = name
    ob.data.name = name
    if origin is not None:
        set_origin(ob, origin)
    return ob


def marker(name, p):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=0.004)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials["Marker"])
    ob = bpy.data.objects.new(name, me)
    _link(ob)
    ob.location = Vector(p)
    return ob


def open_box(bm, x0, x1, y0, y1, z0, z1):
    """Box without its bottom face (sits embedded on another part), outward winding."""
    v = [bm.verts.new(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    for f in ((4, 5, 6, 7), (2, 3, 7, 6), (0, 1, 5, 4), (1, 2, 6, 5), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])


def pic_rail(name, group, mat, y0, y1, z0, skip=(), pitch=0.01001, tooth=0.00478):
    """Picatinny rail on base height z0 from y0 to y1: dovetail spine + bevelled teeth (no teeth inside `skip`)."""
    bm = bmesh.new()
    half = [(0.0075, -0.0005), (0.0075, 0.0016), (0.0106, 0.0047), (0.0106, 0.0056), (0.0098, 0.0064)]
    prism(bm, [(x, z0 + z) for x, z in mirror_x(half)], y0, y1, 'Y')
    finish(name + "Spine", bm, mat, group, bevel=0.0008)
    bm = bmesh.new()
    n = int((y1 - y0 - 0.002) / pitch)
    start = (y0 + y1) / 2 - (n - 1) * pitch / 2
    for i in range(n):
        yc = start + i * pitch
        if any(a < yc < b for a, b in skip):
            continue
        open_box(bm, -0.0080, 0.0080, yc - tooth / 2, yc + tooth / 2, z0 + 0.0060, z0 + 0.0094)
    finish(name + "Teeth", bm, mat, group, bevel=0.0008, recalc=False)


# =====================================================================================
# Ridgeline AR
# =====================================================================================
std_materials((0.45, 0.40, 0.32))   # desaturated tan accent

ZB = 0.044               # bore axis height above GripR
RB = 0.065               # rail base (top of upper body / handguard)
RT = RB + 0.0094         # rail top
UP0, UP1 = -0.0265, 0.178
HG0, HG1 = 0.179, 0.509
FH0, FH1 = 0.518, 0.574
WZ = 0.1100                 # holo window centre (line of sight)
HY0, HY1 = 0.0860, 0.1460   # holo hood rear / front

# ---------------- upper receiver ----------------
bm = bmesh.new(); cut = bmesh.new()
prism(bm, mirror_x([(0.0118, 0.030), (0.0118, 0.0575), (0.0082, 0.0655)]), UP0, UP1, 'Y')
cyl(bm, (0, UP1 - 0.004, ZB), 0.0158, 0.008, 'Y', 24)                     # front ring
cyl(bm, (0.0128, 0.052, 0.0525), 0.0068, 0.040, 'Y', 16)                  # forward assist housing
frame_poly(cut, rrect(0.062, 0.0140, 0.002, 2), (0.0, 0.117, ZB), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.0045, 0.03)  # ejection port
cyl(cut, (0.0128, 0.0318, 0.0525), 0.0050, 0.004, 'Y', 16)                # FA bore
frame_poly(cut, rrect(0.0820, 0.0120, 0.0030, 3), (-0.0118, 0.0640, 0.0460), (0, 1, 0), (0, 0, 1), (1, 0, 0), -0.003, 0.0009)  # left relief pocket
finish("Upper", bm, "Metal", "Body_Metal", bevel=0.0011, cut=cut)
bm = bmesh.new()
frame_poly(bm, [(0.066, 0.046), (0.086, 0.046), (0.086, 0.0605), (0.074, 0.0605)], (0, 0, 0), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.0105, 0.0158)
finish("Deflector", bm, "Metal", "Body_Metal", bevel=0.0009)
bm = bmesh.new()
lathe(bm, [(0.0050, 0.031), (0.0054, 0.028), (0.0054, 0.0245), (0.0046, 0.0225), (0.0025, 0.0218)], 'Y', 16, (0.0128, 0.0, 0.0525))
finish("FAButton", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
cyl(bm, (0, 0.117, ZB), 0.0090, 0.068, 'Y', 24)
finish("Carrier", bm, "Steel", "Body_Steel", bevel=0.0008)
bm = bmesh.new()
box(bm, (0.0151, 0.117, 0.0272), (0.0013, 0.064, 0.0165), rot=(0, -16, 0))     # open dust cover
box(bm, (0.0173, 0.117, 0.0215), (0.0015, 0.022, 0.0030), rot=(0, -16, 0))
finish("DustCover", bm, "Metal", "Body_Metal", bevel=0.0005)
bm = bmesh.new()
cyl(bm, (0.0128, 0.117, 0.0356), 0.0013, 0.070, 'Y', 8)
finish("Hinge", bm, "Steel", "Body_Steel", bevel=0.0004, angle=50)
pic_rail("UpperRail", "Body_Metal", "Metal", UP0, UP1, RB, skip=((-0.0245, 0.0055), (0.0785, 0.1575)))

# ---------------- charging handle (separate, slides -Y) ----------------
bm = bmesh.new()
ch = [(-0.0035, 0.0), (0.0035, 0.0), (0.0035, 0.004), (0.016, 0.004), (0.0215, 0.006), (0.0215, 0.0098), (-0.0215, 0.0098), (-0.0215, 0.006), (-0.016, 0.004), (-0.0035, 0.004)]
prism(bm, [(x, 0.0610 + z) for x, z in ch], -0.0400, -0.0285, 'Y')
box(bm, (0, -0.012, 0.0647), (0.0070, 0.032, 0.0050))
box(bm, (-0.0170, -0.0300, 0.0680), (0.0090, 0.0060, 0.0030))
finish("ChargingHandle", bm, "Metal", "ChargingHandle", bevel=0.0008)

# ---------------- lower receiver ----------------
bm = bmesh.new()
lo = [(-0.0265, 0.0305), (0.1765, 0.0305), (0.1785, 0.0285), (0.1785, 0.000), (-0.012, 0.000), (-0.022, 0.004), (-0.0265, 0.012)]
prism(bm, lo, -0.0119, 0.0119, 'X')
cyl(bm, (0, 0.1695, 0.0255), 0.0062, 0.0252, 'X', 16)     # front pivot boss
cyl(bm, (0, -0.0170, 0.0255), 0.0055, 0.0252, 'X', 16)    # rear takedown boss
finish("Lower", bm, "Metal", "Body_Metal", bevel=0.0011)
# magwell panel (wider than the fire-control area) with hollow cavity
bm = bmesh.new(); cut = bmesh.new()
mw = [(0.0975, 0.0080), (0.0975, -0.0300), (0.1795, -0.0300), (0.1795, 0.0220), (0.1735, 0.0275), (0.1360, 0.0275), (0.1160, 0.0125), (0.1040, 0.0080)]
prism(bm, mw, -0.0131, 0.0131, 'X')
box(cut, (0, 0.1330, -0.0200), (0.0236, 0.0640, 0.0420))
finish("Magwell", bm, "Metal", "Body_Metal", bevel=0.0010, cut=cut)
bm = bmesh.new()
tube_loft(bm, [(rrect(0.0305, 0.0870, 0.0050, 3, 0, 0.1385), -0.0365), (rrect(0.0268, 0.0826, 0.0030, 3, 0, 0.1385), -0.0292)],
          [(rrect(0.0266, 0.0676, 0.0030, 3, 0, 0.1330), -0.0365), (rrect(0.0236, 0.0640, 0.0020, 3, 0, 0.1330), -0.0292)], 'Z')
finish("MagFlare", bm, "Metal", "Body_Metal", bevel=0.0008, angle=40)

# trigger guard (polymer, oversized)
bm = bmesh.new()
tg_path = [(0, 0.0405, 0.004), (0, 0.0425, -0.010), (0, 0.0480, -0.0205), (0, 0.0575, -0.0272), (0, 0.0700, -0.0292), (0, 0.0850, -0.0292), (0, 0.1000, -0.0275)]
sweep(bm, rrect(0.0110, 0.0056, 0.0022, 2), tg_path, up=(1, 0, 0))
finish("TriggerGuard", bm, "Polymer", "Body_Polymer", bevel=0.0008, angle=40)

# trigger
bm = bmesh.new()
trig = [(0.0578, 0.002), (0.0582, -0.0060), (0.0574, -0.0120), (0.0555, -0.0160), (0.0562, -0.0188), (0.0588, -0.0178),
        (0.0610, -0.0145), (0.0626, -0.0095), (0.0630, -0.0035), (0.0624, 0.002)]
prism(bm, trig, -0.0030, 0.0030, 'X')
finish("Trigger", bm, "Steel", "Body_Steel", bevel=0.0008)

# pistol grip (A2 style with finger nub), tilted 22 deg back
bm = bmesh.new()
gang = R(22)
gdir = Vector((0, -math.sin(gang), -math.cos(gang)))
gfwd = Vector((0, math.cos(gang), -math.sin(gang)))
gsec = []
for s, back, front, wid in ((-0.024, 0.000, 0.0425, 0.0235), (-0.010, 0.000, 0.0415, 0.0250), (0.004, 0.000, 0.0395, 0.0262),
                            (0.016, 0.000, 0.0370, 0.0270), (0.028, 0.000, 0.0360, 0.0272), (0.038, 0.000, 0.0388, 0.0274),
                            (0.046, 0.000, 0.0390, 0.0274), (0.054, 0.000, 0.0365, 0.0274), (0.066, 0.000, 0.0350, 0.0272),
                            (0.080, 0.000, 0.0350, 0.0270), (0.090, 0.0005, 0.0340, 0.0262), (0.097, 0.0020, 0.0315, 0.0240),
                            (0.0995, 0.0045, 0.0280, 0.0200)):
    depth = front - back
    gsec.append([gdir * s + gfwd * (back + depth / 2 + v) + Vector((u, 0, 0)) for u, v in rrect(wid, depth, min(0.0085, wid / 2 - 0.001), 3)])
add_loops(bm, gsec)
finish("Grip", bm, "Polymer", "Body_Polymer", bevel=0.0015, seg=3, angle=40)

# lower controls: selector levers, bolt catch, mag release fence
bm = bmesh.new()
cyl(bm, (-0.0129, 0.0140, 0.0200), 0.0060, 0.0022, 'X', 14)
box(bm, (-0.0137, 0.0215, 0.0205), (0.0020, 0.0150, 0.0040), rot=(8, 0, 0))
cyl(bm, (0.0129, 0.0140, 0.0200), 0.0052, 0.0022, 'X', 14)
box(bm, (0.0137, 0.0195, 0.0200), (0.0020, 0.0100, 0.0036))
box(bm, (-0.0133, 0.1040, 0.0215), (0.0030, 0.0110, 0.0080))
lathe(bm, [(0.0078, 0.0115), (0.0078, 0.0134), (0.0060, 0.0134), (0.0060, 0.0115)], 'X', 14, (0, 0.0880, 0.0165), closed=True)
finish("Controls", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
lathe(bm, [(0.0048, 0.0112), (0.0048, 0.0144), (0.0040, 0.0152), (0.0020, 0.0154)], 'X', 14, (0, 0.0880, 0.0165))   # mag release button
for (y, z, big) in ((0.1695, 0.0255, True), (-0.0170, 0.0255, True), (0.0600, 0.0130, False), (0.0390, 0.0195, False)):
    cyl(bm, (0, y, z), 0.0022 if big else 0.0017, 0.0266 if big else 0.0252, 'X', 10)
finish("Pins", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)

# ---------------- buffer tube, castle nut, end plate ----------------
bm = bmesh.new()
lathe(bm, [(0.0168, -0.0265), (0.0168, -0.0298)], 'Y', 24, (0, 0, ZB))
finish("EndPlate", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new(); cut = bmesh.new()
lathe(bm, [(0.0158, -0.0298), (0.0158, -0.0380)], 'Y', 24, (0, 0, ZB))
for i in range(4):
    a = R(45 + 90 * i)
    box(cut, (math.cos(a) * 0.0165, -0.0380, ZB + math.sin(a) * 0.0165), (0.0045, 0.0060, 0.0045), rot=(0, -math.degrees(a), 0))
finish("CastleNut", bm, "Metal", "Body_Metal", bevel=0.0008, cut=cut, cut_late=True)
bm = bmesh.new()
lathe(bm, [(0.0146, -0.0380), (0.0146, -0.2340), (0.0130, -0.2360)], 'Y', 24, (0, 0, ZB))
box(bm, (0, -0.1420, ZB - 0.0150), (0.0085, 0.1840, 0.0050))   # adjustment key
finish("BufferTube", bm, "Metal", "Body_Metal", bevel=0.0008)

# ---------------- collapsible stock with cheek riser ----------------
bm = bmesh.new(); cut = bmesh.new()
stock_secs = [(-0.0940, 0.0330, 0.0360, 0.0450), (-0.1000, 0.0380, 0.0420, 0.0460), (-0.1600, 0.0400, 0.0440, 0.0470),
              (-0.2440, 0.0410, 0.0480, 0.0490), (-0.2560, 0.0400, 0.0470, 0.0490)]
loft(bm, [(rrect(w, h, 0.0100, 3, 0, zc), y) for (y, w, h, zc) in stock_secs], 'Y')
for sx in (1, -1):
    box(cut, (sx * 0.0225, -0.1750, 0.0440), (0.0060, 0.1100, 0.0040))      # side grooves
finish("StockSleeve", bm, "Polymer", "Body_Polymer", bevel=0.0012, angle=40, cut=cut)
bm = bmesh.new(); cut = bmesh.new()
web = [(-0.1080, 0.0320), (-0.2560, 0.0320), (-0.2560, -0.0600), (-0.2420, -0.0640), (-0.1300, 0.0170), (-0.1150, 0.0260)]
prism(bm, web, -0.0095, 0.0095, 'X')
prism(cut, [(-0.1520, 0.0170), (-0.2390, 0.0170), (-0.2390, -0.0410)], -0.02, 0.02, 'X')
finish("StockWeb", bm, "Polymer", "Body_Polymer", bevel=0.0012, cut=cut)
bm = bmesh.new()
prism(bm, rrect(0.0420, 0.1340, 0.0090, 3, 0, 0.0075), -0.2570, -0.2440, 'Y')   # butt frame
finish("ButtFrame", bm, "Polymer", "Body_Polymer", bevel=0.0012, angle=40)
bm = bmesh.new()
loft(bm, [(rrect(0.0420, 0.1340, 0.0100, 3, 0, 0.0075), -0.2560), (rrect(0.0445, 0.1390, 0.0110, 3, 0, 0.0075), -0.2620),
          (rrect(0.0440, 0.1380, 0.0105, 3, 0, 0.0075), -0.2660), (rrect(0.0410, 0.1350, 0.0090, 3, 0, 0.0075), -0.2680)], 'Y')
finish("ButtPad", bm, "Rubber", "Body_Rubber", bevel=0.0012, angle=40)
bm = bmesh.new()
box(bm, (0, -0.1150, 0.0225), (0.0090, 0.0300, 0.0040), rot=(-6, 0, 0))   # adjustment lever
finish("StockLever", bm, "Polymer", "Body_Polymer", bevel=0.0008)
bm = bmesh.new()
for sx in (1, -1):
    ring_x(bm, sx * 0.0200, sx, -0.2150, 0.0560, 0.0058, 0.0036, 0.0020, 12)   # stock QD cups
    ring_x(bm, sx * 0.0210, sx, 0.4900, ZB, 0.0060, 0.0038, 0.0020, 12)        # handguard QD cups
finish("QDCups", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)

# ---------------- handguard (13" free-float M-LOK) ----------------
hg_out = [(0.0100, 0.0220), (0.0190, 0.0320), (0.0190, 0.0560), (0.0100, 0.0650), (-0.0100, 0.0650), (-0.0190, 0.0560), (-0.0190, 0.0320), (-0.0100, 0.0220)]
hg_in = offset_poly(hg_out, 0.0025)
bm = bmesh.new(); cut = bmesh.new()
tube_prism(bm, hg_out, hg_in, HG0, HG1, 'Y')
ys = [0.2150 + 0.040 * i for i in range(7)]
for yc in ys:
    for sx in (1, -1):
        slot_cutter(cut, (sx * 0.0190, yc, ZB), (sx, 0, 0), (0, 1, 0), 0.032, 0.0070, 0.0045, 3, ch=0.0008)
for yc in ys[::2]:
    slot_cutter(cut, (0.0, yc, 0.0220), (0, 0, -1), (0, 1, 0), 0.032, 0.0070, 0.0045, 3, ch=0.0008)
for yc in ys[1::2]:
    for sx in (1, -1):
        slot_cutter(cut, (sx * 0.0145, yc, 0.0270), (sx * 0.743, 0, -0.669), (0, 1, 0), 0.032, 0.0060, 0.0045, 3, ch=0.0007)
finish("Handguard", bm, "Metal", "Body_Metal", bevel=0.0012, cut=cut, cut_late=True)
pic_rail("HGRail", "Body_Metal", "Metal", HG0 + 0.001, HG1 - 0.001, RB, skip=((0.4795, 0.5055),))
bm = bmesh.new()
for sx in (1, -1):
    cyl(bm, (sx * 0.0195, 0.4900, ZB), 0.0072, 0.0030, 'X', 16)
finish("HGBoss", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
for sx in (1, -1):
    for (y, z) in ((0.1880, 0.0360), (0.1880, 0.0520)):
        cyl(bm, (sx * 0.0192, y, z), 0.0021, 0.0020, 'X', 10)
finish("Screws", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
prism(bm, [(0.4300, 0.0230), (0.4700, 0.0230), (0.4700, 0.0130), (0.4640, 0.0090), (0.4500, 0.0110), (0.4360, 0.0185)], -0.0085, 0.0085, 'X')
finish("Handstop", bm, "Accent", "Body_Accent", bevel=0.0012)

# ---------------- barrel, gas system, muzzle ----------------
bm = bmesh.new()
lathe(bm, [(0.0098, UP1 - 0.004), (0.0098, 0.3290), (0.0094, 0.3300), (0.0094, 0.3520), (0.0088, 0.3540), (0.0086, 0.5180)], 'Y', 20, (0, 0, ZB))
finish("Barrel", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
lathe(bm, [(0.0122, 0.3300), (0.0122, 0.3520)], 'Y', 20, (0, 0, ZB))
box(bm, (0, 0.3410, ZB + 0.0118), (0.0100, 0.0200, 0.0070))
finish("GasBlock", bm, "Metal", "Body_Metal", bevel=0.0008)
bm = bmesh.new()
cyl(bm, (0, 0.2560, ZB + 0.0140), 0.0024, 0.1600, 'Y', 8)
finish("GasTube", bm, "Steel", "Body_Steel", bevel=0.0005, angle=50)
# A2 style birdcage flash hider, hollow with 5 ports, closed bottom, wrench flats
bm = bmesh.new(); cut = bmesh.new()
lathe(bm, [(0.0106, FH0), (0.0115, FH0 + 0.0025), (0.0115, FH1 - 0.0022), (0.0103, FH1), (0.0084, FH1), (0.0077, FH1 - 0.0015),
           (0.0077, FH0 + 0.0150), (0.0036, FH0 + 0.0140), (0.0036, FH0)], 'Y', 24, (0, 0, ZB), closed=True)
for ang in (30, 90, 150, 210, 330):
    a = R(ang)
    radial = Vector((math.cos(a), 0, math.sin(a)))
    slot_cutter(cut, Vector((0, FH0 + 0.0345, ZB)) + radial * 0.0115, radial, (0, 1, 0), 0.0300, 0.0038, 0.0070, 3, ch=0.0006)
for sx in (1, -1):
    box(cut, (sx * 0.0130, FH0 + 0.0065, ZB), (0.0060, 0.0090, 0.0300))
finish("FlashHider", bm, "Metal", "Body_Metal", bevel=0.0008, cut=cut, cut_late=True)

# ---------------- back-up iron sights (folded) ----------------
bm = bmesh.new()
for (y0, y1) in ((0.4810, 0.5040), (-0.0230, 0.0040)):
    prism(bm, mirror_x([(0.0118, RT - 0.0055), (0.0118, RT + 0.0030), (0.0095, RT + 0.0045)]), y0, y1, 'Y')
    prism(bm, mirror_x([(0.0085, RT + 0.0040), (0.0085, RT + 0.0085), (0.0060, RT + 0.0100)]), y0 + 0.002, y1 - 0.002, 'Y')
finish("BUIS", bm, "Polymer", "Body_Polymer", bevel=0.0010)

# ---------------- EOTech-style holographic sight ----------------
bm = bmesh.new()
prism(bm, rrect(0.0262, 0.0115, 0.0025, 2, 0, RT - 0.0012), 0.0800, 0.1560, 'Y')           # rail clamp base
finish("OpticBase", bm, "Metal", "Body_Metal", bevel=0.0010)
bm = bmesh.new()
loft(bm, [(rrect(0.0400, 0.0170, 0.0040, 3, 0, 0.0875), 0.0760), (rrect(0.0420, 0.0185, 0.0045, 3, 0, 0.0875), 0.0790),
          (rrect(0.0420, 0.0185, 0.0045, 3, 0, 0.0875), 0.1570), (rrect(0.0390, 0.0165, 0.0040, 3, 0, 0.0875), 0.1600)], 'Y')
finish("OpticHousing", bm, "Metal", "Body_Metal", bevel=0.0010, angle=40)
bm = bmesh.new()
h_out = rrect(0.0470, 0.0370, 0.0060, 3, 0, 0.1115)
h_out2 = rrect(0.0485, 0.0385, 0.0065, 3, 0, 0.1118)
h_in = rrect(0.0350, 0.0250, 0.0030, 3, 0, WZ)
h_in2 = rrect(0.0362, 0.0262, 0.0034, 3, 0, WZ)
tube_loft(bm, [(h_out, HY0), (h_out2, HY0 + 0.006), (h_out2, HY1 - 0.004), (h_out, HY1)],
          [(h_in2, HY0), (h_in, HY0 + 0.003), (h_in, HY1 - 0.003), (h_in2, HY1)], 'Y')
for v in bm.verts:                       # visor: the top of the hood front reaches further forward
    if v.co.y > HY1 - 0.0045:
        v.co.y += 0.0080 * max(0.0, (v.co.z - 0.0930)) / 0.0385
finish("Hood", bm, "Metal", "Body_Metal", bevel=0.0010, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0310, 0.0200, 0.0040, 3, 0.1160, 0.1115), -0.0254, -0.0238, 'X')  # left side logo plate
finish("OpticPlate", bm, "Metal", "Body_Metal", bevel=0.0006, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0340, 0.0480, 0.0040, 3, 0, 0.1160), 0.1296, 0.1326, 'Z')          # top cap
finish("OpticCap", bm, "Polymer", "Body_Polymer", bevel=0.0007, angle=40)
bm = bmesh.new()
for sx in (1, -1):
    box(bm, (sx * 0.0090, 0.0752, 0.0880), (0.0090, 0.0035, 0.0070))                  # rear buttons
for z in (0.1020, 0.1120):
    box(bm, (0.0250, 0.1080, z), (0.0030, 0.0080, 0.0060))                             # right side buttons
finish("OpticButtons", bm, "Rubber", "Body_Rubber", bevel=0.0008)
bm = bmesh.new()
lathe(bm, [(0.0080, 0.1595), (0.0088, 0.1605), (0.0088, 0.1655), (0.0080, 0.1665), (0.0050, 0.1668)], 'Y', 16, (0, 0, 0.0875))  # battery cap
lathe(bm, [(0.0040, -0.0130), (0.0068, -0.0140), (0.0068, -0.0190), (0.0058, -0.0200), (0.0030, -0.0202)], 'X', 16, (0, 0.1300, RT - 0.0030))  # cross-bolt knob
finish("OpticKnobs", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
frame_poly(bm, [(0.0, -0.0030), (0.0320, -0.0030), (0.0360, 0.0), (0.0320, 0.0030), (0.0, 0.0030)], (0.0126, 0.1450, RT - 0.0012), (0, -1, 0), (0, 0, 1), (1, 0, 0), 0.0, 0.0028)
finish("OpticLever", bm, "Metal", "Body_Metal", bevel=0.0008)
bm = bmesh.new()
box(bm, (0, 0.0985, WZ), (0.0356, 0.0012, 0.0256))
finish("OpticLens", bm, "Lens", "Body_Lens", bevel=0, smooth=False)

# ---------------- magazine (separate, origin at feed lips) ----------------
MAG_TOP = Vector((0, 0.1330, 0.0280))
bm = bmesh.new()
cl = [MAG_TOP + Vector((0, 0, -0.0670 * i / 6)) for i in range(7)]
Rm, th = 0.40, R(17.0)
c0 = MAG_TOP + Vector((0, 0, -0.0670))
for i in range(1, 11):
    t = th * i / 10
    cl.append(c0 + Vector((0, Rm * (1 - math.cos(t)), -Rm * math.sin(t))))
depths = [0.0612 + 0.0030 * (k / (len(cl) - 1)) for k in range(len(cl))]
angs = [th * max(0, k - 6) / 10 for k in range(len(cl))]
secs = []
for k, p in enumerate(cl):
    fwd = Vector((0, math.cos(angs[k]), math.sin(angs[k])))
    secs.append([p + Vector((u, 0, 0)) + fwd * v for u, v in rrect(0.0222, depths[k], 0.0030, 3)])
add_loops(bm, secs)
for k in (13, 15):                                         # two grip ribs per side near the base
    for sx in (1, -1):
        M = Matrix.Translation(cl[k] + Vector((sx * 0.0113, 0, 0))) @ Euler((angs[k], 0, 0)).to_matrix().to_4x4()
        bmesh.ops.create_cube(bm, size=1.0, matrix=M @ Matrix.Diagonal((0.0016, depths[k] * 0.78, 0.0030, 1)))
box(bm, (0, MAG_TOP.y, MAG_TOP.z - 0.0690), (0.0240, depths[6] + 0.0010, 0.0030))     # insertion stop ridge
finish("MagBody", bm, "Accent", "Mag", bevel=0.0008, angle=40)
bm = bmesh.new()
a = th
fwd = Vector((0, math.cos(a), math.sin(a))); tang = Vector((0, math.sin(a), -math.cos(a)))
fp = [[cl[-1] + tang * d + Vector((u, 0, 0)) + fwd * (v + 0.0015) for u, v in rrect(0.0258, depths[-1] + 0.0060, 0.0040, 3)] for d in (-0.0030, 0.0085)]
add_loops(bm, fp)
finish("MagFloor", bm, "Polymer", "Mag", bevel=0.0012, angle=40)

# ---------------- join + markers ----------------
for g in ("Body_Metal", "Body_Polymer", "Body_Steel", "Body_Rubber", "Body_Accent", "Body_Lens"):
    join_group(g, g)
join_group("ChargingHandle", "ChargingHandle", origin=(0, -0.0343, 0.0659))
join_group("Mag", "Mag", origin=MAG_TOP)

marker("Muzzle", (0, FH1, ZB))
marker("Sight", (0, HY0, WZ))
marker("GripL", (0, 0.3600, 0.0220))
marker("Eject", (0.0118, 0.1170, ZB))
bpy.context.view_layer.update()
