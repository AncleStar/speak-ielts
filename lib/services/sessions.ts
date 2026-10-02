import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { answer, level, mockSet, practiceSession, progress, retryItem, sessionEvent, ttsAsset, user } from "@/db/schema";
import { getChapter, getPhrases } from "@/lib/content/load";
import type { Hints } from "@/lib/content/types";
import { db } from "@/lib/db";
import { timeScale } from "@/lib/env";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { buildFollowUpMessages } from "@/lib/feedback/prompt";
import { validateFollowUpChoice } from "@/lib/feedback/validate";
import { logOps } from "@/lib/ops";
import { withLock } from "@/lib/lock";
import { providers } from "@/lib/providers";
import { assertCanStartSession, getQuotaStatus, reserveSessionQuota } from "@/lib/quota";
import { requirePublished } from "@/lib/services/content";
import { recomputeSessionOutcome } from "@/lib/services/outcome";
import { ensureTtsAssets } from "@/lib/services/tts";
import {
  attachTtsIds,
  buildLevelPlan,
  buildMockPlan,
  buildSingleQuestionPlan,
  collectPromptTexts,
  requiredSlots,
  type AnswerKind,
  type SessionPlan,
} from "@/lib/sessions/plan";
import { FOLLOWUP_WAIT_SECONDS, mockPartDurationMs, startOfDayShanghai } from "@/lib/timing";
import { metered } from "@/lib/providers/metered";

export type SessionRow = typeof practiceSession.$inferSelect;

export interface CreateSessionInput {
  mode: "level" | "mock" | "practice" | "retry";
  levelId?: string;
  mockSetId?: string;
  questionId?: string;
  sourceAnswerId?: string;
  fresh?: boolean;
}

type UserLite = { id: string; consentAt: Date | null };

async function buildPlan(u: UserLite, input: CreateSessionInput): Promise<{ plan: SessionPlan; levelId?: string; mockSetId?: string; questionId?: string; sourceAnswerId?: string }> {
  const scale = timeScale();
  const phrases = getPhrases();
  if (input.mode === "level") {
    if (!input.levelId) throw badRequest("缺少关卡编号");
    const [l] = await db.select().from(level).where(eq(level.id, input.levelId));
    if (!l) throw notFound("关卡");
    if (l.mockSetId) return buildPlan(u, { mode: "mock", mockSetId: l.mockSetId, fresh: input.fresh });
    const [previous] = await db.select({ id: level.id }).from(level)
      .where(sql`(${level.chapter} < ${l.chapter} or (${level.chapter} = ${l.chapter} and ${level.order} < ${l.order})) and ${level.chapter} <= 5`)
      .orderBy(desc(level.chapter), desc(level.order)).limit(1);
    if (previous) {
      const [done] = await db.select({ completedAt: progress.completedAt }).from(progress).where(and(eq(progress.userId, u.id), eq(progress.levelId, previous.id)));
      if (!done?.completedAt) throw forbidden("请先完成上一关，或前往题库自由练习", "level_locked");
    }
    const questions = await requirePublished(l.questionIds);
    const plan = buildLevelPlan({ levelId: l.id, levelTitle: l.title, chapter: getChapter(l.chapter), questions, phrases, scale });
    return { plan, levelId: l.id };
  }
  if (input.mode === "mock") {
    const setId = input.mockSetId ?? "mock-1";
    const [m] = await db.select().from(mockSet).where(eq(mockSet.id, setId));
    if (!m) throw notFound("模考题组");
    const p = m.plan as { part1: string[]; part2: string; part3: string[] };
    const all = await requirePublished([...p.part1, p.part2, ...p.part3]);
    const plan = buildMockPlan({
      title: m.title,
      part1: all.slice(0, p.part1.length),
      part2: all[p.part1.length],
      part3: all.slice(p.part1.length + 1),
      phrases,
      scale,
    });
    const [l] = await db.select({ id: level.id }).from(level).where(eq(level.mockSetId, m.id));
    return { plan, mockSetId: m.id, levelId: l?.id };
  }
  if (input.mode === "practice") {
    if (!input.questionId) throw badRequest("缺少题目编号");
    const [q] = await requirePublished([input.questionId]);
    return { plan: buildSingleQuestionPlan({ mode: "practice", question: q, phrases, scale }), questionId: input.questionId };
  }
  // 重练：沿用原题的计时与提示；使用题目当前发布版本
  if (!input.sourceAnswerId && !input.questionId) throw badRequest("缺少重练来源");
  let questionId = input.questionId;
  let answerSeconds: number | undefined;
  let prepSeconds: number | undefined;
  let hints: Hints | undefined;
  let itemRule: string | undefined;
  let minEffective: number | undefined;
  let retryPrompt: { text: string; zh: string; id: string | null } | undefined;
  if (input.sourceAnswerId) {
    const [src] = await db
      .select({ a: answer, s: practiceSession })
      .from(answer)
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
      .where(and(eq(answer.id, input.sourceAnswerId), eq(answer.userId, u.id), isNull(practiceSession.deletedAt)));
    if (!src) throw notFound("原回答");
    questionId = src.a.questionId;
    const plan = src.s.plan as SessionPlan;
    const item = plan.items[src.a.planIndex];
    const scaleOf = plan.timeScale || 1;
    if (src.a.kind !== "main") {
      retryPrompt = { text: src.a.promptText, zh: item?.followUp?.candidates.find(c => c.id === src.a.followUpId)?.zh ?? item?.zh ?? "请直接回应追问", id: src.a.followUpId };
      answerSeconds = 45; prepSeconds = 0;
    }
    if (item && src.a.kind === "main" && plan.mode !== "mock") {
      answerSeconds = item.answerSeconds ? item.answerSeconds / scaleOf : undefined;
      prepSeconds = item.prepSeconds ? item.prepSeconds / scaleOf : undefined;
      hints = plan.hints;
      itemRule = item.itemRule;
      minEffective = item.minEffectiveSeconds ? item.minEffectiveSeconds / scaleOf : undefined;
    } else if (item && src.a.kind === "followup" && item.followUp) {
      answerSeconds = item.followUp.answerSeconds / scaleOf;
    }
  }
  const [q] = await requirePublished([questionId!]);
  const retryPlan = buildSingleQuestionPlan({ mode: "retry", question: q, phrases, scale, answerSeconds, prepSeconds, hints, itemRule, minEffectiveSeconds: minEffective });
  if (retryPrompt) {
    Object.assign(retryPlan.items[0], { prompt: { text: retryPrompt.text, ttsId: null }, zh: retryPrompt.zh, followUpId: retryPrompt.id, card: undefined, lead: [], prepSeconds: 0, itemRule: "直接回应追问，并补充具体理由或例子" });
  }
  return {
    plan: retryPlan,
    questionId,
    sourceAnswerId: input.sourceAnswerId,
  };
}

/** 创建训练 / 模考 / 自由练习 / 重练会话：检查额度、固定题目版本、准备考官音频。 */
export async function createSession(u: UserLite, input: CreateSessionInput): Promise<{ id: string; reused: boolean }> {
  return withLock("session-admission", () => createSessionLocked(u, input));
}

async function createSessionLocked(u: UserLite, input: CreateSessionInput): Promise<{ id: string; reused: boolean }> {
  if (!u.consentAt) throw forbidden("请先在入门设置中阅读并同意录音说明", "consent_required");
  const built = await buildPlan(u, input);

  // 同一关卡已有未完成的会话时继续该会话（已完成题目保留）；当天因无活动被标记放弃的会话可恢复
  if (!input.fresh && built.plan.mode === "level" && built.levelId) {
    const [existing] = await db
      .select({ id: practiceSession.id, status: practiceSession.status, reservedSeconds: practiceSession.reservedSeconds })
      .from(practiceSession)
      .where(
        and(
          eq(practiceSession.userId, u.id),
          eq(practiceSession.levelId, built.levelId),
          eq(practiceSession.mode, "level"),
          isNull(practiceSession.deletedAt),
          sql`(${practiceSession.status} = 'active' or (${practiceSession.status} = 'abandoned' and ${practiceSession.createdAt} >= ${startOfDayShanghai()}))`,
        ),
      )
      .orderBy(desc(practiceSession.createdAt))
      .limit(1);
    if (existing) {
      if (existing.status === "abandoned") {
        const [used] = await db
          .select({ ms: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::float8` })
          .from(answer)
          .where(eq(answer.sessionId, existing.id));
        await assertCanStartSession(u.id, Math.max(0, existing.reservedSeconds - Number(used?.ms ?? 0) / 1000));
        await db.transaction(async tx => {
        await reserveSessionQuota(tx, u.id, existing.id, existing.reservedSeconds);
        await tx
          .update(practiceSession)
          .set({ status: "active", endedAt: null, interruptReason: null, lastActivityAt: new Date() })
          .where(eq(practiceSession.id, existing.id));
        });
      }
      return { id: existing.id, reused: true };
    }
  }
  // 尚未开始的模考直接复用，避免重复点击产生多个会话
  if (built.plan.mode === "mock") {
    const [existing] = await db
      .select({ id: practiceSession.id })
      .from(practiceSession)
      .where(
        and(
          eq(practiceSession.userId, u.id),
          eq(practiceSession.mode, "mock"),
          eq(practiceSession.mockSetId, built.mockSetId!),
          eq(practiceSession.status, "active"),
          isNull(practiceSession.startedAt),
          isNull(practiceSession.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, reused: true };
  }

  await assertCanStartSession(u.id, built.plan.reserveSeconds);
  const ids = await ensureTtsAssets(collectPromptTexts(built.plan));
  const plan = attachTtsIds(built.plan, ids);

  const row = await db.transaction(async tx => {
  const sessionId = crypto.randomUUID();
  await reserveSessionQuota(tx, u.id, sessionId, plan.reserveSeconds);
  const [inserted] = await tx
    .insert(practiceSession)
    .values({
      id: sessionId,
      userId: u.id,
      mode: plan.mode,
      levelId: built.levelId ?? null,
      mockSetId: built.mockSetId ?? null,
      questionId: built.questionId ?? null,
      sourceAnswerId: built.sourceAnswerId ?? null,
      plan,
      reservedSeconds: plan.reserveSeconds,
      timeScale: plan.timeScale,
    })
    .returning({ id: practiceSession.id });
  return inserted;
  });

  if (built.levelId) {
    await db
      .insert(progress)
      .values({ userId: u.id, levelId: built.levelId, attempts: 1 })
      .onConflictDoUpdate({
        target: [progress.userId, progress.levelId],
        set: { attempts: sql`${progress.attempts} + 1`, updatedAt: new Date() },
      });
  }
  return { id: row.id, reused: false };
}

/** 读取会话（校验归属；已删除视为不存在） */
export async function getOwnedSession(userId: string, sessionId: string): Promise<SessionRow> {
  const [s] = await db
    .select()
    .from(practiceSession)
    .where(and(eq(practiceSession.id, sessionId), eq(practiceSession.userId, userId), isNull(practiceSession.deletedAt)));
  if (!s) throw notFound("会话");
  return s;
}

export async function getSessionView(userId: string, sessionId: string) {
  const s = await getOwnedSession(userId, sessionId);
  const plan = await planWithCurrentVoice(s.plan as SessionPlan);
  const answers = await db
    .select({
      id: answer.id,
      planIndex: answer.planIndex,
      kind: answer.kind,
      followUpId: answer.followUpId,
      attempt: answer.attempt,
      status: answer.status,
      submissionId: answer.submissionId,
      interrupted: answer.interrupted,
      clientDurationMs: answer.clientDurationMs,
    })
    .from(answer)
    .where(eq(answer.sessionId, s.id))
    .orderBy(asc(answer.planIndex), asc(answer.createdAt));
  const ttsIds = collectTtsIds(plan);
  const tts = ttsIds.length
    ? await db.select({ id: ttsAsset.id, status: ttsAsset.status }).from(ttsAsset).where(inArray(ttsAsset.id, ttsIds))
    : [];
  return {
    session: {
      id: s.id,
      mode: s.mode,
      status: s.status,
      levelId: s.levelId,
      mockSetId: s.mockSetId,
      questionId: s.questionId,
      position: s.position,
      currentPart: s.currentPart,
      partDeadlines: s.partDeadlines,
      partStarts: s.partStarts,
      skipped: s.skipped,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      interruptReason: s.interruptReason,
      createdAt: s.createdAt,
    },
    plan,
    answers,
    tts: Object.fromEntries(tts.map((t) => [t.id, t.status])),
    serverTime: Date.now(),
  };
}

function collectTtsIds(plan: SessionPlan): string[] {
  const ids = new Set<string>();
  const add = (x: { ttsId: string | null } | undefined) => x?.ttsId && ids.add(x.ttsId);
  Object.values(plan.phrases).forEach(add);
  for (const i of plan.items) {
    add(i.prompt);
    i.lead.forEach(add);
    i.followUp?.candidates.forEach(add);
  }
  return [...ids];
}

/** 保持题目版本和考试计时不变，只为返回给浏览器的计划更新声音资源。 */
async function planWithCurrentVoice(plan: SessionPlan) {
  const ids = collectTtsIds(plan);
  const identity = providers().ttsIdentity();
  const rows = ids.length ? await db.select({ model: ttsAsset.model, voice: ttsAsset.voice })
    .from(ttsAsset).where(inArray(ttsAsset.id, ids)) : [];
  if (rows.length === ids.length && ids.length && rows.every(r => r.model === identity.model && r.voice === identity.voice)) return plan;
  return attachTtsIds(plan, await ensureTtsAssets(collectPromptTexts(plan)));
}

export type SessionEventType = "start" | "part_start" | "position" | "skip" | "finish" | "interrupt" | "heartbeat";

/**
 * 会话事件（带事件标识，可重复提交）：开始、部分开始、推进、跳过、结束、中断。
 * 同一事件标识重复提交时返回首次处理的结果。
 */
export async function recordEvent(
  userId: string,
  sessionId: string,
  ev: { eventId: string; type: SessionEventType; part?: number; position?: number; planIndex?: number; reason?: string },
) {
  return withLock(`session-event:${sessionId}`, () => recordEventLocked(userId, sessionId, ev));
}

async function recordEventLocked(userId: string, sessionId: string, ev: { eventId: string; type: SessionEventType; part?: number; position?: number; planIndex?: number; reason?: string }) {
  if (!ev.eventId || ev.eventId.length > 100) throw badRequest("缺少事件标识");
  const s = await getOwnedSession(userId, sessionId);
  const [prev] = await db.select().from(sessionEvent).where(eq(sessionEvent.id, ev.eventId));
  if (prev) {
    if (prev.sessionId !== s.id) throw badRequest("事件标识冲突");
    return { duplicate: true, ...(prev.result as object), serverTime: Date.now() };
  }
  const now = new Date();
  const plan = s.plan as SessionPlan;
  const patch: Partial<SessionRow> = { lastActivityAt: now };
  let result: Record<string, unknown> = {};

  const isActive = s.status === "active";
  switch (ev.type) {
    case "start":
      if (!s.startedAt) patch.startedAt = now;
      break;
    case "heartbeat":
      break;
    case "part_start": {
      if (plan.mode !== "mock") throw badRequest("只有模考有分部分计时");
      const part = ev.part;
      if (part !== 1 && part !== 2 && part !== 3) throw badRequest("无效的部分");
      if (!isActive) throw new AppError(409, "session_closed", "本次模考已结束");
      const deadlines = { ...s.partDeadlines };
      const starts = { ...s.partStarts };
      if (!deadlines[String(part)]) {
        const previousDeadline = part > 1 ? s.partDeadlines[String(part - 1)] : undefined;
        if (part > 1 && (!previousDeadline || now.getTime() < Date.parse(previousDeadline))) {
          throw new AppError(409, "part_order", "上一部分尚未结束，不能提前进入下一部分");
        }
        const start = previousDeadline ? Date.parse(previousDeadline) : now.getTime();
        starts[String(part)] = new Date(start).toISOString();
        deadlines[String(part)] = new Date(start + mockPartDurationMs(part, plan.timeScale)).toISOString();
      }
      patch.partDeadlines = deadlines;
      patch.partStarts = starts;
      patch.currentPart = part;
      if (!s.startedAt) patch.startedAt = now;
      result = { partDeadlines: deadlines, partStarts: starts };
      break;
    }
    case "position":
      if (typeof ev.position === "number" && ev.position >= 0 && ev.position <= plan.items.length) patch.position = ev.position;
      break;
    case "skip":
      if (typeof ev.planIndex !== "number" || !plan.items[ev.planIndex]) throw badRequest("无效的题目位置");
      patch.skipped = [...new Set([...s.skipped, ev.planIndex])];
      break;
    case "interrupt":
      if (plan.mode === "mock" && isActive) {
        patch.status = "interrupted";
        patch.interruptReason = (ev.reason ?? "technical").slice(0, 100);
        patch.endedAt = now;
      }
      break;
    case "finish":
      result = await finishSession(s, plan, now, patch, ev.reason);
      break;
    default:
      throw badRequest("未知事件");
  }

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sessionEvent)
      .values({ id: ev.eventId, sessionId: s.id, type: ev.type, payload: ev, result })
      .onConflictDoNothing()
      .returning({ id: sessionEvent.id });
    if (inserted.length) await tx.update(practiceSession).set(patch).where(eq(practiceSession.id, s.id));
  });
  if (patch.status && patch.status !== "active") {
    await afterSessionClosed(s.id).catch((e) => console.error("[session] 结束后处理失败", e));
  }
  const [fresh] = await db.select().from(practiceSession).where(eq(practiceSession.id, s.id));
  return {
    duplicate: false,
    ...result,
    status: fresh.status,
    partDeadlines: fresh.partDeadlines,
    partStarts: fresh.partStarts,
    position: fresh.position,
    serverTime: Date.now(),
  };
}

/** 结束会话：训练需全部必答题已保存录音才记为完成；模考需三个部分都已开始且未中断。 */
async function finishSession(s: SessionRow, plan: SessionPlan, now: Date, patch: Partial<SessionRow>, reason?: string) {
  if (s.status !== "active") return { finished: s.status === "completed" };
  const saved = await db
    .select({ planIndex: answer.planIndex, kind: answer.kind, part: answer.part, interrupted: answer.interrupted })
    .from(answer)
    .where(and(eq(answer.sessionId, s.id), inArray(answer.status, ["uploaded", "queued", "processing", "done", "insufficient", "failed"])));
  if (plan.mode === "mock") {
    const allParts = ["1", "2", "3"].every((p) => s.partStarts[p]);
    const timedOut = !!s.partDeadlines["3"] && now.getTime() >= Date.parse(s.partDeadlines["3"]);
    const allAnswered = [1, 2, 3].every((part) => saved.some((a) => a.part === part && !a.interrupted));
    const [pending] = await db.select({ count: sql<number>`count(*)::int` }).from(answer)
      .where(and(eq(answer.sessionId, s.id), eq(answer.status, "created")));
    if (allParts && timedOut && allAnswered && !pending.count && reason !== "ended_early") {
      patch.status = "completed";
    } else {
      patch.status = "interrupted";
      patch.interruptReason = reason ?? "incomplete";
    }
    patch.endedAt = now;
    return { finished: patch.status === "completed", missing: [] };
  }
  const missing = requiredSlots(plan).filter((slot) => !saved.some((a) => a.planIndex === slot.index && a.kind === slot.kind));
  if (missing.length === 0) {
    patch.status = "completed";
    patch.endedAt = now;
    return { finished: true, missing: [] };
  }
  return { finished: false, missing };
}

/** 会话结束后：关卡完成记录、重练清单、报告汇总 */
export async function afterSessionClosed(sessionId: string) {
  const [s] = await db.select().from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (!s) return;
  await getQuotaStatus(s.userId);
  if (s.status === "completed" && s.levelId) {
    await db
      .insert(progress)
      .values({ userId: s.userId, levelId: s.levelId, completedAt: s.endedAt ?? new Date(), attempts: 1 })
      .onConflictDoUpdate({
        target: [progress.userId, progress.levelId],
        set: { completedAt: sql`coalesce(${progress.completedAt}, ${s.endedAt ?? new Date()})`, updatedAt: new Date() },
      });
  }
  await recomputeSessionOutcome(sessionId);
}

/**
 * 第五章追问：等待主问题回答的转写完成（最长 12 秒），再让模型从本题已审核的 2 道追问中选择 1 道。
 * 模型只返回编号，服务端校验编号属于当前题目；超时、转写失败或选择失败时使用默认追问。
 */
export async function selectFollowUp(userId: string, sessionId: string, planIndex: number) {
  const s = await getOwnedSession(userId, sessionId);
  const plan = await planWithCurrentVoice(s.plan as SessionPlan);
  const item = plan.items[planIndex];
  if (!item?.followUp) throw badRequest("该题没有追问");
  const fu = item.followUp;

  const [main] = await db
    .select()
    .from(answer)
    .where(and(eq(answer.sessionId, s.id), eq(answer.planIndex, planIndex), eq(answer.kind, "main")))
    .orderBy(desc(answer.attempt))
    .limit(1);

  const eventId = `followup:${s.id}:${planIndex}:${main?.id ?? "none"}`;
  const [prev] = await db.select().from(sessionEvent).where(eq(sessionEvent.id, eventId));
  const pick = (id: string, source: string, reason?: string) => {
    const c = fu.candidates.find((x) => x.id === id) ?? fu.candidates.find((x) => x.id === fu.defaultId)!;
    return { followUp: { id: c.id, text: c.text, zh: c.zh, ttsId: c.ttsId }, answerSeconds: fu.answerSeconds, source, reason };
  };
  if (prev) {
    const r = prev.result as { id: string; source: string; reason?: string };
    return pick(r.id, r.source, r.reason);
  }

  let chosen = fu.defaultId;
  let source = "default";
  let reason: string | undefined = "使用默认追问";
  if (main) {
    const deadline = Date.now() + FOLLOWUP_WAIT_SECONDS * 1000;
    let transcript: string | null = null;
    while (Date.now() < deadline) {
      const [a] = await db
        .select({ transcript: answer.transcript, status: answer.status })
        .from(answer)
        .where(eq(answer.id, main.id));
      if (a?.transcript) {
        transcript = a.transcript;
        break;
      }
      if (!a || ["insufficient", "failed", "done"].includes(a.status)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (transcript && deadline - Date.now() > 300) {
      try {
        const msgs = buildFollowUpMessages({ question: item.prompt.text, transcript, candidates: fu.candidates });
        const r = await metered(`followup:${main.id}`, userId).llmJson({
          purpose: "followup",
          ...msgs,
          maxTokens: 200,
          timeoutMs: Math.max(1, deadline - Date.now()),
          mockHint: { candidates: fu.candidates.map((c) => c.id), transcript },
        });
        const id = validateFollowUpChoice(r.json ?? r.raw, fu.candidates.map((c) => c.id));
        if (id) {
          chosen = id;
          source = "model";
          const rs = (r.json as { reason?: unknown })?.reason;
          reason = typeof rs === "string" ? rs.slice(0, 200) : undefined;
        } else {
          reason = "模型返回的编号不在本题追问中，使用默认追问";
        }
      } catch (e) {
        reason = "追问选择失败，使用默认追问";
        await logOps("warn", "followup", main.id, `追问选择失败：${(e as Error).message}`);
      }
    } else {
      reason = "等待转写超时或转写失败，使用默认追问";
    }
  }
  await db
    .insert(sessionEvent)
    .values({ id: eventId, sessionId: s.id, type: "followup", payload: { planIndex }, result: { id: chosen, source, reason } })
    .onConflictDoNothing();
  return pick(chosen, source, reason);
}

/** 历史记录 */
export async function listSessions(userId: string, opts: { mode?: string; limit?: number; offset?: number } = {}) {
  const rows = await db
    .select({
      id: practiceSession.id,
      mode: practiceSession.mode,
      status: practiceSession.status,
      levelId: practiceSession.levelId,
      mockSetId: practiceSession.mockSetId,
      questionId: practiceSession.questionId,
      plan: practiceSession.plan,
      report: practiceSession.report,
      createdAt: practiceSession.createdAt,
      endedAt: practiceSession.endedAt,
      answerCount: sql<number>`count(${answer.id})::int`,
      durationMs: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::int`,
    })
    .from(practiceSession)
    .leftJoin(answer, eq(answer.sessionId, practiceSession.id))
    .where(
      and(
        eq(practiceSession.userId, userId),
        isNull(practiceSession.deletedAt),
        opts.mode ? eq(practiceSession.mode, opts.mode) : undefined,
      ),
    )
    .groupBy(practiceSession.id)
    .orderBy(desc(practiceSession.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
  return rows.map((r) => {
    const plan = r.plan as SessionPlan;
    return { ...r, plan: undefined, title: plan.title, subtitle: plan.subtitle, draft: plan.draft };
  });
}

export async function totalTrainingSeconds(userId: string) {
  const [r] = await db
    .select({ ms: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::float8` })
    .from(answer)
    .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
    .where(and(eq(answer.userId, userId), isNull(practiceSession.deletedAt)));
  return Math.round(Number(r?.ms ?? 0) / 1000);
}

/** 30 分钟无活动的进行中会话标记为"已放弃"并释放额度（模考标记中断） */
export async function abandonStaleSessions(minutes: number) {
  const since = new Date(Date.now() - minutes * 60_000);
  const rows = await db
    .update(practiceSession)
    .set({ status: sql`case when ${practiceSession.mode} = 'mock' and ${practiceSession.startedAt} is not null then 'interrupted' else 'abandoned' end`, interruptReason: "inactive", endedAt: new Date() })
    .where(and(eq(practiceSession.status, "active"), sql`${practiceSession.lastActivityAt} < ${since}`))
    .returning({ id: practiceSession.id });
  for (const r of rows) await afterSessionClosed(r.id).catch(() => {});
  return rows.length;
}

export function slotKey(planIndex: number, kind: AnswerKind) {
  return `${planIndex}:${kind}`;
}

export async function getUserBasic(userId: string) {
  const [u] = await db.select().from(user).where(eq(user.id, userId));
  return u;
}
