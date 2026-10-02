import type { ChapterDef, Hints, PhraseKey, QuestionContent } from "@/lib/content/types";
import { MOCK_PART_SECONDS, MOCK_TOTAL_SECONDS, P2_PREP_SECONDS, P2_SPEAK_MAX_SECONDS } from "@/lib/timing";

export type SessionMode = "level" | "mock" | "practice" | "retry";
export type AnswerKind = "main" | "followup" | "rounding";

export interface PromptAudio {
  text: string;
  ttsId: string | null;
}

export interface PlanItem {
  index: number;
  part: 1 | 2 | 3;
  questionId: string;
  versionId: string;
  /** 题目未经人工审核通过（AI 草稿） */
  draft: boolean;
  kind: AnswerKind;
  followUpId?: string;
  topic: string;
  topicName: string;
  prompt: PromptAudio;
  /** 提问前播放的考官用语（主题引入、Part 2 指令等） */
  lead: PromptAudio[];
  zh: string;
  keywords: string[];
  expressions: string[];
  structure: string;
  card?: { title: string; points: string[]; lastPoint: string };
  /** 已按 TIME_SCALE 缩放（秒） */
  prepSeconds?: number;
  /** 已缩放（秒）；null 表示受模考部分截止时间约束 */
  answerSeconds: number | null;
  /** 已缩放（秒）：服务端校验上限 */
  maxSeconds: number;
  /** 第五章：回答后从已审核的追问中选择 1 道 */
  followUp?: {
    candidates: (PromptAudio & { id: string; zh?: string })[];
    defaultId: string;
    answerSeconds: number;
  };
  itemRule: string;
  /** 已缩放（秒） */
  minEffectiveSeconds?: number;
}

export interface PlanGoal {
  description: string;
  requiredMet: number;
  of: number;
  countKinds: AnswerKind[];
  minEffectiveSeconds?: number;
}

export interface SessionPlan {
  v: 1;
  mode: SessionMode;
  title: string;
  subtitle: string;
  chapter: number | null;
  timeScale: number;
  hints: Hints;
  hintNote: string;
  items: PlanItem[];
  phrases: Partial<Record<PhraseKey, PromptAudio>>;
  goal: PlanGoal | null;
  mock: { parts: Record<"1" | "2" | "3", { durationSec: number; items: number[] }> } | null;
  reserveSeconds: number;
  draft: boolean;
}

export interface VersionedQuestion {
  version?: number;
  versionId: string;
  content: QuestionContent;
  reviewStatus: string;
}

export const MOCK_HINTS: Hints = {
  showText: false,
  showZh: false,
  showKeywords: false,
  showExpressions: false,
  showStructure: false,
  showCard: true,
  notes: true,
};

export const PRACTICE_HINTS: Hints = {
  showText: true,
  showZh: true,
  showKeywords: true,
  showExpressions: true,
  showStructure: true,
  showCard: true,
  notes: true,
};

const s = (sec: number, scale: number) => Math.round(sec * scale * 1000) / 1000;
const P = (text: string): PromptAudio => ({ text, ttsId: null });

function baseItem(index: number, v: VersionedQuestion, kind: AnswerKind = "main"): Omit<PlanItem, "answerSeconds" | "maxSeconds" | "itemRule"> {
  const c = v.content;
  return {
    index,
    part: c.part,
    questionId: c.id,
    versionId: v.versionId,
    draft: v.reviewStatus !== "approved",
    kind,
    topic: c.topic,
    topicName: c.topicName,
    prompt: P(c.text),
    lead: [],
    zh: c.zh,
    keywords: c.keywords,
    expressions: c.usefulExpressions,
    structure: c.structureTips,
    card: c.card ? { title: c.text, points: c.card.points, lastPoint: c.card.lastPoint } : undefined,
  };
}

function withPhrases(keys: PhraseKey[], phrases: Record<PhraseKey, string>) {
  const out: Partial<Record<PhraseKey, PromptAudio>> = {};
  for (const k of keys) out[k] = P(phrases[k]);
  return out;
}

function finalize(plan: Omit<SessionPlan, "draft">): SessionPlan {
  return { ...plan, draft: plan.items.some((i) => i.draft) };
}

/** 闯关训练（第 1–5 章） */
export function buildLevelPlan(opts: {
  levelId: string;
  levelTitle: string;
  chapter: ChapterDef;
  questions: VersionedQuestion[];
  phrases: Record<PhraseKey, string>;
  scale: number;
}): SessionPlan {
  const { chapter: ch, scale } = opts;
  const t = ch.timing;
  const items: PlanItem[] = opts.questions.map((v, i) => {
    const c = v.content;
    const base = baseItem(i, v);
    const answer = s(t.answerSeconds ?? c.defaultTiming.answerSeconds, scale);
    const item: PlanItem = {
      ...base,
      answerSeconds: answer,
      maxSeconds: answer,
      itemRule: ch.goal.itemRule,
      minEffectiveSeconds: ch.goal.minEffectiveSeconds ? s(ch.goal.minEffectiveSeconds, scale) : undefined,
    };
    if (c.part === 1 && i === 0 && c.topicIntro) item.lead.push(P(c.topicIntro));
    if (c.part === 2) {
      item.lead.push(P(opts.phrases.p2_instruction));
      item.prepSeconds = s(t.prepSeconds ?? P2_PREP_SECONDS, scale);
    }
    if (c.part === 3 && t.followUpSeconds && c.followUps?.length) {
      item.followUp = {
        candidates: c.followUps.map((f) => ({ id: f.id, text: f.text, zh: f.zh, ttsId: null })),
        defaultId: c.defaultFollowUpId ?? c.followUps[0].id,
        answerSeconds: s(t.followUpSeconds, scale),
      };
    }
    return item;
  });
  const reserve = items.reduce((a, i) => a + (i.answerSeconds ?? 0) + (i.followUp?.answerSeconds ?? 0), 0);
  return finalize({
    v: 1,
    mode: "level",
    title: `关卡 ${opts.levelId}　${opts.levelTitle}`,
    subtitle: `第 ${ch.chapter} 章 · ${ch.title}`,
    chapter: ch.chapter,
    timeScale: scale,
    hints: ch.hints,
    hintNote: ch.hintNote,
    items,
    phrases: withPhrases(["training_intro", "training_end", "prep_end", "time_up", "followup_lead"], opts.phrases),
    goal: {
      description: ch.goal.description,
      requiredMet: ch.goal.requiredMet,
      of: ch.goal.of,
      countKinds: ["main"],
      minEffectiveSeconds: ch.goal.minEffectiveSeconds ? s(ch.goal.minEffectiveSeconds, scale) : undefined,
    },
    mock: null,
    reserveSeconds: Math.ceil(reserve),
  });
}

/** 完整模考（第 6 章 / 首页"开始模考"） */
export function buildMockPlan(opts: {
  title: string;
  part1: VersionedQuestion[];
  part2: VersionedQuestion;
  part3: VersionedQuestion[];
  phrases: Record<PhraseKey, string>;
  scale: number;
}): SessionPlan {
  const { scale, phrases } = opts;
  const items: PlanItem[] = [];
  const parts: Record<"1" | "2" | "3", { durationSec: number; items: number[] }> = {
    "1": { durationSec: s(MOCK_PART_SECONDS[1], scale), items: [] },
    "2": { durationSec: s(MOCK_PART_SECONDS[2], scale), items: [] },
    "3": { durationSec: s(MOCK_PART_SECONDS[3], scale), items: [] },
  };
  const p1Max = s(MOCK_PART_SECONDS[1], scale);
  const p2Max = s(MOCK_PART_SECONDS[2], scale);
  const p3Max = s(MOCK_PART_SECONDS[3], scale);

  let lastTopic = "";
  for (const v of opts.part1) {
    const item: PlanItem = { ...baseItem(items.length, v), answerSeconds: null, maxSeconds: p1Max, itemRule: v.content.evaluationRule };
    if (v.content.topic !== lastTopic) {
      if (lastTopic) item.lead.push(P(phrases.p1_topic_switch));
      if (v.content.topicIntro) item.lead.push(P(v.content.topicIntro));
      lastTopic = v.content.topic;
    }
    parts["1"].items.push(item.index);
    items.push(item);
  }

  const card = opts.part2;
  const p2: PlanItem = {
    ...baseItem(items.length, card),
    lead: [P(phrases.p2_instruction)],
    prepSeconds: s(P2_PREP_SECONDS, scale),
    answerSeconds: s(P2_SPEAK_MAX_SECONDS, scale),
    maxSeconds: s(P2_SPEAK_MAX_SECONDS, scale),
    itemRule: card.content.evaluationRule,
  };
  parts["2"].items.push(p2.index);
  items.push(p2);
  const rounding = card.content.roundingOff?.[0];
  if (rounding) {
    const r: PlanItem = {
      ...baseItem(items.length, card, "rounding"),
      followUpId: rounding.id,
      prompt: P(rounding.text),
      card: undefined,
      answerSeconds: null,
      maxSeconds: p2Max,
      itemRule: "简短回应收尾问题",
    };
    parts["2"].items.push(r.index);
    items.push(r);
  }

  for (const v of opts.part3) {
    const main: PlanItem = { ...baseItem(items.length, v), answerSeconds: null, maxSeconds: p3Max, itemRule: v.content.evaluationRule };
    parts["3"].items.push(main.index);
    items.push(main);
    const fu = v.content.followUps?.find((f) => f.id === v.content.defaultFollowUpId) ?? v.content.followUps?.[0];
    if (fu) {
      const f: PlanItem = {
        ...baseItem(items.length, v, "followup"),
        followUpId: fu.id,
        prompt: P(fu.text),
        zh: fu.zh ?? v.content.zh,
        answerSeconds: null,
        maxSeconds: p3Max,
        itemRule: "针对追问给出明确回应并加以说明",
      };
      parts["3"].items.push(f.index);
      items.push(f);
    }
  }

  return finalize({
    v: 1,
    mode: "mock",
    title: opts.title,
    subtitle: "完整模考 · 12 分 30 秒",
    chapter: 6,
    timeScale: scale,
    hints: MOCK_HINTS,
    hintNote: "模考中问答字幕默认隐藏，Part 2 显示任务卡；当次模考不能暂停或重答。",
    items,
    phrases: withPhrases(
      ["mock_intro", "p1_to_p2", "p2_start", "p2_stop", "p2_to_p3", "part_timeout", "closing"],
      phrases,
    ),
    goal: { description: "三个部分完整完成且未中断", requiredMet: 0, of: 0, countKinds: [] },
    mock: { parts },
    reserveSeconds: Math.ceil(s(MOCK_TOTAL_SECONDS, scale)),
  });
}

/** 自由练习 / 重练：单题，按题型默认时间或沿用原关卡计时 */
export function buildSingleQuestionPlan(opts: {
  mode: "practice" | "retry";
  question: VersionedQuestion;
  phrases: Record<PhraseKey, string>;
  scale: number;
  answerSeconds?: number;
  prepSeconds?: number;
  hints?: Hints;
  itemRule?: string;
  minEffectiveSeconds?: number;
}): SessionPlan {
  const { question: v, scale } = opts;
  const c = v.content;
  const answerUnscaled = opts.answerSeconds ?? c.defaultTiming.answerSeconds;
  const answer = s(answerUnscaled, scale);
  const item: PlanItem = {
    ...baseItem(0, v),
    answerSeconds: answer,
    maxSeconds: answer,
    itemRule: opts.itemRule ?? c.evaluationRule,
    minEffectiveSeconds: opts.minEffectiveSeconds ? s(opts.minEffectiveSeconds, scale) : undefined,
  };
  if (c.part === 2) {
    item.lead.push(P(opts.phrases.p2_instruction));
    item.prepSeconds = s(opts.prepSeconds ?? c.defaultTiming.prepSeconds ?? P2_PREP_SECONDS, scale);
  }
  return finalize({
    v: 1,
    mode: opts.mode,
    title: opts.mode === "retry" ? "重练" : "自由练习",
    subtitle: `Part ${c.part} · ${c.topicName} · ${c.id}`,
    chapter: null,
    timeScale: scale,
    hints: opts.hints ?? PRACTICE_HINTS,
    hintNote: "训练设置：计时为练习用途，不代表官方单题时限。",
    items: [item],
    phrases: withPhrases(["training_end", "prep_end", "time_up"], opts.phrases),
    goal: { description: item.itemRule, requiredMet: 1, of: 1, countKinds: ["main"], minEffectiveSeconds: item.minEffectiveSeconds },
    mock: null,
    reserveSeconds: Math.ceil(answer),
  });
}

/** 收集计划中所有需要考官音频的文本 */
export function collectPromptTexts(plan: SessionPlan): string[] {
  const set = new Set<string>();
  for (const p of Object.values(plan.phrases)) if (p) set.add(p.text);
  for (const i of plan.items) {
    set.add(i.prompt.text);
    for (const l of i.lead) set.add(l.text);
    for (const c of i.followUp?.candidates ?? []) set.add(c.text);
  }
  return [...set];
}

/** 把 TTS 资源编号写回计划 */
export function attachTtsIds(plan: SessionPlan, ids: Map<string, string>): SessionPlan {
  const fix = (p: PromptAudio) => ({ ...p, ttsId: ids.get(p.text) ?? null });
  return {
    ...plan,
    phrases: Object.fromEntries(Object.entries(plan.phrases).map(([k, v]) => [k, v ? fix(v) : v])),
    items: plan.items.map((i) => ({
      ...i,
      prompt: fix(i.prompt),
      lead: i.lead.map(fix),
      followUp: i.followUp ? { ...i.followUp, candidates: i.followUp.candidates.map((c) => ({ ...c, ...fix(c) })) } : undefined,
    })),
  };
}

/** 训练会话中必须作答的位置（主问题；第五章另需追问） */
export function requiredSlots(plan: SessionPlan): { index: number; kind: AnswerKind }[] {
  if (plan.mode === "mock") return [];
  const out: { index: number; kind: AnswerKind }[] = [];
  for (const i of plan.items) {
    out.push({ index: i.index, kind: "main" });
    if (i.followUp) out.push({ index: i.index, kind: "followup" });
  }
  return out;
}

/** 某个位置的答题时长上限（秒，已缩放） */
export function slotLimitSeconds(plan: SessionPlan, index: number, kind: AnswerKind): number | null {
  const item = plan.items[index];
  if (!item) return null;
  if (plan.mode === "mock") return kind === item.kind ? item.maxSeconds : null;
  if (kind === "main") return item.maxSeconds;
  if (kind === "followup" && item.followUp) return item.followUp.answerSeconds;
  return null;
}
