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
  uncoveredSeconds?: number;
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

export async function dailyUsageSeconds(userId: string, now = new Date(), connection: Tx | typeof db = db, excludeSessionId?: string, includeReservations = true): Promise<number> {
  const dayStart = startOfDayShanghai(now), dayEnd = new Date(dayStart.getTime() + 86400_000);
  const rows = await connection
    .select({
      status: practiceSession.status,
      reservedSeconds: practiceSession.reservedSeconds,
      usedSeconds: sql<number>`coalesce(sum(case when ${answer.createdAt} >= ${dayStart} and ${answer.createdAt} < ${dayEnd} then coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0) else 0 end), 0)::float8 / 1000`,
    })
    .from(practiceSession)
    .leftJoin(answer, eq(answer.sessionId, practiceSession.id))
    .where(and(eq(practiceSession.userId, userId), excludeSessionId ? sql`${practiceSession.id} <> ${excludeSessionId}` : undefined, sql`((${practiceSession.createdAt} >= ${dayStart} and ${practiceSession.createdAt} < ${dayEnd}) or (${answer.createdAt} >= ${dayStart} and ${answer.createdAt} < ${dayEnd}) or ${includeReservations} and ${practiceSession.status} = 'active')`))
    .groupBy(practiceSession.id);
  const [deleted] = await connection.select({ seconds: sql<number>`coalesce(sum((${usageEvent.units}->>'seconds')::float8), 0)` }).from(usageEvent)
    .where(and(eq(usageEvent.userId, userId), eq(usageEvent.service, "deleted-audio-quota"), sql`${usageEvent.units}->>'day' = ${startOfDayShanghai(now).toISOString()}`));
  return computeDailyUsage(rows.map((r) => ({ ...r, status: includeReservations ? r.status : "closed", usedSeconds: Number(r.usedSeconds) }))) + Number(deleted?.seconds ?? 0);
}

export async function userDailyLimitSeconds(userId: string, settings?: AppSettings, connection: Tx | typeof db = db): Promise<number> {
  const s = settings ?? (await getSettings());
  const [u] = await connection.select({ q: user.dailyQuotaMinutes }).from(user).where(eq(user.id, userId));
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

/** Reconcile measured usage under the wallet lock. Settled holds can be corrected without double charging. */
export async function settleQuotaHolds(tx: Tx, userId: string, now = new Date()) {
  // Aggregate once: historical, unchanged holds must not cause one query per recording on every /api/me.
  const rows = await tx.select({ hold: quotaHold, sessionId: practiceSession.id, status: practiceSession.status,
    deletedAt: practiceSession.deletedAt, reserve: practiceSession.reservedSeconds,
    used: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::float8 / 1000`,
    lastRecordedAt: sql<Date | string | null>`max(${answer.createdAt})`,
  }).from(quotaHold).leftJoin(practiceSession, eq(practiceSession.id, quotaHold.sessionId))
    .leftJoin(answer, and(eq(answer.sessionId, quotaHold.sessionId), sql`${answer.createdAt} >= (${quotaHold.day}::date::timestamp at time zone 'Asia/Shanghai') and ${answer.createdAt} < ((${quotaHold.day}::date + 1)::timestamp at time zone 'Asia/Shanghai')`))
    .where(eq(quotaHold.userId, userId)).groupBy(quotaHold.id, practiceSession.id).orderBy(quotaHold.day, quotaHold.createdAt, quotaHold.id);
  for (const row of rows) {
    const hold = row.hold, used = row.sessionId ? Math.ceil(Number(row.used)) : hold.usedSeconds;
    const active = row.status === "active" && !row.deletedAt && hold.day === rewardDay(now);
    const needed = active ? Math.max(used, row.reserve ?? 0) : used;
    const held = hold.baseSeconds + hold.credits.reduce((n, c) => n + c.seconds, 0);
    if (used === hold.usedSeconds && needed === held && !hold.uncoveredSeconds && hold.settled === !active) continue;
    const recordedAt = row.lastRecordedAt ? new Date(row.lastRecordedAt) : hold.createdAt;
    const day = dayDate(hold.day);
    const otherHolds = await tx.select().from(quotaHold).where(and(eq(quotaHold.userId, userId), eq(quotaHold.day, hold.day), sql`${quotaHold.id} <> ${hold.id}`));
    const otherBase = otherHolds.reduce((n, h) => n + h.baseSeconds, 0), otherCredits = otherHolds.reduce((n, h) => n + h.credits.reduce((m, c) => m + c.seconds, 0), 0);
    const otherRaw = row.sessionId ? await dailyUsageSeconds(userId, day, tx, hold.sessionId, hold.day === rewardDay(now)) : 0;
    // A deleted ledger keeps its already assigned base; a later day's free allowance cannot cover an old recording.
    const freeBase = row.sessionId ? Math.max(0, hold.baseLimitSeconds - Math.max(otherBase, Math.ceil(otherRaw) - otherCredits)) : hold.baseSeconds;
    const base = Math.min(needed, Math.max(hold.baseSeconds, freeBase));
    let extra = Math.max(0, needed - base);
    const credits: { id: string; seconds: number }[] = [];
    for (const credit of hold.credits) {
      const keep = Math.min(extra, credit.seconds); extra -= keep;
      if (credit.seconds > keep) await tx.update(minuteCredit).set({ remainingSeconds: sql`${minuteCredit.remainingSeconds} + ${credit.seconds - keep}` }).where(eq(minuteCredit.id, credit.id));
      if (keep) credits.push({ id: credit.id, seconds: keep });
    }
    if (extra) {
      // Existing recordings may correct a voucher that was valid when recorded; this does not renew expired credit.
      const grants = await tx.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), sql`${minuteCredit.remainingSeconds} > 0`,
        sql`(${minuteCredit.expiresAt} > ${now} or (${minuteCredit.createdAt} <= ${recordedAt} and ${minuteCredit.expiresAt} > ${recordedAt}))`)).orderBy(minuteCredit.expiresAt, minuteCredit.id);
      for (const grant of grants) {
        const take = Math.min(extra, grant.remainingSeconds); if (!take) continue;
        await tx.update(minuteCredit).set({ remainingSeconds: grant.remainingSeconds - take }).where(eq(minuteCredit.id, grant.id));
        const existing = credits.find(c => c.id === grant.id); if (existing) existing.seconds += take; else credits.push({ id: grant.id, seconds: take }); extra -= take;
      }
    }
    await tx.update(quotaHold).set({ settled: !active, baseSeconds: base, credits, usedSeconds: used, uncoveredSeconds: extra }).where(eq(quotaHold.id, hold.id));
  }
}

/** Persist decoded time and its ledger together. Shortfalls commit before the caller decides to wait for quota. */
export async function reconcileAnswerQuota(answerId: string, measured?: { durationMs: number; metrics: unknown }, now = new Date()) {
  if (measured && (!Number.isSafeInteger(measured.durationMs) || measured.durationMs < 0)) throw new AppError(400, "invalid_duration", "录音时长无效");
  const [owner] = await db.select({ userId: answer.userId }).from(answer).where(eq(answer.id, answerId));
  if (!owner) throw new AppError(404, "not_found", "回答不存在");
  return db.transaction(async tx => {
    await walletLock(tx, owner.userId);
    const [row] = await tx.select({ id: answer.id, sessionId: answer.sessionId, createdAt: answer.createdAt }).from(answer)
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId)).where(and(eq(answer.id, answerId), isNull(practiceSession.deletedAt))).for("update", { of: answer });
    if (!row) throw new AppError(404, "not_found", "回答已删除");
    if (measured) await tx.update(answer).set({ durationMs: measured.durationMs, metrics: measured.metrics }).where(eq(answer.id, row.id));
    await settleQuotaHolds(tx, owner.userId, now);
    const [hold] = await tx.select({ uncoveredSeconds: quotaHold.uncoveredSeconds }).from(quotaHold).where(and(eq(quotaHold.sessionId, row.sessionId), eq(quotaHold.day, rewardDay(row.createdAt))));
    return { uncoveredSeconds: hold?.uncoveredSeconds ?? 0 };
  });
}

export function assertCoveredQuota(uncoveredSeconds: number) {
  if (uncoveredSeconds > 0) throw new AppError(429, "quota_exceeded", `录音实测时长还有 ${uncoveredSeconds} 秒未覆盖。请兑换分钟券后重试；录音与已完成结果会保留。`, { uncoveredSeconds });
}

async function quotaStatusTx(tx: Tx, userId: string, settings: AppSettings, now = new Date(), excludeSessionId?: string): Promise<QuotaStatus> {
  const raw = await dailyUsageSeconds(userId, now, tx, excludeSessionId);
  const [owner] = await tx.select({ q: user.dailyQuotaMinutes }).from(user).where(eq(user.id, userId));
  const limit = Math.round((owner?.q ?? settings.limits.dailyMinutes) * 60);
  const holds = await tx.select().from(quotaHold).where(and(eq(quotaHold.userId, userId), eq(quotaHold.day, rewardDay(now)), excludeSessionId ? sql`${quotaHold.sessionId} <> ${excludeSessionId}` : undefined));
  const covered = holds.reduce((n, h) => n + h.credits.reduce((m, c) => m + c.seconds, 0), 0);
  const credits = await tx.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), sql`${minuteCredit.expiresAt} > ${now} and ${minuteCredit.remainingSeconds} > 0`)).orderBy(minuteCredit.expiresAt);
  const extraSeconds = credits.reduce((n, c) => n + c.remainingSeconds, 0);
  const [uncovered] = await tx.select({ all: sql<number>`coalesce(sum(${quotaHold.uncoveredSeconds}),0)::int`, past: sql<number>`coalesce(sum(case when ${quotaHold.day} <> ${rewardDay(now)} then ${quotaHold.uncoveredSeconds} else 0 end),0)::int` }).from(quotaHold).where(eq(quotaHold.userId, userId));
  const used = Math.max(0, Math.ceil(raw) - covered), baseRemainingSeconds = Math.max(0, limit - used);
  const remainingSeconds = Number(uncovered.all) > 0 ? 0 : Math.max(0, limit + extraSeconds - used - Number(uncovered.past));
  return { ...quotaFrom(used, limit), remainingSeconds, exceeded: remainingSeconds <= 0, baseRemainingSeconds, extraSeconds,
    reservedSeconds: holds.filter(h => !h.settled).reduce((n, h) => n + h.baseSeconds + h.credits.reduce((m, c) => m + c.seconds, 0), 0), uncoveredSeconds: Number(uncovered.all), nextExpiry: credits[0]?.expiresAt.toISOString() ?? null };
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
  assertCoveredQuota(quota.uncoveredSeconds ?? 0);
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
  await tx.insert(quotaHold).values({ userId, sessionId, day, baseSeconds: base, credits, baseLimitSeconds: hold?.baseLimitSeconds ?? await userDailyLimitSeconds(userId, settings, tx) }).onConflictDoUpdate({ target: [quotaHold.sessionId, quotaHold.day], set: { baseSeconds: base, credits, settled: false, uncoveredSeconds: 0 } });
}

export async function activeSessionCount(settings: AppSettings, excludeSessionId?: string): Promise<number> {
  const since = new Date(Date.now() - settings.limits.abandonMinutes * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(practiceSession)
    .where(
      and(
        eq(practiceSession.status, "active"),
        isNull(practiceSession.deletedAt),
        gte(practiceSession.lastActivityAt, since),
        excludeSessionId ? sql`${practiceSession.id} <> ${excludeSessionId}` : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * 新建会话前的检查：暂停开关、月度预算、全站并发、个人每日额度（含本次预留）。
 * 预留：训练为各题答题上限之和；模考为 12.5 分钟。
 */
export async function assertCanStartSession(userId: string, reserveSeconds: number, excludeSessionId?: string) {
  const settings = await getSettings();
  if (settings.pauseNewSessions) {
    throw new AppError(503, "paused", "管理员已暂停新的练习，请稍后再试。历史记录仍可正常查看。");
  }
  await assertUserAiBudget(userId);
  const active = await activeSessionCount(settings, excludeSessionId);
  if (active >= settings.limits.maxActiveSessions) {
    throw new AppError(429, "busy", `当前同时进行的面试已达上限（${settings.limits.maxActiveSessions} 个），请稍后再试。`);
  }
  const q = await getQuotaStatus(userId);
  assertCoveredQuota(q.uncoveredSeconds ?? 0);
  if (reserveSeconds > q.remainingSeconds) {
    throw new AppError(429, "quota_exceeded", `可用额度不足：剩余 ${Math.floor(q.remainingSeconds / 60)} 分钟，本次需预留约 ${Math.ceil(reserveSeconds / 60)} 分钟。`, {
      quota: q,
    });
  }
  return { settings };
}
