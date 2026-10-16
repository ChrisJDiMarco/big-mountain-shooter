# Avalanche 12 - pump-action 12 gauge (Mossberg 590 / 870 tactical style) with ghost ring sights and side saddle.
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
# Avalanche 12
# =====================================================================================
std_materials((0.45, 0.40, 0.32))   # desaturated tan accent (stock, grip, pump)
make_mat("ShellRed", (0.50, 0.035, 0.030), 0.0, 0.45)
make_mat("Brass", (0.78, 0.52, 0.18), 1.0, 0.28)

ZB = 0.040               # bore axis
ZT = 0.0145              # magazine tube axis
RTOP = 0.064             # receiver top
RC0, RC1 = -0.012, 0.198 # receiver rear / front
SZ = RTOP + 0.0135       # sight line (ghost ring centre, front post tip)
MUZ = 0.670
PY0, PY1 = 0.290, 0.480  # pump (forward position; ~85 mm stroke back to the receiver)
PZ = 0.0155              # pump centre height


def shell(bm_hull, bm_brass, base, axis, L=0.070, brass_len=0.016):
    """12 ga shell: brass head at `base`, hull toward `axis` (unit vector)."""
    ax = Vector(axis).normalized()
    if abs(ax.z) > 0.9:
        a = 'Z'
    elif abs(ax.y) > 0.9:
        a = 'Y'
    else:
        a = 'X'
    sgn = 1 if (ax.x + ax.y + ax.z) > 0 else -1
    lathe(bm_brass, [(0.0094, sgn * 0.0000), (0.0110, sgn * 0.0004), (0.0110, sgn * 0.0016), (0.0103, sgn * 0.0019), (0.0103, sgn * brass_len), (0.0095, sgn * brass_len)], a, 16, base)
    lathe(bm_hull, [(0.0100, sgn * (brass_len - 0.0010)), (0.0101, sgn * (L - 0.0040)), (0.0094, sgn * (L - 0.0006)), (0.0060, sgn * L)], a, 16, base)


# ---------------- receiver ----------------
bm = bmesh.new(); cut = bmesh.new()
rc = [(RC1, RTOP), (RC1, 0.0020), (0.0000, 0.0020), (RC0, 0.0100), (RC0, 0.0560), (RC0 + 0.0080, RTOP)]
prism(bm, rc, -0.0165, 0.0165, 'X')
frame_poly(cut, rrect(0.0620, 0.0210, 0.0030, 3), (0.0, 0.1100, 0.0440), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.0040, 0.03)     # ejection port
frame_poly(cut, rrect(0.0230, 0.0860, 0.0040, 3), (0.0, 0.1260, 0.0), (1, 0, 0), (0, 1, 0), (0, 0, 1), -0.010, 0.0200)    # loading port
finish("Receiver", bm, "Metal", "Body_Metal", bevel=0.0012, cut=cut)
bm = bmesh.new()
cyl(bm, (0, 0.1100, 0.0440), 0.0110, 0.0600, 'Y', 24)       # bolt seen through the port
box(bm, (0.0108, 0.1330, 0.0470), (0.0030, 0.0100, 0.0040))   # extractor
box(bm, (0, 0.1260, 0.0150), (0.0200, 0.0800, 0.0024))       # shell lifter in the loading port
finish("BoltLifter", bm, "Steel", "Body_Steel", bevel=0.0008)
pic_rail("RxRail", "Body_Metal", "Metal", 0.0440, RC1 - 0.006, RTOP - 0.0003)
# vented heat shield over the top of the barrel (arc stays above the pump's edges)
def arc_outline(r_o, r_i, a0, a1, n=18):
    outer = [(r_o * math.cos(R(a0 + (a1 - a0) * i / n)), ZB + r_o * math.sin(R(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]
    inner = [(r_i * math.cos(R(a1 - (a1 - a0) * i / n)), ZB + r_i * math.sin(R(a1 - (a1 - a0) * i / n))) for i in range(n + 1)]
    return outer + inner
bm = bmesh.new(); cut = bmesh.new()
prism(bm, arc_outline(0.0152, 0.0137, 12, 168), 0.2140, 0.4300, 'Y')
for ang in (50, 90, 130):
    a = R(ang)
    radial = Vector((math.cos(a), 0, math.sin(a)))
    for k in range(6):
        yc = 0.2360 + 0.0330 * k + (0.0165 if ang == 90 else 0.0)
        if yc > 0.4100:
            continue
        slot_cutter(cut, Vector((0, yc, ZB)) + radial * 0.0152, radial, (0, 1, 0), 0.0200, 0.0062, 0.0040, 3, ch=0.0005)
finish("HeatShield", bm, "Metal", "Body_Metal", bevel=0.0008, cut=cut, cut_late=True)
bm = bmesh.new()
for y in (0.2220, 0.4220):
    prism(bm, arc_outline(0.0139, 0.0104, 12, 168), y - 0.0025, y + 0.0025, 'Y')
finish("ShieldClamps", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
for sx in (1, -1):
    for y in (0.0250, 0.0700):
        cyl(bm, (sx * 0.0165, y, 0.0110), 0.0024, 0.0016, 'X', 10)
box(bm, (0, -0.0030, RTOP - 0.0020), (0.0090, 0.0120, 0.0050), rot=(-12, 0, 0))   # tang safety
finish("RxSmall", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
box(bm, (-0.0172, 0.0080, 0.0000), (0.0030, 0.0120, 0.0060))                         # action release lever (left)
finish("ActionRelease", bm, "Metal", "Body_Metal", bevel=0.0008)

# ---------------- ghost ring rear sight ----------------
bm = bmesh.new()
prism(bm, rrect(0.0220, 0.0080, 0.0020, 2, 0, RTOP + 0.0020), 0.0060, 0.0360, 'Y')            # base
for sx in (1, -1):
    prism(bm, [(0.0100, RTOP + 0.0040), (0.0300, RTOP + 0.0040), (0.0300, RTOP + 0.0120), (0.0240, SZ + 0.0070), (0.0140, SZ + 0.0070), (0.0100, RTOP + 0.0110)],
          sx * 0.0072, sx * 0.0102, 'X')                                                        # protective ears
lathe(bm, [(0.0064, 0.0185), (0.0064, 0.0215), (0.0032, 0.0215), (0.0032, 0.0185)], 'Y', 24, (0, 0, SZ), closed=True)   # aperture ring
box(bm, (0, 0.0200, (RTOP + 0.0060 + SZ - 0.0058) / 2), (0.0036, 0.0030, SZ - 0.0058 - RTOP - 0.0060))                 # ring stem
finish("GhostRing", bm, "Metal", "Body_Metal", bevel=0.0006)

# ---------------- barrel, magazine tube, cap, clamp, front sight ----------------
bm = bmesh.new()
lathe(bm, [(0.0130, RC1 - 0.002), (0.0130, RC1 + 0.002), (0.0112, RC1 + 0.005), (0.0110, MUZ - 0.002), (0.0104, MUZ), (0.0092, MUZ),
           (0.0092, MUZ - 0.050), (0.0040, MUZ - 0.052), (0.0040, RC1 - 0.002)], 'Y', 24, (0, 0, ZB), closed=True)
finish("Barrel", bm, "Metal", "Body_Metal", bevel=0.0007)
bm = bmesh.new()
lathe(bm, [(0.0104, MUZ - 0.0004), (0.0104, MUZ + 0.0004), (0.0093, MUZ + 0.0004), (0.0093, MUZ - 0.0004)], 'Y', 24, (0, 0, ZB), closed=True)  # crown
finish("Crown", bm, "Steel", "Body_Steel", bevel=0.0003, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0125, RC1 - 0.004), (0.0125, 0.6330)], 'Y', 24, (0, 0, ZT))
finish("MagTube", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
cap = [(0.0128, 0.6320), (0.0136, 0.6340)]
for i in range(4):
    y = 0.6360 + i * 0.0050
    cap += [(0.0136, y), (0.0130, y + 0.0012), (0.0130, y + 0.0028), (0.0136, y + 0.0040)]
cap += [(0.0136, 0.6560), (0.0128, 0.6600), (0.0060, 0.6610)]
lathe(bm, cap, 'Y', 24, (0, 0, ZT))
finish("MagCap", bm, "Metal", "Body_Metal", bevel=0.0006, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0055, -0.0015), (0.0055, 0.0015), (0.0033, 0.0015), (0.0033, -0.0015)], 'X', 14, (0, 0.6480, ZT - 0.0185), closed=True)   # sling loop under cap
finish("CapLoop", bm, "Steel", "Body_Steel", bevel=0.0004, angle=40)
bm = bmesh.new()
clamp = rrect(0.0300, 0.0560, 0.0120, 4, 0, (ZT + ZB) / 2 + 0.0010)
prism(bm, clamp, 0.6000, 0.6170, 'Y')
finish("BarrelClamp", bm, "Metal", "Body_Metal", bevel=0.0009, angle=40)
bm = bmesh.new()
cyl(bm, (0.0150, 0.6085, (ZT + ZB) / 2), 0.0030, 0.0030, 'X', 12)
finish("ClampScrew", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0190, 0.0110, 0.0030, 2, 0, ZB + 0.0110), 0.6380, 0.6640, 'Y')               # front sight saddle
for sx in (1, -1):
    prism(bm, [(0.6400, ZB + 0.0140), (0.6620, ZB + 0.0140), (0.6600, SZ + 0.0040), (0.6440, SZ + 0.0040)], sx * 0.0058, sx * 0.0085, 'X')   # ears
finish("FrontSight", bm, "Metal", "Body_Metal", bevel=0.0006)
bm = bmesh.new()
prism(bm, [(0.6480, ZB + 0.0130), (0.6560, ZB + 0.0130), (0.6545, SZ), (0.6495, SZ)], -0.0013, 0.0013, 'X')                  # front post
finish("FrontPost", bm, "Steel", "Body_Steel", bevel=0.0004)

# ---------------- trigger group ----------------
bm = bmesh.new()
sweep(bm, rrect(0.0110, 0.0056, 0.0022, 2), [(0, 0.0405, 0.006), (0, 0.0425, -0.008), (0, 0.0480, -0.0180), (0, 0.0570, -0.0235), (0, 0.0700, -0.0250),
                                             (0, 0.0790, -0.0200), (0, 0.0820, -0.0080), (0, 0.0825, 0.0060)], up=(1, 0, 0))
prism(bm, [(0.0400, 0.0040), (0.0840, 0.0040), (0.0840, -0.0020), (0.0400, -0.0020)], -0.0110, 0.0110, 'X')   # trigger plate
finish("TriggerGuard", bm, "Polymer", "Body_Polymer", bevel=0.0008, angle=40)
bm = bmesh.new()
trig = [(0.0578, 0.002), (0.0582, -0.0060), (0.0574, -0.0120), (0.0555, -0.0160), (0.0562, -0.0188), (0.0588, -0.0178),
        (0.0610, -0.0145), (0.0626, -0.0095), (0.0630, -0.0035), (0.0624, 0.002)]
prism(bm, trig, -0.0030, 0.0030, 'X')
finish("Trigger", bm, "Steel", "Body_Steel", bevel=0.0008)

# ---------------- pistol grip + buttstock (tan) ----------------
bm = bmesh.new()
gang = R(20)
gdir = Vector((0, -math.sin(gang), -math.cos(gang)))
gfwd = Vector((0, math.cos(gang), -math.sin(gang)))
gsec = []
for s, back, front, wid in ((-0.024, 0.000, 0.0420, 0.0250), (-0.008, 0.000, 0.0405, 0.0262), (0.006, 0.000, 0.0385, 0.0274),
                            (0.020, 0.000, 0.0365, 0.0280), (0.034, 0.000, 0.0372, 0.0282), (0.048, 0.000, 0.0366, 0.0282),
                            (0.062, 0.000, 0.0358, 0.0280), (0.076, 0.000, 0.0358, 0.0278), (0.088, 0.0008, 0.0348, 0.0268),
                            (0.0950, 0.0025, 0.0320, 0.0244), (0.0975, 0.0050, 0.0285, 0.0204)):
    depth = front - back
    gsec.append([gdir * s + gfwd * (back + depth / 2 + v) + Vector((u, 0, 0)) for u, v in rrect(wid, depth, min(0.0088, wid / 2 - 0.001), 3)])
add_loops(bm, gsec)
finish("Grip", bm, "Accent", "Body_Accent", bevel=0.0015, seg=3, angle=40)
bm = bmesh.new(); cut = bmesh.new()
stock_secs = []
for y, top, bot, wid, rad in ((RC0 + 0.002, 0.0600, 0.0100, 0.0320, 0.0060), (-0.0240, 0.0585, 0.0010, 0.0336, 0.0080),
                              (-0.0420, 0.0572, -0.0100, 0.0350, 0.0095), (-0.0700, 0.0578, -0.0190, 0.0368, 0.0105),
                              (-0.1100, 0.0596, -0.0255, 0.0384, 0.0110), (-0.1600, 0.0608, -0.0340, 0.0398, 0.0115),
                              (-0.2200, 0.0612, -0.0480, 0.0410, 0.0118), (-0.2700, 0.0616, -0.0650, 0.0418, 0.0118),
                              (-0.3080, 0.0620, -0.0770, 0.0420, 0.0116), (-0.3180, 0.0618, -0.0775, 0.0412, 0.0110)):
    stock_secs.append((rrect(wid, top - bot, rad, 3, 0, (top + bot) / 2), y))
loft(bm, stock_secs, 'Y')
for sx in (1, -1):
    slot_cutter(cut, (sx * 0.0208, -0.2560, -0.0380), (sx, 0, 0), (0, 1, 0), 0.0300, 0.0090, 0.0215, 4, ch=0.0008)   # sling slot (through)
finish("Stock", bm, "Accent", "Body_Accent", bevel=0.0016, seg=2, angle=40, cut=cut, cut_late=True)
bm = bmesh.new()
loft(bm, [(rrect(0.0220, 0.0070, 0.0030, 3, 0, 0.0600), -0.0820), (rrect(0.0330, 0.0110, 0.0050, 3, 0, 0.0625), -0.1000),
          (rrect(0.0350, 0.0120, 0.0055, 3, 0, 0.0640), -0.2300), (rrect(0.0330, 0.0110, 0.0050, 3, 0, 0.0640), -0.2500),
          (rrect(0.0260, 0.0080, 0.0035, 3, 0, 0.0630), -0.2580)], 'Y')
finish("CheekRiser", bm, "Polymer", "Body_Polymer", bevel=0.0010, angle=40)
bm = bmesh.new()
loft(bm, [(rrect(0.0380, 0.1380, 0.0110, 3, 0, -0.0070), -0.3170), (rrect(0.0410, 0.1430, 0.0125, 3, 0, -0.0070), -0.3240),
          (rrect(0.0405, 0.1420, 0.0120, 3, 0, -0.0070), -0.3330), (rrect(0.0380, 0.1390, 0.0105, 3, 0, -0.0070), -0.3360)], 'Y')
finish("RecoilPad", bm, "Rubber", "Body_Rubber", bevel=0.0012, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0055, 0.0008), (0.0055, -0.0022), (0.0034, -0.0022), (0.0034, 0.0008)], 'Z', 14, (0, -0.2700, -0.0695), closed=True)   # stock QD cup
finish("StockQD", bm, "Steel", "Body_Steel", bevel=0.0004, angle=40)

# ---------------- side saddle (left) with six shells ----------------
SX = -0.0298                             # shell column centre x
ys = [0.0560 + 0.0236 * i for i in range(6)]
bm = bmesh.new()
prism(bm, rrect(0.1480, 0.0500, 0.0040, 3, 0.1150, 0.0320), -0.0196, -0.0160, 'X')                      # back plate
prism(bm, rrect(0.1480, 0.0170, 0.0030, 3, 0.1150, 0.0300), -0.0418, -0.0398, 'X')                      # retaining band
for i in range(7):
    y = ys[0] - 0.0118 + 0.0236 * i
    box(bm, (-0.0297, y, 0.0300), (0.0210, 0.0024, 0.0170))                                            # dividers
finish("SideSaddle", bm, "Polymer", "Body_Polymer", bevel=0.0008)
bm = bmesh.new()
for y in ((0.0560 + 0.1300) / 2 - 0.0410, (0.0560 + 0.1300) / 2 + 0.0410):
    cyl(bm, (-0.0198, y + 0.0190, 0.0500), 0.0021, 0.0016, 'X', 10)
finish("SaddleScrews", bm, "Steel", "Body_Steel", bevel=0.0004, angle=40)
bh = bmesh.new(); bb = bmesh.new()
for y in ys:
    shell(bh, bb, (SX, y, -0.0180), (0, 0, 1))
finish("SaddleShells", bh, "ShellRed", "Body_ShellRed", bevel=0.0006, angle=40)
finish("SaddleBrass", bb, "Brass", "Body_Brass", bevel=0.0004, angle=40)

# ---------------- pump forend (separate) with action bars ----------------
bm = bmesh.new(); cut = bmesh.new()
secs = []
def psec(y, k):
    return (rrect(0.0430 * k, 0.0400 * k, 0.0120 * k, 3, 0, PZ), y)
secs += [psec(PY0, 0.93), psec(PY0 + 0.004, 1.05), psec(PY0 + 0.012, 1.05), psec(PY0 + 0.020, 1.0)]
y = PY0 + 0.030
while y < PY1 - 0.036:
    secs += [psec(y, 1.0), psec(y + 0.003, 0.955), psec(y + 0.009, 0.955), psec(y + 0.012, 1.0)]
    y += 0.016
secs += [psec(PY1 - 0.022, 1.0), psec(PY1 - 0.012, 1.07), psec(PY1 - 0.004, 1.07), psec(PY1, 0.95)]
loft(bm, secs, 'Y')
cyl(cut, (0, (PY0 + PY1) / 2, ZB), 0.0118, PY1 - PY0 + 0.02, 'Y', 24)                   # channel for the barrel
cyl(cut, (0, (PY0 + PY1) / 2, ZT), 0.0128, PY1 - PY0 + 0.02, 'Y', 24)                   # bore for the mag tube
finish("PumpBody", bm, "Accent", "Pump", bevel=0.0012, angle=35, cut=cut)
bm = bmesh.new()
for sx in (1, -1):
    box(bm, (sx * 0.0118, (0.1500 + PY0 + 0.010) / 2, ZT + 0.0060), (0.0022, PY0 + 0.010 - 0.1500, 0.0060))
finish("ActionBars", bm, "Steel", "Pump", bevel=0.0006)

# ---------------- loose shell for reloads (Mag) ----------------
MAG_TIP = Vector((0, 0.1600, 0.0010))
bh = bmesh.new(); bb = bmesh.new()
shell(bh, bb, (0, 0.0900, 0.0010), (0, 1, 0))
finish("LooseHull", bh, "ShellRed", "Mag", bevel=0.0006, angle=40)
finish("LooseBrass", bb, "Brass", "Mag", bevel=0.0004, angle=40)

# ---------------- join + markers ----------------
for g in ("Body_Metal", "Body_Polymer", "Body_Steel", "Body_Rubber", "Body_Accent", "Body_ShellRed", "Body_Brass"):
    join_group(g, g)
join_group("Pump", "Pump", origin=(0, (PY0 + PY1) / 2, PZ))
join_group("Mag", "Mag", origin=MAG_TIP)

marker("Muzzle", (0, MUZ, ZB))
marker("Sight", (0, 0.0200, SZ))
marker("GripL", (0, (PY0 + PY1) / 2, PZ - 0.0200))
marker("Eject", (0.0165, 0.1100, 0.0440))
bpy.context.view_layer.update()
