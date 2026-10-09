import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { deletionLog, personalThought, thoughtGeneration, thoughtPractice, thoughtReview, user, vocabularyEntry } from "@/db/schema";
import { db } from "@/lib/db";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { metered } from "@/lib/providers/metered";
import { reviewIntervalDays } from "@/lib/services/review-intervals";
import { appendDeletionLog } from "@/lib/services/deletion";
import { THOUGHT_SYSTEM } from "@/lib/thoughts/prompt";
import { containsTerm, editThoughtSchema, editVocabularySchema, generateThoughtSchema, normalizeTerm, practiceSchema, saveVocabularySchema, thoughtOutputSchema,
  type ThoughtDetail, type ThoughtList, type VocabularyList } from "@/lib/thoughts/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const searchPattern = (query: string) => `%${query.replace(/[\\%_]/g, "\\$&")}%`;
async function lock(tx: Tx, userId: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`thoughts:${userId}`}, 0))`); }
async function owned(conn: typeof db | Tx, userId: string, id: string) {
  const [row] = await conn.select().from(personalThought).where(and(eq(personalThought.id, id), eq(personalThought.userId, userId)));
  if (!row) throw notFound("观点");
  return row;
}
function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw conflict("这份观点已在其他页面修改，请重新打开后操作。当前输入仍保留。", "thought_changed");
}

export async function listThoughts(userId: string, query = "", offset = 0): Promise<ThoughtList> {
  const where = and(eq(personalThought.userId, userId), query ? or(ilike(personalThought.title, searchPattern(query)), ilike(personalThought.sourceText, searchPattern(query))) : undefined);
  const [items, [count]] = await Promise.all([
    db.select({ id: personalThought.id, title: personalThought.title, sourceText: personalThought.sourceText, mock: personalThought.mock, updatedAt: personalThought.updatedAt })
      .from(personalThought).where(where).orderBy(desc(personalThought.updatedAt), personalThought.id).limit(20).offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(personalThought).where(where),
  ]);
  return { items: items.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })), total: count.total, offset, pageSize: 20 };
}

export async function getThought(userId: string, id: string): Promise<ThoughtDetail> {
  const row = await owned(db, userId, id);
  const [[review], practices] = await Promise.all([
    db.select().from(thoughtReview).where(and(eq(thoughtReview.thoughtId, id), eq(thoughtReview.userId, userId))),
    db.select().from(thoughtPractice).where(and(eq(thoughtPractice.thoughtId, id), eq(thoughtPractice.userId, userId))).orderBy(desc(thoughtPractice.createdAt)).limit(20),
  ]);
  return { id: row.id, sourceText: row.sourceText, title: row.title, analysis: row.analysis, simple: row.simple, natural: row.natural, nuanced: row.nuanced,
    vocabulary: row.vocabulary, model: row.model, mock: row.mock, edited: row.edited, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    review: review ? { completedCount: review.completedCount, nextDueAt: review.nextDueAt.toISOString(), lastReviewedAt: review.lastReviewedAt?.toISOString() ?? null } : null,
    practices: practices.map(p => ({ id: p.id, outcome: p.outcome, durationSeconds: p.durationSeconds, recalledText: p.recalledText, naturalText: p.naturalText, createdAt: p.createdAt.toISOString() })),
  };
}

export async function generateThought(userId: string, input: unknown) {
  const parsed = generateThoughtSchema.safeParse(input);
  if (!parsed.success) throw badRequest("请输入 3–2000 字的观点。");
  const { sourceText, requestId } = parsed.data;
  const sourceHash = hash(sourceText);
  const existingId = await db.transaction(async tx => {
    await lock(tx, userId);
    const [owner] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.banned, false), sql`${user.deletedAt} is null`));
    if (!owner) throw new AppError(403, "account_inactive", "账号已停用。");
    const [existing] = await tx.select().from(thoughtGeneration).where(and(eq(thoughtGeneration.userId, userId), eq(thoughtGeneration.requestId, requestId)));
    if (existing) {
      if (existing.sourceHash !== sourceHash) throw conflict("请为新的观点重新发起生成。", "request_changed");
      if (existing.status === "done") { if (!existing.thoughtId) throw notFound("已删除的观点"); return existing.thoughtId; }
      throw conflict(existing.status === "pending" ? "这次生成仍在处理中，请稍后刷新观点历史。" : "这次生成未完成，请重新发起生成。", existing.status === "pending" ? "generation_pending" : "generation_failed");
    }
    const recent = await tx.select().from(thoughtGeneration).where(and(eq(thoughtGeneration.userId, userId), gte(thoughtGeneration.createdAt, new Date(Date.now() - 600_000))));
    if (recent.length >= 6 || recent.some(r => r.status === "pending" && r.createdAt.getTime() > Date.now() - 90_000))
      throw new AppError(429, "thought_rate_limit", "生成较频繁，请稍后再试；已有表达仍可编辑和练习。");
    await tx.insert(thoughtGeneration).values({ userId, requestId, sourceHash });
    return null;
  });
  if (existingId) return getThought(userId, existingId);
  try {
    const result = await metered(`thought:${requestId}`, userId).llmJson({ purpose: "thought", system: THOUGHT_SYSTEM,
      user: JSON.stringify({ opinion: sourceText }), maxTokens: 2600, timeoutMs: 60_000, mockHint: { sourceText } });
    const output = thoughtOutputSchema.safeParse(result.json);
    if (!output.success) throw new AppError(502, "thought_invalid_output", "模型返回的表达不完整，未保存为观点。可稍后重试；本次用量已记入 API 与用量。");
    const data = output.data;
    // Only save vocabulary actually present in the expressions and its example.
    const seen = new Set<string>();
    data.vocabulary = data.vocabulary.filter(word => {
      const term = normalizeTerm(word.term);
      const expressions = [data.simple, data.natural, data.nuanced].join("\n");
      if (seen.has(term) || !containsTerm(expressions, word.term) || !containsTerm(word.example, word.term) || !containsTerm(expressions, word.example)) return false;
      seen.add(term); return true;
    });
    const id = await db.transaction(async tx => {
      await lock(tx, userId);
      const [owner] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.banned, false), sql`${user.deletedAt} is null`)).for("share");
      if (!owner) throw new AppError(403, "account_inactive", "账号已停用，生成结果未保存。");
      const [row] = await tx.insert(personalThought).values({ ...data, sourceText, userId, model: result.model, mock: result.mock }).returning({ id: personalThought.id });
      await tx.update(thoughtGeneration).set({ status: "done", thoughtId: row.id }).where(and(eq(thoughtGeneration.userId, userId), eq(thoughtGeneration.requestId, requestId)));
      return row.id;
    });
    return getThought(userId, id);
  } catch (error) {
    await db.update(thoughtGeneration).set({ status: "failed" }).where(and(eq(thoughtGeneration.userId, userId), eq(thoughtGeneration.requestId, requestId), eq(thoughtGeneration.status, "pending")));
    if (error instanceof AppError) throw error;
    // Providers can echo inputs or credentials in their errors; never propagate them.
    throw new AppError(502, "thought_generation_failed", "生成未完成，请检查 API 配置后重试。本次调用情况可在 API 与用量查看。");
  }
}

export async function editThought(userId: string, id: string, input: unknown) {
  const parsed = editThoughtSchema.safeParse(input);
  if (!parsed.success) throw badRequest("请检查观点标题和三种英文表达的长度、语言。");
  const { revision, ...values } = parsed.data;
  await db.transaction(async tx => {
    await lock(tx, userId);
    const row = await owned(tx, userId, id); assertRevision(row.revision, revision);
    await tx.update(personalThought).set({ ...values, revision: revision + 1, edited: true, updatedAt: new Date() }).where(eq(personalThought.id, id));
    if (row.natural !== values.natural) await tx.update(thoughtReview).set({ naturalText: values.natural, completedCount: 0, nextDueAt: new Date(), lastReviewedAt: null }).where(eq(thoughtReview.thoughtId, id));
  });
  return getThought(userId, id);
}

export async function deleteThought(userId: string, id: string) {
  await db.transaction(async tx => {
    await lock(tx, userId); await owned(tx, userId, id);
    const intent = { id: randomUUID(), kind: "thought" as const, targetId: id, userId, at: new Date().toISOString() };
    await appendDeletionLog(intent);
    await tx.delete(personalThought).where(eq(personalThought.id, id));
    await tx.insert(deletionLog).values({ id: intent.id, kind: intent.kind, targetId: id, userId, requestedBy: userId, completedAt: new Date(), createdAt: new Date(intent.at) });
  });
  return { ok: true };
}

export async function enrollThought(userId: string, id: string, revision: number, remove = false) {
  await db.transaction(async tx => {
    await lock(tx, userId); const row = await owned(tx, userId, id); assertRevision(row.revision, revision);
    if (remove) { await tx.delete(thoughtReview).where(eq(thoughtReview.thoughtId, id)); return; }
    await tx.insert(thoughtReview).values({ userId, thoughtId: id, naturalText: row.natural }).onConflictDoNothing();
  });
  return getThought(userId, id);
}

export async function recordThoughtPractice(userId: string, id: string, input: unknown, now = new Date()) {
  const parsed = practiceSchema.safeParse(input);
  if (!parsed.success) throw badRequest("练习记录参数错误。");
  const p = parsed.data;
  await db.transaction(async tx => {
    await lock(tx, userId); const row = await owned(tx, userId, id);
    const [existing] = await tx.select().from(thoughtPractice).where(and(eq(thoughtPractice.userId, userId), eq(thoughtPractice.requestId, p.requestId)));
    if (existing) {
      if (existing.thoughtId !== id || existing.thoughtRevision !== p.revision || existing.outcome !== p.outcome || existing.recalledText !== p.recalledText || existing.durationSeconds !== p.durationSeconds)
        throw conflict("这次练习的提交内容发生变化，请重新开始练习。", "request_changed");
      return;
    }
    assertRevision(row.revision, p.revision);
    if (p.durationSeconds < 1 && p.recalledText.length < 3) throw badRequest("请先录音或写下尝试表达，再保存练习。");
    if (p.outcome !== "practice") {
      const [review] = await tx.select().from(thoughtReview).where(and(eq(thoughtReview.thoughtId, id), eq(thoughtReview.userId, userId)));
      if (!review) throw conflict("请先把 Natural 加入复习。", "review_required");
      const count = p.outcome === "again" ? 0 : review.completedCount + 1;
      await tx.update(thoughtReview).set({ completedCount: count, lastReviewedAt: now,
        nextDueAt: new Date(now.getTime() + reviewIntervalDays(Math.max(count, 1)) * 86400_000) }).where(eq(thoughtReview.thoughtId, id));
    }
    await tx.insert(thoughtPractice).values({ userId, thoughtId: id, requestId: p.requestId, thoughtRevision: row.revision,
      naturalText: row.natural, recalledText: p.recalledText, outcome: p.outcome, durationSeconds: p.durationSeconds, createdAt: now });
  });
  return getThought(userId, id);
}

export async function getThoughtReviewQueue(userId: string, now = new Date()) {
  const rows = await db.select({ id: personalThought.id, title: personalThought.title, sourceText: personalThought.sourceText,
    mock: personalThought.mock, nextDueAt: thoughtReview.nextDueAt, completedCount: thoughtReview.completedCount }).from(thoughtReview)
    .innerJoin(personalThought, eq(personalThought.id, thoughtReview.thoughtId))
    .where(and(eq(thoughtReview.userId, userId), eq(personalThought.userId, userId))).orderBy(thoughtReview.nextDueAt, personalThought.id);
  const items = rows.map(row => ({ ...row, nextDueAt: row.nextDueAt.toISOString() }));
  return { due: items.filter(row => Date.parse(row.nextDueAt) <= now.getTime()), upcoming: items.filter(row => Date.parse(row.nextDueAt) > now.getTime()) };
}

export async function listVocabulary(userId: string, query = "", offset = 0): Promise<VocabularyList> {
  const where = and(eq(vocabularyEntry.userId, userId), query ? or(ilike(vocabularyEntry.term, searchPattern(query)), ilike(vocabularyEntry.meaning, searchPattern(query))) : undefined);
  const [rows, [count]] = await Promise.all([
    db.select().from(vocabularyEntry).where(where).orderBy(desc(vocabularyEntry.updatedAt), vocabularyEntry.id).limit(40).offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(vocabularyEntry).where(where),
  ]);
  return { items: rows.map(({ id, term, meaning, example, thoughtId, updatedAt }) => ({ id, term, meaning, example, thoughtId, updatedAt: updatedAt.toISOString() })), total: count.total, offset, pageSize: 40 };
}

export async function saveThoughtVocabulary(userId: string, input: unknown) {
  const parsed = saveVocabularySchema.safeParse(input);
  if (!parsed.success) throw badRequest("请选择要收藏的词语。");
  const { thoughtId, revision, indices } = parsed.data;
  return db.transaction(async tx => {
    await lock(tx, userId); const thought = await owned(tx, userId, thoughtId); assertRevision(thought.revision, revision);
    let added = 0;
    for (const index of new Set(indices)) {
      const word = thought.vocabulary[index];
      if (!word || !containsTerm([thought.simple, thought.natural, thought.nuanced].join("\n"), word.term)) throw badRequest("词语已不在当前表达中，请先保存或重新生成表达。");
      const rows = await tx.insert(vocabularyEntry).values({ ...word, normalizedTerm: normalizeTerm(word.term), userId, thoughtId })
        .onConflictDoNothing({ target: [vocabularyEntry.userId, vocabularyEntry.normalizedTerm] }).returning({ id: vocabularyEntry.id });
      added += rows.length;
    }
    return { added, existing: new Set(indices).size - added };
  });
}

export async function editVocabulary(userId: string, id: string, input: unknown) {
  const parsed = editVocabularySchema.safeParse(input); if (!parsed.success) throw badRequest("请检查词语、释义与例句。");
  return db.transaction(async tx => {
    await lock(tx, userId);
    const [row] = await tx.select().from(vocabularyEntry).where(and(eq(vocabularyEntry.id, id), eq(vocabularyEntry.userId, userId)));
    if (!row) throw notFound("词语");
    const normalizedTerm = normalizeTerm(parsed.data.term);
    const [duplicate] = await tx.select({ id: vocabularyEntry.id }).from(vocabularyEntry).where(and(eq(vocabularyEntry.userId, userId), eq(vocabularyEntry.normalizedTerm, normalizedTerm)));
    if (duplicate && duplicate.id !== id) throw conflict("词汇库中已存在这个词语。");
    await tx.update(vocabularyEntry).set({ ...parsed.data, normalizedTerm, updatedAt: new Date() }).where(eq(vocabularyEntry.id, id));
    return { ok: true };
  });
}
export async function deleteVocabulary(userId: string, id: string) {
  await db.transaction(async tx => {
    await lock(tx, userId);
    const [row] = await tx.select({ id: vocabularyEntry.id }).from(vocabularyEntry).where(and(eq(vocabularyEntry.userId, userId), eq(vocabularyEntry.id, id)));
    if (!row) throw notFound("词语");
    const intent = { id: randomUUID(), kind: "vocabulary" as const, targetId: id, userId, at: new Date().toISOString() };
    await appendDeletionLog(intent);
    await tx.delete(vocabularyEntry).where(eq(vocabularyEntry.id, id));
    await tx.insert(deletionLog).values({ id: intent.id, kind: intent.kind, targetId: id, userId, requestedBy: userId, completedAt: new Date(), createdAt: new Date(intent.at) });
  });
  return { ok: true };
}
