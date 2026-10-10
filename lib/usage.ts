import { and, eq, gte, sql } from "drizzle-orm";
import { usageEvent } from "@/db/schema";
import { db } from "@/lib/db";
import { getSettings, type AppSettings } from "@/lib/settings";
import { startOfMonthShanghai } from "@/lib/timing";
import { withLock } from "@/lib/lock";
import { AppError } from "@/lib/errors";
import { AI_CATALOG, personalPrice } from "@/lib/ai/catalog";
import { assertRecoveryReady } from "@/lib/recovery-state";

/** 调用前持久化预算预留，防止并发任务在记账前穿透预算。
 * 超时等未知计费结果保留预估金额，成功后按服务返回用量结算。
 */
export async function billableCall<T extends { model: string; latencyMs: number }>(opts: {
  service: "asr" | "tts" | "llm" | "omni";
  model: string;
  mock: boolean;
  /** 本地神经语音是真实合成，但不产生云 API 费用。 */
  billable?: boolean;
  userId?: string;
  billingSource?: "platform" | "personal";
  monthlyBudgetYuan?: number;
  jobRef: string;
  estimate: UsageUnits;
  /** A gate that runs before dispatch. A rejected gate sends no request and releases the reservation. */
  beforeRun?: () => Promise<void>;
  run: () => Promise<T>;
  units: (result: T) => UsageUnits;
}): Promise<T> {
  await assertRecoveryReady();
  const settings = await getSettings();
  const source = opts.billingSource ?? "platform";
  if (source === "personal" && (!opts.userId || opts.monthlyBudgetYuan === undefined)) throw new Error("Missing personal billing owner");
  const priceFor = (model: string, units: UsageUnits) => source === "personal"
    ? { ...settings.pricing, ...personalPrice(model, "inputTokens" in units ? units.inputTokens : 0) } : settings.pricing;
  const meta = (units: UsageUnits, model = opts.model) => ({ ...units, price: priceFor(model, units), priceDate: source === "personal" ? AI_CATALOG.priceDate : "site-settings", costEstimated: true });
  const billable = !opts.mock && opts.billable !== false;
  const reservedCost = billable ? estimateCost(opts.service, opts.estimate, priceFor(opts.model, opts.estimate)) : 0;
  const id = await withLock(source === "personal" ? `ai-budget:${opts.userId}` : "ai-budget", async () => {
    if (billable && await monthCostYuan(new Date(), source === "personal" ? opts.userId : undefined) + reservedCost > (opts.monthlyBudgetYuan ?? settings.budget.monthlyYuan)) {
      throw new AppError(429, source === "personal" ? "personal_budget_exceeded" : "budget_exceeded", source === "personal" ? "个人月度 AI 预算不足，请在 API 与用量页面调整后重试。" : "本月 AI 预算不足，任务已停止；调整预算后可重试。");
    }
    const [row] = await db.insert(usageEvent).values({
      service: opts.service, model: opts.model, mock: opts.mock, userId: opts.userId, billingSource: source,
      jobRef: opts.jobRef, units: { ...meta(opts.estimate), estimated: true, pending: true }, costYuan: reservedCost, ok: false,
    }).returning({ id: usageEvent.id });
    return row.id;
  });
  let dispatched = false;
  try {
    await opts.beforeRun?.();
    dispatched = true;
    const result = await opts.run();
    const units = opts.units(result);
    await db.update(usageEvent).set({ model: result.model, units: { ...meta(units, result.model), pending: false }, costYuan: billable ? estimateCost(opts.service, units, priceFor(result.model, units)) : 0, ok: true, latencyMs: result.latencyMs }).where(eq(usageEvent.id, id));
    return result;
  } catch (error) {
    const units = dispatched ? opts.estimate : "seconds" in opts.estimate ? { seconds: 0 } : "chars" in opts.estimate ? { chars: 0 } : { inputTokens: 0, outputTokens: 0 };
    await db.update(usageEvent).set({ units: { ...meta(units), estimated: dispatched, pending: false, cancelledBeforeDispatch: !dispatched, ...(!dispatched ? { cancelledEstimate: opts.estimate } : {}) }, ...(!dispatched ? { costYuan: 0 } : {}), ok: false }).where(eq(usageEvent.id, id));
    throw error;
  }
}

export type UsageUnits = (
  | { seconds: number }
  | { chars: number }
  | { inputTokens: number; outputTokens: number }) & { estimated?: boolean };

export function estimateCost(service: string, units: UsageUnits, pricing: AppSettings["pricing"]): number {
  if (service === "asr" && "seconds" in units) return units.seconds * pricing.asrPerSecond;
  if (service === "tts" && "chars" in units) return (units.chars / 10_000) * pricing.ttsPer10kChars;
  if (service === "llm" && "inputTokens" in units)
    return (units.inputTokens / 1e6) * pricing.llmInputPerMTok + (units.outputTokens / 1e6) * pricing.llmOutputPerMTok;
  if (service === "omni" && "inputTokens" in units)
    return (units.inputTokens / 1e6) * pricing.omniInputPerMTok + (units.outputTokens / 1e6) * pricing.omniOutputPerMTok;
  return 0;
}

/** 记录一次云服务调用的用量与估算成本（模拟模式记为 0 元）。 */
export async function recordUsage(e: {
  userId?: string | null;
  service: "asr" | "tts" | "llm" | "omni";
  model: string;
  units: UsageUnits;
  jobRef?: string;
  mock: boolean;
  latencyMs?: number;
  ok?: boolean;
}) {
  const settings = await getSettings();
  const cost = e.mock ? 0 : estimateCost(e.service, e.units, settings.pricing);
  await db.insert(usageEvent).values({
    userId: e.userId ?? null,
    service: e.service,
    model: e.model,
    units: e.units,
    jobRef: e.jobRef,
    costYuan: cost,
    mock: e.mock,
    latencyMs: e.latencyMs,
    ok: e.ok ?? true,
  });
  return cost;
}

export async function monthCostYuan(now = new Date(), personalUserId?: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvent.costYuan}), 0)::float8` })
    .from(usageEvent)
    .where(and(gte(usageEvent.createdAt, startOfMonthShanghai(now)), sql`${usageEvent.mock} = false`, eq(usageEvent.billingSource, personalUserId ? "personal" : "platform"), personalUserId ? eq(usageEvent.userId, personalUserId) : undefined));
  return Number(row?.total ?? 0);
}
