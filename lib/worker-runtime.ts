import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { Env } from "@/lib/env";
import { NATURAL_MODEL_TAG } from "@/lib/providers/natural-voice-cache";

function readBuildId() {
  try {
    const file = path.resolve(/* turbopackIgnore: true */ ".next", "BUILD_ID"), stat = fs.lstatSync(/* turbopackIgnore: true */ file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return "unbuilt";
    const id = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8").trim();
    return /^[\w-]{1,128}$/.test(id) ? id : "unbuilt";
  } catch { return "unbuilt"; }
}
// Capture once: a running old worker must not adopt a newly replaced build marker.
export const capturedWorkerBuildId = readBuildId();
const directory = (value: string) => { const absolute = path.resolve(/* turbopackIgnore: true */ value); return process.platform === "win32" ? absolute.toLowerCase() : absolute; };

/** Opaque compatibility token only. Never persist the configuration or secrets used to compute it. */
export function runtimeConfigId(e: Env, buildId = capturedWorkerBuildId) {
  const cloudVoice = e.TTS_PROVIDER === "dashscope" || e.TTS_PROVIDER === "auto" && e.AI_PROVIDER === "dashscope";
  const localVoice = e.TTS_PROVIDER === "kokoro";
  const usesCloud = e.AI_PROVIDER === "dashscope" || cloudVoice;
  const config = [
    "worker-compatibility-v2", buildId, e.LOCAL_APP_INSTANCE,
    e.AI_PROVIDER, e.ASR_MODEL, e.LLM_MODEL, e.ENABLE_AUDIO_DIAGNOSIS, e.OMNI_MODEL, e.TIME_SCALE,
    e.TTS_PROVIDER, localVoice ? [NATURAL_MODEL_TAG, e.LOCAL_TTS_VOICE, e.LOCAL_TTS_SPEED, e.ESPEAK_PATH] : cloudVoice ? [e.TTS_MODEL, e.TTS_VOICE] : "mock",
    usesCloud ? [e.DASHSCOPE_BASE_URL, e.DASHSCOPE_NATIVE_BASE_URL, e.DASHSCOPE_API_KEY] : null,
    e.USER_API_KEY_SECRET || e.BETTER_AUTH_SECRET,
    e.STORAGE_DRIVER, directory(e.DATA_DIR), e.FFMPEG_PATH,
    e.STORAGE_DRIVER === "local" ? directory(e.LOCAL_STORAGE_DIR) : [e.OSS_REGION, e.OSS_BUCKET, e.OSS_ENDPOINT, e.OSS_ACCESS_KEY_ID, e.OSS_ACCESS_KEY_SECRET],
  ];
  return "v2_" + createHmac("sha256", e.BETTER_AUTH_SECRET).update(JSON.stringify(config)).digest("hex").slice(0, 32);
}

export const WORKER_STALE_MS = 60000, WORKER_FUTURE_TOLERANCE_MS = 5000;
export type WorkerState = "ready" | "missing" | "stale" | "mismatch" | "mixed" | "clock" | "task_mismatch";
export function evaluateWorkerHealth(rows: { value: unknown; at: Date }[], configId: string, now = new Date()) {
  const time = now.getTime(), future = rows.filter(r => r.at.getTime() > time + WORKER_FUTURE_TOLERANCE_MS);
  const fresh = rows.filter(r => Number.isFinite(r.at.getTime()) && r.at.getTime() <= time + WORKER_FUTURE_TOLERANCE_MS && time - r.at.getTime() < WORKER_STALE_MS);
  const same = (r: { value: unknown }) => !!r.value && typeof r.value === "object" && "configId" in r.value && r.value.configId === configId;
  const matching = fresh.filter(same).sort((a, b) => b.at.getTime() - a.at.getTime()), different = fresh.filter(r => !same(r));
  const state: WorkerState = future.length ? "clock" : matching.length ? different.length ? "mixed" : "ready" : different.length ? "mismatch" : rows.length ? "stale" : "missing";
  return { ready: state === "ready", state, lastHeartbeat: matching[0]?.at ?? null, compatibleHeartbeats: matching.length, incompatibleHeartbeats: different.length, futureHeartbeats: future.length };
}
export function workerStateMessage(state: WorkerState) {
  return ({ task_mismatch: "任务执行环境与当前配置不匹配，请暂停新会话并核对部署；已有录音和费用记录保留", ready: "后台心跳与当前配置匹配", missing: "未收到后台心跳，请启动 worker", stale: "后台心跳已过期，请检查或重启 worker", mismatch: "近期后台心跳与网页配置或可见构建不匹配，请统一配置并重启网页和全部 worker", mixed: "近期心跳同时包含匹配与不匹配的后台，请停止旧后台并统一重启；旧心跳停止后最多等待 60 秒", clock: "后台心跳时间异常，请核对网页、数据库和后台的系统时钟" })[state];
}
