import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { level, mockSet, question, questionVersion } from "@/db/schema";
import { loadContent, normalizeContent, type ContentBundle } from "@/lib/content/load";
import {
  metaFileSchema,
  part1FileSchema,
  part2FileSchema,
  part3FileSchema,
  questionContentSchema,
  REVIEW_STATUSES,
  type QuestionContent,
  type ReviewStatus,
} from "@/lib/content/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, badRequest } from "@/lib/errors";
import type { VersionedQuestion } from "@/lib/sessions/plan";

export function contentHash(c: QuestionContent): string {
  // 审核状态不计入内容哈希：只改审核状态不产生新版本
  const { reviewStatus: _r, ...rest } = c;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** 当前可用于新会话的已发布版本（生产环境额外要求审核通过） */
export async function publishedVersions(questionIds: string[]): Promise<Map<string, VersionedQuestion>> {
  if (questionIds.length === 0) return new Map();
  const requireReview = env().CONTENT_REQUIRE_REVIEW;
  const rows = await db
    .selectDistinctOn([questionVersion.questionId], {
      id: questionVersion.id,
      version: questionVersion.version,
      questionId: questionVersion.questionId,
      content: questionVersion.content,
      reviewStatus: questionVersion.reviewStatus,
    })
    .from(questionVersion)
    .where(
      and(
        inArray(questionVersion.questionId, questionIds),
        eq(questionVersion.published, true),
        requireReview ? eq(questionVersion.reviewStatus, "approved") : undefined,
      ),
    )
    .orderBy(questionVersion.questionId, desc(questionVersion.version));
  return new Map(
    rows.map((r) => [r.questionId, { versionId: r.id, version: r.version, content: r.content as QuestionContent, reviewStatus: r.reviewStatus }]),
  );
}

export async function requirePublished(questionIds: string[]): Promise<VersionedQuestion[]> {
  const map = await publishedVersions(questionIds);
  const missing = questionIds.filter((id) => !map.has(id));
  if (missing.length) throw new AppError(409, "content_not_ready", "内容准备中：部分题目尚未发布");
  return questionIds.map((id) => map.get(id)!);
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  published: number;
  errors: string[];
}

/**
 * 导入/更新题目：内容变化时生成新版本（已开始的会话继续使用原版本）。
 * 新版本默认不发布；autoPublish 时按发布门槛决定是否发布。
 */
export async function upsertQuestions(
  items: QuestionContent[],
  opts: { autoPublish?: boolean; reviewer?: string } = {},
): Promise<ImportResult> {
  const res: ImportResult = { created: 0, updated: 0, unchanged: 0, published: 0, errors: [] };
  const requireReview = env().CONTENT_REQUIRE_REVIEW;
  for (const raw of items) {
    const parsed = questionContentSchema.safeParse(raw);
    if (!parsed.success) {
      res.errors.push(`${(raw as { id?: string }).id ?? "?"}：${parsed.error.issues[0]?.message}`);
      continue;
    }
    const c = parsed.data;
    const hash = contentHash(c);
    await db.transaction(async (tx) => {
      const [q] = await tx.select().from(question).where(eq(question.id, c.id));
      if (!q) {
        await tx.insert(question).values({ id: c.id, scenario: c.scenario, language: c.language, part: c.part, topic: c.topic });
      }
      const [latest] = await tx
        .select()
        .from(questionVersion)
        .where(eq(questionVersion.questionId, c.id))
        .orderBy(desc(questionVersion.version))
        .limit(1);
      if (latest && latest.contentHash === hash) {
        res.unchanged++;
        return;
      }
      const canPublish = !!opts.autoPublish && (!requireReview || c.reviewStatus === "approved");
      const [v] = await tx
        .insert(questionVersion)
        .values({
          questionId: c.id,
          version: (latest?.version ?? 0) + 1,
          contentHash: hash,
          content: c,
          reviewStatus: c.reviewStatus,
          sourceType: c.sourceType,
          published: canPublish,
          reviewedBy: opts.reviewer,
        })
        .returning({ id: questionVersion.id });
      await tx.update(question).set({ currentVersionId: v.id, updatedAt: new Date() }).where(eq(question.id, c.id));
      if (latest) res.updated++;
      else res.created++;
      if (canPublish) res.published++;
    });
  }
  return res;
}

/** 解析管理后台上传的 JSON：支持题库文件格式（part1/part2/part3）或标准化题目数组 */
export function parseImportPayload(payload: unknown, bundle: ContentBundle = loadContent()): QuestionContent[] {
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj)) return z.array(questionContentSchema).parse(obj);
  if (Array.isArray(obj?.questions) && (obj.questions as unknown[])[0] && "text" in ((obj.questions as unknown[])[0] as object)) {
    return z.array(questionContentSchema).parse(obj.questions);
  }
  const meta = obj.meta ? metaFileSchema.parse(obj.meta) : bundle.meta;
  const part1 = obj.topics ? part1FileSchema.parse(obj) : undefined;
  const part2 = obj.cards ? part2FileSchema.parse(obj) : undefined;
  const part3 = obj.questions ? part3FileSchema.parse(obj) : undefined;
  if (!part1 && !part2 && !part3) throw badRequest("无法识别的题库格式：需要 topics / cards / questions 字段");
  return normalizeContent({ meta, part1, part2, part3, categories: bundle.categories });
}

export async function setReviewStatus(versionId: string, status: ReviewStatus, reviewer: string, note?: string) {
  if (!REVIEW_STATUSES.includes(status)) throw badRequest("未知的审核状态");
  const [v] = await db.select().from(questionVersion).where(eq(questionVersion.id, versionId));
  if (!v) throw new AppError(404, "not_found", "题目版本不存在");
  const content = { ...(v.content as QuestionContent), reviewStatus: status };
  const unpublish = env().CONTENT_REQUIRE_REVIEW && status !== "approved" && v.published;
  await db
    .update(questionVersion)
    .set({ reviewStatus: status, content, reviewedBy: reviewer, reviewNote: note ?? v.reviewNote, published: unpublish ? false : v.published, updatedAt: new Date() })
    .where(eq(questionVersion.id, versionId));
}

export async function setPublished(versionId: string, published: boolean) {
  const [v] = await db.select().from(questionVersion).where(eq(questionVersion.id, versionId));
  if (!v) throw new AppError(404, "not_found", "题目版本不存在");
  if (published && env().CONTENT_REQUIRE_REVIEW && v.reviewStatus !== "approved") {
    throw new AppError(409, "review_required", "生产环境只能发布审核通过（approved）的题目");
  }
  await db.update(questionVersion).set({ published, updatedAt: new Date() }).where(eq(questionVersion.id, versionId));
}

/** 同步关卡与模考编排（来自 content/ielts/levels.json、mocks.json、chapters.json） */
export async function syncLevelsAndMocks(bundle: ContentBundle = loadContent()) {
  for (const m of bundle.mocks) {
    const plan = { part1: m.part1, part2: m.part2, part3: m.part3 };
    await db
      .insert(mockSet)
      .values({ id: m.id, title: m.title, plan })
      .onConflictDoUpdate({ target: mockSet.id, set: { title: m.title, plan, updatedAt: new Date() } });
  }
  for (const l of bundle.levels) {
    const ch = bundle.chapters.find((c) => c.chapter === l.chapter)!;
    const values = {
      id: l.id,
      chapter: l.chapter,
      order: l.order,
      title: l.title,
      questionIds: l.questions,
      mockSetId: l.mockSet ?? null,
      timing: ch.timing,
      hints: ch.hints,
      goalRule: ch.goal,
    };
    await db
      .insert(level)
      .values(values)
      .onConflictDoUpdate({ target: level.id, set: { ...values, updatedAt: new Date() } });
  }
}

export type LevelRow = typeof level.$inferSelect;

export async function listLevels(): Promise<LevelRow[]> {
  return db.select().from(level).orderBy(asc(level.chapter), asc(level.order));
}

/** 关卡内容是否已全部发布（否则显示"内容准备中"） */
export async function levelAvailability(levels: LevelRow[]): Promise<Map<string, boolean>> {
  const mocks = await db.select().from(mockSet);
  const need = new Set<string>();
  const levelQuestions = new Map<string, string[]>();
  for (const l of levels) {
    let ids = l.questionIds;
    if (l.mockSetId) {
      const m = mocks.find((x) => x.id === l.mockSetId);
      const p = m?.plan as { part1: string[]; part2: string; part3: string[] } | undefined;
      ids = p ? [...p.part1, p.part2, ...p.part3] : [];
    }
    levelQuestions.set(l.id, ids);
    ids.forEach((i) => need.add(i));
  }
  const pub = await publishedVersions([...need]);
  return new Map(levels.map((l) => [l.id, (levelQuestions.get(l.id) ?? []).every((q) => pub.has(q)) && (levelQuestions.get(l.id)?.length ?? 0) > 0]));
}

/** 自由练习：列出全部已发布的主问题 */
export async function listPublishedQuestions() {
  const ids = (await db.select({ id: question.id }).from(question)).map((r) => r.id);
  const map = await publishedVersions(ids);
  return [...map.values()]
    .map((v) => ({ ...v.content, version: v.version, reviewStatus: v.reviewStatus }))
    .sort((a, b) => a.part - b.part || a.topic.localeCompare(b.topic) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export async function questionStats() {
  const rows = await db
    .select({
      part: question.part,
      total: sql<number>`count(distinct ${question.id})::int`,
    })
    .from(question)
    .groupBy(question.part);
  return rows;
}
