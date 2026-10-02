import type { ContentBundle } from "./load";
import { PHRASE_KEYS, type QuestionContent } from "./types";

export const EXPECTED = {
  part1: 60,
  part1Topics: 12,
  part1PerTopic: 5,
  part2: 20,
  part2PerCategory: 4,
  part3: 60,
  part3PerCard: 3,
  followUps: 120,
  levels: 30,
  mocks: 5,
  sample: { part1: 6, part2: 2, part3: 4 },
} as const;

export const PART1_TOPIC_NAMES = [
  "居住与家乡",
  "家庭",
  "学习",
  "工作",
  "兴趣",
  "日常安排",
  "旅行",
  "饮食",
  "运动",
  "科技",
  "购物",
  "天气与季节",
];

export interface IntegrityReport {
  ok: boolean;
  errors: string[];
  stats: {
    part1: number;
    part2: number;
    part3: number;
    followUps: number;
    roundingOff: number;
    levels: number;
    mocks: number;
    phrases: number;
    sample: number;
    reachableByPractice: number;
  };
}

/** 题库完整性校验：数量、编号、关联关系、关卡与模考编排。 */
export function checkIntegrity(b: ContentBundle): IntegrityReport {
  const errors: string[] = [];
  const byId = new Map<string, QuestionContent>();
  for (const q of b.questions) {
    if (byId.has(q.id)) errors.push(`题目编号重复：${q.id}`);
    byId.set(q.id, q);
  }
  const p1 = b.questions.filter((q) => q.part === 1);
  const p2 = b.questions.filter((q) => q.part === 2);
  const p3 = b.questions.filter((q) => q.part === 3);

  if (p1.length !== EXPECTED.part1) errors.push(`Part 1 应为 ${EXPECTED.part1} 道，实际 ${p1.length}`);
  if (p2.length !== EXPECTED.part2) errors.push(`Part 2 应为 ${EXPECTED.part2} 张，实际 ${p2.length}`);
  if (p3.length !== EXPECTED.part3) errors.push(`Part 3 应为 ${EXPECTED.part3} 道，实际 ${p3.length}`);

  if (b.topics.length !== EXPECTED.part1Topics) errors.push(`Part 1 主题应为 ${EXPECTED.part1Topics} 个，实际 ${b.topics.length}`);
  for (const name of PART1_TOPIC_NAMES) {
    if (!b.topics.some((t) => t.name === name)) errors.push(`缺少 Part 1 主题：${name}`);
  }
  for (const t of b.topics) {
    const n = p1.filter((q) => q.topic === t.code).length;
    if (n !== EXPECTED.part1PerTopic) errors.push(`主题 ${t.code} 应有 ${EXPECTED.part1PerTopic} 道，实际 ${n}`);
  }
  for (const c of b.categories) {
    const cards = p2.filter((q) => q.topic === c.code);
    if (cards.length !== EXPECTED.part2PerCategory) errors.push(`类别 ${c.code} 应有 ${EXPECTED.part2PerCategory} 张任务卡，实际 ${cards.length}`);
  }

  let followUps = 0;
  let rounding = 0;
  const followIds = new Set<string>();
  for (const q of p2) {
    const r = q.roundingOff?.length ?? 0;
    rounding += r;
    if (r < 1 || r > 2) errors.push(`${q.id} 收尾问题应为 1–2 道`);
    if (!q.card || q.card.points.length < 2) errors.push(`${q.id} 缺少任务卡要点`);
    const related = p3.filter((x) => x.relatedCardId === q.id);
    if (related.length !== EXPECTED.part3PerCard) errors.push(`${q.id} 应关联 ${EXPECTED.part3PerCard} 道 Part 3，实际 ${related.length}`);
  }
  for (const q of p3) {
    if (!q.relatedCardId || !byId.has(q.relatedCardId)) errors.push(`${q.id} 关联的任务卡 ${q.relatedCardId} 不存在`);
    const f = q.followUps ?? [];
    followUps += f.length;
    if (f.length !== 2) errors.push(`${q.id} 应有 2 道追问`);
    for (const x of f) {
      if (followIds.has(x.id)) errors.push(`追问编号重复：${x.id}`);
      followIds.add(x.id);
    }
    if (!q.defaultFollowUpId || !f.some((x) => x.id === q.defaultFollowUpId)) errors.push(`${q.id} 默认追问不在追问列表中`);
  }
  if (followUps !== EXPECTED.followUps) errors.push(`追问应为 ${EXPECTED.followUps} 道，实际 ${followUps}`);

  // 关卡
  if (b.levels.length !== EXPECTED.levels) errors.push(`关卡应为 ${EXPECTED.levels} 个，实际 ${b.levels.length}`);
  const levelIds = new Set<string>();
  for (const l of b.levels) {
    if (levelIds.has(l.id)) errors.push(`关卡编号重复：${l.id}`);
    levelIds.add(l.id);
    if (l.id !== `${l.chapter}-${l.order}`) errors.push(`关卡 ${l.id} 的章节/顺序不一致`);
    const expectPart = l.chapter <= 2 ? 1 : l.chapter <= 4 ? 2 : l.chapter === 5 ? 3 : 0;
    const expectCount = l.chapter <= 2 ? 4 : l.chapter <= 4 ? 1 : l.chapter === 5 ? 3 : 0;
    if (l.chapter === 6) {
      if (!l.mockSet || !b.mocks.some((m) => m.id === l.mockSet)) errors.push(`关卡 ${l.id} 的模考题组不存在`);
      continue;
    }
    if (l.questions.length !== expectCount) errors.push(`关卡 ${l.id} 应有 ${expectCount} 道题，实际 ${l.questions.length}`);
    for (const qid of l.questions) {
      const q = byId.get(qid);
      if (!q) errors.push(`关卡 ${l.id} 引用的题目 ${qid} 不存在`);
      else if (q.part !== expectPart) errors.push(`关卡 ${l.id} 的题目 ${qid} 不属于 Part ${expectPart}`);
    }
  }
  for (let c = 1; c <= 6; c++) {
    for (let o = 1; o <= 5; o++) if (!levelIds.has(`${c}-${o}`)) errors.push(`缺少关卡 ${c}-${o}`);
    if (!b.chapters.some((x) => x.chapter === c)) errors.push(`缺少第 ${c} 章配置`);
  }

  // 模考
  if (b.mocks.length !== EXPECTED.mocks) errors.push(`模考应为 ${EXPECTED.mocks} 套，实际 ${b.mocks.length}`);
  for (const m of b.mocks) {
    for (const qid of m.part1) if (byId.get(qid)?.part !== 1) errors.push(`${m.id} Part 1 题目 ${qid} 无效`);
    const card = byId.get(m.part2);
    if (card?.part !== 2) errors.push(`${m.id} Part 2 任务卡 ${m.part2} 无效`);
    for (const qid of m.part3) {
      const q = byId.get(qid);
      if (q?.part !== 3) errors.push(`${m.id} Part 3 题目 ${qid} 无效`);
      else if (q.relatedCardId !== m.part2) errors.push(`${m.id} Part 3 题目 ${qid} 未关联任务卡 ${m.part2}`);
    }
  }

  // 考官用语
  for (const k of PHRASE_KEYS) if (!b.phrases[k]) errors.push(`缺少考官用语：${k}`);

  // 样本题
  const sample = b.questions.filter((q) => q.sample);
  const sp = (p: number) => sample.filter((q) => q.part === p).length;
  if (sp(1) !== EXPECTED.sample.part1 || sp(2) !== EXPECTED.sample.part2 || sp(3) !== EXPECTED.sample.part3) {
    errors.push(`样本题应为 Part1 ${EXPECTED.sample.part1} / Part2 ${EXPECTED.sample.part2} / Part3 ${EXPECTED.sample.part3}，实际 ${sp(1)}/${sp(2)}/${sp(3)}`);
  }

  // 参考回答与基本字段
  for (const q of b.questions) {
    const words = q.referenceAnswer.split(/\s+/).filter(Boolean).length;
    const min = q.part === 1 ? 25 : q.part === 2 ? 120 : 50;
    if (words < min) errors.push(`${q.id} 参考回答过短（${words} 词，至少 ${min}）`);
    if (!/[?.]$/.test(q.text.trim()) && q.part !== 2) errors.push(`${q.id} 题目文本应以问号或句号结尾`);
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      part1: p1.length,
      part2: p2.length,
      part3: p3.length,
      followUps,
      roundingOff: rounding,
      levels: b.levels.length,
      mocks: b.mocks.length,
      phrases: Object.keys(b.phrases).length,
      sample: sample.length,
      // 自由练习：所有主问题均可单题练习
      reachableByPractice: b.questions.length,
    },
  };
}
