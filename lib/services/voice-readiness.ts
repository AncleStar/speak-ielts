import path from "node:path";
import { dataDir } from "@/lib/env";
import { providers } from "@/lib/providers";
import { ensureNaturalVoiceCache, NATURAL_FILES, VoiceCacheError } from "@/lib/providers/natural-voice-cache";
import type { VoiceStatus } from "@/lib/voice/status";

/** Read-only check of pinned model files. No inference, download, queue or paid service is dispatched. */
export async function checkVoiceReadiness(): Promise<VoiceStatus> {
  const p = providers(), identity = p.ttsIdentity(), base = { provider: p.ttsKind, voiceLabel: identity.label ?? identity.voice, checkedAt: new Date().toISOString(), checkedFiles: 0, totalFiles: p.ttsKind === "local" ? NATURAL_FILES.length : 0 };
  if (p.ttsKind !== "local") return { ...base, state: "not_required", message: p.ttsKind === "mock" ? "当前使用模拟语音，本机模型检查不适用。模拟声音不能用于评价考官听感。" : "当前使用云端语音，本机模型检查不适用；本次不会调用云服务或检查账户余额。" };
  let problemFile: string | undefined;
  try {
    await ensureNaturalVoiceCache(path.join(dataDir(), "models"), { timeoutMs: 10000, onProgress: event => { problemFile = event.file; if (event.stage === "cached") base.checkedFiles++; } });
    return { ...base, checkedAt: new Date().toISOString(), state: "ready", message: "本机模型文件已通过大小与完整性校验。语音引擎加载和播放仍需在设备检查页试听确认。" };
  } catch (error) {
    const state = error instanceof VoiceCacheError && error.code === "missing" ? "unprepared" : "unavailable";
    const message = state === "unprepared" ? "本机模型文件缺失或校验失败。请部署者先准备自然语音模型，再重新检查；重复生成题目音频不能修复模型文件。" : error instanceof VoiceCacheError && error.code === "timeout" ? "模型检查超过 10 秒，尚未确认可用。请检查磁盘状态，稍后重试。" : "模型文件无法完成检查，请检查缓存目录权限、文件占用及磁盘状态后重试。";
    return { ...base, checkedAt: new Date().toISOString(), state, message, problemFile };
  }
}
