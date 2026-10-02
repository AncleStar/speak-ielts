"use client";
import { Disc3, CalendarDays, Map, Settings, History, Shield, Menu, Coins } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AmbientToggle } from "@/components/ambient-background";
const ITEMS = [
  {href:"/practice",label:"训练磁盘",Icon:Disc3},
  {href:"/history",label:"学习记录",Icon:History},
  {href:"/growth",label:"成长日历",Icon:CalendarDays},
  {href:"/rewards",label:"积分兑换",Icon:Coins},
  {href:"/levels",label:"关卡",Icon:Map},
  {href:"/settings",label:"设置",Icon:Settings},
];
function isActive(path:string,href:string){return path.startsWith(href) || href==="/history" && (/^\/(answers|sessions)\//.test(path));}
export function SpeakBrand(){return <span className="speak-brand"><strong>SPEAK</strong><span>ENGLISH PRACTICE</span><span>TRAINING <b>OS</b></span></span>;}
export function TopNav({isAdmin,name}:{isAdmin:boolean;name:string}){
  const pathname=usePathname();
  const menu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(menu.current)menu.current.open=false;},[pathname]);
  return <header className="terminal-header"><Link href="/" aria-label="SPEAK 首页"><SpeakBrand/></Link><div className="terminal-navigation"><nav aria-label="主导航">{ITEMS.map(({href,label})=><Link key={href} href={href} aria-current={isActive(pathname,href)?"page":undefined}>{label}</Link>)}</nav><div className="terminal-account"><AmbientToggle/>{isAdmin && <Link href="/admin" aria-label="管理"><Shield size={17}/></Link>}<Link href="/" className="terminal-username" title="个人终端 · 签到与积分">{name}</Link></div></div>
    <details className="terminal-mobile-menu" ref={menu} onKeyDown={event=>{if(event.key==="Escape"&&menu.current){menu.current.open=false;menu.current.querySelector("summary")?.focus();}}}>
      <summary aria-label="页面导航"><Menu size={21}/><span>导航</span></summary>
      <div onClick={event=>{if((event.target as HTMLElement).closest("a")&&menu.current)menu.current.open=false;}}>
        <nav aria-label="快捷导航"><Link href="/">个人终端 · 签到与积分</Link>{ITEMS.map(({href,label,Icon})=><Link key={href} href={href} aria-current={isActive(pathname,href)?"page":undefined}><Icon size={16}/>{label}</Link>)}{isAdmin&&<Link href="/admin"><Shield size={16}/>管理</Link>}</nav>
        <AmbientToggle/>
      </div>
    </details>
  </header>;
}
export function BottomNav(){
  const path=usePathname();const [keyboardOpen,setKeyboardOpen]=useState(false);
  useEffect(()=>{const vp=window.visualViewport;const update=()=>setKeyboardOpen(!!vp && vp.height<window.innerHeight*.75 && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName??""));vp?.addEventListener("resize",update);document.addEventListener("focusin",update);document.addEventListener("focusout",update);return()=>{vp?.removeEventListener("resize",update);document.removeEventListener("focusin",update);document.removeEventListener("focusout",update);};},[]);
  if(keyboardOpen)return null;
  return <nav className="terminal-bottom" aria-label="底部导航"><ul>{ITEMS.map(({href,label,Icon})=><li key={href}><Link href={href} aria-current={isActive(path,href)?"page":undefined} className={cn(isActive(path,href)&&"active")}><Icon size={20}/>{label}</Link></li>)}</ul></nav>;
}
