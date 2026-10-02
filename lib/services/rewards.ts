import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { answer, appSetting, dailyCheckin, minuteCredit, practiceSession, rewardLedger, reviewVisit, user } from "@/db/schema";
import { db, type Tx } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { monthCostYuan } from "@/lib/usage";

/** Fixed UTC+8 in this release. Neither browser time nor travel changes the reward day. */
export const rewardDay = (date = new Date()) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export const dayDate = (day: string) => new Date(`${day}T00:00:00+08:00`);
export const previousDay = (day: string) => rewardDay(new Date(dayDate(day).getTime() - 86400_000));
export async function walletLock(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'wallet:' + userId}, 0))`);
}
export async function balance(tx: Tx | typeof db, userId: string) {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${rewardLedger.points}), 0)::int` }).from(rewardLedger).where(eq(rewardLedger.userId, userId));
  return Number(r.n);
}
async function award(tx: Tx, userId: string, kind: string, key: string, day: string, points: number, note: string, cap: number) {
  const [existing] = await tx.select().from(rewardLedger).where(and(eq(rewardLedger.userId, userId), eq(rewardLedger.eventKey, key)));
  if (existing) return 0;
  const [earned] = await tx.select({ n: sql<number>`coalesce(sum(${rewardLedger.points}), 0)::int` }).from(rewardLedger)
    .where(and(eq(rewardLedger.userId, userId), eq(rewardLedger.day, day), inArray(rewardLedger.kind, ["checkin", "practice", "review"])));
  const amount = kind === "milestone" ? points : Math.min(points, Math.max(0, cap - Number(earned.n)));
  await tx.insert(rewardLedger).values({ userId, eventKey: key, kind, day, points: amount, note: amount ? note : `${note}（当日奖励已达上限）` });
  return amount;
}
export async function checkIn(userId: string, now = new Date()) {
  const settings = (await getSettings()).rewards;
  return db.transaction(async tx => {
    await walletLock(tx, userId);
    const day = rewardDay(now);
    const [exists] = await tx.select().from(dailyCheckin).where(and(eq(dailyCheckin.userId, userId), eq(dailyCheckin.day, day)));
    if (exists) return { earned: 0, duplicate: true, streak: exists.streak };
    if (!settings.enabled) throw new AppError(409, "rewards_paused", "签到奖励暂时关闭，请稍后再试。");
    const [last] = await tx.select().from(dailyCheckin).where(and(eq(dailyCheckin.userId, userId), eq(dailyCheckin.day, previousDay(day))));
    const streak = (last?.streak ?? 0) + 1;
    await tx.insert(dailyCheckin).values({ userId, day, streak, createdAt: now });
    let earned = await award(tx, userId, "checkin", `checkin:${day}`, day, settings.checkin, "每日签到", settings.dailyCap);
    if (streak % 7 === 0) earned += await award(tx, userId, "milestone", `milestone:${day}`, day, settings.milestone, `连续签到 ${streak} 天`, settings.dailyCap);
    return { earned, duplicate: false, streak };
  });
}
export async function redeemMinutes(userId: string, requestId: string, now = new Date(), offer?: { cost: number; minutes: number; days: number }) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw badRequest("无效的兑换标识");
  const settings = await getSettings();
  return db.transaction(async tx => {
    await walletLock(tx, userId);
    const [existing] = await tx.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), eq(minuteCredit.redemptionKey, requestId)));
    if (existing) return existing;
    const r = settings.rewards;
    if (!r.redemptionEnabled || settings.pauseNewSessions) throw new AppError(409, "redemption_paused", "分钟券兑换已暂停，积分会保留。");
    if (await monthCostYuan() >= settings.budget.monthlyYuan) throw new AppError(429, "budget_exceeded", "本月服务预算已用完，暂缓兑换，积分会保留。");
    const day = rewardDay(now);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(rewardLedger).where(and(eq(rewardLedger.userId, userId), eq(rewardLedger.day, day), eq(rewardLedger.kind, "redeem")));
    if (count.n >= r.redemptionDailyLimit) throw badRequest("已达到今日兑换次数上限");
    if (offer && (offer.cost !== r.voucherCost || offer.minutes !== r.voucherMinutes || offer.days !== r.voucherDays)) throw badRequest("兑换规则已更新，请刷新页面后重新确认", "offer_changed");
    if (await balance(tx, userId) < r.voucherCost) throw badRequest("积分不足，完成签到和练习可以继续积累", "insufficient_points");
    await tx.insert(rewardLedger).values({ userId, eventKey: `redeem:${requestId}`, kind: "redeem", points: -r.voucherCost, day, note: `兑换 ${r.voucherMinutes} 分钟券（${r.voucherDays} 天有效）`, createdAt: now });
    const [credit] = await tx.insert(minuteCredit).values({ userId, redemptionKey: requestId, totalSeconds: r.voucherMinutes * 60, remainingSeconds: r.voucherMinutes * 60, expiresAt: new Date(now.getTime() + r.voucherDays * 86400_000), createdAt: now }).returning();
    return credit;
  });
}
export async function rewardCompletedPractice(sessionId: string) {
  const settings = (await getSettings()).rewards;
  if (!settings.enabled) return;
  await db.transaction(async tx => {
    const [s] = await tx.select().from(practiceSession).where(and(eq(practiceSession.id, sessionId), isNull(practiceSession.deletedAt)));
    if (!s || s.status !== "completed" || !s.endedAt || s.timeScale !== 1) return;
    const [activation] = await tx.select().from(appSetting).where(eq(appSetting.key, "rewardsStartedAt"));
    if (!activation || s.createdAt < new Date(activation.value as string)) return;
    await walletLock(tx, s.userId);
    // Require server-decoded real audio and speech metrics. Mock transcripts or score estimates never earn points.
    const recordings = await tx.select().from(answer).where(and(eq(answer.sessionId, s.id), eq(answer.interrupted, false)));
    if (!recordings.some(a => !!a.storageKey && (a.durationMs ?? 0) >= 5000 && !(a.metrics as { overLimit?: boolean })?.overLimit && a.status !== "insufficient" && Number((a.metrics as { speechSec?: number })?.speechSec ?? 0) >= 3)) return;
    const day = rewardDay(s.endedAt);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(rewardLedger).where(and(eq(rewardLedger.userId, s.userId), eq(rewardLedger.day, day), eq(rewardLedger.kind, "practice")));
    if (count.n < settings.practiceLimit) await award(tx, s.userId, "practice", `practice:${s.id}`, day, settings.practice, "完成有效口语练习", settings.dailyCap);
    if (s.mode === "retry" && s.sourceAnswerId) {
      const [visit] = await tx.select().from(reviewVisit).where(and(eq(reviewVisit.userId, s.userId), eq(reviewVisit.answerId, s.sourceAnswerId)));
      if (visit && visit.createdAt <= s.createdAt) await award(tx, s.userId, "review", `review:${day}`, day, settings.review, "复盘后完成重练", settings.dailyCap);
    }
  });
}
export async function markReviewed(userId: string, answerId: string) {
  const [owned] = await db.select({ id: answer.id }).from(answer).innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId)).where(and(eq(answer.id, answerId), eq(answer.userId, userId), isNull(practiceSession.deletedAt)));
  if (!owned) throw notFound("回答");
  await db.insert(reviewVisit).values({ userId, answerId }).onConflictDoNothing();
}
export async function adjustPoints(adminId: string, userId: string, points: number, note: string, key: string) {
  if (!Number.isInteger(points) || !points || Math.abs(points) > 10000 || note.trim().length < 3 || note.length > 200 || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw badRequest("请填写有效积分数和调整原因（3–200 字）");
  return db.transaction(async tx => {
    await walletLock(tx, userId);
    const [owner] = await tx.select().from(user).where(and(eq(user.id, userId), isNull(user.deletedAt)));
    if (!owner) throw notFound("账号");
    const [old] = await tx.select().from(rewardLedger).where(and(eq(rewardLedger.userId, userId), eq(rewardLedger.eventKey, `adjust:${key}`)));
    if (old) return;
    if (await balance(tx, userId) + points < 0) throw badRequest("调整后积分不能为负数");
    await tx.insert(rewardLedger).values({ userId, eventKey: `adjust:${key}`, kind: "adjust", points, day: rewardDay(), note: note.trim(), actorId: adminId });
  });
}
export async function getRewards(userId: string) {
  const [points, checkins, ledger, credits, settings] = await Promise.all([
    balance(db, userId), db.select().from(dailyCheckin).where(eq(dailyCheckin.userId, userId)).orderBy(desc(dailyCheckin.day)),
    db.select().from(rewardLedger).where(eq(rewardLedger.userId, userId)).orderBy(desc(rewardLedger.createdAt)).limit(60),
    db.select().from(minuteCredit).where(and(eq(minuteCredit.userId, userId), gt(minuteCredit.expiresAt, new Date()))).orderBy(minuteCredit.expiresAt), getSettings(),
  ]);
  const today = rewardDay(); const latest = checkins[0];
  return { points, checkedIn: latest?.day === today, streak: latest && [today, previousDay(today)].includes(latest.day) ? latest.streak : 0, totalDays: checkins.length, ledger, credits, rules: settings.rewards };
}
