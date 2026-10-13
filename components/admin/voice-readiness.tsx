"use client";
import { useEffect, useRef, useState } from "react";
import { Button, LinkButton } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { api } from "@/lib/client/api";
import { PRIVATE_SESSION_EVENT } from "@/lib/client/private-session";
import type { VoiceStatus } from "@/lib/voice/status";

export function VoiceReadiness() {
  const [status, setStatus] = useState<VoiceStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [ended, setEnded] = useState(false);
  const current = useRef<AbortController | null>(null), revision = useRef(0);
  useEffect(() => { const stop = () => { revision.current++; current.current?.abort(); current.current = null; setBusy(false); setStatus(null); setError(""); setEnded(true); }; window.addEventListener(PRIVATE_SESSION_EVENT, stop); return () => { revision.current++; current.current?.abort(); window.removeEventListener(PRIVATE_SESSION_EVENT, stop); }; }, []);
  async function check() {
    if (current.current || ended) return;
    const request = ++revision.current, controller = new AbortController(); current.current = controller; setBusy(true); setError(""); setStatus(null);
    try { const result = await api<VoiceStatus>("/api/admin/voice-status", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }); if (revision.current === request) setStatus(result); }
    catch { if (revision.current === request) setError("检查未完成，请检查连接后重试。当前未确认模型可用。"); }
    finally { if (revision.current === request) { current.current = null; setBusy(false); } }
  }
  return <section aria-label="语音模型检查" data-testid="voice-readiness" className="space-y-3 border-t border-line pt-3">
    <p className="font-medium">本机语音模型</p><p className="text-xs text-muted">检查模型文件，不下载、不生成音频，也不消耗 API 额度。模型文件通过不代表麦克风、语音引擎或播放已经通过。</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || ended} onClick={() => void check()}>{busy ? "正在检查模型…" : "检查语音模型"}</Button><LinkButton size="sm" variant="ghost" href="/device-check">去试听考官</LinkButton></div>
    {busy && <p role="status">正在校验本机模型，请稍候…</p>}
    {error && <Alert tone="warning">{error}</Alert>}
    {status && <Alert tone={status.state === "ready" ? "success" : status.state === "not_required" ? "info" : "warning"} title={status.state === "ready" ? "模型文件已校验" : status.state === "not_required" ? "当前无需本机模型" : status.state === "unprepared" ? "自然语音尚未准备好" : "模型检查未完成"}>
      <p>{status.message}</p><p className="mt-2 text-xs">{status.voiceLabel} · {new Date(status.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>
      {status.totalFiles > 0 && <p className="text-xs">已校验 {status.checkedFiles} / {status.totalFiles} 个文件{status.problemFile ? ` · 待检查：${status.problemFile}` : ""}</p>}
      {(status.state === "unprepared" || status.state === "unavailable") && <div className="mt-2 space-y-2 text-sm"><p>部署者在项目目录运行 <code>npm run setup:voice</code>，按终端进度完成准备；成功后重启网页和 worker，再检查并试听。Docker 部署使用下方说明中的容器命令。</p><p><a className="underline" href="https://github.com/AncleStar/speak-ielts/blob/main/docs/%E8%87%AA%E7%84%B6%E8%80%83%E5%AE%98%E8%AF%AD%E9%9F%B3.md" target="_blank" rel="noreferrer">自然语音准备与恢复说明</a></p></div>}
    </Alert>}
  </section>;
}
