import { and, eq, gte, isNull, lt, or } from "drizzle-orm";
import { answer, dailyCheckin, practiceSession, question, reviewVisit, rewardLedger } from "@/db/schema";
import { db } from "@/lib/db";
import { dayDate, rewardDay } from "@/lib/services/rewards";
import type { SessionPlan } from "@/lib/sessions/plan";

export interface GrowthEvent { day: string; at: string; points?: number; type: "checkin" | "practice" | "mock" | "retry" | "review" | "points"; title: string; href?: string; seconds?: number; status?: string }
export async function getGrowth(userId: string, requestedMonth?: string, now = new Date()) {
  const today = rewardDay(now);
  const month = requestedMonth && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
  const start = dayDate(`${month}-01`), nextMonth = new Date(`${month}-01T12:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const end = dayDate(`${nextMonth.toISOString().slice(0, 7)}-01`);
  const recentStart = new Date(dayDate(today).getTime() - 29 * 86400_000);
  const from = start < recentStart ? start : recentStart;
  const until = end > now ? end : new Date(now.getTime() + 1);
  const [sessions, recordings, checkins, reviews, ledger] = await Promise.all([
    db.select().from(practiceSession).where(and(eq(practiceSession.userId, userId), isNull(practiceSession.deletedAt), or(gte(practiceSession.createdAt, from), gte(practiceSession.endedAt, from)), lt(practiceSession.createdAt, until))),
    db.select({ at: answer.createdAt, sessionId: answer.sessionId, duration: answer.durationMs, speech: answer.metrics, topic: question.topic, session: practiceSession }).from(answer)
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId)).innerJoin(question, eq(question.id, answer.questionId))
      .where(and(eq(answer.userId, userId), isNull(practiceSession.deletedAt), gte(answer.createdAt, from), lt(answer.createdAt, until))),
    db.select().from(dailyCheckin).where(and(eq(dailyCheckin.userId, userId), gte(dailyCheckin.day, rewardDay(from)), lt(dailyCheckin.day, rewardDay(until)))),
    db.select({ at: reviewVisit.createdAt, id: answer.id, sessionId: answer.sessionId }).from(reviewVisit).innerJoin(answer, eq(answer.id, reviewVisit.answerId))
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId)).where(and(eq(reviewVisit.userId, userId), isNull(practiceSession.deletedAt), gte(reviewVisit.createdAt, from), lt(reviewVisit.createdAt, until))),
    db.select().from(rewardLedger).where(and(eq(rewardLedger.userId, userId), gte(rewardLedger.createdAt, from), lt(rewardLedger.createdAt, until))),
  ]);
  const visibleSessions = new Map([...sessions, ...recordings.map(a => a.session)].map(s => [s.id, s]));
  const events: GrowthEvent[] = [
    ...[...visibleSessions.values()].flatMap(s => {
      const days = new Set([rewardDay(s.createdAt), ...recordings.filter(a => a.sessionId === s.id).map(a => rewardDay(a.at))]);
      return [...days].map(day => ({ day, at: (recordings.find(a => a.sessionId === s.id && rewardDay(a.at) === day)?.at ?? s.createdAt).toISOString(), type: (s.mode === "mock" ? "mock" : s.mode === "retry" ? "retry" : "practice") as GrowthEvent["type"], title: (s.plan as SessionPlan).title, href: s.status === "active" ? `/interview/${s.id}` : `/sessions/${s.id}`, status: s.status, seconds: Math.round(recordings.filter(a => a.sessionId === s.id && rewardDay(a.at) === day).reduce((n, a) => n + (a.duration ?? 0) / 1000, 0)) }));
    }),
    ...checkins.map(c => ({ day: c.day, at: c.createdAt.toISOString(), type: "checkin" as const, title: `签到 · 连续 ${c.streak} 天` })),
    ...reviews.map(r => ({ day: rewardDay(r.at), at: r.at.toISOString(), type: "review" as const, title: "回答复盘与同题对比", href: `/answers/${r.id}` })),
    ...ledger.map(l => ({ day: l.day, at: l.createdAt.toISOString(), type: "points" as const, title: l.note, points: l.points, href: "/rewards" })),
  ];
  const stats = (days: number) => {
    const since = new Date(dayDate(today).getTime() - (days - 1) * 86400_000);
    const actual = recordings.filter(a => a.at >= since && a.duration !== null && a.duration > 0);
    return { days: new Set(actual.map(a => rewardDay(a.at))).size, seconds: Math.round(actual.reduce((n, a) => n + (a.duration ?? 0) / 1000, 0)), speechSeconds: Math.round(actual.reduce((n, a) => n + Number((a.speech as { speechSec?: number })?.speechSec ?? 0), 0)), topics: new Set(actual.map(a => a.topic)).size, retries: sessions.filter(s => s.endedAt && s.endedAt >= since && s.mode === "retry" && s.status === "completed").length };
  };
  return { month, today, events: events.filter(e => e.day.startsWith(month)), week: stats(7), monthStats: stats(30), dailySeconds: Array.from({ length: 30 }, (_, i) => {
    const day = rewardDay(new Date(recentStart.getTime() + i * 86400_000));
    return { day, seconds: Math.round(recordings.filter(a => rewardDay(a.at) === day).reduce((n, a) => n + (a.duration ?? 0) / 1000, 0)) };
  }) };
}
