# Retarget to See - Original Target Rig Action Importer
# Select the ORIGINAL Target armature in Blender, run this script,
# then choose the *_RIG_original_action.json exported by the web page.

import bpy
import json
from mathutils import Vector, Matrix, Quaternion
from bpy_extras.io_utils import ImportHelper
from bpy.props import StringProperty


def _score_armature(obj, data):
    if not obj or obj.type != 'ARMATURE':
        return -1
    wanted = set(data.get("bones", {}).keys())
    return len(wanted.intersection(set(obj.data.bones.keys())))


def _find_armature(data):
    active = bpy.context.object
    if active and active.type == 'ARMATURE' and _score_armature(active, data) >= 3:
        return active

    candidates = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not candidates:
        raise RuntimeError("No hay ningun Armature en la escena.")

    candidates.sort(key=lambda o: _score_armature(o, data), reverse=True)
    best = candidates[0]
    if _score_armature(best, data) < 3:
        raise RuntimeError(
            "No encontre un Armature con suficientes huesos coincidentes. "
            "Selecciona el RIG original del Target antes de importar."
        )
    return best


def _basis_from_three_points(p0, p1, p2):
    x = p1 - p0
    if x.length < 1e-8:
        raise RuntimeError("Anchors degenerados: eje principal sin longitud.")
    x.normalize()

    z = x.cross(p2 - p0)
    if z.length < 1e-8:
        raise RuntimeError("Anchors degenerados: los tres puntos son colineales.")
    z.normalize()

    y = z.cross(x)
    y.normalize()

    return Matrix((
        (x.x, y.x, z.x),
        (x.y, y.y, z.y),
        (x.z, y.z, z.z),
    ))


def _alignment(data, arm):
    a0, a1, a2 = data["anchors"]

    t0 = Vector(data["bones"][a0]["restPos"])
    t1 = Vector(data["bones"][a1]["restPos"])
    t2 = Vector(data["bones"][a2]["restPos"])

    b0 = arm.data.bones[a0].matrix_local.to_translation()
    b1 = arm.data.bones[a1].matrix_local.to_translation()
    b2 = arm.data.bones[a2].matrix_local.to_translation()

    bt = _basis_from_three_points(t0, t1, t2)
    bb = _basis_from_three_points(b0, b1, b2)
    rot = bb @ bt.transposed()

    ratios = []
    for ta, tb, ba, bbp in (
        (t0, t1, b0, b1),
        (t0, t2, b0, b2),
        (t1, t2, b1, b2),
    ):
        td = (tb - ta).length
        bd = (bbp - ba).length
        if td > 1e-8 and bd > 1e-8:
            ratios.append(bd / td)

    scale = sum(ratios) / len(ratios) if ratios else 1.0
    return rot, scale


def _pose_depth(pb):
    depth = 0
    p = pb.parent
    while p:
        depth += 1
        p = p.parent
    return depth


def import_original_rig_action(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("format") != "retarget-to-see-original-rig-action":
        raise RuntimeError("El JSON no es un paquete RIG original de Retarget to See.")

    arm = _find_armature(data)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)

    align_rot, align_scale = _alignment(data, arm)
    align_rot_inv = align_rot.transposed()

    names = [
        n for n in data["bones"].keys()
        if n in arm.pose.bones and n in arm.data.bones
    ]
    if len(names) < 3:
        raise RuntimeError("El RIG seleccionado no contiene suficientes huesos del Target.")

    pose_bones = [arm.pose.bones[n] for n in names]
    pose_bones.sort(key=_pose_depth)

    # CloudRig/Rigify often constrains DEF bones. The web result is already
    # baked visually, so constraints on the baked bones would double-transform
    # them. Mute only those constraints; the rest of the rig is left intact.
    mute_constraints = bool(data.get("muteConstraints", True))
    if mute_constraints:
        for pb in pose_bones:
            for con in pb.constraints:
                con.mute = True

    arm.animation_data_create()

    action_name = data.get("actionName", "Retargeted_RIG_Original")
    old = bpy.data.actions.get(action_name)
    if old:
        bpy.data.actions.remove(old)

    action = bpy.data.actions.new(action_name)
    arm.animation_data.action = action

    fps = max(1, int(round(float(data.get("fps", 30)))))
    bpy.context.scene.render.fps = fps
    start_frame = int(data.get("startFrame", 0))

    times = data["times"]

    for sample_index, time_sec in enumerate(times):
        frame = start_frame + int(round(float(time_sec) * fps))
        bpy.context.scene.frame_set(frame)

        for pb in pose_bones:
            item = data["bones"][pb.name]["frames"][sample_index]
            rest = arm.data.bones[pb.name].matrix_local

            # Position: each bone uses its OWN original Blender rest head,
            # plus the retargeted world displacement converted to Blender axes.
            dp = Vector(item["dp"])
            position = rest.to_translation() + (align_rot @ dp) * align_scale

            # Rotation: world-space delta is independent of bone roll.
            # Convert only the global coordinate basis, then apply it to the
            # exact Blender rest orientation of this bone.
            q = item["dq"]  # [x,y,z,w]
            delta_three = Quaternion((q[3], q[0], q[1], q[2])).to_matrix()
            delta_blender = align_rot @ delta_three @ align_rot_inv
            pose_rot = delta_blender @ rest.to_quaternion().to_matrix()

            matrix = pose_rot.to_4x4()
            matrix.translation = position

            pb.rotation_mode = 'QUATERNION'
            pb.matrix = matrix

            pb.keyframe_insert(
                data_path="location",
                frame=frame,
                group=pb.name,
            )
            pb.keyframe_insert(
                data_path="rotation_quaternion",
                frame=frame,
                group=pb.name,
            )
            pb.keyframe_insert(
                data_path="scale",
                frame=frame,
                group=pb.name,
            )

    for fcurve in action.fcurves:
        for key in fcurve.keyframe_points:
            key.interpolation = 'LINEAR'

    duration = float(data.get("duration", 0.0))
    end_frame = start_frame + int(round(duration * fps))
    bpy.context.scene.frame_start = min(bpy.context.scene.frame_start, start_frame)
    bpy.context.scene.frame_end = max(bpy.context.scene.frame_end, end_frame)
    bpy.context.scene.frame_set(start_frame)

    print("Retarget to See")
    print(" Armature:", arm.name)
    print(" Action:", action.name)
    print(" Baked bones:", len(pose_bones))
    print(" Anchors:", data["anchors"])
    print(" Three->Blender scale:", align_scale)

    return arm, action


class RETARGET_OT_import_original_action(bpy.types.Operator, ImportHelper):
    bl_idname = "retarget_to_see.import_original_action"
    bl_label = "Import Retarget to See Original-Rig Action"
    bl_options = {'REGISTER', 'UNDO'}

    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={'HIDDEN'})

    def execute(self, context):
        try:
            arm, action = import_original_rig_action(self.filepath)
            self.report(
                {'INFO'},
                "Action '%s' creada en %s" % (action.name, arm.name)
            )
            return {'FINISHED'}
        except Exception as exc:
            self.report({'ERROR'}, str(exc))
            raise


def register():
    try:
        bpy.utils.unregister_class(RETARGET_OT_import_original_action)
    except Exception:
        pass
    bpy.utils.register_class(RETARGET_OT_import_original_action)


register()
bpy.ops.retarget_to_see.import_original_action('INVOKE_DEFAULT')
