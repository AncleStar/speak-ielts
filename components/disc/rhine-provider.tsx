"use client";
import { createContext,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { usePathname } from "next/navigation";
import type { DiscSceneProps } from "./disc-scene";
import type { RhineStage } from "./rhine-runtime";
import { practiceHref, type PracticeLocation } from "@/lib/client/practice-location";
import { useTerminalEntry } from "@/components/auth/terminal-entry";

type Context = { configure:(props:DiscSceneProps)=>void;status:string;simple:boolean;toggle:()=>void;enter:()=>Promise<void>;cancel:()=>void;library:PracticeLocation|null;remember:(value:PracticeLocation)=>void;practiceHref:string;stopPlayback:()=>void };
const RhineContext=createContext<Context|null>(null);
export const useRhine=()=>useContext(RhineContext);

/** One canvas survives practice → interview → replay navigation. */
export function RhineProvider({children}:{children:React.ReactNode}){
  const entry=useTerminalEntry();
  const path=usePathname();
  const active=path==="/practice"||path.startsWith("/interview/")||path.startsWith("/answers/");
  const variant=path==="/practice"?"library":path.startsWith("/interview/")?"studio":"archive";
  const host=useRef<HTMLDivElement>(null),stage=useRef<RhineStage|null>(null);
  const latest=useRef<DiscSceneProps>({variant:"library",ids:["SPEAK"]});
  const [status,setStatus]=useState("loading"),[simple,setSimple]=useState(false),[configured,setConfigured]=useState(false);
  const [library,setLibrary]=useState<PracticeLocation|null>(null);
  const entryReady=entry?.ready;
  useEffect(()=>{entryReady?.(path==="/practice"&&configured&&(simple||status==="ready"||status==="fallback"));},[entryReady,path,configured,simple,status]);
  const remember=useCallback((value:PracticeLocation)=>setLibrary(old=>old&&practiceHref(old)===practiceHref(value)?old:value),[]);
  const configure=useCallback((props:DiscSceneProps)=>{latest.current=props;setConfigured(true);stage.current?.update();},[]);
  useLayoutEffect(()=>{
    if(active)document.documentElement.dataset.rhine=variant;
    else delete document.documentElement.dataset.rhine;
    return()=>{delete document.documentElement.dataset.rhine;};
  },[active,variant]);
  const stopPlayback=useCallback(()=>stage.current?.stopPlayback(),[]);
  useEffect(()=>{stopPlayback();return stopPlayback;},[path,stopPlayback]);
  useEffect(()=>{
    if(!active||!configured||simple||!host.current)return;
    let cancelled=false;setStatus("loading");
    import("./rhine-runtime").then(async({createRhineStage})=>{
      if(cancelled)return;
      const next=await createRhineStage(host.current!,()=>latest.current,()=>{if(!cancelled)setStatus("fallback");});
      if(cancelled){next.dispose();return;}stage.current=next;setStatus("ready");
    }).catch(()=>{if(!cancelled)setStatus("fallback");});
    return()=>{cancelled=true;stage.current?.dispose();stage.current=null;};
  },[active,configured,simple]);
  useEffect(()=>{if(variant==="library")stage.current?.cancel();},[path,variant]);
  const enter=useCallback(async()=>{
    stage.current?.enter();
    let paused=false;try{paused=localStorage.getItem("ambient-paused")==="true";}catch{}
    const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches||document.documentElement.dataset.motion==="reduced"||paused;
    if(stage.current&&!simple&&!reduced)await new Promise<void>(resolve=>setTimeout(resolve,1500));
  },[simple]);
  const cancel=useCallback(()=>stage.current?.cancel(),[]);
  const value=useMemo(()=>({configure,status,simple,toggle:()=>setSimple(v=>!v),enter,cancel,library,remember,practiceHref:practiceHref(library),stopPlayback}),[configure,status,simple,enter,cancel,library,remember,stopPlayback]);
  return <RhineContext.Provider value={value}>
    <div className="rhine-root" data-rhine={active?variant:undefined} data-entry={entry?.phase??"idle"}>
    {active&&<div className="rhine-world" data-renderer={simple?"simple":status} data-variant={variant}>
      <div className="rhine-world-canvas" ref={host}/>
      <div className="rhine-atmosphere"/>
      {!simple&&status==="loading"?<div className="rhine-world-loading" role="status"><i/>正在载入训练磁盘</div>:(simple||status==="fallback")&&<div className="rhine-world-fallback"><img src="/models/rhine/record-disc.webp" alt="训练磁盘"/><span>简洁显示 · 选题和录音功能正常可用</span></div>}
    </div>}
    <div className="rhine-content">{children}</div>
    </div>
  </RhineContext.Provider>;
}
