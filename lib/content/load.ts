import fs from "node:fs";
import path from "node:path";
import {
  chapterSchema,
  levelFileSchema,
  metaFileSchema,
  mockFileSchema,
  part1FileSchema,
  part2FileSchema,
  part3FileSchema,
  phraseFileSchema,
  type ChapterDef,
  type LevelDef,
  type MockDef,
  type PhraseKey,
  type QuestionContent,
} from "./types";
import { z } from "zod";

export const CONTENT_DIR = () =>
  path.resolve(/*turbopackIgnore: true*/ process.env.CONTENT_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "content", "ielts"));

export interface ContentBundle {
  meta: z.infer<typeof metaFileSchema>;
  questions: QuestionContent[];
  topics: { code: string; name: string; intro: string; part: 1 }[];
  categories: { code: string; name: string }[];
  chapters: ChapterDef[];
  levels: LevelDef[];
  mocks: MockDef[];
  phrases: Record<PhraseKey, string>;
}

function readJson(dir: string, file: string): unknown {
  const p = path.join(dir, file);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export const DEFAULT_GOALS = {
  1: {
    goal: "直接回答问题，并补充具体细节",
    rule: "首句直接回应题目，并补充至少一个具体细节（原因、例子、频率或感受）",
    answerSeconds: 45,
  },
  2: {
    goal: "围绕任务卡完整、连贯地讲述",
    rule: "覆盖任务卡各要点，有开头—经过—结尾的结构，并解释最后一问",
    answerSeconds: 120,
    prepSeconds: 60,
  },
  3: {
    goal: "明确观点，并用原因、对比或例子支撑",
    rule: "明确表达观点，并用原因、对比或例子加以支撑",
    answerSeconds: 75,
  },
} as const;

type RawCommon = {
  zh: string;
  difficulty: number;
  keywords: string[];
  tips: string;
  expressions: string[];
  reference: string;
  difficulties: string[];
  goal?: string;
  rule?: string;
  sample?: boolean;
  reviewStatus?: QuestionContent["reviewStatus"];
  sourceType?: QuestionContent["sourceType"];
};

function commonFields(raw: RawCommon, part: 1 | 2 | 3, meta: ContentBundle["meta"]) {
  const d = DEFAULT_GOALS[part];
  return {
    scenario: meta.scenario,
    language: meta.language,
    difficulty: raw.difficulty,
    trainingGoal: raw.goal ?? d.goal,
    evaluationRule: raw.rule ?? d.rule,
    zh: raw.zh,
    keywords: raw.keywords,
    structureTips: raw.tips,
    usefulExpressions: raw.expressions,
    referenceAnswer: raw.reference,
    commonDifficulties: raw.difficulties,
    sourceType: raw.sourceType ?? meta.sourceType,
    reviewStatus: raw.reviewStatus ?? meta.reviewStatus,
    sample: raw.sample ?? false,
  };
}

/** 将编写格式转换为标准化的题目内容快照。 */
export function normalizeContent(input: {
  meta: ContentBundle["meta"];
  part1?: z.infer<typeof part1FileSchema>;
  part2?: z.infer<typeof part2FileSchema>;
  part3?: z.infer<typeof part3FileSchema>;
  /** 用于 Part 3 查找关联任务卡的主题名 */
  categories?: { code: string; name: string }[];
}): QuestionContent[] {
  const out: QuestionContent[] = [];
  const { meta } = input;
  const categories = input.categories ?? input.part2?.categories ?? [];
  const catName = (code: string) => categories.find((c) => c.code === code)?.name ?? code;

  for (const t of input.part1?.topics ?? []) {
    for (const q of t.questions) {
      out.push({
        id: `P1-${t.code}-${q.n}`,
        part: 1,
        topic: t.code,
        topicName: t.name,
        topicIntro: t.intro,
        text: q.q,
        defaultTiming: { answerSeconds: DEFAULT_GOALS[1].answerSeconds },
        ...commonFields(q, 1, meta),
      });
    }
  }
  for (const c of input.part2?.cards ?? []) {
    const cat = c.id.split("-")[1];
    out.push({
      id: c.id,
      part: 2,
      topic: cat,
      topicName: catName(cat),
      text: c.q,
      card: { points: c.points, lastPoint: c.lastPoint },
      roundingOff: c.roundingOff.map((r) => ({ id: r.id, text: r.q })),
      defaultTiming: { answerSeconds: DEFAULT_GOALS[2].answerSeconds, prepSeconds: DEFAULT_GOALS[2].prepSeconds },
      ...commonFields(c, 2, meta),
    });
  }
  for (const q of input.part3?.questions ?? []) {
    const cat = q.id.split("-")[1];
    out.push({
      id: q.id,
      part: 3,
      topic: cat,
      topicName: catName(cat),
      text: q.q,
      relatedCardId: q.card,
      followUps: q.followUps.map((f) => ({ id: f.id, text: f.q, zh: f.zh })),
      defaultFollowUpId: q.defaultFollowUp,
      defaultTiming: { answerSeconds: DEFAULT_GOALS[3].answerSeconds },
      ...commonFields(q, 3, meta),
    });
  }
  return out;
}

let cache: ContentBundle | null = null;

/** 读取 content/ielts/ 下全部题库与编排文件（进程内缓存）。 */
export function loadContent(dir = CONTENT_DIR(), { fresh = false } = {}): ContentBundle {
  if (cache && !fresh) return cache;
  const meta = metaFileSchema.parse(readJson(dir, "meta.json"));
  const part1 = part1FileSchema.parse(readJson(dir, "part1.json"));
  const part2 = part2FileSchema.parse(readJson(dir, "part2.json"));
  const part3 = part3FileSchema.parse(readJson(dir, "part3.json"));
  const chapters = z.object({ chapters: z.array(chapterSchema) }).parse(readJson(dir, "chapters.json")).chapters;
  const levels = levelFileSchema.parse(readJson(dir, "levels.json")).levels;
  const mocks = mockFileSchema.parse(readJson(dir, "mocks.json")).mocks;
  const phrases = phraseFileSchema.parse(readJson(dir, "phrases.json")).phrases as Record<PhraseKey, string>;
  const bundle: ContentBundle = {
    meta,
    questions: normalizeContent({ meta, part1, part2, part3 }),
    topics: part1.topics.map((t) => ({ code: t.code, name: t.name, intro: t.intro, part: 1 as const })),
    categories: part2.categories,
    chapters,
    levels,
    mocks,
    phrases,
  };
  cache = bundle;
  return bundle;
}

export function getChapter(chapter: number): ChapterDef {
  const c = loadContent().chapters.find((x) => x.chapter === chapter);
  if (!c) throw new Error(`未知章节 ${chapter}`);
  return c;
}

export function getPhrases() {
  return loadContent().phrases;
}
