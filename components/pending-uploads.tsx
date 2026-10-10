"use client";

import { useEffect, useRef, useState } from "react";
import { LinkButton, Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { getBlob, listRecordings, localIdentity, purgeExpired, recordingRecoveryState, recoverRecording, type RecordingMeta, type RecordingRecoveryState } from "@/lib/client/idb";
import { PRIVATE_SESSION_EVENT, RECORDING_CONSENT_EVENT } from "@/lib/client/private-session";
import { uploadQueue } from "@/lib/client/uploader";
import { requestUploadDiscard } from "@/lib/client/upload-discard";

type Item = RecordingMeta & { recovery: RecordingRecoveryState };
/** Only the current login's durable, stopped fragments can be recovered or discarded. */
export function PendingUploads({ userId, sessionId, onChange, onUploaded, onBusyChange, disabled = false }: { userId: string; sessionId?: string; onChange?: (items: RecordingMeta[]) => void; onUploaded?: () => Promise<void>; onBusyChange?: (busy: boolean) => void; disabled?: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null), [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const uploaded = useRef(onUploaded); uploaded.current = onUploaded;
  const busyChange = useRef(onBusyChange); busyChange.current = onBusyChange;
  const revision = useRef(0), blocked = useRef(false), previewUrl = useRef(""), previewId = useRef<string | null>(null);
  function clearPreview() { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = ""; previewId.current = null; setPreview(null); }
  async function refresh() {
    const request = ++revision.current, scope = localIdentity();
    if (blocked.current || scope?.userId !== userId || !scope.consentAllowed) return;
    await purgeExpired();
    const all = await listRecordings(sessionId), visible: Item[] = [];
    for (const meta of all) visible.push({ ...meta, recovery: await recordingRecoveryState(meta) });
    const current = localIdentity();
    if (blocked.current || request !== revision.current || current?.epoch !== scope.epoch || current.userId !== userId || current.consentVersion !== scope.consentVersion || !current.consentAllowed) return;
    setItems(visible); change.current?.(all);
    if (previewId.current && !all.some(meta => meta.id === previewId.current)) clearPreview();
  }
  useEffect(() => {
    blocked.current = false;
    const load = () => { void refresh().catch(() => {}); };
    const stop = () => { blocked.current = true; revision.current++; clearPreview(); setItems([]); setMsg(null); change.current?.([]); };
    const unsubscribe = uploadQueue.subscribe(load), timer = setInterval(load, 5000);
    load(); window.addEventListener("online", load); window.addEventListener("focus", load);
    window.addEventListener(PRIVATE_SESSION_EVENT, stop); window.addEventListener(RECORDING_CONSENT_EVENT, stop);
    return () => { blocked.current = true; revision.current++; unsubscribe(); clearInterval(timer); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = "";
      window.removeEventListener("online", load); window.removeEventListener("focus", load); window.removeEventListener(PRIVATE_SESSION_EVENT, stop); window.removeEventListener(RECORDING_CONSENT_EVENT, stop); };
  }, [userId, sessionId]);

  async function act(meta: Item, work: () => Promise<string>) {
    const scope = localIdentity(); if (busy || disabled || !scope?.consentAllowed || scope.userId !== userId) return;
    setBusy(meta.id); busyChange.current?.(true); setMsg(null);
    try { const text = await work(); if (!blocked.current && localIdentity()?.epoch === scope.epoch) setMsg(text); }
    catch (error) { if (!blocked.current && localIdentity()?.epoch === scope.epoch) setMsg(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally { setBusy(null); busyChange.current?.(false); await refresh(); }
  }
  async function playLocal(meta: RecordingMeta) {
    const scope = localIdentity(), blob = await getBlob(meta.id, meta.mimeType);
    if (blocked.current || localIdentity()?.epoch !== scope?.epoch || !localIdentity()?.consentAllowed) return;
    if (!blob?.size) throw new Error("没有已写入的录音分片，可以丢弃后重新回答。");
    clearPreview(); previewUrl.current = URL.createObjectURL(blob); previewId.current = meta.id; setPreview({ id: meta.id, url: previewUrl.current });
  }
  if (!items.length) return msg ? <Alert tone="info">{msg}</Alert> : null;
  return <Alert tone="warning" title={`本机有 ${items.length} 段未上传的录音（保留 24 小时）`}>
    <p>中断片段可恢复、回放和补传；完整回答需重新录制。关闭前未写入的最后片段无法恢复。</p>
    <ul className="mt-3 space-y-3">
      {items.map(meta => {
        const stopped = meta.recovery === "ready" || meta.recovery === "recoverable", waiting = !!busy || disabled || uploadQueue.isPending(meta.id);
        return <li key={meta.id} data-testid={`local-recording-${meta.id}`} className="min-w-0 space-y-2 border-t border-current/15 pt-2">
          <p className="break-words">第 {meta.planIndex + 1} 题 · {Math.round(meta.durationMs / 1000)} 秒 · {meta.promptText.slice(0, 80)}</p>
          {meta.recovery === "live" && <p>另一页面正在录音或保存，此处不能恢复或丢弃。</p>}
          {meta.recovery === "unverified" && <p>无法确认录音占用：旧片段或当前浏览器没有占用锁。请保留数据并关闭旧页面；这类片段暂不支持安全接管。</p>}
          {meta.interrupted && meta.recovery === "ready" && <p>已恢复为中断片段，不计为完整作答。</p>}
          {meta.lastError && <p className="break-words">{meta.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            {meta.status === "recording" ? <Button size="sm" variant="secondary" disabled={waiting || !stopped} onClick={() => void act(meta, async () => { const result = await recoverRecording(meta.id); await playLocal(result.meta); return "已恢复本机现有片段。可以回放后重试上传；也可以丢弃，再重新回答。"; })}>恢复中断片段</Button>
              : <><Button size="sm" variant="secondary" disabled={waiting} onClick={() => void act(meta, async () => { await uploadQueue.enqueue(meta); clearPreview(); await uploaded.current?.(); return "上传成功，反馈将在后台生成。"; })}>{uploadQueue.isPending(meta.id) ? "正在上传…" : "重试上传"}</Button>
                <Button size="sm" variant="outline" disabled={waiting} onClick={() => void act(meta, async () => { await playLocal(meta); return "正在回放本机保留片段。"; })}>回放片段</Button></>}
            <Button size="sm" variant="ghost" disabled={waiting || !stopped} onClick={() => { if (confirm("丢弃这段本机录音？丢弃后无法恢复。")) void act(meta, async () => {
              const result = await requestUploadDiscard(meta, clearPreview);
              if (!result.receipt) return result.persistent ? "本机片段已丢弃，取消任务已保留。上传暂记尚未确认释放，联网后自动同步。" : "本机片段已丢弃，服务器暂记尚未确认释放。浏览器无法持久保存取消任务，请保持此页并联网；未上传满 24 小时后自动释放。";
              await uploaded.current?.();
              return result.receipt.alreadyStored ? "本机片段已丢弃；服务器已保存的记录与已消费时长仍保留。" : `本机片段已丢弃，上传暂记已撤销。${result.receipt.wholePlanActive ? "进行中的整盘预留需退出练习后释放。" : "可回到原练习重新回答。"}`;
            }); }}>丢弃片段</Button>
            {!sessionId && <LinkButton href={`/interview/${meta.sessionId}`} size="sm" variant="outline">回到原练习</LinkButton>}
          </div>
          {preview?.id === meta.id && <audio src={preview.url} controls preload="metadata" aria-label="本机中断录音回放" className="block w-full min-w-0 max-w-full" />}
          {uploadQueue.isPending(meta.id) && <p role="status">{uploadQueue.stage(meta.id)}</p>}
        </li>;
      })}
    </ul>
    {msg && !items.some(meta => meta.lastError === msg) && <p role="status" className="mt-3 break-words">{msg}</p>}
  </Alert>;
}
