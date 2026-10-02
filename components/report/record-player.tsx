"use client";
import { Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const clock = (n:number) => `${Math.floor(n/60).toString().padStart(2,"0")}:${Math.floor(n%60).toString().padStart(2,"0")}`;
export function RecordPlayer({answerId,durationMs,onPlaying}:{answerId:string;durationMs:number|null;onPlaying?:(v:boolean)=>void}) {
  const audio=useRef<HTMLAudioElement>(null);
  const [playing,setPlaying]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState((durationMs??0)/1000),[rate,setRate]=useState(1),[volume,setVolume]=useState(1),[error,setError]=useState("");
  const change=(v:boolean)=>{setPlaying(v);onPlaying?.(v);};
  useEffect(()=>()=>onPlaying?.(false),[onPlaying]);
  async function toggle(){const el=audio.current;if(!el)return;setError("");if(!el.paused){el.pause();return;}try{await el.play();}catch{change(false);setError("录音暂时无法播放，请检查网络后重试。");}}
  return <div className="record-player" data-testid="record-player" data-playing={playing}>
    <audio ref={audio} preload="none" src={`/api/answers/${answerId}/audio`} data-testid="answer-audio" onPlaying={()=>change(true)} onPause={()=>change(false)} onWaiting={()=>change(false)} onEnded={()=>change(false)} onTimeUpdate={()=>setTime(audio.current?.currentTime??0)} onLoadedMetadata={()=>{const d=audio.current?.duration;if(d && Number.isFinite(d))setDuration(d);}} onError={()=>{change(false);setError("录音不可用或已到期；文字报告仍可查看。");}}/>
    <button type="button" className="record-play-button" aria-label={playing?"暂停录音回放":"播放录音"} onClick={toggle}>{playing?<Pause fill="currentColor"/>:<Play fill="currentColor"/>}</button>
    <div className="record-timeline"><label className="sr-only" htmlFor={`seek-${answerId}`}>回放进度</label><input id={`seek-${answerId}`} type="range" min="0" max={Math.max(duration,.1)} step="0.05" value={Math.min(time,duration)} disabled={!duration} onChange={e=>{const t=Number(e.target.value);if(audio.current)audio.current.currentTime=t;setTime(t);}}/><p><span>{clock(time)}</span><span>/ {clock(duration)}</span></p></div>
    <select aria-label="回放速度" value={rate} onChange={e=>{const v=Number(e.target.value);setRate(v);if(audio.current)audio.current.playbackRate=v;}}>{[.75,1,1.25,1.5,2].map(v=><option key={v} value={v}>{v}×</option>)}</select>
    <label className="record-volume"><Volume2 size={21}/><span className="sr-only">回放音量</span><input type="range" aria-label="回放音量" min="0" max="1" step=".05" value={volume} onChange={e=>{const v=Number(e.target.value);setVolume(v);if(audio.current)audio.current.volume=v;}}/></label>
    {error && <p role="alert" className="record-error">{error}<button onClick={()=>{audio.current?.load();void toggle();}}>重试播放</button></p>}
  </div>;
}
