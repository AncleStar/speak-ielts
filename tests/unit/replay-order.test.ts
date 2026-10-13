import { expect, it } from "vitest";
import { replayAttempts } from "@/lib/sessions/replay-order";
import { summarize } from "@/lib/services/outcome";
import type { SessionPlan } from "@/lib/sessions/plan";
it("late fragments remain visible without replacing the latest full answer or mutating input order", () => {
  const input = [{ answer: { id: "older-full", interrupted: false } }, { answer: { id: "new-full", interrupted: false } }, { answer: { id: "late-fragment", interrupted: true } }];
  expect(replayAttempts(input).map(a => a.answer.id)).toEqual(["new-full", "late-fragment", "older-full"]); expect(input[0].answer.id).toBe("older-full");
  expect(replayAttempts(input.filter(a => a.answer.interrupted))[0].answer.id).toBe("late-fragment");
});
it("a pending late fragment cannot erase an evaluated full answer's goal", () => {
  const plan = { mode: "practice", items: [{ index: 0 }], goal: { of: 1, requiredMet: 1, countKinds: ["main"], description: "Synthetic goal" } } as SessionPlan;
  const base = { planIndex: 0, kind: "main", durationMs: 6000, clientDurationMs: 6000, metrics: { speechSec: 5 }, storageKey: "synthetic.wav" };
  const full = { ...base, id: "full", status: "done", interrupted: false }, fragment = { ...base, id: "fragment", status: "queued", interrupted: true };
  const result = summarize(plan, "completed", [full, fragment], [{ answerId: "full", goalMet: true, goalReason: "Synthetic evaluation marker", mock: false }]);
  expect(result.pending).toBe(1); expect(result.goal.met).toBe(true); expect(result.goal.metCount).toBe(1);
  expect(summarize(plan, "completed", [{ ...full, status: "queued" }], [{ answerId: "full", goalMet: true, goalReason: "Synthetic", mock: false }]).goal.met).toBeNull();
});
