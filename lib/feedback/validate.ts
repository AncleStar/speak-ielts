import { PRONUNCIATION_NOT_ASSESSED, rawFeedbackSchema, type RawFeedback, type StoredFeedback } from "./schema";

/** 小写化、去标点、合并空白 */
export function normalizeForEvidence(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’‘`´]/g, "'")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 证据必须是转写的连续子串（按整词边界匹配，比纯字符子串更严格）。 */
export function isEvidenceInTranscript(evidence: string, transcript: string): boolean {
  const e = normalizeForEvidence(evidence);
  if (e.length < 3) return false;
  const t = normalizeForEvidence(transcript);
  return ` ${t} `.includes(` ${e} `);
}

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export interface ProgramGoal {
  /** 程序化条件：有效作答时长下限（秒，已按 TIME_SCALE 缩放） */
  minEffectiveSeconds?: number;
  /** 实测有效作答时长（秒） */
  effectiveSeconds?: number;
}

export type ValidationResult =
  | { ok: true; feedback: StoredFeedback; dropped: number }
  | { ok: false; reason: "parse" | "schema" | "no_evidence"; detail: string };

/**
 * 附录 B 的校验流程：
 * 1. Zod 校验字段与长度；
 * 2. 证据校验，不满足的条目直接丢弃；
 * 3. 丢弃后 strengths 与 improvements 均为空 → 不合格；
 * 4. 发音维度固定为"未评估"；
 * 5. 程序化目标条件不满足时，即使模型判定 met=true 也记为未达成。
 */
export function validateFeedback(raw: unknown, transcript: string, program: ProgramGoal = {}): ValidationResult {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: "parse", detail: (e as Error).message };
    }
  }
  const parsed = rawFeedbackSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema",
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const fb: RawFeedback = parsed.data;
  const strengths = fb.strengths.filter((s) => isEvidenceInTranscript(s.evidence, transcript));
  const improvements = fb.improvements.filter((s) => isEvidenceInTranscript(s.evidence, transcript));
  const dropped = fb.strengths.length - strengths.length + (fb.improvements.length - improvements.length);
  if (strengths.length === 0 && improvements.length === 0) {
    return { ok: false, reason: "no_evidence", detail: "所有条目的证据都无法在转写中找到" };
  }

  let met = fb.goal.met;
  let programReason: string | undefined;
  if (program.minEffectiveSeconds !== undefined && program.effectiveSeconds !== undefined) {
    if (program.effectiveSeconds < program.minEffectiveSeconds) {
      met = false;
      programReason = `有效作答 ${program.effectiveSeconds.toFixed(0)} 秒，未达到本关要求的 ${program.minEffectiveSeconds.toFixed(0)} 秒`;
    }
  }

  const stored: StoredFeedback = {
    ...fb,
    strengths,
    improvements,
    goal: {
      met,
      modelMet: fb.goal.met,
      reason: programReason ? `${programReason}。${fb.goal.reason}` : fb.goal.reason,
      programReason,
    },
    pronunciation: { status: "not_assessed", note: PRONUNCIATION_NOT_ASSESSED },
  };
  return { ok: true, feedback: stored, dropped };
}

/** 追问选择校验：模型只返回编号，且必须属于当前题目的追问池 */
export function validateFollowUpChoice(raw: unknown, candidateIds: string[]): string | null {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const id = (obj as { followUpId?: unknown }).followUpId;
  if (typeof id !== "string") return null;
  return candidateIds.includes(id.trim()) ? id.trim() : null;
}
