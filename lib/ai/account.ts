import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { usageEvent } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, badRequest } from "@/lib/errors";
import { getQuotaStatus } from "@/lib/quota";
import { providers, ProviderError } from "@/lib/providers";
import { metered } from "@/lib/providers/metered";
import { withLocks } from "@/lib/lock";
import { monthCostYuan } from "@/lib/usage";
import { aiSettingsLock, getAiConfig, publicAiConfig } from "./credentials";

export function usageMonthRange(month: string) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("月份格式应为 YYYY-MM。");
  const from = new Date(`${month}-01T00:00:00+08:00`);
  // UTC day can be the previous month's last day: calculate via the target local month instead.
  const [year, n] = month.split("-").map(Number);
  return { from, to: new Date(Date.UTC(year, n, 1) - 8 * 3600_000) };
}
export async function getAiAccount(userId: string, month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7), offset = 0) {
  const range = usageMonthRange(month);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw badRequest("页码无效");
  const condition = and(eq(usageEvent.userId, userId), gte(usageEvent.createdAt, range.from), lt(usageEvent.createdAt, range.to), sql`${usageEvent.service} <> 'deleted-audio-quota'`);
  const [config, quota, totals, rows, personalMonthCost] = await Promise.all([
    getAiConfig(userId), getQuotaStatus(userId),
    db.select({ source: usageEvent.billingSource, cost: sql<number>`coalesce(sum(${usageEvent.costYuan}),0)::float8`,
      calls: sql<number>`count(*) filter (where ${usageEvent.service} <> 'recovery-adjustment' and ${usageEvent.units}->>'cancelledBeforeDispatch' is distinct from 'true')::int`, seconds: sql<number>`coalesce(sum((${usageEvent.units}->>'seconds')::float8),0)::float8`,
      inputTokens: sql<number>`coalesce(sum((${usageEvent.units}->>'inputTokens')::float8),0)::float8`,
      outputTokens: sql<number>`coalesce(sum((${usageEvent.units}->>'outputTokens')::float8),0)::float8` }).from(usageEvent).where(condition).groupBy(usageEvent.billingSource),
    db.select({ id: usageEvent.id, service: usageEvent.service, model: usageEvent.model, source: usageEvent.billingSource, units: usageEvent.units, cost: usageEvent.costYuan, mock: usageEvent.mock, ok: usageEvent.ok, createdAt: usageEvent.createdAt }).from(usageEvent).where(condition).orderBy(desc(usageEvent.createdAt), desc(usageEvent.id)).limit(31).offset(offset),
    monthCostYuan(new Date(), userId),
  ]);
  return { config: publicAiConfig(config), quota, totals, personalMonthCost, month, offset, hasMore: rows.length > 30,
    rows: rows.slice(0, 30).map(row => ({ ...row, createdAt: row.createdAt.toISOString(), units: row.units as Record<string, unknown> })),
    platform: { mock: env().AI_PROVIDER === "mock", asrModel: env().ASR_MODEL, llmModel: env().LLM_MODEL, tts: providers().ttsKind } };
}
export type AiAccountView = Awaited<ReturnType<typeof getAiAccount>>;

export async function testPersonalConnection(userId: string) {
  // Declare nested billing locks once. Hold settings consistently so a personal check cannot switch to site billing.
  return withLocks([`ai-check:${userId}`, `ai-budget:${userId}`, aiSettingsLock(userId)], async () => {
    const config = await getAiConfig(userId);
    if (config?.mode !== "personal" || !config.keyCiphertext) throw badRequest("请先保存个人 API Key 模式。");
    const jobRef = `connection-check:${userId}`;
    const [recent] = await db.select({ id: usageEvent.id }).from(usageEvent).where(and(eq(usageEvent.userId, userId), eq(usageEvent.jobRef, jobRef), gte(usageEvent.createdAt, new Date(Date.now() - 60000)))).limit(1);
    if (recent) throw new AppError(429, "check_rate_limit", "每分钟可测试一次，请稍后再试。");
    try {
      const result = await metered(jobRef, userId).llmJson({ purpose: "check", system: 'Return a JSON object with a single key "ok" set to true.', user: "Connection check. JSON only.", maxTokens: 32, timeoutMs: 15000 });
      if (!(result.json && typeof result.json === "object" && "ok" in result.json && result.json.ok === true)) throw new AppError(502, "invalid_model_response", "接口已响应，但结构化输出不符合要求；本次用量已记入明细。");
      return { ok: true, model: result.model, message: "反馈模型连接正常，本次费用已记入明细。语音识别权限需在首次录音时验证。" };
    } catch (e) {
      if (e instanceof ProviderError) throw new AppError(400, "provider_check_failed", "百炼连接测试失败，请检查北京地域的 API Key、模型权限和账户额度；本次请求的估算预留可在明细中查看。");
      throw e;
    }
  });
}
