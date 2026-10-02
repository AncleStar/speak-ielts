"use client";

/**
 * 考官音频播放：
 * - 复用单一 <audio> 元素（iOS Safari 需要在用户手势中"解锁"一次）；
 * - 开始前预加载所有固定问题与过渡语（转为本地 blob，播放时不依赖网络）；
 * - 播放失败自动重试 1 次，再失败返回 "failed"，由界面显示题目文字并允许继续。
 */

function silentWavUrl(): string {
  const sampleRate = 8000;
  const n = 800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export type PlayResult = "played" | "failed" | "stopped";

export class ExaminerAudio {
  private el: HTMLAudioElement | null = null;
  private cache = new Map<string, string>();
  private failedIds = new Set<string>();
  private stopFn: (() => void) | null = null;
  private controller = new AbortController();
  unlocked = false;

  private audio(): HTMLAudioElement {
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = "auto";
      this.el.setAttribute("playsinline", "true");
    }
    return this.el;
  }

  /** 必须在用户点击事件中调用 */
  async unlock() {
    const a = this.audio();
    try {
      a.src = silentWavUrl();
      await a.play();
      a.pause();
      this.unlocked = true;
    } catch {
      this.unlocked = false;
    }
  }

  async preload(ids: string[], onProgress?: (done: number, total: number) => void) {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const signal = this.controller.signal;
    const unique = [...new Set(ids.filter(Boolean))];
    let done = 0;
    const worker = async (id: string) => {
      if (!this.cache.has(id)) {
        for (let attempt = 0; attempt < 2 && !this.cache.has(id); attempt++) {
          try {
            if (signal.aborted) break;
            const res = await fetch(`/api/tts/${id}`, { credentials: "same-origin", cache: "no-cache", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
            if (!res.ok) throw new Error(String(res.status));
            const blob = await res.blob();
            if (!blob.size || signal.aborted) throw new Error("empty audio");
            this.cache.set(id, URL.createObjectURL(blob));
            this.failedIds.delete(id);
          } catch {
            this.failedIds.add(id);
          }
        }
      }
      done++;
      onProgress?.(done, unique.length);
    };
    const queue = [...unique];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !signal.aborted) await worker(queue.shift()!);
      }),
    );
    return { failed: unique.filter((id) => !this.cache.has(id)) };
  }

  isReady(id: string | null | undefined) {
    return !!id && this.cache.has(id);
  }

  private playOnce(url: string): Promise<PlayResult> {
    const a = this.audio();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: PlayResult) => {
        if (settled) return;
        settled = true;
        a.onended = null;
        a.onerror = null;
        this.stopFn = null;
        resolve(r);
      };
      this.stopFn = () => {
        a.pause();
        finish("stopped");
      };
      a.onended = () => finish("played");
      a.onerror = () => finish("failed");
      a.src = url;
      a.currentTime = 0;
      a.play().catch(() => finish("failed"));
    });
  }

  /** 播放一条考官音频；失败自动重试 1 次 */
  async play(ttsId: string | null | undefined): Promise<PlayResult> {
    if (!ttsId) return "failed";
    if (!this.cache.has(ttsId)) await this.preload([ttsId]);
    const url = this.cache.get(ttsId);
    if (!url) return "failed";
    const first = await this.playOnce(url);
    if (first !== "failed") return first;
    return this.playOnce(url);
  }

  stop() {
    this.stopFn?.();
  }

  dispose() {
    this.controller.abort();
    this.stop();
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
  }
}
