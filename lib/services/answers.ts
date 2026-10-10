import crypto from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { answer, feedback, practiceSession, retryItem, sessionEvent, user } from "@/db/schema";
import { detectAudioType, MAX_UPLOAD_BYTES } from "@/lib/audio";
import type { QuestionContent } from "@/lib/content/types";
import { db } from "@/lib/db";
import { authSecret } from "@/lib/env";
import { AppError, badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import { QUEUES, enqueue } from "@/lib/queue";
import { getOwnedSession } from "@/lib/services/sessions";
import { slotLimitSeconds, type AnswerKind, type SessionPlan } from "@/lib/sessions/plan";
import { recordingKey, storage } from "@/lib/storage";
import { isDurationWithinLimit } from "@/lib/timing";
import { questionVersion } from "@/db/schema";
import { assertCoveredQuota, reconcileAnswerQuota, reserveSessionQuota, settleQuotaHolds } from "@/lib/quota";
import { startOfDayShanghai } from "@/lib/timing";
import { assertUserAiBudget } from "@/lib/ai/runtime";
import { withRecordingConsent } from "@/lib/services/recording-consent";
import { accountedRecordingMs, PENDING_UPLOAD_TTL_MS } from "@/lib/answer-quota";
import { walletLock } from "@/lib/services/rewards";
import { withLock } from "@/lib/lock";

export type AnswerRow = typeof answer.$inferSelect;

const TICKET_TTL_MS = 15 * 60 * 1000;

function ticketKey() {
  return crypto.createHmac("sha256", authSecret()).update("upload-ticket-v1").digest();
}

/** 短期上传凭证：限定回答对象与有效期 */
export function signUploadTicket(answerId: string, userId: string, now = Date.now(), consentVersion = 0): string {
  const exp = now + TICKET_TTL_MS;
  const sig = crypto.createHmac("sha256", ticketKey()).update(`${answerId}.${userId}.${consentVersion}.${exp}`).digest("base64url");
  return `${consentVersion}.${exp}.${sig}`;
}

export function verifyUploadTicket(ticket: string, answerId: string, userId: string, now = Date.now(), consentVersion = 0): boolean {
  const [version, expStr, sig, extra] = ticket.split(".");
  const exp = Number(expStr);
  if (extra !== undefined || version !== String(consentVersion) || !exp || !sig || exp < now) return false;
  const expected = crypto.createHmac("sha256", ticketKey()).update(`${answerId}.${userId}.${consentVersion}.${exp}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface TicketInput {
  sessionId: string;
  planIndex: number;
  kind: AnswerKind;
  followUpId?: string | null;
  submissionId: string;
  clientDurationMs: number;
  interrupted?: boolean;
  consentVersion?: number;
}

/**
 * 申请上传凭证：校验会话归属与题目位置，按提交标识创建或复用回答（重复申请不产生重复记录）。
 */
export async function createUploadTicket(userId: string, input: TicketInput) {
  return withRecordingConsent(userId, version => createUploadTicketLocked(userId, input, version), [`upload-admission:${userId}`]);
}

async function createUploadTicketLocked(userId: string, input: TicketInput, version: number) {
  if (input.consentVersion !== undefined && input.consentVersion !== version) throw forbidden("录音授权已改变，请开始新的录音", "consent_required");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.submissionId ?? "")) throw badRequest("无效的提交标识");
  const [u] = await db.select({ consentAt: user.consentAt }).from(user).where(eq(user.id, userId));
  if (!u?.consentAt) throw forbidden("请先同意录音说明", "consent_required");
  const s = await getOwnedSession(userId, input.sessionId);
  const plan = s.plan as SessionPlan;
  const [discarded] = await db.select({ id: sessionEvent.id }).from(sessionEvent).where(and(eq(sessionEvent.sessionId, s.id), eq(sessionEvent.type, "upload_discard"), sql`${sessionEvent.result}->>'submissionId' = ${input.submissionId}`)).limit(1);
  if (discarded) throw new AppError(410, "upload_discarded", "该片段已经丢弃，旧上传凭证不能继续使用。");

  const [existing] = await db
    .select()
    .from(answer)
    .where(and(eq(answer.sessionId, s.id), eq(answer.submissionId, input.submissionId)));
  if (existing) {
    if (existing.processingStage === "upload_discarded") throw new AppError(410, "upload_discarded", "该片段已经丢弃，旧上传凭证不能继续使用。");
    if (!existing.storageKey && existing.processingStage === "consent_wait") throw forbidden("这次录音的授权已撤回，请开始新的录音", "consent_required");
    if (!existing.storageKey && existing.createdAt.getTime() + PENDING_UPLOAD_TTL_MS <= Date.now()) throw new AppError(410, "upload_expired", "未上传片段已超过 24 小时补传期，请重新录音。");
    return { answerId: existing.id, status: existing.status, ticket: retainedTicket(existing, userId, version) };
  }

  const paused = (s.status === "paused" || s.status === "interrupted" && s.interruptReason === "user_exit") && s.endedAt && Date.now() - s.endedAt.getTime() < 24 * 3600_000;
  const allowed = paused && s.pausedUploads.some(p => p.submissionId === input.submissionId && p.planIndex === input.planIndex && p.kind === input.kind && (p.followUpId ?? null) === (input.followUpId ?? null) && p.consentVersion === version && input.consentVersion === version);
  if (s.status !== "active" && !allowed) throw conflict("本次练习已暂停或结束；只有退出前保留的录音可补传，新录音请先继续练习。", "session_closed");
  const item = plan.items[input.planIndex];
  if (!item) throw badRequest("无效的题目位置");
  const kind = input.kind;
  const limit = slotLimitSeconds(plan, input.planIndex, kind);
  if (limit === null) throw badRequest("该位置不接受此类回答");
  let followUpId: string | null = null;
  let promptText = item.prompt.text;
  if (plan.mode !== "mock" && kind === "followup") {
    const c = item.followUp?.candidates.find((x) => x.id === input.followUpId);
    if (!c) throw badRequest("追问编号不属于本题");
    followUpId = c.id;
    promptText = c.text;
  } else if (item.followUpId) {
    followUpId = item.followUpId;
  }
  const dur = Math.round(Number(input.clientDurationMs));
  if (!Number.isFinite(dur) || dur < 0) throw badRequest("无效的录音时长");
  if (!isDurationWithinLimit(dur, limit)) {
    throw badRequest(`录音时长超过本题上限（${Math.round(limit)} 秒）`, "duration_exceeded");
  }
  const [usedInSession] = await db.select({ seconds: sql<number>`coalesce(sum(${accountedRecordingMs()}), 0)::float8 / 1000` }).from(answer)
    .where(and(eq(answer.sessionId, s.id), sql`${answer.createdAt} >= ${startOfDayShanghai()}`));

  const [prevAttempt] = await db
    .select({ n: sql<number>`coalesce(max(${answer.attempt}), 0)::int` })
    .from(answer)
    .where(and(eq(answer.sessionId, s.id), eq(answer.planIndex, input.planIndex), eq(answer.kind, kind)));
  const row = await db.transaction(async tx => {
  const reserve = Math.ceil(Math.max(paused ? 0 : s.reservedSeconds, Number(usedInSession.seconds) + dur / 1000));
  await reserveSessionQuota(tx, userId, s.id, reserve);
  const inserted = await tx
    .insert(answer)
    .values({
      sessionId: s.id,
      userId,
      questionId: item.questionId,
      questionVersionId: item.versionId,
      planIndex: input.planIndex,
      part: item.part,
      kind,
      followUpId,
      promptText,
      attempt: Number(prevAttempt?.n ?? 0) + 1,
      submissionId: input.submissionId,
      clientDurationMs: dur,
      limitSeconds: Math.ceil(limit),
      interrupted: !!input.interrupted,
    })
    .onConflictDoNothing({ target: [answer.sessionId, answer.submissionId] })
    .returning();
  const row =
    inserted[0] ??
    (await tx.select().from(answer).where(and(eq(answer.sessionId, s.id), eq(answer.submissionId, input.submissionId))))[0];
  if (paused) await settleQuotaHolds(tx, userId);
  else await tx.update(practiceSession).set({ reservedSeconds: reserve, lastActivityAt: new Date() }).where(eq(practiceSession.id, s.id));
  return row;
  });
  return { answerId: row.id, status: row.status, ticket: retainedTicket(row, userId, version) };
}

function retainedTicket(row: AnswerRow, userId: string, version: number) {
  const now = Date.now();
  return signUploadTicket(row.id, userId, row.storageKey ? now : Math.min(now, row.createdAt.getTime() + PENDING_UPLOAD_TTL_MS - TICKET_TTL_MS), version);
}

/** Cancellation shares admission/consent and wallet locks. Stored audio is never refunded or deleted here. */
export async function discardPendingUpload(userId: string, sessionId: string, submissionId: string) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(submissionId)) throw badRequest("无效的提交标识");
  return withLock(`recording-consent:${userId}`, () => db.transaction(async tx => {
    await walletLock(tx, userId);
    const [s] = await tx.select().from(practiceSession).where(and(eq(practiceSession.id, sessionId), eq(practiceSession.userId, userId)));
    if (!s) throw notFound("会话");
    const [a] = await tx.select().from(answer).where(and(eq(answer.sessionId, sessionId), eq(answer.submissionId, submissionId)));
    if (a && (a.storageKey || a.durationMs !== null)) return { discarded: false, alreadyStored: true, wholePlanActive: s.status === "active" };
    const [prior] = await tx.select({ id: sessionEvent.id }).from(sessionEvent).where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.type, "upload_discard"), sql`${sessionEvent.result}->>'submissionId' = ${submissionId}`)).limit(1);
    if (!prior) await tx.insert(sessionEvent).values({ id: crypto.randomUUID(), sessionId, type: "upload_discard", result: { submissionId } });
    if (a) await tx.update(answer).set({ status: "failed", processingStage: "upload_discarded", interrupted: true, error: "片段已丢弃，尚未上传的时间预留已撤销。", updatedAt: new Date() }).where(eq(answer.id, a.id));
    await tx.update(practiceSession).set({ pausedUploads: s.pausedUploads.filter(row => row.submissionId !== submissionId) }).where(eq(practiceSession.id, sessionId));
    await settleQuotaHolds(tx, userId);
    return { discarded: true, alreadyStored: false, wholePlanActive: s.status === "active" };
  }));
}

/** 接收录音：凭上传凭证，校验大小与实际类型（按文件头），写入私有存储。 */
export async function receiveAudio(userId: string, answerId: string, ticket: string, body: Buffer) {
  return withRecordingConsent(userId, version => receiveAudioLocked(userId, answerId, ticket, body, version), [`audio:${answerId}`]);
}

async function receiveAudioLocked(userId: string, answerId: string, ticket: string, body: Buffer, version: number) {
  if (!verifyUploadTicket(ticket, answerId, userId, Date.now(), version)) throw new AppError(403, "invalid_ticket", "上传凭证无效、已过期或录音授权已改变");
  const [a] = await db.select().from(answer).where(and(eq(answer.id, answerId), eq(answer.userId, userId)));
  if (!a) throw notFound("回答");
  if (a.processingStage === "upload_discarded") throw new AppError(410, "upload_discarded", "该片段已经丢弃，旧上传凭证不能继续使用。");
  await assertSessionVisible(a.sessionId);
  if (a.status !== "created") return { status: a.status, duplicate: true };
  if (a.createdAt.getTime() + PENDING_UPLOAD_TTL_MS <= Date.now()) throw new AppError(410, "upload_expired", "未上传片段已超过 24 小时补传期，请重新录音。");
  if (body.length === 0) throw badRequest("录音为空");
  if (body.length > MAX_UPLOAD_BYTES) throw new AppError(413, "too_large", "录音文件超过 25 MB");
  const kind = detectAudioType(body);
  if (!kind || kind.ext === "mp3") throw new AppError(415, "unsupported_type", "不支持的录音格式（需要 WebM / MP4 / Ogg / WAV）");
  const key = recordingKey(userId, a.sessionId, a.id, kind.ext);
  await storage().put(key, body, kind.mime);
  const [updated] = await db
    .update(answer)
    .set({ status: "uploaded", storageKey: key, mimeType: kind.mime, sizeBytes: body.length, updatedAt: new Date() })
    .where(and(eq(answer.id, a.id), eq(answer.status, "created")))
    .returning({ status: answer.status });
  return { status: updated?.status ?? "uploaded", duplicate: !updated };
}

/** 确认录音已保存并创建处理任务（同一回答只创建一次） */
export async function submitAnswer(userId: string, answerId: string) {
  return withRecordingConsent(userId, () => submitAnswerLocked(userId, answerId));
}
async function submitAnswerLocked(userId: string, answerId: string) {
  const [a] = await db.select().from(answer).where(and(eq(answer.id, answerId), eq(answer.userId, userId)));
  if (!a) throw notFound("回答");
  if (a.processingStage === "upload_discarded") throw new AppError(410, "upload_discarded", "该片段已经丢弃，不能继续提交。");
  await assertSessionVisible(a.sessionId);
  if (a.status === "created") throw conflict("录音尚未上传", "not_uploaded");
  const [claimed] = await db
    .update(answer)
    .set({ status: "queued", submittedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(answer.id, a.id), eq(answer.status, "uploaded")))
    .returning({ id: answer.id });
  if (claimed) {
    await enqueue(QUEUES.processAnswer, { answerId: a.id, mode: "full" });
    return { status: "queued", enqueued: true };
  }
  const [cur] = await db.select({ status: answer.status }).from(answer).where(eq(answer.id, a.id));
  return { status: cur.status, enqueued: false };
}

/** 读取回答（校验归属；管理员仅在用户授权排查时可查看） */
export async function getAnswerDetail(viewer: { id: string; isAdmin: boolean }, answerId: string) {
  const [row] = await db
    .select({ a: answer, s: practiceSession, owner: { allowAdminView: user.allowAdminView } })
    .from(answer)
    .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
    .innerJoin(user, eq(user.id, answer.userId))
    .where(and(eq(answer.id, answerId), isNull(practiceSession.deletedAt)));
  if (!row) throw notFound("回答");
  const own = row.a.userId === viewer.id;
  if (!own && !(viewer.isAdmin && row.owner.allowAdminView)) throw notFound("回答");
  const [fb] = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.answerId, answerId), eq(feedback.isCurrent, true)))
    .orderBy(desc(feedback.createdAt))
    .limit(1);
  const [ver] = await db.select({ content: questionVersion.content, reviewStatus: questionVersion.reviewStatus, version: questionVersion.version, sourceType: questionVersion.sourceType, reviewNote: questionVersion.reviewNote }).from(questionVersion).where(eq(questionVersion.id, row.a.questionVersionId));
  const plan = row.s.plan as SessionPlan;
  return {
    answer: publicAnswer(row.a),
    feedback: fb ? { ...fb, data: fb.data } : null,
    question: ver ? { ...ver, content: ver.content as QuestionContent } : null,
    session: { id: row.s.id, mode: row.s.mode, title: plan.title, status: row.s.status },
    planItem: plan.items[row.a.planIndex] ?? null,
    own,
  };
}

export function publicAnswer(a: AnswerRow) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    questionId: a.questionId,
    planIndex: a.planIndex,
    part: a.part,
    kind: a.kind,
    followUpId: a.followUpId,
    promptText: a.promptText,
    attempt: a.attempt,
    status: a.status,
    durationMs: a.durationMs ?? a.clientDurationMs,
    limitSeconds: a.limitSeconds,
    metrics: a.metrics,
    transcript: a.transcript,
    transcriptMock: a.transcriptMock,
    processingStage: a.processingStage,
    questionVersionId: a.questionVersionId,
    correctedTranscript: a.correctedTranscript,
    insufficientReason: a.insufficientReason,
    error: a.status === "failed" ? a.error : null,
    interrupted: a.interrupted,
    hasAudio: !!a.storageKey && !a.audioDeletedAt && a.createdAt.getTime() + 30 * 86400_000 > Date.now(),
    audioExpiresAt: a.audioDeletedAt ? null : new Date(a.createdAt.getTime() + 30 * 86400_000).toISOString(),
    createdAt: a.createdAt,
    processedAt: a.processedAt,
  };
}

/** 提交修正文本；可选择用修正文本重新生成反馈（原始转写保留） */
export async function submitCorrection(userId: string, answerId: string, text: string, regenerate: boolean) {
  return regenerate ? withRecordingConsent(userId, () => submitCorrectionLocked(userId, answerId, text, regenerate)) : submitCorrectionLocked(userId, answerId, text, regenerate);
}
async function submitCorrectionLocked(userId: string, answerId: string, text: string, regenerate: boolean) {
  const t = text.trim();
  if (t.length < 2 || t.length > 5000) throw badRequest("修正文本长度应在 2–5000 字符之间");
  const [a] = await db.select().from(answer).where(and(eq(answer.id, answerId), eq(answer.userId, userId)));
  if (!a) throw notFound("回答");
  await assertSessionVisible(a.sessionId);
  if (a.transcript === null) throw conflict("原始转写尚未完成，暂不能修正", "no_transcript");
  if (["queued", "processing"].includes(a.status)) throw conflict("正在处理中，请稍后再试", "busy");
  const updated = await db.update(answer).set({ correctedTranscript: t, ...(regenerate ? { status: "queued", processingStage: "feedback", feedbackUsesCorrection: true, error: null } : {}), updatedAt: new Date() })
    .where(and(eq(answer.id, a.id), eq(answer.status, a.status))).returning({ id: answer.id });
  if (!updated.length) throw conflict("正在处理中，请稍后再试", "busy");
  if (!regenerate) return { status: a.status, regenerating: false };
  await enqueue(QUEUES.processAnswer, { answerId: a.id, mode: "correction" });
  return { status: "queued", regenerating: true };
}

/** 重试失败的处理（重试时跳过已完成阶段） */
export async function retryProcessing(userId: string, answerId: string) {
  return withRecordingConsent(userId, () => retryProcessingLocked(userId, answerId));
}
async function retryProcessingLocked(userId: string, answerId: string) {
  const [a] = await db.select().from(answer).where(and(eq(answer.id, answerId), eq(answer.userId, userId)));
  if (!a) throw notFound("回答");
  await assertSessionVisible(a.sessionId);
  if (a.status === "uploaded") return submitAnswerLocked(userId, answerId);
  if (a.status !== "failed") throw conflict("只有处理失败的回答可以重试", "not_failed");
  if (a.processingStage === "budget_wait") await assertUserAiBudget(userId);
  if (a.processingStage === "quota_wait") assertCoveredQuota((await reconcileAnswerQuota(a.id)).uncoveredSeconds);
  if (a.transcript === null && (!a.storageKey || a.audioDeletedAt || a.createdAt.getTime() + 30 * 86400_000 <= Date.now())) {
    throw new AppError(410, "audio_expired", "录音未上传或已到期，无法重新识别，请重新作答。");
  }
  const [claimed] = await db
    .update(answer)
    .set({ status: "queued", processingStage: a.transcript === null ? "audio" : "feedback", error: null, updatedAt: new Date() })
    .where(and(eq(answer.id, a.id), eq(answer.status, "failed")))
    .returning({ id: answer.id });
  if (claimed) await enqueue(QUEUES.processAnswer, { answerId: a.id, mode: a.feedbackUsesCorrection ? "correction" : "full" });
  return { status: "queued" };
}

async function assertSessionVisible(sessionId: string) {
  const [s] = await db.select({ deletedAt: practiceSession.deletedAt }).from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (!s || s.deletedAt) throw notFound("回答");
}

/** 录音回放：OSS 返回 5 分钟签名链接；本地驱动由接口直接输出 */
export async function getAnswerAudio(viewer: { id: string; isAdmin: boolean }, answerId: string) {
  const d = await getAnswerDetail(viewer, answerId);
  const [a] = await db.select().from(answer).where(eq(answer.id, answerId));
  if (!a.storageKey || a.audioDeletedAt || a.createdAt.getTime() + 30 * 86400_000 <= Date.now()) throw new AppError(410, "audio_expired", "录音已超过保存期限或已删除");
  const st = storage();
  const url = await st.signedUrl(a.storageKey, 300);
  return { key: a.storageKey, mime: a.mimeType ?? "application/octet-stream", url, own: d.own };
}

export async function addRetryItem(userId: string, answerId: string, note?: string) {
  const [a] = await db.select().from(answer).where(and(eq(answer.id, answerId), eq(answer.userId, userId)));
  if (!a) throw notFound("回答");
  await assertSessionVisible(a.sessionId);
  await db
    .insert(retryItem)
    .values({ userId, questionId: a.questionId, sourceAnswerId: a.id, note: note?.slice(0, 200) })
    .onConflictDoNothing();
  return { ok: true };
}

export async function removeRetryItem(userId: string, id: string) {
  await db.update(retryItem).set({ doneAt: new Date() }).where(and(eq(retryItem.id, id), eq(retryItem.userId, userId)));
}

/** 同一题目的历次作答（用于对比） */
export async function answerHistory(userId: string, questionId: string) {
  const rows = await db
    .select({ a: answer, s: { mode: practiceSession.mode, plan: practiceSession.plan } })
    .from(answer)
    .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId))
    .where(and(eq(answer.userId, userId), eq(answer.questionId, questionId), eq(answer.kind, "main"), isNull(practiceSession.deletedAt)))
    .orderBy(desc(answer.createdAt))
    .limit(20);
  const out = [];
  for (const r of rows) {
    const [fb] = await db
      .select()
      .from(feedback)
      .where(and(eq(feedback.answerId, r.a.id), eq(feedback.isCurrent, true)))
      .limit(1);
    const plan = r.s.plan as SessionPlan;
    out.push({ answer: publicAnswer(r.a), feedback: fb ?? null, sessionTitle: plan.title, mode: r.s.mode,
      goalRule: plan.items[r.a.planIndex]?.itemRule, minEffectiveSeconds: plan.items[r.a.planIndex]?.minEffectiveSeconds ?? null, timeScale: plan.timeScale });
  }
  return out;
}
