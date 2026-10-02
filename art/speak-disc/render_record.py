"""Render the licensed Rhine cassette for the record shelf. Uses a fresh Blender scene."""
from pathlib import Path
import math
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/models/rhine"
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(OUT / "archive-cassette.glb"))
for obj in list(bpy.context.scene.objects):
    if obj.type != "MESH":
        continue
    names = [mat.name.split(".")[0] for mat in obj.data.materials if mat]
    if any(n in ["Carbon_Ink", "Moulded_Lettering"] for n in names):
        bpy.data.objects.remove(obj, do_unlink=True)
        continue
    for mat in obj.data.materials:
        if not mat or not mat.use_nodes:
            continue
        p = mat.node_tree.nodes.get("Principled BSDF")
        if not p:
            continue
        name = mat.name.split(".")[0]
        if name == "Frosted_Polymer":
            p.inputs["Base Color"].default_value = (.94, .92, .87, 1)
            p.inputs["Transmission Weight"].default_value = .95
            p.inputs["Alpha"].default_value = .24
            p.inputs["Roughness"].default_value = .07
            p.inputs["IOR"].default_value = 1.46
        elif name in ["Optical_Diffuser", "Internal_Ceramic", "Subsurface_Optics", "Optical_Edges"]:
            p.inputs["Base Color"].default_value = (.69, .66, .60, 1)
            p.inputs["Roughness"].default_value = .34
            p.inputs["Transmission Weight"].default_value = 0
        elif name == "Amber_Optical_Inlay":
            p.inputs["Base Color"].default_value = (.54, .25, .07, 1)
            p.inputs["Metallic"].default_value = .48
            p.inputs["Roughness"].default_value = .22
        elif name == "Titanium_Fasteners":
            p.inputs["Metallic"].default_value = .8
            p.inputs["Roughness"].default_value = .26

ink = bpy.data.materials.new("SPEAK graphite")
ink.diffuse_color = (.04, .045, .038, 1)
ink.use_nodes = True
ink.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.04, .045, .038, 1)
for body, loc, size in [
    ("SPEAK / AUDIO", (-1.80, -.32, 3.12), .115),
    ("PERSONAL RECORD", (-1.80, -.32, 2.98), .073),
]:
    curve = bpy.data.curves.new("Record marking", "FONT")
    curve.body, curve.size, curve.extrude = body, size, .0003
    obj = bpy.data.objects.new("Record marking", curve)
    bpy.context.collection.objects.link(obj)
    obj.location, obj.rotation_euler = loc, (math.pi / 2, 0, 0)
    obj.data.materials.append(ink)

scene = bpy.context.scene
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (.82, .85, .90, 1)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = .55
target = Vector((0, 0, 1.85))
for name, pos, power, size in [
    ("Broad softbox", (-4, -5, 7), 1000, 5),
    ("Warm side", (5, -2, 4), 750, 4),
    ("Edge light", (0, 3, 6), 1200, 3),
]:
    light = bpy.data.lights.new(name, "AREA")
    light.energy, light.size = power, size
    obj = bpy.data.objects.new(name, light)
    scene.collection.objects.link(obj)
    obj.location = pos
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
camera = bpy.data.objects.new("Record camera", bpy.data.cameras.new("Record camera"))
scene.collection.objects.link(camera)
camera.location = (6, -15, 6.8)
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type, camera.data.ortho_scale = "ORTHO", 6.4
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.samples, scene.cycles.use_denoising = 96, True
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    gpu = [d for d in prefs.devices if d.type == "OPTIX"]
    for d in prefs.devices:
        d.use = d in gpu
    if gpu:
        scene.cycles.device = "GPU"
except Exception:
    pass
scene.view_settings.view_transform = "AgX"
scene.view_settings.exposure = .35
scene.render.resolution_x = scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = str(OUT / "record-disc.png")
bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).with_name("record-disc-v2.blend")))
bpy.ops.render.render(write_still=True)
print("RECORD_THUMBNAIL_COMPLETE", scene.render.filepath)
