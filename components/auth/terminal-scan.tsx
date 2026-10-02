"use client";
import { memo,useEffect,useState } from "react";
import { bootMotion } from "@/components/disc/rhine/boot-motion";

// Arc construction and measured tracks adapted from RhineLabUI's boot.ts / boot-motion.ts.
const arc=(radius:number,start:number,sweep:number,x=960,y=540)=>{
  const p=(a:number)=>`${x+Math.cos(a)*radius},${y+Math.sin(a)*radius}`;
  if(sweep>=Math.PI*1.999)return `M${p(start)}A${radius},${radius} 0 1 1 ${p(start+Math.PI)}A${radius},${radius} 0 1 1 ${p(start+Math.PI*2)}`;
  return `M${p(start)}A${radius},${radius} 0 ${sweep>Math.PI?1:0} 1 ${p(start+sweep)}`;
};
export const TerminalScan=memo(function TerminalScan({authorized=false,elapsed:controlledElapsed,scanOnly=false}:{authorized?:boolean;elapsed?:number;scanOnly?:boolean}){
  const [localElapsed,setElapsed]=useState(0),[reduced,setReduced]=useState(false);
  const elapsed=controlledElapsed??localElapsed;
  useEffect(()=>{
    if(controlledElapsed!==undefined)return;
    const query=matchMedia("(prefers-reduced-motion: reduce)");
    let raf=0,start=performance.now(),hiddenAt=0,animate=true;
    const frame=(now:number)=>{setElapsed((now-start)/1000);if(!document.hidden&&animate)raf=requestAnimationFrame(frame);};
    const update=()=>{let paused=false;try{paused=localStorage.getItem("ambient-paused")==="true";}catch{}animate=!(query.matches||document.documentElement.dataset.motion==="reduced"||paused);setReduced(!animate);cancelAnimationFrame(raf);if(animate&&!document.hidden)raf=requestAnimationFrame(frame);};update();
    const visibility=()=>{if(document.hidden){hiddenAt=performance.now();cancelAnimationFrame(raf);}else{start+=performance.now()-hiddenAt;if(animate)raf=requestAnimationFrame(frame);}};
    query.addEventListener("change",update);window.addEventListener("ambient-pause-change",update);document.addEventListener("visibilitychange",visibility);
    return()=>{cancelAnimationFrame(raf);query.removeEventListener("change",update);window.removeEventListener("ambient-pause-change",update);document.removeEventListener("visibilitychange",visibility);};
  },[authorized,controlledElapsed!==undefined]);
  const t=reduced?16:14.48+(authorized?Math.min(elapsed,3.27):(elapsed*.32)%3.27);
  const s=bootMotion(t),scan=s.scan;
  const welcome=authorized&&elapsed>3.27;
  return <div className="terminal-scan" data-authorized={authorized} data-welcome={welcome} aria-hidden="true" style={scanOnly?{opacity:Math.max(0,Math.min(1,(3.27-elapsed)/.8))}:undefined}>
    <svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity={welcome?0:1}>
      <path d={arc(scan.radius,scan.outerStart,scan.outerSweep)}/><path d={arc(scan.whiteRadius,scan.whiteStart,scan.whiteSweep)} stroke="white" strokeWidth="4"/>
      <path d={arc(scan.innerRadius,scan.innerStart,scan.innerSweep)}/><path d={arc(scan.innerRadius,scan.innerStart+Math.PI,scan.innerSweep)}/>
      {s.scanOrbit.sideVisible&&s.scanOrbit.sides.map((side,i)=><path key={i} d={arc(side.radius,side.start,side.sweep,side.x,side.y)}/>)}
      {s.scanOrbit.satellites.map((point,i)=><circle key={i} cx={point.x} cy={point.y} r={point.radius} fill="currentColor" stroke="none"/>)}
      {[0,1].map(i=><circle key={i} cx={960+Math.cos(scan.orbit+i*Math.PI)*scan.orbitRadius} cy={540+Math.sin(scan.orbit+i*Math.PI)*scan.orbitRadius} r={scan.dotRadius} fill="#ed821b" stroke="none"/>)}
      <circle cx={960+Math.cos(scan.outerStart+scan.outerSweep)*scan.radius} cy={540+Math.sin(scan.outerStart+scan.outerSweep)*scan.radius} r={scan.blackCap} fill="currentColor" stroke="none"/>
      <circle cx={960+Math.cos(scan.whiteStart)*scan.whiteRadius} cy={540+Math.sin(scan.whiteStart)*scan.whiteRadius} r={scan.whiteCap} fill="white" stroke="none"/>
    </g></svg>
    {authorized&&!welcome&&<div className="terminal-authorized">PERMISSION AUTHORIZED<span>身份验证通过</span></div>}
    {!scanOnly&&welcome&&<div className="terminal-welcome"><p>WELCOME TO</p><strong>SPEAK TRAINING</strong><p>PERSONAL DATABASE</p><span>你的下一次进步，从这里开始。</span></div>}
  </div>;
});
