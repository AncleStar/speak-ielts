import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { DiscSceneProps } from "./disc-scene";

export interface DiscStage { update(): void; dispose(): void }

export async function createDiscStage(host: HTMLElement, props: () => DiscSceneProps, failed: () => void): Promise<DiscStage> {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, host.clientWidth < 600 ? 1.25 : 1.5));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.setClearColor(0xebe8e2, 0);
  host.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-5, 5, 3, -3, .1, 100);
  const library = props().variant === "library";
  camera.position.set(library ? 4.4 : .65, library ? 4.7 : 2.8, 12);
  camera.lookAt(0, 1.85, 0);
  const pmrem = new T.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04);
  scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();
  scene.add(new T.HemisphereLight(0xffffff, 0xb5ad9d, .8));
  const light = new T.DirectionalLight(0xfff4df, 2); light.position.set(-4, 8, 6); scene.add(light);
  light.castShadow=true; light.shadow.mapSize.set(1024,1024);
  Object.assign(light.shadow.camera,{left:-10,right:10,top:8,bottom:-8,near:.1,far:30});
  light.shadow.bias=-.001;
  const group = new T.Group(); scene.add(group);
  group.scale.x = library ? 1.12 : 1.25;
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();
  const groundGeometry = new T.PlaneGeometry(35,35); geometries.add(groundGeometry);
  const groundMaterial = new T.ShadowMaterial({opacity:.13}); materials.add(groundMaterial);
  const ground = new T.Mesh(groundGeometry,groundMaterial); ground.rotation.x=-Math.PI/2; ground.position.y=-.18; ground.receiveShadow=true; scene.add(ground);
  const track = (root: T.Object3D) => root.traverse(o => {
    if (o instanceof T.Mesh) { geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m); }
  });
  let destroyed = false, raf = 0, visible = true, last = 0, settleUntil = 0;
  let reduced = false, paused = false, pointerX = 0, pointerY = 0;
  let measuredFrames = 0, measuredSeconds = 0, loweredQuality = false;
  let led: T.MeshStandardMaterial | null = null;
  const discs: { object: T.Object3D; reels: T.Object3D[]; label: T.Mesh; texture: T.CanvasTexture; canvas: HTMLCanvasElement; id: string; index: number }[] = [];
  const loader = new GLTFLoader();
  function dispose() {
    if (destroyed) return; destroyed = true;
    cancelAnimationFrame(raf); resizeObserver?.disconnect(); intersection?.disconnect(); attributes?.disconnect();
    motion.removeEventListener("change", preferences); document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("ambient-pause-change", preferences); window.removeEventListener("storage", preferences);
    host.removeEventListener("pointermove", pointer); host.removeEventListener("pointerleave", leave); host.removeEventListener("click", select);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  }
  function wake() { if (destroyed) return; settleUntil = performance.now() + 1800; if (!raf && visible && !document.hidden) raf = requestAnimationFrame(draw); }
  function preferences() {
    reduced = motion.matches || document.documentElement.dataset.motion === "reduced";
    try { paused = localStorage.getItem("ambient-paused") === "true"; } catch { paused = true; }
    wake();
  }
  function visibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; last = 0; } else wake(); }
  function pointer(e: PointerEvent) { if (e.pointerType !== "mouse" || reduced || paused) return; const b = host.getBoundingClientRect(); pointerX = (e.clientX-b.left)/b.width-.5; pointerY = (e.clientY-b.top)/b.height-.5; wake(); }
  function leave() { pointerX = pointerY = 0; wake(); }
  function select(e: MouseEvent) {
    if (!library) return;
    const b = host.getBoundingClientRect();
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2((e.clientX-b.left)/b.width*2-1, -(e.clientY-b.top)/b.height*2+1), camera);
    const hit = ray.intersectObjects(discs.filter(d => d.object.visible).map(d => d.object), true)[0];
    if (hit) { let obj: T.Object3D | null = hit.object; while (obj && obj.userData.discIndex === undefined) obj = obj.parent; if (obj) props().onSelect?.(obj.userData.discIndex); }
  }
  function contextLost(e: Event) { e.preventDefault(); failed(); dispose(); }
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const resizeObserver = new ResizeObserver(() => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight), aspect = width/height;
    const span = library ? Math.max(5.6, 7.8/aspect) : Math.max(4.45, 4.5/aspect);
    camera.left = -span*aspect/2; camera.right = span*aspect/2; camera.top = span/2; camera.bottom = -span/2;
    camera.updateProjectionMatrix(); renderer.setSize(width, height); wake();
  });
  const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (visible) wake(); else { cancelAnimationFrame(raf); raf=0; last=0; } });
  const attributes = new MutationObserver(preferences);
  function updateLabels() {
    const p = props(), selected = p.selected ?? 0;
    const start = Math.max(0, Math.min(selected-3, p.ids.length-discs.length));
    const desired = Array.from({length:Math.min(discs.length,p.ids.length)},(_,i)=>library?start+i:selected);
    const retained = desired.map(i=>discs.find(d=>d.id===p.ids[i]));
    const available = discs.filter(d=>!retained.includes(d));
    discs.forEach(d=>{d.object.visible=false;});
    desired.forEach((index,i) => {
      const d=retained[i]??available.shift()!;
      d.index = index; d.object.visible = true;
      d.object.userData.discIndex = d.index;
      const id = p.ids[d.index] ?? "SPEAK";
      if (d.id === id) return; d.id = id;
      const ctx = d.canvas.getContext("2d")!;
      ctx.fillStyle = "#eae6dd"; ctx.fillRect(0,0,640,140); ctx.fillStyle = "#20231d";
      ctx.font = "bold 38px Arial"; ctx.fillText(id, 20, 62, 600);
      ctx.font = "18px Arial"; ctx.fillText(p.variant === "archive" ? "PERSONAL RECORD / SPEAK" : "SPEAK TRAINING DISC",20,107);
      d.texture.needsUpdate = true;
    });
  }
  function draw(time: number) {
    raf = 0; if (destroyed || !visible || document.hidden) return;
    const dt = Math.min((time-(last || time))/1000, .05); last=time;
    if (dt>0 && measuredFrames++ < 90) measuredSeconds+=dt;
    if (measuredFrames === 90 && !loweredQuality && measuredSeconds/90 > .028) {
      loweredQuality=true; renderer.setPixelRatio(1); renderer.setSize(host.clientWidth,host.clientHeight);
    }
    const p = props(), selected = p.selected ?? 0;
    const moving = !reduced && !paused;
    const spin = moving && ["speaking", "recording", "playing"].includes(p.state ?? "");
    const ease = moving ? 1-Math.exp(-9*dt) : 1;
    group.rotation.y = T.MathUtils.lerp(group.rotation.y, moving && p.state !== "recording" ? pointerX*.12 : 0, ease);
    group.rotation.x = T.MathUtils.lerp(group.rotation.x, moving && p.state !== "recording" ? pointerY*.06 : 0, ease);
    for (const d of discs) {
      if (!d.object.visible) continue;
      const offset = d.index-selected;
      const scale = library && offset === 0 ? 1.24 : 1;
      d.object.scale.lerp(new T.Vector3(scale,scale,scale),ease);
      const target = library ? new T.Vector3(offset*.93, offset === 0 ? .35 : -.14, offset === 0 ? 1 : -1-Math.abs(offset)*.12) : new T.Vector3(0, p.state === "loading" || p.state === "idle" && p.variant === "studio" ? .95 : .37, 0);
      d.object.position.lerp(target,ease);
      d.object.rotation.y = T.MathUtils.lerp(d.object.rotation.y, library && offset !== 0 ? -.95 : -.12,ease);
      if (spin && offset === 0) for (const reel of d.reels) reel.rotation.z -= dt*(p.state === "recording" ? .55 : .9);
    }
    if (led) { led.color.set(p.state === "recording" ? 0xc72015 : 0x56483e); led.emissive.set(p.state === "recording" ? 0xff1608 : 0x000000); led.emissiveIntensity = p.state === "recording" ? 2 : 0; }
    renderer.render(scene, camera);
    if (spin || time < settleUntil && moving) raf=requestAnimationFrame(draw);
  }
  try {
    const discAsset = await loader.loadAsync("/models/speak-disc/v1/training-disc.glb"); track(discAsset.scene);
    const count = library ? 9 : 1;
    discAsset.scene.traverse(o => { if (o instanceof T.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m instanceof T.MeshPhysicalMaterial && m.transmission > 0) { m.transmission = .99; m.roughness = .025; m.thickness = .025; }
      if (m instanceof T.MeshStandardMaterial && m.name === "Disc_Ivory") { m.color.set(0xc8beaa); m.roughness=.45; }
      o.castShadow = !m.name.includes("ClearPolycarbonate");
    } });
    for (let i=0;i<count;i++) {
      const object = discAsset.scene.clone(true);
      const canvas = document.createElement("canvas"); canvas.width=640; canvas.height=140;
      const texture = new T.CanvasTexture(canvas); texture.colorSpace=T.SRGBColorSpace; textures.add(texture);
      const material = new T.MeshBasicMaterial({map:texture}); materials.add(material);
      const geometry = new T.PlaneGeometry(1.9,.415); geometries.add(geometry);
      const label = new T.Mesh(geometry,material); label.position.set(-.32,3.15,.183);
      // The label is attached in exported Y-up coordinates to the scene, not the Blender Z-up root.
      object.add(label); object.position.set(0,1.5,-3); group.add(object);
      if (props().variant === "archive") {
        const accent = object.getObjectByName("Disc_CategoryAccent") as T.Mesh | undefined;
        if (accent) { const m = (accent.material as T.MeshStandardMaterial).clone(); m.color.set(0x4c5435); materials.add(m); accent.material=m; }
      }
      discs.push({object,reels:["Disc_ReelLarge","Disc_ReelSmall"].map(n=>object.getObjectByName(n)!).filter(Boolean),label,texture,canvas,id:"",index:i});
    }
    if (!library) {
      const deck = await loader.loadAsync("/models/speak-disc/v1/playback-deck.glb"); track(deck.scene); group.add(deck.scene);
      const node = deck.scene.getObjectByName("Deck_RecordLED") as T.Mesh;
      if (node) { led = (node.material as T.MeshStandardMaterial).clone(); materials.add(led); node.material = led; }
    }
    updateLabels(); preferences();
    resizeObserver.observe(host); intersection.observe(host); attributes.observe(document.documentElement,{attributes:true,attributeFilter:["data-motion","data-transparency"]});
    motion.addEventListener("change",preferences); window.addEventListener("ambient-pause-change",preferences); window.addEventListener("storage",preferences);
    document.addEventListener("visibilitychange",visibility); host.addEventListener("pointermove",pointer); host.addEventListener("pointerleave",leave); host.addEventListener("click",select);
    renderer.domElement.addEventListener("webglcontextlost",contextLost);
    wake();
    return {update() { updateLabels(); wake(); }, dispose};
  } catch (error) { dispose(); throw error; }
}
