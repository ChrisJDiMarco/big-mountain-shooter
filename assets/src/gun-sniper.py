# Summit .338 - modern bolt-action precision rifle (AX-338 / AWM style) with a large variable scope.
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
# Summit .338
# =====================================================================================
std_materials((0.72, 0.74, 0.76))   # arctic white-grey accent (chassis + stock)

ZB = 0.045                    # bore axis
AR = 0.0165                   # action radius
AC0, AC1 = -0.045, 0.185      # action rear / front
RB = 0.0600                   # action rail base
RT = RB + 0.0094              # rail top
SZ = 0.0995                   # scope axis
SC0, SC1 = -0.070, 0.280      # scope ocular end / objective end
CH0, CH1 = -0.055, 0.192      # chassis centre section
FE0, FE1 = 0.175, 0.500       # forend (rear overlaps the action front)
MUZ0, MUZ = 0.795, 0.880      # brake rear / muzzle

# ---------------- action ----------------
bm = bmesh.new(); cut = bmesh.new()
lathe(bm, [(0.0130, AC0), (AR, AC0 + 0.004), (AR, AC1 - 0.003), (0.0150, AC1)], 'Y', 32, (0, 0, ZB))
box(bm, (0, (AC0 + AC1) / 2 + 0.002, RB - 0.0020), (0.0150, AC1 - AC0 - 0.006, 0.0050))                 # flat rail seat
frame_poly(cut, rrect(0.0750, 0.0160, 0.0030, 3), (0, 0.0875, ZB), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.0040, 0.03)   # ejection port
box(cut, (0.0170, -0.0300, ZB - 0.0030), (0.0200, 0.0150, 0.0140))                                       # bolt handle notch
finish("Action", bm, "Metal", "Body_Metal", bevel=0.0010, cut=cut)
pic_rail("ActionRail", "Body_Metal", "Metal", AC0 + 0.023, AC1 - 0.004, RB, skip=((0.0180, 0.0420), (0.1380, 0.1620)))   # starts ahead of the bolt handle

# ---------------- bolt (separate, origin on the bore axis at the handle root) ----------------
BOLT_O = Vector((0, -0.0300, ZB))
bm = bmesh.new()
cyl(bm, (0, 0.0450, ZB), 0.0095, 0.1800, 'Y', 24)                                                         # bolt body
lathe(bm, [(0.0110, -0.0240), (0.0122, -0.0255), (0.0122, -0.0345), (0.0110, -0.0360)], 'Y', 24, (0, 0, ZB))  # handle collar
finish("BoltBody", bm, "Steel", "Bolt", bevel=0.0008)
bm = bmesh.new()
lathe(bm, [(0.0130, AC0 + 0.001), (0.0148, AC0 - 0.002), (0.0148, AC0 - 0.016), (0.0120, AC0 - 0.021), (0.0060, AC0 - 0.022)], 'Y', 24, (0, 0, ZB))  # shroud
sweep(bm, circle(0.0046, 12), [(0.0080, -0.0300, ZB), (0.0240, -0.0330, ZB - 0.0060), (0.0400, -0.0380, ZB - 0.0140), (0.0480, -0.0410, ZB - 0.0180)], up=(0, 0, 1))
finish("BoltHandle", bm, "Metal", "Bolt", bevel=0.0006, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0040, 0.0000), (0.0090, 0.0025), (0.0108, 0.0070), (0.0108, 0.0170), (0.0090, 0.0215), (0.0040, 0.0235)], 'X', 20, (0.0440, -0.0420, ZB - 0.0190))
finish("BoltKnob", bm, "Polymer", "Bolt", bevel=0.0008, angle=40)

# ---------------- chassis centre section (arctic) ----------------
bm = bmesh.new(); cut = bmesh.new()
chs = [(CH0, 0.0360), (CH1, 0.0360), (CH1, -0.0260), (CH1 - 0.004, -0.0310), (0.0880, -0.0310), (0.0840, -0.0260), (0.0840, -0.0020),
       (0.0400, 0.0000), (-0.0100, 0.0000), (-0.0400, 0.0040), (CH0, 0.0100)]
prism(bm, chs, -0.0235, 0.0235, 'X')
box(cut, (0, 0.1370, -0.0100), (0.0272, 0.1010, 0.0600))                                                 # magwell cavity
lathe(cut, [(AR + 0.0006, AC0 - 0.01), (AR + 0.0006, AC1 + 0.01)], 'Y', 32, (0, 0, ZB))                  # action bedding channel
box(cut, (0.0215, -0.0350, 0.0360), (0.0230, 0.0340, 0.0160))                                            # bolt handle clearance notch
finish("Chassis", bm, "Accent", "Body_Accent", bevel=0.0015, cut=cut)
bm = bmesh.new()
for sx in (1, -1):
    frame_poly(bm, rrect(0.0880, 0.0140, 0.0040, 3), (sx * 0.0235, 0.1370, -0.0130), (0, 1, 0), (0, 0, 1), (sx, 0, 0), -0.0010, 0.0010)   # magwell grip panels
finish("ChassisPanels", bm, "Polymer", "Body_Polymer", bevel=0.0008, angle=40)

# trigger guard, trigger, mag release paddle, grip
bm = bmesh.new()
sweep(bm, rrect(0.0120, 0.0060, 0.0024, 2), [(0, 0.0360, 0.0040), (0, 0.0385, -0.0100), (0, 0.0450, -0.0210), (0, 0.0560, -0.0270), (0, 0.0700, -0.0280), (0, 0.0860, -0.0240)], up=(1, 0, 0))
box(bm, (0, 0.0815, -0.0140), (0.0100, 0.0040, 0.0150), rot=(-10, 0, 0))                                 # mag release paddle
finish("TriggerGuard", bm, "Metal", "Body_Metal", bevel=0.0008, angle=40)
bm = bmesh.new()
trig = [(0.0580, 0.002), (0.0584, -0.0070), (0.0578, -0.0140), (0.0566, -0.0185), (0.0578, -0.0200), (0.0600, -0.0190),
        (0.0614, -0.0150), (0.0622, -0.0080), (0.0624, 0.002)]
prism(bm, trig, -0.0032, 0.0032, 'X')
finish("Trigger", bm, "Steel", "Body_Steel", bevel=0.0008)
bm = bmesh.new()
gang = R(12)
gdir = Vector((0, -math.sin(gang), -math.cos(gang)))
gfwd = Vector((0, math.cos(gang), -math.sin(gang)))
gsec = []
for s, back, front, wid in ((-0.024, -0.0040, 0.0400, 0.0260), (-0.008, -0.0030, 0.0390, 0.0272), (0.006, -0.0005, 0.0372, 0.0284),
                            (0.020, 0.0000, 0.0352, 0.0290), (0.034, 0.0000, 0.0368, 0.0292), (0.048, 0.0000, 0.0362, 0.0292),
                            (0.062, 0.0000, 0.0356, 0.0290), (0.078, 0.0000, 0.0360, 0.0288), (0.092, 0.0008, 0.0352, 0.0278),
                            (0.1000, 0.0025, 0.0325, 0.0254), (0.1025, 0.0050, 0.0290, 0.0212)):
    depth = front - back
    gsec.append([gdir * s + gfwd * (back + depth / 2 + v) + Vector((u, 0, 0)) for u, v in rrect(wid, depth, min(0.0090, wid / 2 - 0.001), 3)])
add_loops(bm, gsec)
finish("Grip", bm, "Polymer", "Body_Polymer", bevel=0.0015, seg=3, angle=40)

# ---------------- forend (arctic) with M-LOK, front NV rail ----------------
fe_out = [(0.0120, 0.0120), (0.0240, 0.0240), (0.0240, 0.0500), (0.0140, 0.0600), (-0.0140, 0.0600), (-0.0240, 0.0500), (-0.0240, 0.0240), (-0.0120, 0.0120)]
fe_in = offset_poly(fe_out, 0.0028)
bm = bmesh.new(); cut = bmesh.new()
shrink = [(x * 0.95, ZB + (z - ZB) * 0.95) for x, z in fe_out]
shrink_in = [(x * 0.95, ZB + (z - ZB) * 0.95) for x, z in fe_in]
tube_loft(bm, [(fe_out, FE0), (fe_out, FE1 - 0.004), (shrink, FE1)], [(fe_in, FE0), (fe_in, FE1 - 0.004), (shrink_in, FE1)], 'Y')
for k in range(5):
    yc = 0.2400 + 0.0480 * k
    for sx in (1, -1):
        slot_cutter(cut, (sx * 0.0240, yc, 0.0370), (sx, 0, 0), (0, 1, 0), 0.0320, 0.0070, 0.0045, 3, ch=0.0008)
for k in range(3):
    slot_cutter(cut, (0.0, 0.2640 + 0.0480 * k, 0.0120), (0, 0, -1), (0, 1, 0), 0.0320, 0.0070, 0.0045, 3, ch=0.0008)
finish("Forend", bm, "Accent", "Body_Accent", bevel=0.0014, cut=cut, cut_late=True)
pic_rail("ForendRail", "Body_Metal", "Metal", 0.4020, FE1 - 0.004, RB - 0.0003)
bm = bmesh.new()
for sx in (1, -1):
    ring_x(bm, sx * 0.0240, sx, 0.4700, 0.0370, 0.0060, 0.0038, 0.0020, 10)      # forend QD
    ring_x(bm, sx * 0.0170, sx, -0.3040, -0.0500, 0.0056, 0.0034, 0.0020, 10)    # butt QD
    for y in (0.2040, 0.2140):
        cyl(bm, (sx * 0.0242, y, 0.0300), 0.0021, 0.0020, 'X', 10)              # forend clamp screws
finish("SmallSteel", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)

# ---------------- barrel (fluted), muzzle brake ----------------
bm = bmesh.new(); cut = bmesh.new()
lathe(bm, [(0.0150, AC1 - 0.004), (0.0150, 0.2400), (0.0136, 0.2500), (0.0136, 0.4800), (0.0122, 0.5000), (0.0122, MUZ0 + 0.002)], 'Y', 24, (0, 0, ZB))
for k in range(6):
    a = R(30 + 60 * k)
    radial = Vector((math.cos(a), 0, math.sin(a)))
    slot_cutter(cut, Vector((0, 0.6500, ZB)) + radial * (0.0122 + 0.0025), radial, (0, 1, 0), 0.2500, 0.0048, 0.0040, 3)
finish("Barrel", bm, "Metal", "Body_Metal", bevel=0.0007, cut=cut, cut_late=True)
bm = bmesh.new(); cut = bmesh.new()
lathe(bm, [(0.0150, MUZ0), (0.0170, MUZ0 + 0.003), (0.0170, MUZ - 0.006), (0.0150, MUZ - 0.001), (0.0120, MUZ), (0.0064, MUZ),
           (0.0064, MUZ - 0.004), (0.0090, MUZ - 0.008), (0.0090, MUZ0 + 0.012), (0.0064, MUZ0 + 0.010), (0.0064, MUZ0)], 'Y', 24, (0, 0, ZB), closed=True)
for yc in (MUZ0 + 0.0230, MUZ0 + 0.0440, MUZ0 + 0.0650):
    frame_poly(cut, rrect(0.0140, 0.0180, 0.0035, 3), (0, yc, ZB), (0, 1, 0), (0, 0, 1), (1, 0, 0), -0.03, 0.03)   # side ports
for yc in (MUZ0 + 0.0230, MUZ0 + 0.0440):
    cyl(cut, (0, yc, ZB + 0.0160), 0.0028, 0.0120, 'Z', 12)                                                     # top comp holes
finish("Brake", bm, "Metal", "Body_Metal", bevel=0.0008, cut=cut, cut_late=True)

# ---------------- folding stock (arctic) with adjustable cheek piece ----------------
bm = bmesh.new()
prism(bm, rrect(0.0440, 0.0240, 0.0060, 3, 0, 0.0140), -0.0720, CH0 + 0.002, 'Y')                         # hinge block (below the bolt path)
finish("Hinge", bm, "Metal", "Body_Metal", bevel=0.0010, angle=40)
bm = bmesh.new()
cyl(bm, (-0.0225, -0.0660, 0.0140), 0.0046, 0.0260, 'Z', 16)
finish("HingePin", bm, "Steel", "Body_Steel", bevel=0.0006)
bm = bmesh.new()
loft(bm, [(rrect(0.0300, 0.0240, 0.0070, 3, 0, 0.0110), -0.0700), (rrect(0.0300, 0.0270, 0.0075, 3, 0, 0.0105), -0.1000),
          (rrect(0.0310, 0.0300, 0.0080, 3, 0, 0.0100), -0.2950), (rrect(0.0300, 0.0290, 0.0075, 3, 0, 0.0100), -0.3040)], 'Y')
finish("StockBeam", bm, "Accent", "Body_Accent", bevel=0.0012, angle=40)
bm = bmesh.new()
sweep(bm, rrect(0.0260, 0.0200, 0.0060, 3), [(0, -0.0700, -0.0010), (0, -0.1800, -0.0330), (0, -0.2980, -0.0650)], up=(1, 0, 0))
finish("StockLower", bm, "Accent", "Body_Accent", bevel=0.0012, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0340, 0.1360, 0.0080, 3, 0, -0.0090), -0.3140, -0.2940, 'Y')                             # butt frame
finish("ButtFrame", bm, "Accent", "Body_Accent", bevel=0.0012, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0320, 0.1320, 0.0070, 3, 0, -0.0090), -0.3240, -0.3135, 'Y')                             # LOP spacer stack
finish("Spacers", bm, "Metal", "Body_Metal", bevel=0.0008, angle=40)
bm = bmesh.new()
loft(bm, [(rrect(0.0330, 0.1340, 0.0090, 3, 0, -0.0090), -0.3240), (rrect(0.0360, 0.1400, 0.0105, 3, 0, -0.0090), -0.3300),
          (rrect(0.0355, 0.1390, 0.0100, 3, 0, -0.0090), -0.3370), (rrect(0.0330, 0.1360, 0.0085, 3, 0, -0.0090), -0.3395)], 'Y')
finish("ButtPad", bm, "Rubber", "Body_Rubber", bevel=0.0012, angle=40)
bm = bmesh.new()
loft(bm, [(rrect(0.0260, 0.0120, 0.0050, 3, 0, 0.0700), -0.1400), (rrect(0.0340, 0.0180, 0.0080, 3, 0, 0.0710), -0.1550),
          (rrect(0.0350, 0.0200, 0.0085, 3, 0, 0.0715), -0.2250), (rrect(0.0330, 0.0180, 0.0080, 3, 0, 0.0710), -0.2380)], 'Y')
finish("CheekPiece", bm, "Polymer", "Body_Polymer", bevel=0.0012, angle=40)
bm = bmesh.new()
for y in (-0.1720, -0.2180):
    cyl(bm, (0, y, 0.0420), 0.0042, 0.0400, 'Z', 12)                                                         # cheek posts (behind the bolt's travel)
finish("CheekPosts", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0040, 0.0150), (0.0072, 0.0160), (0.0072, 0.0215), (0.0060, 0.0225), (0.0030, 0.0228)], 'X', 16, (0, -0.1950, 0.0100))   # cheek lock knob (right)
finish("CheekKnob", bm, "Metal", "Body_Metal", bevel=0.0006)

# ---------------- scope + rings ----------------
bm = bmesh.new()
scope = [(0.0205, SC0), (0.0222, SC0 + 0.0020), (0.0225, -0.0330), (0.0232, -0.0310), (0.0232, -0.0110), (0.0216, -0.0090),
         (0.0185, -0.0020), (0.0170, 0.0040), (0.0170, 0.1760), (0.0186, 0.1980), (0.0292, 0.2360), (0.0310, 0.2420),
         (0.0310, SC1 - 0.0020), (0.0298, SC1), (0.0280, SC1), (0.0280, SC1 - 0.0100), (0.0150, SC1 - 0.0110),
         (0.0150, SC0 + 0.0070), (0.0198, SC0 + 0.0060), (0.0198, SC0)]
lathe(bm, scope, 'Y', 32, (0, 0, SZ), closed=True)
finish("ScopeTube", bm, "Metal", "Body_Metal", bevel=0.0008, angle=40)
bm = bmesh.new()
prism(bm, rrect(0.0400, 0.0400, 0.0100, 3, 0, SZ), 0.0680, 0.1220, 'Y')                                    # turret saddle
finish("ScopeSaddle", bm, "Metal", "Body_Metal", bevel=0.0012, angle=40)
bm = bmesh.new()
turret = [(0.0110, 0.0170), (0.0142, 0.0190)]
z = 0.0215
for i in range(5):
    turret += [(0.0142, z), (0.0133, z + 0.0010), (0.0133, z + 0.0022), (0.0142, z + 0.0032)]
    z += 0.0034
turret += [(0.0142, z + 0.0010), (0.0128, z + 0.0030), (0.0060, z + 0.0034)]
lathe(bm, turret, 'Z', 24, (0, 0.0950, SZ))                                                                   # elevation (top)
lathe(bm, [(0.0100, 0.0170), (0.0125, 0.0190), (0.0125, 0.0290), (0.0115, 0.0310), (0.0050, 0.0313)], 'X', 24, (0, 0.0950, SZ))   # windage (right)
lathe(bm, [(0.0120, -0.0170), (0.0165, -0.0190), (0.0165, -0.0270), (0.0150, -0.0285), (0.0070, -0.0290)], 'X', 24, (0, 0.0950, SZ))  # side focus (left)
box(bm, (0.0250, -0.0210, SZ + 0.0070), (0.0060, 0.0080, 0.0040), rot=(0, -30, 0))                        # power ring throw lever
finish("Turrets", bm, "Metal", "Body_Metal", bevel=0.0006, angle=60)
bm = bmesh.new()
for yc in (0.0300, 0.1500):
    lathe(bm, [(0.0216, yc - 0.0080), (0.0216, yc + 0.0080), (0.0166, yc + 0.0080), (0.0166, yc - 0.0080)], 'Y', 24, (0, 0, SZ), closed=True)   # ring
    prism(bm, [(0.0120, RT - 0.0040), (0.0120, SZ - 0.0215), (0.0090, SZ - 0.0185), (-0.0090, SZ - 0.0185), (-0.0120, SZ - 0.0215), (-0.0120, RT - 0.0040)],
          yc - 0.0080, yc + 0.0080, 'Y')                                                                         # ring base
finish("Rings", bm, "Metal", "Body_Metal", bevel=0.0009)
bm = bmesh.new()
for yc in (0.0300, 0.1500):
    for sx in (1, -1):
        cyl(bm, (sx * 0.0128, yc, RT - 0.0010), 0.0028, 0.0030, 'X', 10)                                    # cross bolts
finish("RingBolts", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
cyl(bm, (0, SC0 + 0.0065, SZ), 0.0199, 0.0008, 'Y', 32)                                                     # rear (ocular) lens
cyl(bm, (0, SC1 - 0.0105, SZ), 0.0281, 0.0008, 'Y', 32)                                                     # front (objective) lens
finish("ScopeLens", bm, "Lens", "Body_Lens", bevel=0, smooth=False)

# ---------------- detachable box magazine (separate) ----------------
MAG_TOP = Vector((0, 0.1370, 0.0260))
bm = bmesh.new()
loft(bm, [(rrect(0.0262, 0.0990, 0.0035, 3, 0, 0.1370), 0.0260), (rrect(0.0262, 0.0990, 0.0035, 3, 0, 0.1370), -0.0500)], 'Z')
for sx in (1, -1):
    frame_poly(bm, rrect(0.0700, 0.0100, 0.0030, 3), (sx * 0.0131, 0.1370, -0.0400), (0, 1, 0), (0, 0, 1), (sx, 0, 0), -0.0008, 0.0006)   # stiffening rib
finish("MagBody", bm, "Metal", "Mag", bevel=0.0008, angle=40)
bm = bmesh.new()
loft(bm, [(rrect(0.0285, 0.1030, 0.0045, 3, 0, 0.1375), -0.0490), (rrect(0.0292, 0.1040, 0.0050, 3, 0, 0.1378), -0.0540),
          (rrect(0.0280, 0.1020, 0.0045, 3, 0, 0.1378), -0.0590)], 'Z')
finish("MagBase", bm, "Polymer", "Mag", bevel=0.0012, angle=40)

# ---------------- join + markers ----------------
for g in ("Body_Metal", "Body_Polymer", "Body_Steel", "Body_Rubber", "Body_Accent", "Body_Lens"):
    join_group(g, g)
join_group("Bolt", "Bolt", origin=BOLT_O)
join_group("Mag", "Mag", origin=MAG_TOP)

marker("Muzzle", (0, MUZ, ZB))
marker("Sight", (0, SC0 + 0.0065, SZ))
marker("GripL", (0, 0.3800, 0.0120))
marker("Eject", (AR, 0.0875, ZB))
bpy.context.view_layer.update()
