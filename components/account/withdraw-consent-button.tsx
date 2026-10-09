"use client";
import { useState } from "react";
import { withdrawConsentAction } from "@/app/actions/account";
import { announceConsentWithdrawal, stopRecordingWork, syncRecordingConsent } from "@/lib/client/private-session";
import { Button } from "@/components/ui/button";
import { localIdentity } from "@/lib/client/idb";
export function WithdrawConsentButton() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form action={async () => {
    if (!confirm("撤回将停止本浏览器的录音与上传，并清除未上传录音。文字草稿和已保存记录保留；后续处理暂停。确定撤回吗？")) return;
    setBusy(true); setError("");
    const captured = localIdentity();
    try {
      const result = await withdrawConsentAction();
      if (captured?.userId !== result.userId || localIdentity()?.epoch !== captured.epoch) { window.location.assign("/settings"); return; }
      stopRecordingWork(); announceConsentWithdrawal();
      try { await syncRecordingConsent(result.userId, result); }
      catch { setError("授权已撤回，但浏览器未能清除本机录音。请在浏览器设置中清除本站数据；已保存记录仍保留。" ); setBusy(false); return; }
      announceConsentWithdrawal(); window.location.assign("/settings?consent=withdrawn");
    } catch { setError("暂时无法确认撤回结果，请检查连接后重试。" ); setBusy(false); }
  }}><Button type="submit" variant="outline" disabled={busy}>{busy ? "正在撤回…" : "撤回录音同意"}</Button>{error && <p role="alert">{error}</p>}</form>;
}
