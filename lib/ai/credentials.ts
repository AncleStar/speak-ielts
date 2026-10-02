import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { userAiConfig } from "@/db/schema";
import { db } from "@/lib/db";
import { authSecret, env } from "@/lib/env";
import { AppError, badRequest } from "@/lib/errors";
import { withLock } from "@/lib/lock";
import { AI_CATALOG } from "./catalog";

export const aiSettingsSchema = z.object({
  mode: z.enum(["platform", "personal"]),
  apiKey: z.string().trim().max(512).optional().default(""),
  asrModel: z.enum(["qwen3-asr-flash-2026-02-10", "qwen3-asr-flash"]),
  llmModel: z.enum(["qwen-plus", "qwen-flash"]),
  monthlyBudgetYuan: z.number().finite().min(0).max(10000),
  consent: z.boolean().optional().default(false),
}).strict();
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;
export type AiConfig = typeof userAiConfig.$inferSelect;
export function aiSettingsLock(userId: string) { return `ai-settings:${userId}`; }
function encryptionKey() {
  const secret = env().USER_API_KEY_SECRET || authSecret();
  if (secret.length < 32) throw new AppError(503, "key_storage_unavailable", "密钥加密服务尚未配置，请联系管理员。");
  return Buffer.from(hkdfSync("sha256", secret, "speak-user-api-key-v1", "aes-256-gcm", 32));
}
export function encryptApiKey(userId: string, value: string) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(userId));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptApiKey(userId: string, value: string) {
  try {
    const [version, nonce, tag, data] = value.split(".");
    if (version !== "v1") throw new Error("version");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonce, "base64url"));
    decipher.setAAD(Buffer.from(userId)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError(409, "key_unavailable", "个人密钥无法解密，请在 API 与用量页面重新填写。");
  }
}
export async function getAiConfig(userId: string) {
  const [row] = await db.select().from(userAiConfig).where(eq(userAiConfig.userId, userId));
  return row ?? null;
}
export function publicAiConfig(row: AiConfig | null) {
  return { mode: (row?.mode ?? "platform") as "platform" | "personal", hasKey: !!row?.keyCiphertext,
    maskedKey: row?.keyLast4 ? `•••• ${row.keyLast4}` : null,
    asrModel: row?.asrModel ?? AI_CATALOG.asr[0].id, llmModel: row?.llmModel ?? AI_CATALOG.llm[0].id,
    monthlyBudgetYuan: row?.monthlyBudgetYuan ?? 20, updatedAt: row?.updatedAt.toISOString() ?? null };
}
export async function saveAiConfig(userId: string, raw: unknown) {
  const parsed = aiSettingsSchema.safeParse(raw);
  if (!parsed.success) throw badRequest("请检查服务模式、模型及预算（0–10000 元）。");
  const { apiKey, consent, ...input } = parsed.data;
  if (input.mode === "personal" && !consent) throw badRequest("请确认个人密钥的服务商数据处理与费用说明。");
  // Explicit whitelist prevents accidental URL/header injection and clipboard whitespace.
  if (apiKey && !/^[A-Za-z0-9_-]{16,512}$/.test(apiKey)) throw badRequest("API Key 格式不正确，请粘贴完整密钥，不要包含空格或换行。");
  return withLock(aiSettingsLock(userId), async () => {
    const old = await getAiConfig(userId);
    if (input.mode === "personal" && !apiKey && !old?.keyCiphertext) throw badRequest("请先填写你的百炼 API Key。");
    const keyCiphertext = apiKey ? encryptApiKey(userId, apiKey) : old?.keyCiphertext ?? null;
    const keyLast4 = apiKey ? apiKey.slice(-4) : old?.keyLast4 ?? null;
    const values = { ...input, keyCiphertext, keyLast4, consentedAt: consent ? new Date() : old?.consentedAt ?? null, updatedAt: new Date() };
    const [row] = await db.insert(userAiConfig).values({ userId, ...values })
      .onConflictDoUpdate({ target: userAiConfig.userId, set: values }).returning();
    return publicAiConfig(row);
  });
}
export async function deleteApiKey(userId: string) {
  return withLock(aiSettingsLock(userId), async () => {
    await db.update(userAiConfig).set({ keyCiphertext: null, keyLast4: null, updatedAt: new Date() }).where(eq(userAiConfig.userId, userId));
    // Keep personal mode: deleting a key must not silently charge the site owner.
    return publicAiConfig(await getAiConfig(userId));
  });
}
