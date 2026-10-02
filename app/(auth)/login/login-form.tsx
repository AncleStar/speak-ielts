"use client";
import { useRef,useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Alert } from "@/components/ui/feedback";
import { Field,Input } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { TerminalScan } from "@/components/auth/terminal-scan";
import { useTerminalEntry } from "@/components/auth/terminal-entry";

export function LoginForm(){
  const entry=useTerminalEntry();
  const [email,setEmail]=useState(""),[password,setPassword]=useState("");
  const [error,setError]=useState<string|null>(null),[pending,setPending]=useState(false),[authorized,setAuthorized]=useState(false);
  const submitted=useRef(false);
  async function onSubmit(e:React.FormEvent){
    e.preventDefault();if(submitted.current)return;submitted.current=true;setError(null);setPending(true);
    try{
      const {error}=await authClient.signIn.email({email:email.trim(),password});
      if(error){setError(error.status===429?"尝试次数过多，请稍后再试":error.code==="BANNED_USER"?"该账号已停用，请联系管理员":"邮箱或密码不正确");return;}
      setAuthorized(true);entry?.begin();
    }catch{setError("连接失败，请确认应用已启动、网络正常后重试");}
    finally{submitted.current=false;setPending(false);}
  }
  return <>
    {!authorized&&<TerminalScan/>}
    {authorized?<div className="rhine-auth-success"><p role="status">登录成功，正在进入训练终端</p></div>:<section className="rhine-access-panel">
      <p className="rhine-access-kicker">ACCESS PERMISSION REQUIRED</p>
      <h1>身份接入<span> / 登录</span></h1>
      <p className="rhine-access-description">雅思口语训练终端 · 继续你的练习记录</p>
      <form onSubmit={onSubmit}>
        <Field label="邮箱" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></Field>
        <Field label="密码" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></Field>
        {error&&<Alert tone="danger">{error}</Alert>}
        <button type="submit" className="rhine-auth-submit" disabled={pending} aria-label={pending?"正在登录…":"登录"}><span>{pending?"VERIFYING IDENTITY…":"ENTER SYSTEM"}<small>{pending?"正在验证身份":"登录训练终端"}</small></span><ArrowRight size={25}/></button>
      </form>
      <div className="rhine-access-links"><Link href="/register">使用邀请码注册</Link><Link href="/password-help">忘记密码？</Link></div>
    </section>}
  </>;
}
