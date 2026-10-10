import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { answer, opsLog, practiceSession, questionVersion, usageEvent, user } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { providers } from "@/lib/providers";
import { getBoss, QUEUES } from "@/lib/queue";
import { activeSessionCount } from "@/lib/quota";
import { getSettings } from "@/lib/settings";
import { startOfDayShanghai, startOfMonthShanghai } from "@/lib/timing";
import { monthCostYuan } from "@/lib/usage";
import { getWorkerHealth } from "@/lib/worker-health";

export async function serviceStatus() {
  const e = env();
  const settings = await getSettings();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  let queues: { name: string; queued: number; active: number; failed: number }[] = [];
  let queueOk = true;
  try {
    const boss = await getBoss();
    const rows = await boss.getQueues(Object.values(QUEUES));
    queues = rows.map((q) => ({ name: q.name, queued: q.queuedCount, active: q.activeCount, failed: q.failedCount }));
  } catch {
    queueOk = false;
  }
  const answerStatus = await db.select({ status: answer.status, n: sql<number>`count(*)::int` }).from(answer).groupBy(answer.status);
  const since = new Date(Date.now() - 24 * 3600_000);
  const errors = await db
    .select()
    .from(opsLog)
    .where(and(sql`${opsLog.level} in ('error','warn')`, gte(opsLog.createdAt, since)))
    .orderBy(desc(opsLog.createdAt))
    .limit(30);
  const worker = await getWorkerHealth();
  const [latency] = await db
    .select({
      avg: sql<number>`coalesce(avg(extract(epoch from (${answer.processedAt} - ${answer.submittedAt}))), 0)::float8`,
      p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by extract(epoch from (${answer.processedAt} - ${answer.submittedAt}))), 0)::float8`,
      n: sql<number>`count(*)::int`,
    })
    .from(answer)
    .where(and(eq(answer.status, "done"), gte(answer.processedAt, since)));
  return {
    config: {
      aiProvider: e.AI_PROVIDER,
      credentialsConfigured: !!e.DASHSCOPE_API_KEY.trim(),
      storage: e.STORAGE_DRIVER,
      timeScale: e.TIME_SCALE,
      requireReview: e.CONTENT_REQUIRE_REVIEW,
      audioDiagnosis: e.ENABLE_AUDIO_DIAGNOSIS,
      models: { asr: e.ASR_MODEL, tts: providers().ttsIdentity().model, voice: providers().ttsIdentity().voice, llm: e.LLM_MODEL, omni: e.OMNI_MODEL },
    },
    dbOk,
    queueOk,
    queues,
    answerStatus,
    errors,
    lastWorkerActivity: worker.lastHeartbeat,
    workerReady: worker.ready,
    activeSessions: await activeSessionCount(settings),
    paused: settings.pauseNewSessions,
    feedbackLatency: { avgSec: Number(latency?.avg ?? 0), p95Sec: Number(latency?.p95 ?? 0), n: Number(latency?.n ?? 0) },
  };
}

export async function usageOverview() {
  const monthStart = startOfMonthShanghai();
  const byService = await db
    .select({
      service: usageEvent.service,
      mock: usageEvent.mock,
      cost: sql<number>`coalesce(sum(${usageEvent.costYuan}), 0)::float8`,
      n: sql<number>`count(*) filter (where ${usageEvent.service} <> 'recovery-adjustment' and ${usageEvent.units}->>'cancelledBeforeDispatch' is distinct from 'true')::int`,
      units: sql<unknown>`jsonb_build_object(
        'seconds', coalesce(sum((${usageEvent.units}->>'seconds')::float8), 0),
        'chars', coalesce(sum((${usageEvent.units}->>'chars')::float8), 0),
        'inputTokens', coalesce(sum((${usageEvent.units}->>'inputTokens')::float8), 0),
        'outputTokens', coalesce(sum((${usageEvent.units}->>'outputTokens')::float8), 0))`,
    })
    .from(usageEvent)
    .where(and(eq(usageEvent.billingSource, "platform"), gte(usageEvent.createdAt, monthStart), sql`${usageEvent.service} <> 'deleted-audio-quota'`))
    .groupBy(usageEvent.service, usageEvent.mock);
  const byUser = await db
    .select({
      userId: usageEvent.userId,
      email: user.email,
      cost: sql<number>`coalesce(sum(${usageEvent.costYuan}), 0)::float8`,
      asrSeconds: sql<number>`coalesce(sum((${usageEvent.units}->>'seconds')::float8), 0)::float8`,
    })
    .from(usageEvent)
    .leftJoin(user, eq(user.id, usageEvent.userId))
    .where(and(eq(usageEvent.billingSource, "platform"), gte(usageEvent.createdAt, monthStart), sql`${usageEvent.service} <> 'deleted-audio-quota'`))
    .groupBy(usageEvent.userId, user.email)
    .orderBy(desc(sql`sum(${usageEvent.costYuan})`));
  // 每次有效练习的实际成本（有效练习 = 至少一条回答成功生成反馈的会话）
  const [effective] = await db
    .select({ n: sql<number>`count(distinct ${answer.sessionId})::int` })
    .from(answer)
    .where(and(eq(answer.status, "done"), gte(answer.createdAt, monthStart)));
  const cost = await monthCostYuan();
  const settings = await getSettings();
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(practiceSession)
    .where(gte(practiceSession.createdAt, startOfDayShanghai()));
  return {
    monthCost: cost,
    budget: settings.budget.monthlyYuan,
    byService,
    byUser,
    effectiveSessions: Number(effective?.n ?? 0),
    costPerEffective: Number(effective?.n ?? 0) > 0 ? cost / Number(effective.n) : null,
    sessionsToday: Number(today?.n ?? 0),
    settings,
  };
}

/** 试用期指标：设备/上传/转写失败率、模考完成率、重练使用率 */
export async function trialMetrics() {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [a] = await db
    .select({
      total: sql<number>`count(*)::int`,
      uploaded: sql<number>`count(*) filter (where ${answer.sizeBytes} is not null or ${answer.storageKey} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${answer.status} = 'failed' and ${answer.processingStage} is distinct from 'consent_wait' and (${answer.sizeBytes} is not null or ${answer.storageKey} is not null))::int`,
      insufficient: sql<number>`count(*) filter (where ${answer.status} = 'insufficient')::int`,
    })
    .from(answer)
    .where(gte(answer.createdAt, since));
  const [m] = await db
    .select({
      total: sql<number>`count(*) filter (where ${practiceSession.startedAt} is not null)::int`,
      completed: sql<number>`count(*) filter (where ${practiceSession.status} = 'completed')::int`,
    })
    .from(practiceSession)
    .where(and(eq(practiceSession.mode, "mock"), gte(practiceSession.createdAt, since)));
  const [r] = await db
    .select({ retry: sql<number>`count(*) filter (where ${practiceSession.mode} = 'retry')::int`, all: sql<number>`count(*)::int` })
    .from(practiceSession)
    .where(gte(practiceSession.createdAt, since));
  const pct = (x: number, y: number) => (y > 0 ? Math.round((x / y) * 1000) / 10 : null);
  return {
    uploadSuccessRate: pct(Number(a.uploaded), Number(a.total)),
    processFailRate: pct(Number(a.failed), Number(a.uploaded)),
    insufficientRate: pct(Number(a.insufficient), Number(a.uploaded)),
    mockCompletionRate: pct(Number(m.completed), Number(m.total)),
    retryUsageRate: pct(Number(r.retry), Number(r.all)),
    answers: Number(a.total),
  };
}

export async function listUsers() {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      mustChangePassword: user.mustChangePassword,
      dailyQuotaMinutes: user.dailyQuotaMinutes,
      allowAdminView: user.allowAdminView,
      consentAt: user.consentAt,
      createdAt: user.createdAt,
      deletedAt: user.deletedAt,
      sessions: sql<number>`(select count(*)::int from ${practiceSession} where ${practiceSession.userId} = ${user.id} and ${practiceSession.deletedAt} is null)`,
      lastActive: sql<Date | null>`(select max(${practiceSession.lastActivityAt}) from ${practiceSession} where ${practiceSession.userId} = ${user.id})`,
    })
    .from(user)
    .where(isNull(user.deletedAt))
    .orderBy(user.createdAt);
  return rows;
}

/** 用户授权排查后，管理员可看到的回答列表 */
export async function userAnswersForAdmin(userId: string) {
  const [u] = await db.select({ allow: user.allowAdminView }).from(user).where(eq(user.id, userId));
  if (!u?.allow) return null;
  return db
    .select({ id: answer.id, promptText: answer.promptText, status: answer.status, createdAt: answer.createdAt })
    .from(answer)
    .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
    .where(and(eq(answer.userId, userId), isNull(practiceSession.deletedAt)))
    .orderBy(desc(answer.createdAt))
    .limit(30);
}

export async function listQuestionVersions(filter: { part?: number; status?: string; q?: string }) {
  const rows = await db
    .selectDistinctOn([questionVersion.questionId], {
      id: questionVersion.id,
      questionId: questionVersion.questionId,
      version: questionVersion.version,
      reviewStatus: questionVersion.reviewStatus,
      published: questionVersion.published,
      sourceType: questionVersion.sourceType,
      content: questionVersion.content,
      updatedAt: questionVersion.updatedAt,
      reviewedBy: questionVersion.reviewedBy,
    })
    .from(questionVersion)
    .orderBy(questionVersion.questionId, desc(questionVersion.version));
  const published = await db
    .selectDistinctOn([questionVersion.questionId], { questionId: questionVersion.questionId, version: questionVersion.version })
    .from(questionVersion)
    .where(eq(questionVersion.published, true))
    .orderBy(questionVersion.questionId, desc(questionVersion.version));
  const pubMap = new Map(published.map((p) => [p.questionId, p.version]));
  return rows
    .map((r) => ({ ...r, content: r.content as { part: number; text: string; topicName: string; referenceAnswer: string; zh: string }, publishedVersion: pubMap.get(r.questionId) ?? null }))
    .filter((r) => (!filter.part || r.content.part === filter.part) && (!filter.status || r.reviewStatus === filter.status) && (!filter.q || r.questionId.includes(filter.q.toUpperCase()) || r.content.text.toLowerCase().includes(filter.q.toLowerCase())))
    .sort((a, b) => a.questionId.localeCompare(b.questionId, undefined, { numeric: true }));
}
