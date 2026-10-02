import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { answer, feedback, practiceSession, retryItem, reviewCompletion, reviewSchedule } from "@/db/schema";
import { db } from "@/lib/db";
import { listPublishedQuestions } from "@/lib/services/content";
export const reviewIntervalDays = (count: number) => [1, 3, 7, 14][Math.min(Math.max(count - 1, 0), 3)];

export async function scheduleCompletedReview(sessionId: string) {
  const [s] = await db.select().from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (!s || s.deletedAt || s.status !== "completed" || s.timeScale !== 1) return;
  const rows = await db.select().from(answer).where(and(eq(answer.sessionId, s.id), eq(answer.kind, "main"), eq(answer.status, "done"), eq(answer.interrupted, false)));
  const valid = rows.filter(a => (a.durationMs ?? 0) >= 5000 && Number((a.metrics as { speechSec?: number })?.speechSec ?? 0) >= 3);
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`review:${s.userId}`}, 0))`);
    for (const questionId of new Set(valid.map(a => a.questionId))) {
      const inserted = await tx.insert(reviewCompletion).values({ sessionId, questionId }).onConflictDoNothing().returning();
      if (!inserted.length) continue;
      const completed = await tx.select({ at: practiceSession.endedAt }).from(reviewCompletion)
        .innerJoin(practiceSession, eq(practiceSession.id, reviewCompletion.sessionId))
        .where(and(eq(practiceSession.userId, s.userId), eq(reviewCompletion.questionId, questionId), isNull(practiceSession.deletedAt)))
        .orderBy(desc(practiceSession.endedAt));
      const lastPracticedAt = completed[0]?.at ?? s.endedAt ?? s.createdAt;
      const values = { completedCount: completed.length, lastPracticedAt,
        nextDueAt: new Date(lastPracticedAt.getTime() + reviewIntervalDays(completed.length) * 86400000) };
      await tx.insert(reviewSchedule).values({ userId: s.userId, questionId, ...values })
        .onConflictDoUpdate({ target: [reviewSchedule.userId, reviewSchedule.questionId], set: values });
      // A new manual mark made after this practice must remain open.
      await tx.update(retryItem).set({ doneAt: new Date() }).where(and(eq(retryItem.userId, s.userId), eq(retryItem.questionId, questionId),
        isNull(retryItem.doneAt), sql`${retryItem.createdAt} <= ${s.endedAt ?? s.createdAt}`));
    }
  });
}

export async function getReviewQueue(userId: string, now = new Date()) {
  const [latest, manual, schedules, published] = await Promise.all([
    db.selectDistinctOn([answer.questionId], { a: answer, endedAt: practiceSession.endedAt, fb: feedback }).from(answer)
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
      .leftJoin(feedback, and(eq(feedback.answerId, answer.id), eq(feedback.isCurrent, true)))
      .where(and(eq(answer.userId, userId), eq(answer.kind, "main"), eq(answer.status, "done"), eq(answer.interrupted, false),
        eq(practiceSession.status, "completed"), eq(practiceSession.timeScale, 1), isNull(practiceSession.deletedAt)))
      .orderBy(answer.questionId, desc(answer.createdAt)),
    db.select({ r: retryItem, a: answer }).from(retryItem).innerJoin(answer, eq(answer.id, retryItem.sourceAnswerId))
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
      .where(and(eq(retryItem.userId, userId), eq(answer.userId, userId), isNull(retryItem.doneAt), isNull(practiceSession.deletedAt))),
    db.select().from(reviewSchedule).where(eq(reviewSchedule.userId, userId)), listPublishedQuestions(),
  ]);
  const available = new Set(published.map(q => q.id));
  const scheduleBy = new Map(schedules.map(s => [s.questionId, s]));
  const items = new Map<string, { questionId: string; sourceAnswerId: string; text: string; reason: string; dueAt: string; manualId?: string }>();
  for (const row of latest) {
    const a = row.a; if (!available.has(a.questionId)) continue;
    const schedule = scheduleBy.get(a.questionId);
    // If the most recent scheduled practice was deleted, derive from surviving records.
    const scheduleCurrent = schedule && schedule.lastPracticedAt.getTime() === row.endedAt?.getTime();
    const due = scheduleCurrent ? schedule.nextDueAt : new Date((row.endedAt ?? a.createdAt).getTime() + 7 * 86400000);
    const fb = row.fb;
    const unmet = fb && !fb.mock && !fb.goalMet && a.transcriptMock === false;
    items.set(a.questionId, { questionId: a.questionId, sourceAnswerId: a.id, text: a.promptText, dueAt: due.toISOString(),
      reason: unmet ? `上次目标待练习：${fb.goalReason}` : scheduleCurrent ? `按练习时间复习 · 上次完成后间隔 ${reviewIntervalDays(schedule.completedCount)} 天` : "这道题已一段时间没有练习，回顾一下表达" });
  }
  for (const { r, a } of manual) if (available.has(r.questionId)) items.set(r.questionId, {
    questionId: r.questionId, sourceAnswerId: a.id, text: a.promptText, manualId: r.id,
    dueAt: r.createdAt.toISOString(), reason: `你标记了这道题${r.note ? `：${r.note}` : "，想再练一次"}`,
  });
  const ordered = [...items.values()].sort((a,b) => Number(!!b.manualId) - Number(!!a.manualId) || a.dueAt.localeCompare(b.dueAt));
  // Manual choices are immediately actionable, even if DB and app clocks differ slightly.
  return { due: ordered.filter(i => i.manualId || Date.parse(i.dueAt) <= now.getTime()), upcoming: ordered.filter(i => !i.manualId && Date.parse(i.dueAt) > now.getTime()) };
}
