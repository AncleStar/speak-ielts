"use server";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { minuteCredit, opsLog } from "@/db/schema";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { getSettings, setSetting, settingsSchema } from "@/lib/settings";
import { adjustPoints, walletLock } from "@/lib/services/rewards";
type State = { error?: string; ok?: string } | null;
export async function updateRewardsAction(_prev: State, fd: FormData): Promise<State> {
  const admin = await requireAdmin();
  try {
    const previous = (await getSettings()).rewards;
    const input = Object.fromEntries(Object.keys(previous).map(k => [k, typeof previous[k as keyof typeof previous] === "boolean" ? fd.get(k) === "on" : Number(fd.get(k))]));
    const parsed = settingsSchema.shape.rewards.safeParse(input);
    if (!parsed.success) return { error: "设置超出允许范围，请检查积分数、次数及有效天数。" };
    await db.transaction(async tx => {
      const { appSetting } = await import("@/db/schema");
      await tx.insert(appSetting).values({ key: "rewards", value: parsed.data }).onConflictDoUpdate({ target: appSetting.key, set: { value: parsed.data, updatedAt: new Date() } });
      await tx.insert(opsLog).values({ level: "info", kind: "rewards-settings", ref: admin.id, message: JSON.stringify({ before: previous, after: parsed.data }) });
    });
  } catch (e) { return { error: e instanceof AppError ? e.message : "保存失败，请重试。" }; }
  revalidatePath("/", "layout"); return { ok: "奖励规则已保存。既有分钟券面额与到期时间保持兑换时的规则。" };
}
export async function adjustPointsAction(_prev: State, fd: FormData): Promise<State> {
  const admin = await requireAdmin();
  try { await adjustPoints(admin.id, String(fd.get("userId")), Number(fd.get("points")), String(fd.get("note") ?? ""), String(fd.get("requestId"))); }
  catch (e) { return { error: e instanceof AppError ? e.message : "调整失败，请重试。" }; }
  revalidatePath("/", "layout"); return { ok: "积分已调整，原因和管理员标识已记入流水。" };
}
export async function extendCreditAction(_prev: State, fd: FormData): Promise<State> {
  const admin = await requireAdmin(), id = String(fd.get("creditId")), note = String(fd.get("note") ?? ""), key = String(fd.get("requestId")), days = Number(fd.get("days"));
  if (!Number.isInteger(days) || days < 1 || days > 90 || note.trim().length < 3 || note.length > 200 || !/^[\w-]{8,100}$/.test(key)) return { error: "延期需填写 1–90 天及至少 3 字原因。" };
  try {
    await db.transaction(async tx => {
      const [credit] = await tx.select().from(minuteCredit).where(eq(minuteCredit.id, id));
      if (!credit) throw new AppError(404, "not_found", "分钟券不存在");
      await walletLock(tx, credit.userId);
      if ((await tx.select().from(opsLog).where(eq(opsLog.id, key))).length) return;
      await tx.update(minuteCredit).set({ expiresAt: sql`greatest(${minuteCredit.expiresAt}, now()) + ${days} * interval '1 day'` }).where(eq(minuteCredit.id, id));
      await tx.insert(opsLog).values({ id: key, level: "info", kind: "credit-extension", ref: id, message: JSON.stringify({ actor: admin.id, days, reason: note.trim() }) });
    });
  } catch (e) { return { error: e instanceof AppError ? e.message : "延期失败，请重试。" }; }
  revalidatePath("/", "layout"); return { ok: "分钟券已延期，操作已记录。" };
}
