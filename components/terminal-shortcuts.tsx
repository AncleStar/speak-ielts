import Link from "next/link";
import { ArrowUpRight, CalendarDays, Coins, Library } from "lucide-react";

export function TerminalShortcuts({className=""}:{className?:string}) {
  return <nav className={`terminal-shortcuts ${className}`} aria-label="学习服务">
    {[{href:"/rewards",title:"积分兑换",caption:"REWARDS",Icon:Coins},{href:"/history",title:"学习记录",caption:"RECORDS",Icon:Library},{href:"/growth",title:"成长日历",caption:"CALENDAR",Icon:CalendarDays}].map(({href,title,caption,Icon})=><Link href={href} key={href}><Icon size={16}/><span><small>{caption}</small><strong>{title}</strong></span><ArrowUpRight size={13}/></Link>)}
  </nav>;
}
