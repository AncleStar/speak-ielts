"use client";
import { useLayoutEffect } from "react";
import { useRhine } from "./rhine-provider";
import type { ArchiveNavigation } from "./rhine/archive-loop";

export interface DiscSceneProps {
  variant:"library"|"studio"|"archive";
  ids:string[];
  columns?:string[];
  selected?:number;
  state?:"idle"|"loading"|"speaking"|"recording"|"saving"|"playing"|"saved";
  navigation?:ArchiveNavigation;
  paused?:boolean;
  intro?:boolean;
  onSelect?:(index:number,navigation?:ArchiveNavigation)=>void;
}
export function DiscScene(props:DiscSceneProps){
  const rhine=useRhine();
  const configure=rhine?.configure;
  useLayoutEffect(()=>{configure?.(props);},[configure,props.ids,props.columns,props.selected,props.state,props.variant,props.onSelect,props.navigation,props.paused,props.intro]);
  return <div className={`disc-scene disc-scene-${props.variant}`} data-testid="disc-scene" data-renderer={rhine?.simple?"simple":rhine?.status??"loading"} data-state={props.state??"idle"}>
    <div className="disc-stage-meta"><span>{props.ids[props.selected??0]??"SPEAK"}</span><button type="button" aria-pressed={rhine?.simple??false} onClick={rhine?.toggle}>{rhine?.simple?"启用 3D":"简洁显示"}</button></div>
    {props.variant!=="library"&&<div className="disc-drive-status" data-state={props.state??"idle"}><i/><span>{props.state==="recording"?"REC / 正在录音":props.state==="speaking"?"PLAY / 考官提问":props.state==="playing"?"PLAY / 录音回放":props.state==="saving"?"WRITE / 正在保存":props.state==="saved"?"STORED / 记录已保存":"READY / 等待开始"}</span></div>}
  </div>;
}
