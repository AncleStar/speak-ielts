"use client";

import { ApiError, api } from "./api";
import { deleteRecording, getBlob, localIdentity, LocalSessionEnded, updateMeta, type RecordingMeta } from "./idb";

export interface UploadResult {
  answerId: string;
  status: string;
}

type Listener = () => void;

function uploadBlob(url: string, blob: Blob, progress: (percent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url); xhr.timeout = 90000;
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    const abort = () => xhr.abort(); signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.onabort = () => reject(new LocalSessionEnded());
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onerror = () => reject(new ApiError(0, "network", "网络中断，录音仍保留在本机"));
    xhr.ontimeout = () => reject(new ApiError(408, "timeout", "上传超时，请恢复网络后重试"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let detail: { error?: { code?: string; message?: string } } = {};
      try { detail = JSON.parse(xhr.responseText); } catch { /* omit raw server output */ }
      if (xhr.status === 401) window.dispatchEvent(new Event("speak-auth-expired"));
      reject(new ApiError(xhr.status, detail.error?.code ?? "upload_failed", detail.error?.message ?? `上传失败（${xhr.status}）`));
    };
    if (signal.aborted) { signal.removeEventListener("abort", abort); reject(new LocalSessionEnded()); return; }
    xhr.send(blob);
  });
}

/**
 * 录音上传队列：申请上传凭证 → 上传录音 → 确认提交。
 * 同一录音使用相同的提交标识，重复上传不会产生重复记录或重复任务。
 * 失败自动重试（1s / 3s / 8s），仍失败则保留本地录音并显示"重试上传"。
 */
class UploadQueue {
  private pending = new Map<string, Promise<UploadResult>>();
  private failed = new Map<string, string>();
  private listeners = new Set<Listener>();
  private version = 0;
  private stages = new Map<string, string>();
  private controllers = new Map<string, AbortController>();
  cancelAll() { for (const controller of this.controllers.values()) controller.abort(); this.failed.clear(); this.stages.clear(); this.emit(); }
  stage(id: string) { return this.stages.get(id); }
  private setStage(id: string, text: string) { this.stages.set(id, text); this.emit(); }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get pendingCount() {
    return this.pending.size;
  }
  get failedEntries() {
    return [...this.failed.entries()];
  }

  isPending(id: string) {
    return this.pending.has(id);
  }

  enqueue(meta: RecordingMeta, blob?: Blob): Promise<UploadResult> {
    const scope = localIdentity();
    if (!scope || scope.consentAllowed !== true || meta.userId !== scope.userId || meta.localEpoch !== scope.epoch || meta.consentVersion !== scope.consentVersion) return Promise.reject(new LocalSessionEnded());
    const existing = this.pending.get(meta.id);
    if (existing) return existing;
    this.failed.delete(meta.id);
    const controller = new AbortController(); this.controllers.set(meta.id, controller);
    const p = this.run(meta, blob, controller.signal).finally(() => {
      this.pending.delete(meta.id);
      this.controllers.delete(meta.id);
      this.emit();
    });
    this.pending.set(meta.id, p);
    this.emit();
    return p;
  }

  private async run(meta: RecordingMeta, blobIn: Blob | undefined, signal: AbortSignal): Promise<UploadResult> {
    const delays = [1000, 3000, 8000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        if (signal.aborted) throw new LocalSessionEnded();
        if (!navigator.onLine) throw new ApiError(0, "offline", "当前离线，录音保留在本机；联网后可重试上传");
        const blob = blobIn ?? (await getBlob(meta.id, meta.mimeType));
        if (!blob || blob.size === 0) throw new ApiError(400, "no_local_audio", "本地录音不存在或为空");
        this.setStage(meta.id, attempt ? `第 ${attempt + 1} 次尝试 · 获取上传凭证` : "1/3 · 获取上传凭证");
        const t = await api<{ answerId: string; status: string; uploadUrl: string }>("/api/answers/upload-ticket", {
          signal,
          body: {
            sessionId: meta.sessionId,
            planIndex: meta.planIndex,
            kind: meta.kind,
            followUpId: meta.followUpId,
            submissionId: meta.id,
            clientDurationMs: Math.round(meta.durationMs),
            interrupted: meta.interrupted,
            consentVersion: meta.consentVersion,
          },
        });
        if (signal.aborted) throw new LocalSessionEnded();
        if (t.status === "created") {
          this.setStage(meta.id, "2/3 · 正在上传录音，请保持页面打开");
          await uploadBlob(t.uploadUrl, blob, percent => this.setStage(meta.id, `2/3 · 正在上传 ${percent}%${percent === 100 ? "，等待服务器确认" : ""}`), signal);
        }
        this.setStage(meta.id, "3/3 · 确认保存并排队生成反馈");
        const s = await api<{ status: string }>(`/api/answers/${t.answerId}/submit`, { method: "POST", signal });
        if (signal.aborted) throw new LocalSessionEnded();
        await deleteRecording(meta.id);
        return { answerId: t.answerId, status: s.status };
      } catch (e) {
        if (signal.aborted || e instanceof LocalSessionEnded) throw new LocalSessionEnded();
        lastErr = e;
        if (!navigator.onLine) break;
        // 4xx（除 408/429）为不可重试错误
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) break;
        if (attempt < delays.length) { this.setStage(meta.id, `连接暂时失败，${delays[attempt] / 1000} 秒后自动重试`); await new Promise<void>(resolve => { const end = () => { clearTimeout(timer); signal.removeEventListener("abort", end); resolve(); }; const timer = setTimeout(end, delays[attempt]); signal.addEventListener("abort", end, { once: true }); }); }
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : "上传失败";
    this.failed.set(meta.id, msg);
    await updateMeta(meta.id, { status: "failed", lastError: msg });
    throw lastErr instanceof Error ? lastErr : new Error(msg);
  }

  /** 等待所有进行中的上传结束（成功或失败） */
  async drain() {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending.values()]);
    }
  }
}

export const uploadQueue = new UploadQueue();
