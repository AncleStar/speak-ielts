"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
export function RegisterForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [show, setShow] = useState(false), [created, setCreated] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const input = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const response = await fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "注册失败，请稍后再试");
      setCreated(true);
      const result = await authClient.signIn.email({ email: String(input.email).trim(), password: String(input.password) });
      if (result.error) { setError("账号已创建，请返回登录。无需再次使用邀请码。"); return; }
      router.replace("/onboarding"); router.refresh();
    } catch (err) { setError(err instanceof TypeError ? "连接失败，请检查网络后重试。如果账号已创建，可直接返回登录。" : (err as Error).message); }
    finally { setBusy(false); }
  }
  return <Card><CardHeader><CardTitle>加入口语练习</CardTitle><CardDescription>小范围试用，请向邀请你的管理员领取邀请码。</CardDescription></CardHeader><CardContent>
    <form className="space-y-4" onSubmit={submit}>
      <Field label="昵称" htmlFor="name"><Input id="name" name="name" autoComplete="nickname" maxLength={60} required /></Field>
      <Field label="邮箱" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="username" maxLength={254} required /></Field>
      <Field label="设置密码" htmlFor="password"><Input id="password" name="password" type={show ? "text" : "password"} autoComplete="new-password" minLength={8} maxLength={128} required />
        <button type="button" className="min-h-11 text-sm text-muted" aria-pressed={show} onClick={() => setShow(!show)}>{show ? "隐藏密码" : "显示密码"} · 至少 8 位</button></Field>
      <Field label="邀请码" htmlFor="code"><Input id="code" name="code" autoComplete="off" spellCheck={false} maxLength={80} required /></Field>
      {error && <Alert tone={created ? "info" : "danger"}>{error}</Alert>}
      <Button type="submit" className="w-full" disabled={busy || created}>{busy ? "正在创建…" : created ? "账号已创建" : "创建账号"}</Button>
    </form><p className="mt-5 text-sm text-muted">注册后设置学习目标，并完成录音说明确认。</p>
    <Link className="mt-3 inline-flex min-h-11 items-center text-sm text-brand-700 underline" href="/login">已有账号，返回登录</Link>
  </CardContent></Card>;
}
