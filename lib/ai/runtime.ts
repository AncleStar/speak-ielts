import { env } from "@/lib/env";
import { eq } from "drizzle-orm";
import { user } from "@/db/schema";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { providers } from "@/lib/providers";
import { createDashscopeProviders } from "@/lib/providers/dashscope";
import { getSettings } from "@/lib/settings";
import { monthCostYuan } from "@/lib/usage";
import { AI_CATALOG } from "./catalog";
import { decryptApiKey, getAiConfig } from "./credentials";

export async function resolveUserAi(userId?: string) {
  if (userId) {
    const [owner] = await db.select({ deletedAt: user.deletedAt, banned: user.banned }).from(user).where(eq(user.id, userId));
    if (!owner || owner.deletedAt || owner.banned) throw new AppError(403, "account_inactive", "账号已停用，模型调用已停止。");
  }
  const config = userId ? await getAiConfig(userId) : null;
  if (config?.mode === "personal") {
    if (!config.keyCiphertext) throw new AppError(409, "key_required", "个人 API Key 已删除，请在 API 与用量页面填写后重试。");
    const apiKey = decryptApiKey(userId!, config.keyCiphertext);
    return { provider: createDashscopeProviders({ DASHSCOPE_API_KEY: apiKey, DASHSCOPE_BASE_URL: AI_CATALOG.baseUrl, ASR_MODEL: config.asrModel, LLM_MODEL: config.llmModel }),
      source: "personal" as const, asrModel: config.asrModel, llmModel: config.llmModel, monthlyBudgetYuan: config.monthlyBudgetYuan };
  }
  return { provider: providers(), source: "platform" as const, asrModel: env().ASR_MODEL, llmModel: env().LLM_MODEL, monthlyBudgetYuan: undefined };
}

export async function assertUserAiBudget(userId: string) {
  const config = await getAiConfig(userId);
  if (config?.mode === "personal") {
    if (!config.keyCiphertext) throw new AppError(409, "key_required", "请先在 API 与用量页面填写个人密钥。");
    if (await monthCostYuan(new Date(), userId) >= config.monthlyBudgetYuan)
      throw new AppError(429, "personal_budget_exceeded", "个人月度 AI 预算不足，请在 API 与用量页面调整后重试。");
  } else if (await monthCostYuan() >= (await getSettings()).budget.monthlyYuan) {
    throw new AppError(429, "budget_exceeded", "本月站点 AI 预算不足，请联系管理员或切换到个人 API Key。");
  }
}
