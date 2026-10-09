"use client";
import { useState } from "react";
import { signOutPrivateSession } from "@/lib/client/private-session";
import { listRecordings, listThoughtDrafts } from "@/lib/client/idb";
import { Button } from "@/components/ui/button";
export function SignOutButton() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form action={async () => {
    const [recordings, drafts] = await Promise.all([listRecordings(), listThoughtDrafts()]);
    if ((recordings.length || drafts.length) && !confirm("退出会清除本机未上传的录音和未保存草稿。确定退出登录吗？")) return;
    setBusy(true); setError("");
    try { await signOutPrivateSession(); }
    catch { setError("退出未完成，请重试；若浏览器拒绝清理资料，请清除本站数据。"); setBusy(false); }
  }}><Button type="submit" variant="ghost" disabled={busy}>{busy ? "正在退出…" : "退出登录"}</Button>{error && <p role="alert">{error}</p>}</form>;
}
