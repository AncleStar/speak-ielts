"use client";

import { LocalConsentEnded, LocalSessionEnded, putChunk, recordingPermitted, saveMeta, updateMeta, type RecordingMeta } from "./idb";
import { PRIVATE_SESSION_EVENT, RECORDING_CONSENT_EVENT } from "./private-session";
import { holdRecording } from "./recording-owner";

export type MicErrorKind = "permission" | "no_device" | "busy" | "insecure" | "unsupported" | "unknown";

export class MicError extends Error {
  constructor(public kind: MicErrorKind, message: string) {
    super(message);
  }
}

export const MIC_ERROR_TEXT: Record<MicErrorKind, string> = {
  permission: "麦克风权限被拒绝。请在浏览器地址栏左侧的站点设置中允许使用麦克风，然后重新检测。",
  no_device: "没有找到可用的麦克风，请连接麦克风或耳机后重新检测。",
  busy: "麦克风正被其他应用占用，请关闭占用麦克风的应用后重试。",
  insecure: "当前页面不是安全连接（HTTPS），浏览器不允许使用麦克风。请通过 HTTPS 或 localhost 访问。",
  unsupported: "当前浏览器不支持网页录音，请使用最新版 Chrome、Edge 或 Safari。",
  unknown: "无法启动麦克风，请重试或更换浏览器。",
};

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/** 通过 MediaRecorder.isTypeSupported() 选择浏览器支持的录音格式 */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function mapMicError(e: unknown): MicError {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new MicError("permission", MIC_ERROR_TEXT.permission);
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return new MicError("no_device", MIC_ERROR_TEXT.no_device);
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return new MicError("busy", MIC_ERROR_TEXT.busy);
  return new MicError("unknown", MIC_ERROR_TEXT.unknown);
}

export interface StopResult {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  interrupted: boolean;
  meta: RecordingMeta;
}

export const DEVICE_KEY = "ielts.micDeviceId";

export function savedDeviceId(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 麦克风录音器：整个面试期间复用同一个音频流。
 * 录音参数请求单声道，并开启回声消除、降噪和自动增益。
 */
export class MicRecorder {
  stream: MediaStream | null = null;
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private seq = 0;
  private pendingWrites: Promise<unknown> = Promise.resolve();
  private startAt = 0;
  private meta: RecordingMeta | null = null;
  private stopResolve: ((r: StopResult) => void) | null = null;
  private stopped: Promise<StopResult> | null = null;
  private interrupted = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  onInterrupted: ((reason: "track_ended" | "recorder_error") => void) | null = null;
  private lifecycle = 0;
  private detach: (() => void) | null = null;

  get recording() {
    return this.mr?.state === "recording";
  }
  interrupt() {
    if (!this.recording) return;
    this.interrupted = true;
    try { this.mr?.stop(); } catch { /* final chunks may already be flushing */ }
    this.onInterrupted?.("track_ended");
  }
  get mimeType() {
    return this.mr?.mimeType || pickMimeType() || "audio/webm";
  }

  async init(deviceId?: string): Promise<void> {
    if (!recordingPermitted()) throw new LocalConsentEnded();
    if (typeof window !== "undefined" && !window.isSecureContext) throw new MicError("insecure", MIC_ERROR_TEXT.insecure);
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError("unsupported", MIC_ERROR_TEXT.unsupported);
    if (typeof MediaRecorder === "undefined") throw new MicError("unsupported", MIC_ERROR_TEXT.unsupported);
    this.release();
    const lifecycle = this.lifecycle;
    const ended = () => this.release({ discard: true });
    window.addEventListener(PRIVATE_SESSION_EVENT, ended); window.addEventListener(RECORDING_CONSENT_EVENT, ended);
    this.detach = () => { window.removeEventListener(PRIVATE_SESSION_EVENT, ended); window.removeEventListener(RECORDING_CONSENT_EVENT, ended); };
    const constraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      if (lifecycle !== this.lifecycle || !recordingPermitted()) { stream.getTracks().forEach(t => t.stop()); throw new LocalConsentEnded(); }
      this.stream = stream;
    } catch (e) {
      if (deviceId && (e as { name?: string }).name === "OverconstrainedError") {
        // 之前选择的设备已不存在，退回默认设备
        return this.init(undefined);
      }
      if (e instanceof LocalSessionEnded) throw e;
      throw mapMicError(e);
    }
    const track = this.stream.getAudioTracks()[0];
    const interrupt = () => {
      if (this.recording) {
        this.interrupted = true;
        try {
          this.mr?.stop();
        } catch {
          /* ignore */
        }
      }
      this.onInterrupted?.("track_ended");
    };
    // 设备失效（拔出、权限被收回、来电占用）
    track.addEventListener("ended", interrupt);
    // 锁屏或切到后台时部分浏览器会将轨道静音；持续 3 秒视为中断
    track.addEventListener("mute", () => {
      if (this.muteTimer) clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => {
        if (track.muted && this.recording) interrupt();
      }, 3000);
    });
    track.addEventListener("unmute", () => {
      if (this.muteTimer) clearTimeout(this.muteTimer);
      this.muteTimer = null;
    });
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.levelBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    } catch {
      this.analyser = null;
    }
  }

  get trackLive() {
    return this.stream?.getAudioTracks()[0]?.readyState === "live";
  }

  async resumeContext() {
    try {
      await this.ctx?.resume();
    } catch {
      /* ignore */
    }
  }

  /** 当前音量（0–1，RMS） */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 3);
  }

  /** 开始录音；返回录音实际开始的时刻（本机时间） */
  async start(meta: Omit<RecordingMeta, "mimeType" | "durationMs" | "createdAt" | "status" | "interrupted">): Promise<number> {
    const lifecycle = this.lifecycle;
    if (!this.stream || !this.trackLive) return Promise.reject(new MicError("no_device", "麦克风已断开，请返回设备检查"));
    const mimeType = pickMimeType();
    const mr = mimeType ? new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 64000 }) : new MediaRecorder(this.stream);
    this.mr = mr;
    this.chunks = [];
    this.seq = 0;
    this.interrupted = false;
    const ownership = await holdRecording(meta.id);
    this.meta = { ...meta, recordingGuard: ownership.guard, mimeType: mr.mimeType || mimeType || "audio/webm", durationMs: 0, createdAt: Date.now(), status: "recording", interrupted: false };
    this.pendingWrites = saveMeta(this.meta);
    try { await this.pendingWrites; if (this.lifecycle !== lifecycle || !recordingPermitted()) throw new LocalConsentEnded(); } catch (error) { ownership.release(); throw error; }
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
        if (this.meta) {
          const id = this.meta.id; const seq = this.seq++;
          const elapsed = Math.max(0, Date.now() - this.startAt);
          this.pendingWrites = this.pendingWrites.then(async () => { await putChunk(id, seq, ev.data); await updateMeta(id, { durationMs: elapsed }); });
          void this.pendingWrites.catch(() => {}); // handled on stop; logout can invalidate a pending write
        }
      }
    };
    mr.onerror = () => {
      this.interrupted = true;
      this.onInterrupted?.("recorder_error");
    };
    this.stopped = new Promise<StopResult>((resolve) => {
      this.stopResolve = resolve;
    });
    mr.onstop = async () => {
      const durationMs = Math.max(0, Date.now() - this.startAt);
      const type = mr.mimeType || this.meta?.mimeType || "audio/webm";
      const blob = new Blob(this.chunks, { type });
      const meta: RecordingMeta = { ...this.meta!, mimeType: type, durationMs, status: "pending", interrupted: this.interrupted };
      try { await this.pendingWrites; await updateMeta(meta.id, { durationMs, status: "pending", interrupted: this.interrupted, mimeType: type }); }
      catch (error) { this.interrupted = true; meta.interrupted = true; if (!(error instanceof LocalSessionEnded)) this.onInterrupted?.("recorder_error"); }
      finally { ownership.release(); }
      // 无论由谁触发停止（用户、计时、设备失效），结果都通过同一个 Promise 返回
      this.stopResolve?.({ blob, durationMs, mimeType: type, interrupted: this.interrupted, meta });
      this.stopResolve = null;
    };
    return new Promise((resolve, reject) => {
      mr.onstart = () => {
        this.startAt = Date.now();
        resolve(this.startAt);
      };
      try {
        mr.start(1000);
      } catch (e) {
        ownership.release();
        reject(mapMicError(e));
      }
    });
  }

  stop(opts: { interrupted?: boolean } = {}): Promise<StopResult | null> {
    if (!this.mr || !this.stopped) return Promise.resolve(null);
    if (opts.interrupted) this.interrupted = true;
    const p = this.stopped;
    if (this.mr.state !== "inactive") {
      try {
        this.mr.stop();
      } catch {
        return Promise.resolve(null);
      }
    }
    // Natural completion and the exit control may stop the same recording.
    // Both callers must await the final persisted chunk before releasing the mic.
    return p.finally(() => { if (this.stopped === p) this.stopped = null; });
  }

  release(options: { discard?: boolean } = {}) {
    this.lifecycle++; this.detach?.(); this.detach = null;
    if (options.discard) { this.chunks = []; this.interrupted = true; if (this.mr) this.mr.ondataavailable = null; }
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    try {
      if (this.mr && this.mr.state !== "inactive") this.mr.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
}
