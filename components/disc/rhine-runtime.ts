import { ArchiveScene } from "./rhine/scene";
import { ArchiveCatalog } from "./rhine/catalog";
import { qualityPresets } from "./rhine/render-quality";
import { fullMotion, reducedMotion } from "./rhine/motion-preferences";
import { SCAN_CORNERS, SCAN_FROM, SCAN_TO } from "./rhine/decryption";
import type { DiscSceneProps } from "./disc-scene";

export interface RhineStage { update(): void; enter(): void; cancel(): void; stopPlayback():void; dispose(): void }

export async function createRhineStage(host: HTMLElement, props: () => DiscSceneProps, failed: () => void, signal?: AbortSignal): Promise<RhineStage> {
  signal?.throwIfAborted();
  const catalogFor = (p: DiscSceneProps) => new ArchiveCatalog(p.ids.map((id,i)=>({id,column:p.columns?.[i]})));
  const scene = new ArchiveScene(host, catalogFor(props()));
  let destroyed=false, raf=0, mode="", lastId="", libraryKey="", entering=false, reduced=false, paused=false, playbackState="", intro=false;
  const motionQuery=matchMedia("(prefers-reduced-motion: reduce)");
  const events=new AbortController();
  let artworkElement: HTMLElement | null = null;
  const artworkResize = new ResizeObserver(refreshArtwork);
  function clearArtwork() {
    scene.setArtworkFrame();
    for (const edge of ["top", "right", "bottom", "left"]) host.parentElement?.style.removeProperty(`--rhine-artwork-${edge}`);
  }
  function refreshArtwork() {
    if (destroyed) return;
    const responsive = host.clientWidth <= 767 || host.clientWidth <= 1100 && (host.clientWidth / host.clientHeight <= 1.05 || host.clientHeight <= 500);
    const next = responsive ? host.closest(".rhine-root")?.querySelector<HTMLElement>(`.disc-scene-${props().variant}`) ?? null : null;
    if (next !== artworkElement) { artworkResize.disconnect(); artworkElement = next; if (next) artworkResize.observe(next); }
    scene.setInputSurface(next ?? undefined);
    const world = host.parentElement;
    if (!next) { clearArtwork(); return; }
    const bounds = next.getBoundingClientRect(), origin = host.getBoundingClientRect();
    const captions = Array.from(next.querySelectorAll<HTMLElement>(".disc-stage-meta,.disc-drive-status")).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    const bottom = Math.min(bounds.bottom - 8, ...captions.map(r => r.top - 10));
    // Keep the real model inside its page slot, leaving caption and control space.
    if (bounds.width <= 24 || bottom - bounds.top <= 40) { clearArtwork(); return; }
    const frame = { left: bounds.left - origin.left + 8, top: bounds.top - origin.top + 6, width: bounds.width - 16, height: bottom - bounds.top - 6 };
    scene.setArtworkFrame(frame);
    world?.style.setProperty("--rhine-artwork-top", `${frame.top}px`);
    world?.style.setProperty("--rhine-artwork-right", `${host.clientWidth - frame.left - frame.width}px`);
    world?.style.setProperty("--rhine-artwork-bottom", `${frame.top + frame.height}px`);
    world?.style.setProperty("--rhine-artwork-left", `${frame.left}px`);
  }
  const overlay=document.createElementNS("http://www.w3.org/2000/svg","svg");
  overlay.classList.add("rhine-inspection"); overlay.setAttribute("aria-hidden","true");
  // Original model-space scan coordinates and timeline, projected through the live camera.
  const scanLine=document.createElementNS("http://www.w3.org/2000/svg","path");
  const corners=SCAN_CORNERS.map(()=>document.createElementNS("http://www.w3.org/2000/svg","rect"));
  const point=document.createElementNS("http://www.w3.org/2000/svg","circle");point.setAttribute("r","4");
  overlay.append(scanLine,...corners,point);host.append(overlay);
  function preferences(){
    reduced=motionQuery.matches || document.documentElement.dataset.motion==="reduced";
    try{paused=localStorage.getItem("ambient-paused")==="true";}catch{paused=false;}
    scene.setMotion(reduced||paused?reducedMotion():{...fullMotion(),pointerParallax:props().state!=="recording"});
    scene.setTheme(document.documentElement.dataset.theme==="dark",mode==="");wake();
  }
  function wake(){if(!destroyed&&!raf&&!document.hidden)raf=requestAnimationFrame(frame);}
  function configure(){
    if(destroyed)return;
    refreshArtwork();
    const p=props();
    if(p.variant==="library"){
      const key=p.ids.join("|")+p.columns?.join("|");
      if(key!==libraryKey){scene.catalog=catalogFor(p);libraryKey=key;lastId="";}
    }
    const id=p.ids[p.selected??0]??"SPEAK";
    let index=scene.catalog.records.findIndex(r=>r.id===id);
    if(index<0){scene.catalog=catalogFor(p);index=p.selected??0;libraryKey="";}
    const changed=id!==lastId;
    if(changed){scene.select(index,p.navigation);lastId=id;}
    const next=p.variant==="library"&&!entering?"archive":"detail";
    if(mode!==next||changed&&next==="detail"){scene.setMode(next);mode=next;}
    if(playbackState!==p.state){playbackState=p.state??"idle";scene.setPlayback(playbackState);}
    preferences();
    const nextIntro=!!p.intro&&p.variant==="library"&&!reduced&&!paused;
    if(nextIntro!==intro){intro=nextIntro;if(intro)scene.startLibraryIntro();else scene.finishLibraryIntro();}
    if(["speaking","recording","playing"].includes(playbackState))scene.finishDecryption();
  }
  function frame(now:number){
    raf=0;if(destroyed||document.hidden)return;
    host.dataset.paused=String(!!props().paused);
    if(props().paused)return;
    scene.update(now/1000);
    host.dataset.sceneTime=String(now);
    const f=scene.decryptionFrame;
    host.dataset.reveal=f.phase;
    host.style.setProperty("--detail-shade",String(scene.detailVisibility));
    document.documentElement.style.setProperty("--rhine-detail",String(scene.detailVisibility));
    document.documentElement.style.setProperty("--rhine-clarity",String(reduced||paused?1:f.clarity));
    overlay.setAttribute("viewBox",`0 0 ${host.clientWidth} ${host.clientHeight}`);
    const scanVisible=!reduced&&!paused&&mode==="detail"&&(f.intervals.length>0||f.markers>0||f.point>0);
    overlay.style.opacity=scanVisible?"1":"0";
    if(scanVisible){
      const at=(t:number)=>scene.projectCard(SCAN_FROM[0]+(SCAN_TO[0]-SCAN_FROM[0])*t,SCAN_FROM[1]+(SCAN_TO[1]-SCAN_FROM[1])*t);
      scanLine.setAttribute("d",f.intervals.map(([a,b])=>`M${at(a)}L${at(b)}`).join(""));
      corners.forEach((rect,i)=>{const [x,y]=scene.projectCard(SCAN_CORNERS[i][0],SCAN_CORNERS[i][1]);rect.setAttribute("x",String(x-3));rect.setAttribute("y",String(y-3));rect.setAttribute("width","6");rect.setAttribute("height","6");rect.setAttribute("opacity",String(f.markers));});
      const [x,y]=at(.5);point.setAttribute("cx",String(x));point.setAttribute("cy",String(y));point.setAttribute("opacity",String(f.point));
    }
    host.dataset.playback=playbackState;
    host.dataset.intro=String(intro);
    raf=requestAnimationFrame(frame);
  }
  const resize=new ResizeObserver(()=>{host.dataset.layout=host.clientWidth/host.clientHeight<1.05?"portrait":host.clientWidth<1100?"compact":"desktop";refreshArtwork();scene.resize();wake();});
  const attributes=new MutationObserver(preferences);
  function dispose(){
    if(destroyed)return;destroyed=true;cancelAnimationFrame(raf);events.abort();signal?.removeEventListener("abort",dispose);resize.disconnect();artworkResize.disconnect();clearArtwork();attributes.disconnect();motionQuery.removeEventListener("change",preferences);scene.dispose();overlay.remove();
  }
  signal?.addEventListener("abort",dispose,{once:true});
  try{
    await scene.load();
    signal?.throwIfAborted();
    scene.setQuality(host.clientWidth<700?qualityPresets.performance:{...qualityPresets.original,aoSamples:16,aoResolution:.5,pixelRatio:1});
    scene.onSelect=(index,cell)=>props().onSelect?.(index,cell?{cell}:undefined);
    scene.onNavigate=(axis,direction)=>{const index=scene.catalog.records.findIndex(r=>r.id===lastId);props().onSelect?.(scene.catalog.navigate(index,axis,direction),{axis,direction});};
    resize.observe(host);attributes.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","data-motion"]});
    motionQuery.addEventListener("change",preferences);
    window.addEventListener("ambient-pause-change",preferences,{signal:events.signal});
    window.addEventListener("storage",preferences,{signal:events.signal});
    document.addEventListener("scroll",()=>{refreshArtwork();wake();},{capture:true,passive:true,signal:events.signal});
    document.addEventListener("visibilitychange",()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else{scene.resumeAnimationClock();wake();}},{signal:events.signal});
    scene.renderer.domElement.addEventListener("webglcontextlost",event=>{event.preventDefault();failed();dispose();},{signal:events.signal});
    configure();wake();
    return {update:configure,enter(){entering=true;configure();},cancel(){entering=false;scene.stopPlayback();configure();},stopPlayback(){scene.stopPlayback();host.dataset.playback="idle";wake();},dispose};
  }catch(error){dispose();throw error;}
}
