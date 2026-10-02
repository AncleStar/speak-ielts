import { describe, expect, it } from "vitest";
import { MOCK_TOTAL_SECONDS, computeClockOffset, remainingMs, canAskNewQuestion, canAskRounding, p2PrepLimitMs, p2SpeakLimitMs, nextMockStep, isDurationWithinLimit, startOfDayShanghai } from "@/lib/timing";
import { isEvidenceInTranscript, validateFeedback, validateFollowUpChoice } from "@/lib/feedback/validate";
import { loadContent } from "@/lib/content/load";
import { checkIntegrity } from "@/lib/content/validate";
import { detectAudioType } from "@/lib/audio";
import { pcmFixture } from "../../scripts/make-fixtures";

describe("exam timing", () => {
  it("uses a 750 second overall template", () => expect(MOCK_TOTAL_SECONDS).toBe(750));
  it("corrects skew using the request midpoint", () => { expect(computeClockOffset(5000, 3000, 3200)).toBe(1900); expect(remainingMs(7000, 4000, 1900)).toBe(1100); });
  it("never displays negative remaining time", () => expect(remainingMs(1000, 5000, 0)).toBe(0));
  it("does not ask new questions when a part is almost over", () => { expect(canAskNewQuestion(1, 19999, 1)).toBe(false); expect(canAskNewQuestion(3, 29999, 1)).toBe(false); expect(canAskNewQuestion(1, 20000, 1)).toBe(true); });
  it("keeps preparation, speaking and rounding within the part", () => { expect(p2PrepLimitMs(100000, 1)).toBe(60000); expect(p2SpeakLimitMs(50000, 1)).toBe(50000); expect(canAskRounding(24999, 1)).toBe(false); });
  it("scales tests consistently and rejects overlong answers", () => { expect(p2PrepLimitMs(10000, 0.1)).toBe(6000); expect(isDurationWithinLimit(32000, 30)).toBe(true); expect(isDurationWithinLimit(32001, 30)).toBe(false); });
  it("handles exhausted question pools and midnight", () => { expect(nextMockStep(1, [0], new Set([0]), 100000, 1).type).toBe("end_part"); expect(startOfDayShanghai(new Date("2026-09-25T17:00:00Z")).toISOString()).toBe("2026-09-25T16:00:00.000Z"); });
});
const transcript = "I enjoy reading books because they help me understand different people.";
const valid = () => ({ summary: "回答了阅读爱好", strengths: [{ point: "给出理由", evidence: "I enjoy reading books" }], improvements: [{ dimension: "content", issue: "补充例子", evidence: "different people", suggestion: "For example, a recent novel helped me understand another culture.", explanation: "补充具体例子" }], sampleAnswer: transcript, nextGoal: "补充一个例子", goal: { met: true, reason: "回应题目" }, dimensions: { fluency_coherence: "结构清楚", lexical: "词汇贴题", grammar: "有原因从句" } });
describe("feedback evidence", () => {
  it("normalizes punctuation without permitting fragments of other words", () => { expect(isEvidenceInTranscript("I ENJOY reading books!", transcript)).toBe(true); expect(isEvidenceInTranscript("read", "bread")).toBe(false); });
  it("drops invented quotes", () => { const input = valid(); input.strengths[0].evidence = "I work as a doctor"; const r = validateFeedback(input, transcript); expect(r.ok).toBe(true); if (r.ok) { expect(r.dropped).toBe(1); expect(r.feedback.strengths).toHaveLength(0); } });
  it("rejects feedback with no traceable evidence", () => { const input = valid(); input.strengths[0].evidence = "invented quote"; input.improvements[0].evidence = "another invented quote"; expect(validateFeedback(input, transcript).ok).toBe(false); });
  it("overrides a model goal result when speech is too short", () => { const r = validateFeedback(valid(), transcript, { effectiveSeconds: 10, minEffectiveSeconds: 60 }); expect(r.ok).toBe(true); if (r.ok) { expect(r.feedback.goal.met).toBe(false); expect(r.feedback.pronunciation.status).toBe("not_assessed"); } });
  it("restricts followups to the current question", () => { expect(validateFollowUpChoice({ followUpId: "other" }, ["allowed"])).toBeNull(); expect(validateFollowUpChoice({ followUpId: "allowed" }, ["allowed"])).toBe("allowed"); });
});
describe("content and recording", () => {
  it("contains the complete reachable draft library", () => { const r = checkIntegrity(loadContent()); expect(r.errors).toEqual([]); expect(r.ok).toBe(true); });
  it("recognizes WAV and rejects an HTML upload", () => { expect(detectAudioType(pcmFixture(0.1))?.ext).toBe("wav"); expect(detectAudioType(Buffer.from("<html>not an audio file</html>"))).toBeNull(); });
});
