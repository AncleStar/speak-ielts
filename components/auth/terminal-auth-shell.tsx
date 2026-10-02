"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { SpeakBrand } from "@/components/nav";
import { AmbientBackground } from "@/components/ambient-background";

export function TerminalAuthShell({children}:{children:React.ReactNode}){
  const path=usePathname();
  return <main className="auth-shell rhine-auth" data-login={path==="/login"}>
    <AmbientBackground variant="auth"/>
    <header className="rhine-auth-header"><Link href="/login" aria-label="SPEAK 登录"><SpeakBrand/></Link><span>PERSONAL ACCESS <b>/</b> IELTS SPEAKING</span></header>
    <div className="rhine-auth-center">{children}</div>
    <div className="rhine-powered">POWERED BY <strong>SPEAK</strong><i/></div>
    <footer className="rhine-auth-footer"><span>ENGLISH PRACTICE TERMINAL</span><span>循序闯关 / 限时模拟 / 每日成长</span></footer>
  </main>;
}
