import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSetting } from "@/db/schema";
import { db } from "@/lib/db";

/** 单价默认值见附录 D（2026-09 公开价格，以控制台为准），可在管理页调整。 */
export const settingsSchema = z.object({
  pricing: z.object({
    asrPerSecond: z.number().min(0),
    ttsPer10kChars: z.number().min(0),
    llmInputPerMTok: z.number().min(0),
    llmOutputPerMTok: z.number().min(0),
    omniInputPerMTok: z.number().min(0),
    omniOutputPerMTok: z.number().min(0),
  }),
  budget: z.object({ monthlyYuan: z.number().min(0) }),
  limits: z.object({
    dailyMinutes: z.number().min(0),
    maxActiveSessions: z.number().int().min(1),
    abandonMinutes: z.number().int().min(5),
  }),
  pauseNewSessions: z.boolean(),
  rewards: z.object({
    enabled: z.boolean(), redemptionEnabled: z.boolean(),
    checkin: z.number().int().min(0).max(100), practice: z.number().int().min(0).max(100),
    review: z.number().int().min(0).max(100), milestone: z.number().int().min(0).max(500),
    dailyCap: z.number().int().min(0).max(1000), practiceLimit: z.number().int().min(0).max(10),
    voucherCost: z.number().int().min(1).max(10000), voucherMinutes: z.number().int().min(1).max(120),
    voucherDays: z.number().int().min(1).max(90), redemptionDailyLimit: z.number().int().min(1).max(10),
  }),
});
export type AppSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  pricing: {
    asrPerSecond: 0.00022,
    ttsPer10kChars: 0.8,
    llmInputPerMTok: 0.8,
    llmOutputPerMTok: 2,
    omniInputPerMTok: 1.6,
    omniOutputPerMTok: 6,
  },
  budget: { monthlyYuan: 100 },
  limits: { dailyMinutes: 30, maxActiveSessions: 5, abandonMinutes: 30 },
  pauseNewSessions: false,
  rewards: { enabled: true, redemptionEnabled: true, checkin: 5, practice: 10, review: 5, milestone: 20,
    dailyCap: 30, practiceLimit: 2, voucherCost: 50, voucherMinutes: 10, voucherDays: 7, redemptionDailyLimit: 2 },
};

type Key = keyof AppSettings;

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(appSetting);
  const merged: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (r.key in merged) {
      const def = (DEFAULT_SETTINGS as Record<string, unknown>)[r.key];
      merged[r.key] = def && typeof def === "object" ? { ...(def as object), ...(r.value as object) } : r.value;
    }
  }
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function setSetting<K extends Key>(key: K, value: AppSettings[K]) {
  const shape = settingsSchema.shape[key];
  const v = shape.parse(value);
  await db
    .insert(appSetting)
    .values({ key, value: v as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: v as object, updatedAt: new Date() } });
}

export async function ensureDefaultSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insert(appSetting).values({ key, value: value as object }).onConflictDoNothing();
  }
}

export async function getSettingRaw(key: string) {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, key));
  return row?.value;
}
