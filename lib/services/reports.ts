import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { answer, feedback, level, practiceSession, progress, retryItem } from "@/db/schema";
import { db } from "@/lib/db";
import type { StoredFeedback } from "@/lib/feedback/schema";
import { getQuotaStatus } from "@/lib/quota";
import { publicAnswer } from "@/lib/services/answers";
import { levelAvailability, listLevels, publishedVersions } from "@/lib/services/content";
import { summarize } from "@/lib/services/outcome";
import { getOwnedSession, listSessions } from "@/lib/services/sessions";
import type { SessionPlan } from "@/lib/sessions/plan";

export type PublicAnswer = ReturnType<typeof publicAnswer>;
export interface AttemptView {
  answer: PublicAnswer;
  feedback: { id: string; data: StoredFeedback; goalMet: boolean; goalReason: string; basedOnCorrection: boolean; mock: boolean; model: string; createdAt: Date } | null;
}

export async function getSessionReport(userId: string, sessionId: string) {
  const s = await getOwnedSession(userId, sessionId);
  const plan = s.plan as SessionPlan;
  const rows = await db.select().from(answer).where(eq(answer.sessionId, s.id)).orderBy(asc(answer.planIndex), asc(answer.createdAt));
  const ids = rows.map((r) => r.id);
  const fbs = ids.length
    ? await db
        .select()
        .from(feedback)
        .where(and(inArray(feedback.answerId, ids), eq(feedback.isCurrent, true)))
    : [];
  const fbMap = new Map(fbs.map((f) => [f.answerId, f]));
  const view = (a: typeof answer.$inferSelect): AttemptView => {
    const f = fbMap.get(a.id);
    return {
      answer: publicAnswer(a),
      feedback: f
        ? {
            id: f.id,
            data: f.data as StoredFeedback,
            goalMet: f.goalMet,
            goalReason: f.goalReason,
            basedOnCorrection: f.basedOnCorrection,
            mock: f.mock,
            model: f.model,
            createdAt: f.createdAt,
          }
        : null,
    };
  };
  const uploaded = rows.filter((r) => r.status !== "created");
  const items = plan.items.map((item) => ({
    index: item.index,
    part: item.part,
    kind: item.kind,
    questionId: item.questionId,
    topicName: item.topicName,
    prompt: item.prompt.text,
    zh: item.zh,
    card: item.card,
    draft: item.draft,
    itemRule: item.itemRule,
    skipped: s.skipped.includes(item.index),
    attempts: uploaded.filter((r) => r.planIndex === item.index && r.kind === item.kind).map(view),
    followUps: uploaded.filter((r) => r.planIndex === item.index && r.kind === "followup" && item.kind !== "followup").map(view),
  }));
  const summary = summarize(
    plan,
    s.status,
    rows,
    fbs.map((f) => ({ answerId: f.answerId, goalMet: f.goalMet, goalReason: f.goalReason, mock: f.mock })),
  );
  const state = uploaded.length === 0 ? "empty" : summary.pending > 0 ? "processing" : summary.failed > 0 ? "partial" : "complete";
  return {
    session: {
      id: s.id,
      mode: s.mode,
      status: s.status,
      levelId: s.levelId,
      mockSetId: s.mockSetId,
      interruptReason: s.interruptReason,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    },
    plan: {
      title: plan.title,
      subtitle: plan.subtitle,
      mode: plan.mode,
      chapter: plan.chapter,
      goal: plan.goal,
      draft: plan.draft,
      timeScale: plan.timeScale,
    },
    items,
    summary,
    state,
    anyMock: fbs.some((f) => f.mock),
  };
}

/** 首页：继续上次练习、今日建议、待重练、最近记录、额度提示 */
export async function getHomeData(userId: string) {
  const [active] = await db
    .select({ id: practiceSession.id, plan: practiceSession.plan, mode: practiceSession.mode, createdAt: practiceSession.createdAt })
    .from(practiceSession)
    .where(and(eq(practiceSession.userId, userId), eq(practiceSession.status, "active"), isNull(practiceSession.deletedAt)))
    .orderBy(desc(practiceSession.lastActivityAt))
    .limit(1);
  const retries = await db
    .select()
    .from(retryItem)
    .where(and(eq(retryItem.userId, userId), isNull(retryItem.doneAt)))
    .orderBy(desc(retryItem.createdAt))
    .limit(10);
  const pv = await publishedVersions(retries.map((r) => r.questionId));
  const retryList = retries.map((r) => {
    const v = pv.get(r.questionId);
    return { id: r.id, questionId: r.questionId, sourceAnswerId: r.sourceAnswerId, text: v?.content.text ?? r.questionId, part: v?.content.part, available: !!v, createdAt: r.createdAt };
  });
  const levelData = await getLevelMap(userId);
  const next = levelData.levels.find((l) => l.available && !l.completed && l.chapter <= 5);
  const recent = await listSessions(userId, { limit: 5 });
  const quota = await getQuotaStatus(userId);
  return {
    active: active ? { id: active.id, title: (active.plan as SessionPlan).title, mode: active.mode, createdAt: active.createdAt } : null,
    retryList,
    nextLevel: next ?? null,
    recent,
    quota,
    stats: { completed: levelData.levels.filter((l) => l.completed).length, goalMet: levelData.levels.filter((l) => l.goalMet).length, total: levelData.levels.length },
  };
}

export async function getLevelMap(userId: string) {
  const levels = await listLevels();
  const avail = await levelAvailability(levels);
  const prog = await db.select().from(progress).where(eq(progress.userId, userId));
  const pm = new Map(prog.map((p) => [p.levelId, p]));
  const activeRows = await db
    .select({ levelId: practiceSession.levelId, id: practiceSession.id })
    .from(practiceSession)
    .where(and(eq(practiceSession.userId, userId), eq(practiceSession.status, "active"), isNull(practiceSession.deletedAt), sql`${practiceSession.levelId} is not null`));
  const activeMap = new Map(activeRows.map((r) => [r.levelId!, r.id]));
  let prevCompleted = true;
  const out = levels.map((l) => {
    const p = pm.get(l.id);
    const completed = !!p?.completedAt;
    // 按顺序推荐：第 1–5 章前一关完成后解锁下一关；第 6 章（模考）始终开放
    const unlocked = l.chapter === 6 || prevCompleted;
    if (l.chapter <= 5) prevCompleted = completed;
    return {
      id: l.id,
      chapter: l.chapter,
      order: l.order,
      title: l.title,
      available: avail.get(l.id) ?? false,
      unlocked,
      completed,
      goalMet: !!p?.goalMetAt,
      attempts: p?.attempts ?? 0,
      bestSessionId: p?.bestSessionId ?? null,
      activeSessionId: activeMap.get(l.id) ?? null,
      timing: l.timing,
      goalRule: l.goalRule,
      questionIds: l.questionIds,
      mockSetId: l.mockSetId,
    };
  });
  return { levels: out };
}

export async function getLevelDetail(userId: string, levelId: string) {
  const { levels } = await getLevelMap(userId);
  const l = levels.find((x) => x.id === levelId);
  if (!l) return null;
  const [row] = await db.select().from(level).where(eq(level.id, levelId));
  return { ...l, hints: row.hints };
}
