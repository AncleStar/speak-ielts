/**
 * 计时规则（前后端共用的纯函数）。
 * - 模考固定模板：Part 1 4:30、Part 2 3:30、Part 3 4:30，共 12:30。
 * - 所有时长均乘以 TIME_SCALE（仅自动化测试使用，生产为 1）。
 */

export const MOCK_PART_SECONDS = { 1: 270, 2: 210, 3: 270 } as const;
export const MOCK_TOTAL_SECONDS = MOCK_PART_SECONDS[1] + MOCK_PART_SECONDS[2] + MOCK_PART_SECONDS[3];
/** Part 1 剩余不足 20 秒、Part 3 剩余不足 30 秒时，不再发起新问题 */
export const MIN_REMAIN_FOR_NEW_QUESTION = { 1: 20, 3: 30 } as const;
/** Part 2：陈述结束后剩余时间不少于 25 秒才追加收尾问题 */
export const MIN_REMAIN_FOR_ROUNDING = 25;
export const P2_PREP_SECONDS = 60;
export const P2_SPEAK_MAX_SECONDS = 120;
/** 服务端校验提交时长的容差 */
export const DURATION_TOLERANCE_SECONDS = 2;
/** 追问选择等待转写的最长时间 */
export const FOLLOWUP_WAIT_SECONDS = 12;

export type MockPart = 1 | 2 | 3;

export function scaled(seconds: number, scale: number): number {
  return seconds * scale;
}

export function mockPartDurationMs(part: MockPart, scale: number): number {
  return Math.round(MOCK_PART_SECONDS[part] * scale * 1000);
}

/**
 * 客户端时钟偏移：offset = 服务器时间 − 本机时间（以请求往返中点估算）。
 * 校正后的"服务器当前时间" = 本机时间 + offset。
 */
export function computeClockOffset(serverTimeMs: number, clientSentMs: number, clientReceivedMs: number): number {
  const mid = clientSentMs + (clientReceivedMs - clientSentMs) / 2;
  return serverTimeMs - mid;
}

/** 倒计时 = 截止时间 −（本机时间 + 偏移），不小于 0 */
export function remainingMs(deadlineMs: number, localNowMs: number, offsetMs: number): number {
  return Math.max(0, deadlineMs - (localNowMs + offsetMs));
}

/** 模考 Part 1 / Part 3：剩余时间是否还允许发起新问题 */
export function canAskNewQuestion(part: 1 | 3, remainMs: number, scale: number): boolean {
  return remainMs >= MIN_REMAIN_FOR_NEW_QUESTION[part] * scale * 1000;
}

/** 模考 Part 2：陈述结束后是否追加收尾问题 */
export function canAskRounding(remainMs: number, scale: number): boolean {
  return remainMs >= MIN_REMAIN_FOR_ROUNDING * scale * 1000;
}

/** Part 2 陈述的实际上限：min(120 秒, 部分剩余时间) */
export function p2SpeakLimitMs(partRemainMs: number, scale: number): number {
  return Math.max(0, Math.min(P2_SPEAK_MAX_SECONDS * scale * 1000, partRemainMs));
}

/** Part 2 准备时间：min(60 秒, 部分剩余时间) */
export function p2PrepLimitMs(partRemainMs: number, scale: number): number {
  return Math.max(0, Math.min(P2_PREP_SECONDS * scale * 1000, partRemainMs));
}

/** 服务端校验：提交时长不超过上限 + 2 秒容差 */
export function isDurationWithinLimit(durationMs: number, limitSeconds: number): boolean {
  return durationMs >= 0 && durationMs <= (limitSeconds + DURATION_TOLERANCE_SECONDS) * 1000;
}

export type MockStep =
  | { type: "ask"; itemIndex: number }
  | { type: "end_part"; reason: "no_more_questions" | "time" };

/**
 * 模考 Part 1 / Part 3 的推进决策：给出下一个可提问的题目，或结束本部分。
 * @param items 本部分题目在计划中的下标（按顺序）
 * @param asked 已提问的下标集合
 */
export function nextMockStep(part: 1 | 3, items: number[], asked: Set<number>, remainMs: number, scale: number): MockStep {
  if (remainMs <= 0) return { type: "end_part", reason: "time" };
  const next = items.find((i) => !asked.has(i));
  if (next === undefined) return { type: "end_part", reason: "no_more_questions" };
  if (!canAskNewQuestion(part, remainMs, scale)) return { type: "end_part", reason: "time" };
  return { type: "ask", itemIndex: next };
}

export type P2Phase = "instruction" | "prep" | "speak" | "stop_phrase" | "rounding" | "done";

/**
 * 模考 Part 2 的阶段切换：引导语 → 60 秒准备 → 最长 120 秒陈述（到时播放 "Thank you."）
 * → 剩余时间 ≥ 25 秒时追加 1 道收尾问题 → 结束。
 */
export function nextP2Phase(
  current: P2Phase,
  ctx: { remainMs: number; scale: number; speakHitLimit: boolean; hasRounding: boolean },
): P2Phase {
  if (ctx.remainMs <= 0 && current !== "stop_phrase") return "done";
  switch (current) {
    case "instruction":
      return "prep";
    case "prep":
      return "speak";
    case "speak":
      if (ctx.speakHitLimit) return "stop_phrase";
      return ctx.hasRounding && canAskRounding(ctx.remainMs, ctx.scale) ? "rounding" : "done";
    case "stop_phrase":
      return ctx.hasRounding && canAskRounding(ctx.remainMs, ctx.scale) ? "rounding" : "done";
    case "rounding":
    case "done":
      return "done";
  }
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 上海时区当日零点（UTC 时间戳） */
export function startOfDayShanghai(now = new Date()): Date {
  const offset = 8 * 3600 * 1000;
  const local = new Date(now.getTime() + offset);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offset);
}

/** 上海时区当月一日零点（UTC 时间戳） */
export function startOfMonthShanghai(now = new Date()): Date {
  const offset = 8 * 3600 * 1000;
  const local = new Date(now.getTime() + offset);
  local.setUTCDate(1);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offset);
}
