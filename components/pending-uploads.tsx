"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { deleteRecording, getBlob, listRecordings, purgeExpired, type RecordingMeta } from "@/lib/client/idb";
import { uploadQueue } from "@/lib/client/uploader";

/** 本机未上传成功的录音（最多保留 24 小时）：提供“重试上传 / 删除” */
export function PendingUploads({ userId }: { userId: string }) {
  const [items, setItems] = useState<RecordingMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [, setVersion] = useState(0);

  async function refresh() {
    await purgeExpired();
    const all = await listRecordings();
    const visible: RecordingMeta[] = [];
    for (const m of all) {
      if (m.userId && m.userId !== userId) continue;
      // Legacy recordings have no owner metadata: verify ownership without exposing the prompt.
      if (!m.userId) { try { if (!(await fetch(`/api/sessions/${encodeURIComponent(m.sessionId)}`)).ok) continue; } catch { continue; } }
      if (m.status !== "recording" || Date.now() - m.createdAt > 10 * 60_000) visible.push(m.status === "recording" ? { ...m, interrupted: true } : m);
    }
    setItems(visible);
  }

  useEffect(() => {
    void refresh();
    const unsubscribe = uploadQueue.subscribe(() => { setVersion(v => v + 1); void refresh(); });
    const online = () => { setMsg("网络已恢复，可以重试上传。"); void refresh(); };
    window.addEventListener("online", online);
    return () => { unsubscribe(); window.removeEventListener("online", online); };
  }, [userId]);

  if (!items.length) return null;

  return (
    <Alert tone="warning" title={`本机有 ${items.length} 段未上传的录音（保留 24 小时）`}>
      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              “{m.promptText.slice(0, 40)}” · {Math.round(m.durationMs / 1000)} 秒{m.lastError ? ` · ${m.lastError}` : ""}
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!!busy || uploadQueue.isPending(m.id)}
                onClick={async () => {
                  setBusy(m.id);
                  setMsg(null);
                  try {
                    const blob = await getBlob(m.id, m.mimeType);
                    await uploadQueue.enqueue(m, blob ?? undefined);
                    setMsg("上传成功，反馈将在后台生成。");
                  } catch (e) {
                    setMsg(`上传失败：${(e as Error).message}`);
                  }
                  setBusy(null);
                  await refresh();
                }}
              >
                {busy === m.id || uploadQueue.isPending(m.id) ? "正在上传…" : "重试上传"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === m.id || uploadQueue.isPending(m.id)}
                onClick={async () => {
                  if (!confirm("删除这段本地录音？删除后无法恢复。")) return;
                  await deleteRecording(m.id);
                  await refresh();
                }}
              >
                删除
              </Button>
            </span>
            {uploadQueue.isPending(m.id) && <p role="status" className="w-full text-xs">{uploadQueue.stage(m.id)}</p>}
          </li>
        ))}
      </ul>
      {msg ? <p className="mt-2">{msg}</p> : null}
    </Alert>
  );
}
