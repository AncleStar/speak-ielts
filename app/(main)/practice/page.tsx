import type { Metadata } from "next";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { answer, practiceSession } from "@/db/schema";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-server";
import { listPublishedQuestions } from "@/lib/services/content";
import { DiscLibrary } from "@/components/disc/disc-library";

export const metadata: Metadata = { title: "训练磁盘 · 题库练习" };
export default async function PracticePage({ searchParams }: { searchParams: Promise<{ part?: string; topic?: string; q?: string; disc?:string }> }) {
  const u = await requireUser();
  const [sp, questions, records] = await Promise.all([searchParams, listPublishedQuestions(), db.select({
    questionId: answer.questionId, count: count(), latestId: sql<string>`(array_agg(${answer.id} ORDER BY ${answer.createdAt} DESC))[1]`,
  }).from(answer).innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
    .where(and(eq(answer.userId, u.id), eq(answer.kind, "main"), ne(answer.status, "created"), isNull(practiceSession.deletedAt))).groupBy(answer.questionId)]);
  const selected=questions.find(q=>q.id===sp.disc);
  return <DiscLibrary questions={questions} records={records} initialPart={sp.part === "2" ? 2 : sp.part === "3" ? 3 : selected?.part??1} initialTopic={sp.topic ?? ""} initialQuery={sp.q ?? ""} initialDisc={selected?.id} explicitLocation={!!(sp.part||sp.topic||sp.q||sp.disc)} />;
}
