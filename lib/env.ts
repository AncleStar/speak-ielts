import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { AppError } from "@/lib/errors";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL 未配置"),
  BETTER_AUTH_SECRET: z.string().optional().default(""),
  BETTER_AUTH_URL: z.string().optional().default("http://localhost:3000"),
  USER_API_KEY_SECRET: z.string().optional().default(""),
  ADMIN_EMAIL: z.string().optional().default(""),
  ADMIN_INITIAL_PASSWORD: z.string().optional().default(""),

  AI_PROVIDER: z.enum(["mock", "dashscope"]).optional().default("mock"),
  TTS_PROVIDER: z.enum(["auto", "kokoro", "mock", "dashscope"]).optional().default("auto"),
  LOCAL_TTS_VOICE: z.enum(["bf_emma", "bf_isabella", "bm_george", "af_heart"]).optional().default("bf_emma"),
  LOCAL_TTS_SPEED: z.coerce.number().min(0.8).max(1.2).optional().default(0.95),
  DASHSCOPE_API_KEY: z.string().optional().default(""),
  DASHSCOPE_BASE_URL: z.string().optional().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  DASHSCOPE_NATIVE_BASE_URL: z.string().optional().default(""),
  ASR_MODEL: z.string().optional().default("qwen3-asr-flash-2026-02-10"),
  TTS_MODEL: z.string().optional().default("qwen3-tts-flash-2025-11-27"),
  TTS_VOICE: z.string().optional().default("Jennifer"),
  LLM_MODEL: z.string().optional().default("qwen-plus"),
  OMNI_MODEL: z.string().optional().default("qwen3.8-omni-flash"),
  ENABLE_AUDIO_DIAGNOSIS: bool(false),

  STORAGE_DRIVER: z.enum(["local", "oss"]).optional().default("local"),
  LOCAL_STORAGE_DIR: z.string().optional().default("./data/storage"),
  DATA_DIR: z.string().optional().default("./data"),
  OSS_REGION: z.string().optional().default(""),
  OSS_BUCKET: z.string().optional().default(""),
  OSS_ACCESS_KEY_ID: z.string().optional().default(""),
  OSS_ACCESS_KEY_SECRET: z.string().optional().default(""),
  OSS_ENDPOINT: z.string().optional().default(""),

  CONTENT_REQUIRE_REVIEW: bool(false),
  SEED_PUBLISH_DRAFTS: bool(false),

  TIME_SCALE: z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined || v === "" ? 1 : Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 1) return 1;
      return n;
    }),

  FFMPEG_PATH: z.string().optional().default("ffmpeg"),
  ESPEAK_PATH: z.string().optional().default("espeak-ng"),
  APP_DOMAIN: z.string().optional().default("localhost"),
  LOCAL_APP_INSTANCE: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** 读取并校验环境变量（惰性，首次调用时解析）。 */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`环境变量配置错误：${msg}`);
    }
    cached = parsed.data;
  }
  if (process.env.RESTORE_FINALIZE !== "true" && fs.existsSync(path.resolve(cached.DATA_DIR, "restore-pending.json")))
    throw new AppError(503, "restore_incomplete", "数据恢复尚未完成，服务暂不可用，请联系部署者检查恢复结果。");
  return cached;
}

/** 测试用：清除缓存以便重新读取 process.env。 */
export function resetEnvCache() {
  cached = null;
}

export function isMockProvider() {
  return env().AI_PROVIDER === "mock";
}

export function timeScale() {
  return env().TIME_SCALE;
}

export function dataDir() {
  return path.resolve(env().DATA_DIR);
}

export function authSecret() {
  const s = env().BETTER_AUTH_SECRET;
  if (s.length >= 32) return s;
  if (env().NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET 至少需要 32 位随机字符");
  }
  return "dev-only-insecure-secret-please-change-0000000000";
}
