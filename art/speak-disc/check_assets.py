"""Round-trip the two exported GLBs in a fresh Blender process."""
from pathlib import Path
import json
import math
import struct
import bpy

HERE=Path(__file__).resolve().parent
ASSETS=HERE.parents[1]/"public"/"models"/"speak-disc"/"v1"
checks=[]
for file,required in [
    ("training-disc.glb",["TrainingDisc","Disc_ReelLarge","Disc_ReelSmall","Disc_LabelAnchor","Disc_LabelSurface","Disc_CategoryAccent","Disc_FrontCover"]),
    ("playback-deck.glb",["PlaybackDeck","Deck_RecordLED","Deck_InsertAnchor","Deck_Slot"])
]:
    data=(ASSETS/file).read_bytes()
    magic,version,size=struct.unpack_from("<4sII",data)
    assert magic==b"glTF" and version==2 and size==len(data)
    length,kind=struct.unpack_from("<II",data,12)
    assert kind==0x4e4f534a
    doc=json.loads(data[20:20+length])
    assert not any("uri" in b for b in doc.get("buffers",[])),"External buffer dependency"
    assert not doc.get("images"),"Unexpected texture dependencies"
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(ASSETS/file))
    names={obj.name for obj in bpy.context.scene.objects}
    assert set(required)<=names, f"Missing runtime nodes: {set(required)-names}"
    for obj in bpy.context.scene.objects:
        assert all(math.isfinite(v) for row in obj.matrix_world for v in row)
    assert len([o for o in bpy.context.scene.objects if o.type=="MESH"])>0
    if file=="training-disc.glb":
        assert "KHR_materials_transmission" in doc.get("extensionsUsed",[])
        for reel in ["Disc_ReelLarge","Disc_ReelSmall"]:
            assert bpy.data.objects[reel].parent.name=="TrainingDisc"
            assert bpy.data.objects[reel].children
    checks.append({"file":file,"bytes":len(data),"roundTripImport":True,"requiredNodes":required,
        "noExternalFiles":True,"meshes":len(doc.get("meshes",[])),"extensions":doc.get("extensionsUsed",[])})
result={"passed":True,"scope":"GLB structure and Blender round-trip; browser performance not tested", "checks":checks}
(HERE/"verification.json").write_text(json.dumps(result,indent=2),encoding="utf8")
print("SPEAK_ASSETS_VERIFIED",json.dumps(result))
