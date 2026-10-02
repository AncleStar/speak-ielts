import { z } from "zod";

export const DIMENSIONS = ["fluency_coherence", "lexical", "grammar", "content"] as const;
export const DIMENSION_LABEL: Record<(typeof DIMENSIONS)[number], string> = {
  fluency_coherence: "流利与连贯",
  lexical: "词汇",
  grammar: "语法",
  content: "内容",
};

const text = (max: number) => z.string().trim().min(1).max(max);

export const strengthSchema = z.object({
  point: text(400),
  evidence: text(400),
});

export const improvementSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  issue: text(400),
  evidence: text(400),
  suggestion: text(600),
  explanation: text(600),
});

/** 模型原始输出：strengths 1–2 条，improvements 1–3 条 */
export const rawFeedbackSchema = z.object({
  summary: text(500),
  strengths: z.array(strengthSchema).min(1).max(2),
  improvements: z.array(improvementSchema).min(1).max(3),
  sampleAnswer: text(4000),
  nextGoal: text(300),
  goal: z.object({ met: z.boolean(), reason: text(500) }),
  dimensions: z.object({
    fluency_coherence: text(500),
    lexical: text(500),
    grammar: text(500),
  }),
});
export type RawFeedback = z.infer<typeof rawFeedbackSchema>;

/** 校验后保存的反馈（证据不可追溯的条目已丢弃，目标判断已叠加程序化条件） */
export const storedFeedbackSchema = rawFeedbackSchema.extend({
  strengths: z.array(strengthSchema).max(2),
  improvements: z.array(improvementSchema).max(3),
  goal: z.object({
    met: z.boolean(),
    reason: z.string(),
    modelMet: z.boolean(),
    programReason: z.string().optional(),
  }),
  pronunciation: z.object({ status: z.literal("not_assessed"), note: z.string() }),
});
export type StoredFeedback = z.infer<typeof storedFeedbackSchema>;

export const followUpChoiceSchema = z.object({
  followUpId: z.string().trim().min(1).max(100),
  reason: z.string().max(300).optional(),
});

export const PRONUNCIATION_NOT_ASSESSED = "发音：未评估（首版未启用音频分析）";
