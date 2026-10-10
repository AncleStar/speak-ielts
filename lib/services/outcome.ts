import { and, eq, inArray, sql } from "drizzle-orm";
import { answer, feedback, practiceSession, progress } from "@/db/schema";
import { db } from "@/lib/db";
import type { SessionPlan } from "@/lib/sessions/plan";
import { rewardCompletedPractice } from "@/lib/services/rewards";
import { scheduleCompletedReview } from "@/lib/services/reviews";

export const PENDING_STATUSES = ["created", "uploaded", "queued", "processing"] as const;

export interface GoalItemResult {
  index: number;
  met: boolean;
  reason: string;
  evaluated: boolean;
}

export interface SessionSummary {
  answers: number;
  done: number;
  pending: number;
  failed: number;
  insufficient: number;
  durationSec: number;
  speechSec: number;
  goal: {
    applicable: boolean;
    description: string;
    metCount: number;
    requiredMet: number;
    of: number;
    met: boolean | null;
    items: GoalItemResult[];
  };
  complete: boolean;
  updatedAt: string;
}

type AnswerLite = {
  id: string;
  planIndex: number;
  kind: string;
  status: string;
  durationMs: number | null;
  clientDurationMs: number | null;
  metrics: unknown;
  interrupted?: boolean;
  storageKey?: string | null;
};
type FeedbackLite = { answerId: string; goalMet: boolean; goalReason: string; mock?: boolean };

/** 由回答与反馈汇总会话结果（纯函数） */
export function summarize(plan: SessionPlan, status: string, answers: AnswerLite[], feedbacks: FeedbackLite[]): SessionSummary {
  const fbByAnswer = new Map(feedbacks.filter(f => !f.mock).map((f) => [f.answerId, f]));
  const uploaded = answers.filter((a) => a.status !== "created" && (a.storageKey === undefined || a.storageKey !== null || a.durationMs !== null));
  const pending = uploaded.filter((a) => (PENDING_STATUSES as readonly string[]).includes(a.status)).length;
  const items: GoalItemResult[] = [];
  let metCount = 0;
  const goal = plan.goal;
  const applicable = !!goal && plan.mode !== "mock" && goal.of > 0;
  if (applicable) {
    for (const item of plan.items) {
      const attempts = uploaded.filter((a) => a.planIndex === item.index && !a.interrupted && goal!.countKinds.includes(a.kind as never));
      const evaluated = attempts.filter((a) => fbByAnswer.has(a.id));
      const metAttempt = evaluated.find((a) => fbByAnswer.get(a.id)!.goalMet);
      const last = evaluated.at(-1);
      const met = !!metAttempt;
      if (met) metCount++;
      items.push({
        index: item.index,
        met,
        evaluated: evaluated.length > 0,
        reason: metAttempt
          ? fbByAnswer.get(metAttempt.id)!.goalReason
          : last
            ? fbByAnswer.get(last.id)!.goalReason
            : attempts.some((a) => a.status === "insufficient")
              ? "有效语音过短，无法充分评价"
              : attempts.length
                ? "尚无真实反馈可评价（处理中、演示或生成失败）"
                : uploaded.some(a => a.planIndex === item.index && a.interrupted) ? "录音中断，请完整作答后再评价目标" : "未作答",
      });
    }
  }
  const durationSec = uploaded.reduce((s, a) => s + (a.durationMs ?? a.clientDurationMs ?? 0) / 1000, 0);
  const speechSec = uploaded.reduce((s, a) => s + (((a.metrics as { speechSec?: number } | null)?.speechSec as number) ?? 0), 0);
  let met: boolean | null = null;
  if (plan.mode === "mock") met = status === "completed";
  else if (applicable && pending === 0 && status === "completed" && items.some(i => i.evaluated)) met = metCount >= goal!.requiredMet;
  return {
    answers: uploaded.length,
    done: uploaded.filter((a) => a.status === "done").length,
    pending,
    failed: uploaded.filter((a) => a.status === "failed").length,
    insufficient: uploaded.filter((a) => a.status === "insufficient").length,
    durationSec: Math.round(durationSec),
    speechSec: Math.round(speechSec),
    goal: {
      applicable: applicable || plan.mode === "mock",
      description: goal?.description ?? "",
      metCount,
      requiredMet: goal?.requiredMet ?? 0,
      of: goal?.of ?? 0,
      met,
      items,
    },
    complete: pending === 0,
    updatedAt: new Date().toISOString(),
  };
}

/** 重新计算会话汇总，并在会话完成时更新关卡"目标达成"记录 */
export async function recomputeSessionOutcome(sessionId: string): Promise<SessionSummary | null> {
  const [s] = await db.select().from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (!s) return null;
  const plan = s.plan as SessionPlan;
  const answers = await db
    .select({
      id: answer.id,
      planIndex: answer.planIndex,
      kind: answer.kind,
      status: answer.status,
      durationMs: answer.durationMs,
      storageKey: answer.storageKey,
      clientDurationMs: answer.clientDurationMs,
      metrics: answer.metrics,
      interrupted: answer.interrupted,
    })
    .from(answer)
    .where(eq(answer.sessionId, sessionId))
    .orderBy(answer.planIndex, answer.attempt);
  const ids = answers.map((a) => a.id);
  const fbs = ids.length
    ? await db
        .select({ answerId: feedback.answerId, goalMet: feedback.goalMet, goalReason: feedback.goalReason, mock: feedback.mock })
        .from(feedback)
        .where(and(inArray(feedback.answerId, ids), eq(feedback.isCurrent, true)))
    : [];
  const summary = summarize(plan, s.status, answers, fbs);
  await db.update(practiceSession).set({ report: summary }).where(eq(practiceSession.id, sessionId));

  if (s.levelId && s.status === "completed" && summary.goal.met !== null) {
    const now = new Date();
    await db
      .insert(progress)
      .values({
        userId: s.userId,
        levelId: s.levelId,
        completedAt: s.endedAt ?? now,
        goalMetAt: summary.goal.met ? now : null,
        bestSessionId: s.id,
        bestGoalCount: summary.goal.metCount,
        attempts: 1,
      })
      .onConflictDoUpdate({
        target: [progress.userId, progress.levelId],
        set: {
          goalMetAt: summary.goal.met ? sql`coalesce(${progress.goalMetAt}, ${now})` : sql`${progress.goalMetAt}`,
          bestSessionId: sql`case when ${progress.bestSessionId} is null or ${summary.goal.metCount} > ${progress.bestGoalCount} then ${s.id} else ${progress.bestSessionId} end`,
          bestGoalCount: sql`greatest(${progress.bestGoalCount}, ${summary.goal.metCount})`,
          updatedAt: now,
        },
      });
  }
  await rewardCompletedPractice(sessionId);
  await scheduleCompletedReview(sessionId);
  return summary;
}
