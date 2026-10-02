import { z } from "zod";

/** 审核状态：AI 起草 → 英语表达已审 → 题型已审 → 通过 */
export const REVIEW_STATUSES = ["ai_draft", "language_reviewed", "format_reviewed", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  ai_draft: "AI 草稿",
  language_reviewed: "英语表达已审",
  format_reviewed: "题型已审",
  approved: "审核通过",
};

export const SOURCE_TYPES = ["original", "licensed"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type Part = 1 | 2 | 3;

// ------------------------------------------------------------
// 题库 JSON 文件（content/ielts/*.json）的编写格式
// ------------------------------------------------------------

const str = z.string().trim().min(1);
const common = {
  zh: str,
  difficulty: z.number().int().min(1).max(3).default(1),
  keywords: z.array(str).min(1),
  tips: str,
  expressions: z.array(str).min(1),
  reference: str,
  difficulties: z.array(str).min(1),
  goal: str.optional(),
  rule: str.optional(),
  sample: z.boolean().optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
};

export const part1FileSchema = z.object({
  topics: z.array(
    z.object({
      code: z.string().regex(/^[A-Z]+$/),
      name: str,
      intro: str,
      questions: z.array(z.object({ n: z.number().int().min(1), q: str, ...common })).min(1),
    }),
  ),
});

export const part2FileSchema = z.object({
  categories: z.array(z.object({ code: z.string().regex(/^[A-Z]+$/), name: str })),
  cards: z.array(
    z.object({
      id: z.string().regex(/^P2-[A-Z]+-\d+$/),
      q: str,
      points: z.array(str).min(2).max(4),
      lastPoint: str,
      roundingOff: z.array(z.object({ id: str, q: str })).min(1).max(2),
      ...common,
    }),
  ),
});

export const part3FileSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().regex(/^P3-[A-Z]+-\d+-\d$/),
      card: z.string().regex(/^P2-[A-Z]+-\d+$/),
      q: str,
      followUps: z.array(z.object({ id: str, q: str, zh: str })).length(2),
      defaultFollowUp: str,
      ...common,
    }),
  ),
});

export const metaFileSchema = z.object({
  scenario: str,
  language: str,
  sourceType: z.enum(SOURCE_TYPES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  note: str,
});

// ------------------------------------------------------------
// 标准化后的题目内容快照（写入 question_version.content）
// ------------------------------------------------------------

export const followUpSchema = z.object({ id: str, text: str, zh: str.optional() });
export const roundingSchema = z.object({ id: str, text: str });

export const questionContentSchema = z.object({
  id: str,
  scenario: str,
  language: str,
  part: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  topic: str,
  topicName: str,
  topicIntro: str.optional(),
  difficulty: z.number().int().min(1).max(3),
  trainingGoal: str,
  evaluationRule: str,
  text: str,
  zh: str,
  card: z.object({ points: z.array(str), lastPoint: str }).optional(),
  relatedCardId: str.optional(),
  followUps: z.array(followUpSchema).optional(),
  defaultFollowUpId: str.optional(),
  roundingOff: z.array(roundingSchema).optional(),
  keywords: z.array(str),
  structureTips: str,
  usefulExpressions: z.array(str),
  referenceAnswer: str,
  commonDifficulties: z.array(str),
  defaultTiming: z.object({ answerSeconds: z.number().positive(), prepSeconds: z.number().positive().optional() }),
  sourceType: z.enum(SOURCE_TYPES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  sample: z.boolean(),
});
export type QuestionContent = z.infer<typeof questionContentSchema>;

// ------------------------------------------------------------
// 章节、关卡、模考、考官用语
// ------------------------------------------------------------

export const hintsSchema = z.object({
  showText: z.boolean(),
  showZh: z.boolean(),
  showKeywords: z.boolean(),
  showExpressions: z.boolean(),
  showStructure: z.boolean(),
  showCard: z.boolean(),
  notes: z.boolean(),
});
export type Hints = z.infer<typeof hintsSchema>;

export const chapterSchema = z.object({
  chapter: z.number().int().min(1).max(6),
  title: str,
  focus: str,
  part: z.number().int().min(0).max(3),
  timing: z.object({
    answerSeconds: z.number().positive().optional(),
    prepSeconds: z.number().positive().optional(),
    followUpSeconds: z.number().positive().optional(),
    mock: z.boolean().optional(),
  }),
  hints: hintsSchema,
  hintNote: str,
  goal: z.object({
    itemRule: str,
    description: str,
    minEffectiveSeconds: z.number().positive().optional(),
    requiredMet: z.number().int().min(0),
    of: z.number().int().min(0),
  }),
});
export type ChapterDef = z.infer<typeof chapterSchema>;

export const levelFileSchema = z.object({
  levels: z.array(
    z.object({
      id: z.string().regex(/^[1-6]-[1-5]$/),
      chapter: z.number().int().min(1).max(6),
      order: z.number().int().min(1).max(5),
      title: str,
      questions: z.array(str).default([]),
      mockSet: str.optional(),
    }),
  ),
});
export type LevelDef = z.infer<typeof levelFileSchema>["levels"][number];

export const mockFileSchema = z.object({
  mocks: z.array(
    z.object({
      id: z.string().regex(/^mock-\d$/),
      title: str,
      part1: z.array(str).min(4),
      part2: str,
      part3: z.array(str).length(3),
    }),
  ),
});
export type MockDef = z.infer<typeof mockFileSchema>["mocks"][number];

export const PHRASE_KEYS = [
  "training_intro",
  "training_end",
  "mock_intro",
  "p1_topic_switch",
  "p1_to_p2",
  "p2_instruction",
  "p2_start",
  "p2_stop",
  "p2_to_p3",
  "part_timeout",
  "closing",
  "prep_end",
  "time_up",
  "followup_lead",
  "device_check",
] as const;
export type PhraseKey = (typeof PHRASE_KEYS)[number];
export const phraseFileSchema = z.object({
  phrases: z.record(z.enum(PHRASE_KEYS), str),
});
