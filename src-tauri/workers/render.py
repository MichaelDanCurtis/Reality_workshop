"""Render a frozen glTF snapshot. Runs in an isolated Blender background process."""
import bpy
import math
import json
import pathlib
import sys
from mathutils import Vector

folder = pathlib.Path(sys.argv[sys.argv.index("--") + 1])
snapshot = json.loads((folder / "scene.gltf").read_text())
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(folder / "scene.gltf"))
scene = bpy.context.scene
cameras = [o for o in scene.objects if o.type == "CAMERA"]
if not cameras:
    raise RuntimeError("The scene snapshot has no camera")
scene.camera = cameras[0]
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.use_denoising = True
aspect = snapshot.get("cameras", [{}])[0].get("perspective", {}).get("aspectRatio", 1.44)
scene.render.resolution_x = max(640, min(2200, round(1000 * aspect)))
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.48, 0.65, 0.8, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.45
# Replace real-time lights with physically meaningful Blender lighting.
for obj in list(scene.objects):
    if obj.type == "LIGHT":
        bpy.data.objects.remove(obj, do_unlink=True)
sun = bpy.data.lights.new("Sun", "SUN")
sun.energy = 3.0
sun.angle = math.radians(8)
sun_obj = bpy.data.objects.new("Sun", sun)
scene.collection.objects.link(sun_obj)
angle = math.radians(snapshot.get("scenes", [{}])[0].get("extras", {}).get("sun_angle", 45))
sun_position = Vector((math.cos(angle) * 25, -math.sin(angle) * 25, 28))
sun_obj.rotation_euler = (-sun_position).to_track_quat('-Z', 'Y').to_euler()
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(folder / "render.png")
bpy.ops.wm.save_as_mainfile(filepath=str(folder / "scene.blend"))
bpy.ops.render.render(write_still=True)
