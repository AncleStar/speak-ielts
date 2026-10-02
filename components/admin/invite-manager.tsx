"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { api } from "@/lib/client/api";
type Row = { id: string; email: string | null; expiresAt: string; usedAt: string | null; revokedAt: string | null };
export function InviteManager({ rows }: { rows: Row[] }) {
  const router = useRouter(); const [code, setCode] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  async function action(body: object) {
    setBusy(true); setMessage("");
    try { const result = await api<{ code?: string }>("/api/admin/invites", { body }); if (result.code) setCode(result.code); router.refresh(); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="space-y-5"><Card><CardContent className="pt-6"><form className="flex flex-wrap items-end gap-4" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void action({ action: "create", email: f.get("email"), days: Number(f.get("days")) }); }}>
    <Field label="限定邮箱（可留空）" htmlFor="invite-email"><Input id="invite-email" name="email" type="email" maxLength={254} /></Field>
    <Field label="有效天数" htmlFor="invite-days"><Input id="invite-days" name="days" type="number" min={1} max={30} defaultValue={7} required /></Field>
    <Button type="submit" disabled={busy}>生成邀请码</Button></form>
    {code && <div className="mt-5 rounded-xl bg-brand-50 p-4"><p className="text-sm">请复制并私下发给受邀人，离开本页后无法再次查看：</p><code className="my-3 block break-all select-all text-lg" data-testid="invite-code">{code}</code><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(code); setMessage("已复制邀请码"); } catch { setMessage("复制不可用，请选中上方邀请码手动复制"); } }}>复制邀请码</Button></div>}
    {message && <p role="status" className="mt-4 text-sm">{message}</p>}
  </CardContent></Card><Card><CardContent className="pt-5"><h2 className="font-semibold">最近 100 个邀请</h2><ul className="divide-y divide-line">{rows.map(row => { const state = row.usedAt ? "已使用" : row.revokedAt ? "已撤销" : Date.parse(row.expiresAt) <= Date.now() ? "已过期" : "可使用"; return <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"><div><p>{row.email || "未限定邮箱"} · {state}</p><p className="mt-1 text-xs text-muted">{new Date(row.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 到期（UTC+8）</p></div>{state === "可使用" && <Button variant="outline" disabled={busy} onClick={() => action({ action: "revoke", id: row.id })}>撤销</Button>}</li>; })}</ul></CardContent></Card></div>;
}
