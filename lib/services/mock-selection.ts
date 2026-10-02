import { and, eq, isNull, sql } from "drizzle-orm";
import { mockSet, practiceSession } from "@/db/schema";
import { db } from "@/lib/db";
import { publishedVersions } from "./content";

export async function getMockCatalog(userId: string) {
  const [sets, history, active] = await Promise.all([
    db.select().from(mockSet),
    db.select({
      id: practiceSession.mockSetId,
      attempts: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${practiceSession.status} = 'completed')::int`,
      lastAttempt: sql<Date | string>`max(${practiceSession.startedAt})`,
    }).from(practiceSession).where(and(eq(practiceSession.userId, userId), eq(practiceSession.mode, "mock"), isNull(practiceSession.deletedAt), sql`${practiceSession.startedAt} is not null`, sql`coalesce((${practiceSession.plan}->>'timeScale')::numeric, 1) = 1`)).groupBy(practiceSession.mockSetId),
    db.select({ id: practiceSession.id, setId: practiceSession.mockSetId }).from(practiceSession).where(and(eq(practiceSession.userId, userId), eq(practiceSession.mode, "mock"), eq(practiceSession.status, "active"), isNull(practiceSession.deletedAt))),
  ]);
  const plans = sets.map(s => ({ ...s, questions: s.plan as { part1: string[]; part2: string; part3: string[] } }));
  const ids = (p: typeof plans[number]) => [...p.questions.part1, p.questions.part2, ...p.questions.part3];
  const versions = await publishedVersions([...new Set(plans.flatMap(ids))]);
  const items = plans.sort((a,b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(s => {
    const h = history.find(h => h.id === s.id);
    const questions = ids(s);
    return {
      id: s.id, title: s.title,
      available: questions.length > 0 && questions.every(id => versions.has(id)),
      topics: [...new Set(questions.map(id => versions.get(id)?.content.topicName).filter(Boolean))].join(" / "),
      draft: questions.some(id => versions.get(id)?.reviewStatus !== "approved"),
      attempts: h?.attempts ?? 0, completed: h?.completed ?? 0,
      lastAttempt: h?.lastAttempt ? new Date(h.lastAttempt).toISOString() : null,
      activeSessionId: active.find(a => a.setId === s.id)?.id ?? null,
    };
  });
  // Start with an untried paper, then the least recently attempted paper. Never use level progress.
  const candidates = items.filter(s => s.available && !s.activeSessionId).sort((a,b) =>
    (a.lastAttempt ? new Date(a.lastAttempt).getTime() : 0) - (b.lastAttempt ? new Date(b.lastAttempt).getTime() : 0));
  const next = candidates[0];
  return { items, recommendedId: next?.id ?? null, recommendation: next ? (next.lastAttempt ? "这套距离上次练习最久" : "这套还没有开始练过") : null };
}
