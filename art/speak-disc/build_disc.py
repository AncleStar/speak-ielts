"""Build editable SPEAK disc assets using the local Blender application.

Run from any directory:
  blender --background --factory-startup --python build_disc.py
Outputs stay beside this script and under public/models/speak-disc/v1.
No existing Blender scene or application database is opened or changed.
"""
from pathlib import Path
import json
import math
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXPORT = ROOT / "public" / "models" / "speak-disc" / "v1"
EXPORT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"

def material(name, rgb, metallic=0, roughness=.4, transmission=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    p = mat.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Transmission Weight"].default_value = transmission
    p.inputs["IOR"].default_value = 1.46
    if emission:
        p.inputs["Emission Color"].default_value = (*rgb, 1)
        p.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = (*rgb, 1)
    return mat

glass = material("Disc_ClearPolycarbonate", (.92, .90, .85), roughness=.12, transmission=1)
ivory = material("Disc_Ivory", (.76, .735, .67), roughness=.32)
silver = material("Hardware_SatinAluminium", (.64, .66, .65), metallic=.82, roughness=.29)
amber = material("Disc_AmberAccent", (.61, .29, .062), metallic=.35, roughness=.28)
ink = material("Label_Charcoal", (.036, .044, .030), roughness=.5)
label = material("Label_Paper", (.88, .86, .81), roughness=.6)
black = material("Slot_DarkRubber", (.025, .027, .024), roughness=.78)
red = material("LED_Record", (.8, .014, .008), roughness=.24, emission=2.5)
white = material("LED_Ready", (.6, .8, .55), roughness=.25, emission=1)

def empty(name, parent=None, location=(0,0,0)):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    return obj

def finish(obj, name, mat, parent):
    obj.name = name
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj

def box(name, location, size, mat, parent=None, bevel=.035):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Manufactured edge", "BEVEL")
        mod.width, mod.segments = bevel, 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    finish(obj,name,mat,parent)
    return obj

def torus(name, location, radius, thickness, mat, parent):
    bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=8, location=location,
        rotation=(math.pi/2, 0, 0), major_radius=radius, minor_radius=thickness)
    obj=finish(bpy.context.object,name,mat,parent)
    for face in obj.data.polygons: face.use_smooth=True
    return obj

def cylinder(name, location, radius, depth, mat, parent, vertices=40):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth,
        location=location, rotation=(math.pi/2,0,0))
    obj=finish(bpy.context.object,name,mat,parent)
    for face in obj.data.polygons: face.use_smooth=len(face.vertices)==4
    return obj

font_path = Path("C:/Windows/Fonts/arial.ttf")
font = bpy.data.fonts.load(str(font_path)) if font_path.exists() else None
def text(name, value, location, size, mat, parent):
    curve=bpy.data.curves.new(name,"FONT")
    curve.body,curve.size,curve.extrude,curve.resolution_u=value,size,0.0004,3
    if font: curve.font=font
    obj=bpy.data.objects.new(name,curve)
    scene.collection.objects.link(obj)
    obj.location=location
    obj.rotation_euler=(math.pi/2,0,0)
    obj.parent=parent
    obj.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active=obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object

disc=empty("TrainingDisc")
disc["assetVersion"]="1.0"
disc["role"]="reusable-training-or-recording-disc"
disc["insertAxis"]="local Y after glTF conversion"
box("Disc_Backplate",(0,.092,1.85),(3.1,.08,3.7),ivory,disc,.075)
box("Disc_FrontCover",(0,-.112,1.85),(3.1,.055,3.7),glass,disc,.055)
for x in [-1.51,1.51]:
    box(f"Disc_Rail_{x}",(x,-.004,1.85),(.072,.2,3.58),glass,disc,.028)
for z in [.06,3.64]:
    box(f"Disc_Edge_{z}",(0,-.004,z),(2.98,.2,.09),glass,disc,.028)

def reel(name, position, radius):
    pivot=empty(name,disc,position)
    pivot["spinAxis"]="local Z after glTF conversion"
    pivot["purpose"]="animate while examiner speaks, recording, or replaying"
    torus(name+"_Outer",(0,0,0),radius,.056,ivory,pivot)
    torus(name+"_Metal",(0,-.022,0),radius-.09,.019,silver,pivot)
    torus(name+"_Amber",(0,-.025,0),radius-.145,.031,amber,pivot)
    cylinder(name+"_Hub",(0,.015,0),max(.1,radius-.205),.055,label,pivot)
    for n in range(8):
        angle=n*math.tau/8
        tick=box(f"{name}_Index_{n}",((radius-.027)*math.sin(angle),-.061,(radius-.027)*math.cos(angle)),(.012,.012,.045),amber,pivot,.003)
        tick.rotation_euler.y=angle
    return pivot

reel("Disc_ReelLarge",(-.42,-.017,1.47),.865)
reel("Disc_ReelSmall",(.81,-.020,2.62),.43)

# Geometry makes the optical bridge readable without an image texture.
bridge=box("Disc_OpticalBridge",(.40,-.015,2.015),(.10,.06,.61),ivory,disc,.035)
bridge.rotation_euler.y=.74
for n,(x,z) in enumerate([(-1.34,.23),(1.34,.23),(-1.34,3.47),(1.34,3.47)]):
    cylinder(f"Disc_Screw_{n}",(x,-.161,z),.077,.040,silver,disc,24)
    a=box(f"Disc_ScrewSlot_{n}",(x,-.183,z),(.085,.008,.012),ink,disc,.002)
    a.rotation_euler.y=math.pi/4

box("Disc_LabelSurface",(-.32,-.151,3.15),(1.95,.016,.48),label,disc,.035)
text("Disc_Brand","SPEAK",(-1.18,-.164,3.22),.19,ink,disc)
text("Disc_Type","TRAINING DISC",(-1.18,-.164,3.03),.072,ink,disc)
tag=box("Disc_CategoryAccent",(-1.405,-.163,2.93),(.16,.022,.66),amber,disc,.025)
tag["purpose"]="set accent by part; olive for personal records"
anchor=empty("Disc_LabelAnchor",disc,(-.22,-.18,3.08))
anchor["purpose"]="runtime question ID or private recording ID; never embed user data in shared GLB"
for n in range(9):
    slit=box(f"Disc_Vent_{n}",(.48+n*.058,-.154,.27),(.015,.012,.13),silver,disc,.002)
    slit.rotation_euler.y=.47
text("Disc_SerialCaption","RECORD / REPLAY",(-1.15,-.158,.37),.067,ink,disc)

deck=empty("PlaybackDeck")
deck["assetVersion"]="1.0"
box("Deck_Body",(0,0,.155),(3.72,1.12,.31),silver,deck,.10)
box("Deck_Top",(0,0,.323),(3.62,1.02,.036),ivory,deck,.07)
box("Deck_Slot",(0,0,.35),(3.23,.32,.028),black,deck,.035)
for x in [-1.67,1.67]:
    box(f"Deck_Foot_{x}",(x,0,-.019),(.32,.73,.075),black,deck,.035)
text("Deck_Brand","SPEAK",(-1.53,-.565,.175),.095,ink,deck)
text("Deck_Function","PLAY / RECORD",(-.55,-.565,.11),.072,ink,deck)
led=cylinder("Deck_RecordLED",(1.16,-.565,.16),.052,.016,red,deck,24)
led["purpose"]="red only when mic recorder is active; off while saving"
text("Deck_RecordLabel","REC",(1.28,-.567,.13),.075,ink,deck)
empty("Deck_InsertAnchor",deck,(0,0,.37))

def children(root):
    return [root]+[o for child in root.children for o in children(child)]

def export(root, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in children(root): obj.select_set(True)
    bpy.context.view_layer.objects.active=root
    bpy.ops.export_scene.gltf(filepath=str(EXPORT/name), export_format="GLB",use_selection=True,
        export_extras=True,export_yup=True,export_animations=False,export_cameras=False,export_lights=False)

# Merge non-interactive pieces by parent and material to reduce browser draw calls.
# Keep the cover, configurable label, category tag, LED and both rotation pivots addressable.
protected={"Disc_FrontCover","Disc_LabelSurface","Disc_CategoryAccent","Deck_RecordLED","Deck_Slot"}
for parent in [disc,deck]+[obj for obj in disc.children if obj.type=="EMPTY"]:
    groups={}
    for obj in list(parent.children):
        if obj.type=="MESH" and obj.name not in protected:
            groups.setdefault(tuple(m.name for m in obj.data.materials),[]).append(obj)
    for mats,objects in groups.items():
        if len(objects)<2: continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects: obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
        objects[0].name=parent.name+"_"+mats[0]

export(disc,"training-disc.glb")
export(deck,"playback-deck.glb")

# Staging is saved in the editable source, but not exported with web models.
disc.location.z=.37
floor=material("Studio_WarmIvory",(.90,.87,.81),roughness=.68)
box("Studio_Floor",(0,0,-.10),(200,200,.08),floor,None,.005)
scene.world.use_nodes=True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value=(.84,.86,.88,1)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value=.65

def area(name,location,energy,size,target):
    data=bpy.data.lights.new(name,"AREA")
    data.energy=energy
    data.shape="DISK"
    data.size=size
    obj=bpy.data.objects.new(name,data)
    scene.collection.objects.link(obj)
    obj.location=location
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()
area("Studio_Key",(-4,-5,7),900,5,(0,0,1.8))
area("Studio_Fill",(4,-2,4),550,4,(0,0,1.8))
area("Studio_Rim",(0,4,6),1100,4,(0,0,2))
cam=bpy.data.cameras.new("Studio_Camera")
camera=bpy.data.objects.new("Studio_Camera",cam)
scene.collection.objects.link(camera)
camera.location=(5,-11,5.1)
camera.rotation_euler=(Vector((0,0,2.0))-camera.location).to_track_quat("-Z","Y").to_euler()
cam.type="ORTHO"
cam.ortho_scale=7.9
scene.camera=camera
scene.render.engine="CYCLES"
scene.cycles.samples=48
scene.cycles.use_denoising=True
try:
    prefs=bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type="OPTIX"
    prefs.get_devices()
    gpus=[d for d in prefs.devices if d.type=="OPTIX"]
    if gpus:
        for device in prefs.devices: device.use=device in gpus
        scene.cycles.device="GPU"
        print("RENDER_DEVICE: OPTIX")
except Exception:
    scene.cycles.device="CPU"
scene.view_settings.view_transform="AgX"
scene.view_settings.exposure=.5
scene.render.resolution_x=1600
scene.render.resolution_y=1100
scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"
scene.render.filepath=str(HERE/"disc-and-deck-preview.png")
bpy.ops.wm.save_as_mainfile(filepath=str(HERE/"speak-disc-v1.blend"))
bpy.ops.render.render(write_still=True)

stats={"blender":bpy.app.version_string,"render":"disc-and-deck-preview.png","assets":[]}
for root,file in [(disc,"training-disc.glb"),(deck,"playback-deck.glb")]:
    meshes=[o for o in children(root) if o.type=="MESH"]
    for obj in meshes: obj.data.calc_loop_triangles()
    stats["assets"].append({"file":file,"bytes":(EXPORT/file).stat().st_size,"meshes":len(meshes),
        "triangles":sum(len(o.data.loop_triangles) for o in meshes),"nodes":[o.name for o in children(root)]})
(HERE/"asset-report.json").write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding="utf-8")
print("SPEAK_ASSETS_COMPLETE",json.dumps({"assets":[{k:v for k,v in a.items() if k!="nodes"} for a in stats["assets"]]}))
