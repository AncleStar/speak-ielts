import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { answer, minuteCredit, practiceSession, quotaHold, usageEvent, user } from "@/db/schema";
import { db, type Tx } from "@/lib/db";
import { dayDate, rewardDay, walletLock } from "@/lib/services/rewards";
import { AppError } from "@/lib/errors";
import { getSettings, type AppSettings } from "@/lib/settings";
import { startOfDayShanghai } from "@/lib/timing";
import { assertUserAiBudget } from "@/lib/ai/runtime";

export interface SessionUsageRow {
  status: string;
  reservedSeconds: number;
  usedSeconds: number;
}

/**
 * 当日已用额度：进行中的会话按 max(预留, 已用) 计，已结束的按实际已用计。
 * 预留在会话结束（完成 / 中断 / 放弃）时自动释放。
 */
export function computeDailyUsage(rows: SessionUsageRow[]): number {
  return rows.reduce((sum, r) => sum + (r.status === "active" ? Math.max(r.reservedSeconds, r.usedSeconds) : r.usedSeconds), 0);
}

export interface QuotaStatus {
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
  ratio: number;
  warn: boolean;
  exceeded: boolean;
  baseRemainingSeconds?: number;
  extraSeconds?: number;
  reservedSeconds?: number;
  nextExpiry?: string | null;
}

export function quotaFrom(usedSeconds: number, limitSeconds: number): QuotaStatus {
  const ratio = limitSeconds > 0 ? usedSeconds / limitSeconds : 1;
  return {
    usedSeconds: Math.round(usedSeconds),
    limitSeconds,
    remainingSeconds: Math.max(0, Math.round(limitSeconds - usedSeconds)),
    ratio,
    warn: ratio >= 0.8,
    exceeded: usedSeconds >= limitSeconds,
  };
}

export async function dailyUsageSeconds(userId: string, now = new Date(), connection: Tx | typeof db = db, excludeSessionId?: string): Promise<number> {
  const rows = await connection
    .select({
      status: practiceSession.status,
      reservedSeconds: practiceSession.reservedSeconds,
      usedSeconds: sql<number>`coalesce(sum(case when ${answer.createdAt} >= ${startOfDayShanghai(now)} then coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0) else 0 end), 0)::float8 / 1000`,
    })
    .from(practiceSession)
    .leftJoin(answer, eq(answer.sessionId, practiceSession.id))
    .where(and(eq(practiceSession.userId, userId), excludeSessionId ? sql`${practiceSession.id} <> ${excludeSessionId}` : undefined, sql`(${practiceSession.createdAt} >= ${startOfDayShanghai(now)} or ${answer.createdAt} >= ${startOfDayShanghai(now)} or ${practiceSession.status} = 'active')`))
    .groupBy(practiceSession.id);
  const [deleted] = await connection.select({ seconds: sql<number>`coalesce(sum((${usageEvent.units}->>'seconds')::float8), 0)` }).from(usageEvent)
    .where(and(eq(usageEvent.userId, userId), eq(usageEvent.service, "deleted-audio-quota"), sql`${usageEvent.units}->>'day' = ${startOfDayShanghai(now).toISOString()}`));
  return computeDailyUsage(rows.map((r) => ({ ...r, usedSeconds: Number(r.usedSeconds) }))) + Number(deleted?.seconds ?? 0);
}

export async function userDailyLimitSeconds(userId: string, settings?: AppSettings): Promise<number> {
  const s = settings ?? (await getSettings());
  const [u] = await db.select({ q: user.dailyQuotaMinutes }).from(user).where(eq(user.id, userId));
  const minutes = u?.q ?? s.limits.dailyMinutes;
  return Math.round(minutes * 60);
}

export async function getQuotaStatus(userId: string, now = new Date()): Promise<QuotaStatus> {
  const settings = await getSettings();
  return db.transaction(async tx => {
    await walletLock(tx, userId);
    await settleQuotaHolds(tx, userId, now);
    return quotaStatusTx(tx, userId, settings, now);
  });
}

/** Settle each finished/day-ended hold exactly once; refund unused reserved credits. */
export async function settleQuotaHolds(tx: Tx, userId: string, now = new Date()) {
  const holds = await tx.select().from(quotaHold).where(and(eq(quotaHold.userId, userId), eq(quotaHold.settled, false)));
  for (const hold of holds) {
    const [s] = await tx.select().from(practiceSession).where(eq(practiceSession.id, hold.sessionId));
    if (s && s.status === "active" && !s.deletedAt && hold.day === rewardDay(now)) continue;
    const start = dayDate(hold.day), end = new Date(start.getTime() + 86400_000);
    const [used] = await tx.select({ n: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::float8 / 1000` }).from(answer)
      .where(and(eq(answer.sessionId, hold.sessionId), sql`${answer.createdAt} >= ${start} and ${answer.createdAt} < ${end}`));
    let extraUsed = Math.max(0, Math.ceil(Number(used.n)) - hold.baseSeconds);
    const credits = [];
    for (const credit of hold.credits) {
      const spent = Math.min(extraUsed, credit.seconds); extraUsed -= spent;
      if (credit.seconds > spent) await tx.update(minuteCredit).set({ remainingSeconds: sql`${minuteCredit.remainingSeconds} + ${credit.seconds - spent}` }).where(eq(minuteCredit.id, credit.id));
      if (spent) credits.push({ id: credit.id, seconds: spent });
    }
    await tx.update(quotaHold).set({ settled: true, baseSeconds: Math.min(hold.baseSeconds, Math.ceil(Number(used.n))), credits }).where(eq(quotaHold.id, hold.id));
  }
}

async function quotaStatusTx(tx: Tx, userId: string, settings: AppSettings, now = new Date(), excludeSessionId?: string): Promise<QuotaStatus> {
  const raw = await dailyUsageSeconds(userId, now, tx, excludeSessionId);
  const [owner] = await tx.select({ q: user.dailyQuotaMinutes }).from(user).where(eq(user.id, userId));
  const limit = Math.round((owner?.q ?? settings.limits.dailyMinutes) * 60);
  const holds = await tx.select().from(quotaHold).where(and(eq(quotaHold.userId, userId), eq(quotaHold.day, rewardDay(now)), excludeSessionId ? sql`${quotaHold.sessionId} <> ${excludeSessionId}` : undefined));
  const covered = holds.reduce((n, h) => n + h.credits.reduce((m, c) => m + c.seconds, 0), 0);
  const credits = await tx.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), sql`${minuteCredit.expiresAt} > ${now} and ${minuteCredit.remainingSeconds} > 0`)).orderBy(minuteCredit.expiresAt);
  const extraSeconds = credits.reduce((n, c) => n + c.remainingSeconds, 0);
  const used = Math.max(0, Math.ceil(raw) - covered), baseRemainingSeconds = Math.max(0, limit - used);
  const remainingSeconds = Math.max(0, limit + extraSeconds - used);
  return { ...quotaFrom(used, limit), remainingSeconds, exceeded: remainingSeconds <= 0, baseRemainingSeconds, extraSeconds,
    reservedSeconds: holds.filter(h => !h.settled).reduce((n, h) => n + h.baseSeconds + h.credits.reduce((m, c) => m + c.seconds, 0), 0), nextExpiry: credits[0]?.expiresAt.toISOString() ?? null };
}

/** Must run in the same transaction as the session/answer write. Locks are shared with wallet operations. */
export async function reserveSessionQuota(tx: Tx, userId: string, sessionId: string, requestedSeconds: number, now = new Date()) {
  await walletLock(tx, userId);
  await settleQuotaHolds(tx, userId, now);
  const day = rewardDay(now);
  const [hold] = await tx.select().from(quotaHold).where(and(eq(quotaHold.sessionId, sessionId), eq(quotaHold.day, day)));
  const held = hold ? hold.baseSeconds + hold.credits.reduce((n, c) => n + c.seconds, 0) : 0;
  if (hold && !hold.settled && held >= Math.ceil(requestedSeconds)) return;
  // Rebuild atomically, keeping still-reserved expired credits available only to this session.
  const preserved = hold ? hold.credits : [];
  const preservedSeconds = preserved.reduce((n, c) => n + c.seconds, 0);
  const settings = await getSettings();
  const quota = await quotaStatusTx(tx, userId, settings, now, sessionId);
  const need = Math.ceil(requestedSeconds);
  if (need > quota.remainingSeconds + preservedSeconds) throw new AppError(429, "quota_exceeded", "可用录音额度不足，请缩短练习或兑换分钟券。本地录音会保留。", { quota });
  // Existing holds preserve their base allocation, so time is consumed in a stable order.
  const base = hold ? hold.baseSeconds + Math.min(Math.max(0, need - held), Math.max(0, (quota.baseRemainingSeconds ?? 0) - hold.baseSeconds)) : Math.min(need, quota.baseRemainingSeconds ?? 0);
  let extra = Math.max(0, need - base - preservedSeconds);
  const credits = [...preserved];
  const grants = await tx.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), sql`${minuteCredit.expiresAt} > ${now} and ${minuteCredit.remainingSeconds} > 0`)).orderBy(minuteCredit.expiresAt, minuteCredit.id);
  for (const grant of grants) {
    const take = Math.min(extra, grant.remainingSeconds); if (!take) continue;
    await tx.update(minuteCredit).set({ remainingSeconds: grant.remainingSeconds - take }).where(eq(minuteCredit.id, grant.id));
    const c = credits.find(c => c.id === grant.id); if (c) c.seconds += take; else credits.push({ id: grant.id, seconds: take }); extra -= take;
  }
  if (extra > 0) throw new AppError(429, "quota_exceeded", "分钟券余额不足，请稍后重试。");
  await tx.insert(quotaHold).values({ userId, sessionId, day, baseSeconds: base, credits }).onConflictDoUpdate({ target: [quotaHold.sessionId, quotaHold.day], set: { baseSeconds: base, credits, settled: false } });
}

export async function activeSessionCount(settings: AppSettings, excludeUserId?: string): Promise<number> {
  const since = new Date(Date.now() - settings.limits.abandonMinutes * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(practiceSession)
    .where(
      and(
        eq(practiceSession.status, "active"),
        isNull(practiceSession.deletedAt),
        gte(practiceSession.lastActivityAt, since),
        excludeUserId ? sql`${practiceSession.userId} <> ${excludeUserId}` : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * 新建会话前的检查：暂停开关、月度预算、全站并发、个人每日额度（含本次预留）。
 * 预留：训练为各题答题上限之和；模考为 12.5 分钟。
 */
export async function assertCanStartSession(userId: string, reserveSeconds: number) {
  const settings = await getSettings();
  if (settings.pauseNewSessions) {
    throw new AppError(503, "paused", "管理员已暂停新的练习，请稍后再试。历史记录仍可正常查看。");
  }
  await assertUserAiBudget(userId);
  const active = await activeSessionCount(settings);
  if (active >= settings.limits.maxActiveSessions) {
    throw new AppError(429, "busy", `当前同时进行的面试已达上限（${settings.limits.maxActiveSessions} 个），请稍后再试。`);
  }
  const q = await getQuotaStatus(userId);
  if (reserveSeconds > q.remainingSeconds) {
    throw new AppError(429, "quota_exceeded", `可用额度不足：剩余 ${Math.floor(q.remainingSeconds / 60)} 分钟，本次需预留约 ${Math.ceil(reserveSeconds / 60)} 分钟。`, {
      quota: q,
    });
  }
  return { settings };
}
