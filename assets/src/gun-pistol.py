# Sidearm 9 - Glock-style 9 mm pistol with three-dot sights and accessory rail.
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
# Sidearm 9
# =====================================================================================
std_materials((0.72, 0.74, 0.76))   # arctic white-grey accent (sight dots, mag base plate)

ZB = 0.0225                  # bore axis
SL0, SL1 = -0.0220, 0.1640   # slide rear / front
SB, ST = 0.0060, 0.0360      # slide bottom / top
SZ = 0.0445                  # sight line: rear sight top edge = front post top (post centred in the notch)
NF = 0.0415                  # rear notch floor
HW = 0.01275                 # slide half width
GANG = R(22)
GDIR = Vector((0, -math.sin(GANG), -math.cos(GANG)))
GFWD = Vector((0, math.cos(GANG), -math.sin(GANG)))


def gp(s, d, x=0.0, tilt=None):
    """Point in the grip frame: s along the grip axis (down from GripR), d toward the front, x across.
    tilt: section plane angle (0 = horizontal, GANG = square to the grip axis)."""
    t = GANG if tilt is None else tilt
    return GDIR * s + Vector((0, math.cos(t), -math.sin(t))) * d + Vector((x, 0, 0))


# ---------------- slide (separate) ----------------
bm = bmesh.new(); cut = bmesh.new()
prism(bm, mirror_x([(HW, SB), (HW, ST - 0.0055), (0.0092, ST)]), SL0, SL1, 'Y')
box(cut, (0.0130, 0.0580, 0.0360), (0.0340, 0.0360, 0.0380))                       # ejection port (right side + top)
cyl(cut, (0, SL1, ZB), 0.0080, 0.0300, 'Y', 24)                                    # barrel opening
cyl(cut, (0, SL1, 0.0115), 0.0042, 0.0240, 'Y', 16)                                # guide rod opening
finish("SlideBody", bm, "Metal", "Slide", bevel=0.0009, cut=cut)
# cocking serrations (cut after the bevel so the grooves stay crisp)
ob = GROUPS["Slide"][-1]
bm = bmesh.new()
for i in range(8):
    y = -0.0185 + 0.0029 * i
    for sx in (1, -1):
        box(bm, (sx * HW, y, 0.0185), (0.0016, 0.0013, 0.0210))
for i in range(6):
    y = 0.1200 + 0.0029 * i
    for sx in (1, -1):
        box(bm, (sx * HW, y, 0.0185), (0.0016, 0.0013, 0.0210))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
cme = bpy.data.meshes.new("SerrCut"); bm.to_mesh(cme); bm.free()
cob = bpy.data.objects.new("SerrCut", cme); _link(cob)
_bool(ob, cob, 'EXACT')
apply_all(ob)
bpy.data.objects.remove(cob, do_unlink=True); bpy.data.meshes.remove(cme)
bm = bmesh.new()
prism(bm, [(0.0300, 0.0180), (0.0410, 0.0180), (0.0410, 0.0300), (0.0300, 0.0300)], HW - 0.0004, HW + 0.0007, 'X')      # extractor
finish("Extractor", bm, "Metal", "Slide", bevel=0.0004)
bm = bmesh.new(); cut = bmesh.new()
prism(bm, [(-0.0060, ST - 0.0010), (0.0060, ST - 0.0010), (0.0060, SZ), (-0.0060, SZ)], SL0 + 0.0045, SL0 + 0.0145, 'Y')       # rear sight (flat top on the sight line)
box(cut, (0, SL0 + 0.0095, NF + 0.0025), (0.0034, 0.0200, 0.0050))                                                          # notch
prism(bm, [(-0.00175, ST - 0.0010), (0.00175, ST - 0.0010), (0.00175, SZ), (-0.00175, SZ)], 0.1490, 0.1560, 'Y')              # front post
prism(bm, mirror_x([(0.0045, ST - 0.0010), (0.0045, ST + 0.0012), (0.0030, ST + 0.0020)]), 0.1470, 0.1580, 'Y')               # front sight base
finish("Sights", bm, "Metal", "Slide", bevel=0.0004, cut=cut)
bm = bmesh.new()
for x in (-0.0038, 0.0038):
    cyl(bm, (x, SL0 + 0.0042, SZ - 0.0026), 0.0011, 0.0010, 'Y', 12)
cyl(bm, (0, 0.1487, SZ - 0.0026), 0.0011, 0.0010, 'Y', 12)
finish("SightDots", bm, "Accent", "Slide", bevel=0, smooth=False)

# ---------------- barrel + guide rod (stay in the frame) ----------------
bm = bmesh.new()
lathe(bm, [(0.0072, 0.0560), (0.0072, SL1 - 0.0035), (0.0066, SL1 - 0.0030), (0.0046, SL1 - 0.0030), (0.0046, SL1 - 0.0080), (0.0020, SL1 - 0.0085)], 'Y', 24, (0, 0, ZB))
prism(bm, mirror_x([(0.0072, ZB - 0.0060), (0.0072, ZB + 0.0082), (0.0062, ZB + 0.0090)]), 0.0080, 0.0600, 'Y')    # chamber hood
finish("Barrel", bm, "Steel", "Body_Steel", bevel=0.0005, angle=40)
bm = bmesh.new()
lathe(bm, [(0.0030, 0.0800), (0.0030, SL1 - 0.0050), (0.0024, SL1 - 0.0040), (0.0012, SL1 - 0.0038)], 'Y', 12, (0, 0, 0.0115))
finish("GuideRod", bm, "Steel", "Body_Steel", bevel=0.0004, angle=40)

# ---------------- frame (polymer) ----------------
bm = bmesh.new(); cut = bmesh.new()
fr = [(-0.0170, 0.0040), (-0.0170, 0.0068), (0.1490, 0.0068), (0.1505, 0.0030), (0.1505, -0.0030), (0.1460, -0.0060), (0.0950, -0.0060),
      (0.0880, -0.0040), (0.0780, -0.0040), (0.0400, -0.0020), (0.0050, -0.0020), (-0.0060, 0.0000)]
prism(bm, fr, -0.0118, 0.0118, 'X')
for y in (0.1100, 0.1300):
    box(cut, (0, y, -0.0062), (0.0300, 0.0040, 0.0040))                            # accessory rail cross slots
for sx in (1, -1):
    box(cut, (sx * 0.0130, 0.1200, -0.0030), (0.0040, 0.0560, 0.0018))             # rail side grooves
finish("Frame", bm, "Polymer", "Body_Polymer", bevel=0.0009, cut=cut)
bm = bmesh.new()
sweep(bm, rrect(0.0100, 0.0048, 0.0020, 2), [(0, 0.0380, 0.0000), (0, 0.0392, -0.0100), (0, 0.0410, -0.0170), (0, 0.0445, -0.0222), (0, 0.0500, -0.0245),
                                             (0, 0.0560, -0.0250), (0, 0.0700, -0.0250), (0, 0.0755, -0.0238), (0, 0.0792, -0.0205), (0, 0.0810, -0.0150),
                                             (0, 0.0808, -0.0090), (0, 0.0795, -0.0030)], up=(1, 0, 0))
finish("TriggerGuard", bm, "Polymer", "Body_Polymer", bevel=0.0008, angle=40)
bm = bmesh.new()
trig = [(0.0490, 0.0030), (0.0498, -0.0050), (0.0492, -0.0110), (0.0475, -0.0150), (0.0488, -0.0162), (0.0510, -0.0150),
        (0.0525, -0.0110), (0.0532, -0.0050), (0.0530, 0.0030)]
prism(bm, trig, -0.0034, 0.0034, 'X')
finish("Trigger", bm, "Polymer", "Body_Polymer", bevel=0.0007)
bm = bmesh.new()
prism(bm, [(0.0522, -0.0010), (0.0543, -0.0022), (0.0540, -0.0100), (0.0518, -0.0122)], -0.0012, 0.0012, 'X')     # trigger safety blade
finish("TriggerBlade", bm, "Steel", "Body_Steel", bevel=0.0003, angle=40)

# grip: 22 deg, beavertail, flared magwell lip
bm = bmesh.new(); cut = bmesh.new()
gsec = []
for s, tilt, back, front, wid in ((-0.0040, 0, -0.0020, 0.0400, 0.0270), (0.0040, 4, 0.0000, 0.0412, 0.0290), (0.0140, 12, 0.0000, 0.0428, 0.0300),
                                  (0.0260, 20, 0.0000, 0.0438, 0.0308), (0.0400, 22, 0.0000, 0.0442, 0.0312), (0.0560, 22, 0.0000, 0.0442, 0.0312),
                                  (0.0680, 22, 0.0000, 0.0438, 0.0310), (0.0750, 22, -0.0005, 0.0444, 0.0314), (0.0800, 22, -0.0012, 0.0454, 0.0320),
                                  (0.0815, 22, -0.0010, 0.0450, 0.0316)):
    depth = front - back
    gsec.append([gp(s, back + depth / 2 + v, u, R(tilt)) for u, v in rrect(wid, depth, min(0.0095, wid / 2 - 0.001), 3)])
add_loops(bm, gsec)
for k in range(7):                                                                 # texture grooves on both flanks
    s = 0.0160 + 0.0075 * k
    for sx in (1, -1):
        M = Matrix.Translation(gp(s, 0.0225, sx * 0.0158)) @ Euler((-GANG, 0, 0)).to_matrix().to_4x4()
        bmesh.ops.create_cube(cut, size=1.0, matrix=M @ Matrix.Diagonal((0.0014, 0.0300, 0.0016, 1)))
for k in range(5):                                                                 # front strap grooves
    s = 0.0200 + 0.0090 * k
    M = Matrix.Translation(gp(s, 0.0446)) @ Euler((-GANG, 0, 0)).to_matrix().to_4x4()
    bmesh.ops.create_cube(cut, size=1.0, matrix=M @ Matrix.Diagonal((0.0200, 0.0014, 0.0016, 1)))
finish("Grip", bm, "Polymer", "Body_Polymer", bevel=0.0012, angle=40, cut=cut, cut_late=True)
bm = bmesh.new()
prism(bm, [(-0.0200, 0.0042), (-0.0060, 0.0042), (-0.0010, -0.0020), (-0.0080, -0.0035), (-0.0180, 0.0005)], -0.0110, 0.0110, 'X')   # beavertail
finish("Beavertail", bm, "Polymer", "Body_Polymer", bevel=0.0010)

# controls and pins
bm = bmesh.new()
prism(bm, [(0.0250, 0.0020), (0.0480, 0.0020), (0.0480, 0.0050), (0.0300, 0.0058), (0.0250, 0.0050)], -0.0129, -0.0115, 'X')   # slide stop lever (left)
for sx in (1, -1):
    box(bm, (sx * 0.0123, 0.0680, 0.0030), (0.0016, 0.0080, 0.0030))                                    # takedown tabs
box(bm, (-0.0150, 0.0340, -0.0060), (0.0026, 0.0080, 0.0060))                                           # mag release (left)
finish("Controls", bm, "Metal", "Body_Metal", bevel=0.0004)
bm = bmesh.new()
for (y, z) in ((0.0470, 0.0010), (0.0700, 0.0005), (-0.0080, 0.0020)):
    cyl(bm, (0, y, z), 0.0014, 0.0250, 'X', 10)
finish("Pins", bm, "Steel", "Body_Steel", bevel=0.0003, angle=40)

# ---------------- magazine (separate, along the grip axis) ----------------
MAG_TOP = gp(-0.0080, 0.0210)
bm = bmesh.new()
msec = []
for s in (-0.0080, 0.0815):
    msec.append([gp(s, 0.0210 + v, u) for u, v in rrect(0.0224, 0.0320, 0.0040, 3)])
add_loops(bm, msec)
finish("MagBody", bm, "Polymer", "Mag", bevel=0.0008, angle=40)
bm = bmesh.new()
bsec = []
for s, w, d, dz in ((0.0805, 0.0290, 0.0440, 0.0225), (0.0840, 0.0300, 0.0462, 0.0228), (0.0890, 0.0300, 0.0466, 0.0230), (0.0915, 0.0288, 0.0450, 0.0228)):
    bsec.append([gp(s, dz + v, u) for u, v in rrect(w, d, 0.0060, 3)])
add_loops(bm, bsec)
finish("MagBase", bm, "Accent", "Mag", bevel=0.0010, angle=40)

# ---------------- join + markers ----------------
for g in ("Body_Metal", "Body_Polymer", "Body_Steel"):
    join_group(g, g)
join_group("Slide", "Slide", origin=(0, SL0, ZB))
join_group("Mag", "Mag", origin=MAG_TOP)

marker("Muzzle", (0, SL1 - 0.0030, ZB))
marker("Sight", (0, SL0 + 0.0045, SZ))
marker("GripL", tuple(gp(0.0400, 0.0220, -0.0160)))
marker("Eject", (HW, 0.0580, 0.0265))
bpy.context.view_layer.update()
