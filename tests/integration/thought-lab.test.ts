import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mockThought } from "@/lib/thoughts/prompt";

const runDir = path.resolve(`data/verification/thought-lab-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5551/thought_lab", BETTER_AUTH_SECRET: "thought-lab-test-only-secret-0000000000000", USER_API_KEY_SECRET: "", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, s: typeof import("@/db/schema"), lab: typeof import("@/lib/services/thoughts");
const sourceText = "我认为大学生应该多参加社会实践";
const request = () => ({ sourceText, requestId: crypto.randomUUID() });
const config = { mode: "personal", asrModel: "qwen3-asr-flash-2026-02-10", llmModel: "qwen-flash", monthlyBudgetYuan: 20, consent: true, apiKey: "test_key_thought_lab_personal_only" };
async function owner() {
  const u = await (await import("@/lib/auth")).createAccount({ email: `thought-${crypto.randomUUID()}@example.test`, password: "Thought-test-only-123!", name: "Thought tester" });
  await db.update(s.user).set({ mustChangePassword: false, consentAt: new Date(), onboardedAt: new Date() }).where(eq(s.user.id, u.id)); return u.id;
}
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5551, dbName: "thought_lab", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema"); lab = await import("@/lib/services/thoughts");
}, 120000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);

it("persists three styles and deduplicates a retried or concurrent generation without extra charges", async () => {
  const userId = await owner(), p = request();
  const results = await Promise.allSettled([lab.generateThought(userId, p), lab.generateThought(userId, p), lab.generateThought(userId, p)]);
  const first = results.find(r => r.status === "fulfilled"); expect(first?.status).toBe("fulfilled");
  const saved = await lab.generateThought(userId, p);
  expect(saved).toMatchObject({ sourceText, mock: true, revision: 0 }); expect(saved.simple).not.toBe(saved.natural); expect(saved.nuanced.length).toBeGreaterThan(saved.simple.length);
  expect((await lab.listThoughts(userId)).total).toBe(1);
  expect(await db.select().from(s.usageEvent).where(eq(s.usageEvent.jobRef, `thought:${p.requestId}`))).toHaveLength(1);
  await expect(lab.generateThought(userId, { ...p, sourceText: "a different opinion" })).rejects.toMatchObject({ code: "request_changed" });
});

it("isolates history, edits, vocabulary, practice and deletion between accounts", async () => {
  const a = await owner(), b = await owner(), thought = await lab.generateThought(a, request());
  expect((await lab.listThoughts(b)).total).toBe(0); expect((await lab.listVocabulary(b)).total).toBe(0);
  const edits = { revision: 0, sourceText, title: "Title", simple: thought.simple, natural: thought.natural, nuanced: thought.nuanced };
  for (const operation of [() => lab.getThought(b, thought.id), () => lab.editThought(b, thought.id, edits), () => lab.deleteThought(b, thought.id), () => lab.enrollThought(b, thought.id, 0),
    () => lab.saveThoughtVocabulary(b, { thoughtId: thought.id, revision: 0, indices: [0] }),
    () => lab.recordThoughtPractice(b, thought.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "practice", recalledText: "My own words", durationSeconds: 0 })])
    await expect(operation()).rejects.toMatchObject({ status: 404 });
  expect((await lab.getThought(a, thought.id)).sourceText).toBe(sourceText);
});

it("rejects stale edits and synchronizes a changed Natural without rewriting past practice", async () => {
  const id = await owner(), thought = await lab.generateThought(id, request()); await lab.enrollThought(id, thought.id, 0);
  await lab.recordThoughtPractice(id, thought.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "remembered", recalledText: "Students can learn through volunteering.", durationSeconds: 0 });
  const input = { revision: 0, sourceText, title: "My edited idea", simple: thought.simple, natural: "Students should volunteer more often because it gives them practical experience.", nuanced: thought.nuanced };
  const edited = await lab.editThought(id, thought.id, input);
  expect(edited.revision).toBe(1); expect(edited.review?.completedCount).toBe(0); expect(edited.practices[0].naturalText).toBe(thought.natural);
  expect((await lab.getThoughtReviewQueue(id)).due.map(row => row.id)).toContain(thought.id);
  await expect(lab.editThought(id, thought.id, input)).rejects.toMatchObject({ code: "thought_changed" });
  await expect(lab.recordThoughtPractice(id, thought.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "remembered", durationSeconds: 5 })).rejects.toMatchObject({ code: "thought_changed" });
});

it("uses the shared review queue, advances 1/3/7/14 days exactly once and handles recall failures", async () => {
  const id = await owner(), t = await lab.generateThought(id, request()); await lab.enrollThought(id, t.id, 0); await lab.enrollThought(id, t.id, 0);
  const getQueue = (await import("@/lib/services/reviews")).getReviewQueue;
  expect((await getQueue(id)).thoughts.due).toHaveLength(1);
  let now = new Date();
  for (const days of [1, 3, 7, 14]) {
    const p = { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "remembered", recalledText: "I think practical experience is helpful.", durationSeconds: 0 };
    const r = await lab.recordThoughtPractice(id, t.id, p, now); await lab.recordThoughtPractice(id, t.id, p, now);
    expect(Date.parse(r.review!.nextDueAt) - now.getTime()).toBe(days * 86400_000); now = new Date(r.review!.nextDueAt);
  }
  const failed = await lab.recordThoughtPractice(id, t.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "again", durationSeconds: 3 }, now);
  expect(failed.review?.completedCount).toBe(0); expect(Date.parse(failed.review!.nextDueAt) - now.getTime()).toBe(86400_000); expect(failed.practices).toHaveLength(5);
  await expect(lab.recordThoughtPractice(id, t.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "remembered" })).rejects.toMatchObject({ status: 400 });
  const solo = await lab.recordThoughtPractice(id, t.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "practice", durationSeconds: 2 }, now);
  expect(solo.review).toEqual(failed.review);
});

it("deduplicates vocabulary, keeps edited words and detaches them when a thought is deleted", async () => {
  const id = await owner(), t = await lab.generateThought(id, request()), another = await lab.generateThought(id, request());
  expect(await lab.saveThoughtVocabulary(id, { thoughtId: t.id, revision: 0, indices: [0, 0, 1] })).toEqual({ added: 2, existing: 0 });
  const words = await lab.listVocabulary(id); const word = words.items.find(w => w.term === "practical experience")!;
  await lab.editVocabulary(id, word.id, { term: "Practical Experience", meaning: "我修改的实践经历", example: word.example });
  expect(await lab.saveThoughtVocabulary(id, { thoughtId: another.id, revision: 0, indices: [0] })).toEqual({ added: 0, existing: 1 });
  expect((await lab.listVocabulary(id, "我修改")).items[0].meaning).toBe("我修改的实践经历");
  await lab.enrollThought(id, t.id, 0); await lab.deleteThought(id, t.id);
  expect((await lab.listVocabulary(id)).items.every(w => w.thoughtId === null)).toBe(true);
  expect((await lab.getThoughtReviewQueue(id)).due).toHaveLength(0);
  expect(await db.select().from(s.thoughtReview).where(eq(s.thoughtReview.thoughtId, t.id))).toHaveLength(0);
  await lab.deleteVocabulary(id, word.id); expect((await lab.listVocabulary(id)).total).toBe(1);
});

it("uses the personal key/model and budget ledger, filters invented vocabulary and refuses keyless fallback", async () => {
  const id = await owner(); const credentials = await import("@/lib/ai/credentials"); await credentials.saveAiConfig(id, config);
  const response = mockThought(sourceText); response.vocabulary.push({ term: "invented jargon", meaning: "不应被收藏", example: "This invented jargon never appears in a version." });
  const calls: { model: string; key: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push({ model: body.model, key: new Headers(init.headers).get("Authorization")! });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 900, completion_tokens: 650 } }), { status: 200 }); }));
  const t = await lab.generateThought(id, request()); expect(t.mock).toBe(false); expect(t.model).toBe("qwen-flash"); expect(t.vocabulary.some(w => w.term === "invented jargon")).toBe(false);
  expect(calls).toEqual([{ model: "qwen-flash", key: `Bearer ${config.apiKey}` }]); expect(JSON.stringify(t)).not.toContain(config.apiKey);
  const [usage] = await db.select().from(s.usageEvent).where(eq(s.usageEvent.userId, id)); expect(usage.billingSource).toBe("personal"); expect(usage.costYuan).toBeGreaterThan(0); expect(usage.ok).toBe(true);
  await credentials.deleteApiKey(id); await expect(lab.generateThought(id, request())).rejects.toMatchObject({ code: "key_required" }); expect(calls).toHaveLength(1);
  await credentials.saveAiConfig(id, { ...config, monthlyBudgetYuan: 0 }); await expect(lab.generateThought(id, request())).rejects.toMatchObject({ code: "personal_budget_exceeded" }); expect(calls).toHaveLength(1);
});

it("does not persist malformed model output or echo secrets on provider errors", async () => {
  const id = await owner(); await (await import("@/lib/ai/credentials")).saveAiConfig(id, config);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"natural":"incomplete"}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), { status: 200 })));
  const malformed = request();
  await expect(lab.generateThought(id, malformed)).rejects.toMatchObject({ code: "thought_invalid_output" }); expect((await lab.listThoughts(id)).total).toBe(0);
  await expect(lab.generateThought(id, malformed)).rejects.toMatchObject({ code: "generation_failed" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(config.apiKey, { status: 401 })));
  try { await lab.generateThought(id, request()); throw new Error("Expected rejection"); } catch (e) { expect(e).toMatchObject({ code: "thought_generation_failed" }); expect(String(e)).not.toContain(config.apiKey); }
  expect((await lab.listThoughts(id)).total).toBe(0);
});

it("caps generation bursts before model invocation and rejects empty or overlong input", async () => {
  const id = await owner(); const p = request();
  await expect(lab.generateThought(id, { ...p, sourceText: " " })).rejects.toMatchObject({ status: 400 });
  await expect(lab.generateThought(id, { ...p, sourceText: "x".repeat(2001) })).rejects.toMatchObject({ status: 400 });
  for (let i = 0; i < 6; i++) await lab.generateThought(id, request());
  await expect(lab.generateThought(id, request())).rejects.toMatchObject({ code: "thought_rate_limit" });
  expect(await db.select().from(s.usageEvent).where(and(eq(s.usageEvent.userId, id), eq(s.usageEvent.service, "llm")))).toHaveLength(6);
});

it("cascades personal materials on account purge", async () => {
  const id = await owner(), t = await lab.generateThought(id, request()); await lab.enrollThought(id, t.id, 0); await lab.saveThoughtVocabulary(id, { thoughtId: t.id, revision: 0, indices: [0] });
  await lab.recordThoughtPractice(id, t.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "practice", durationSeconds: 2 });
  await (await import("@/lib/services/deletion")).purgeUser(id);
  expect((await lab.listThoughts(id)).total).toBe(0); expect((await lab.listVocabulary(id)).total).toBe(0);
  expect(await db.select().from(s.thoughtGeneration).where(eq(s.thoughtGeneration.userId, id))).toHaveLength(0);
  expect(await db.select().from(s.thoughtPractice).where(eq(s.thoughtPractice.userId, id))).toHaveLength(0);
});

it("joins saved viewpoint practice to growth using UTC+8 days without inflating audio or rewards", async () => {
  const id = await owner(), stranger = await owner(), t = await lab.generateThought(id, request());
  await lab.enrollThought(id, t.id, 0);
  const now = new Date("2026-10-09T01:00:00Z");
  const attempt = (at: string, outcome = "practice", durationSeconds = 0) => lab.recordThoughtPractice(id, t.id, {
    action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome, durationSeconds, recalledText: "I can express my idea.",
  }, new Date(at));
  await attempt("2026-10-08T15:59:59Z"); // October 8 in UTC+8
  await attempt("2026-10-08T16:00:00Z", "remembered", 30); // October 9
  await attempt("2026-09-30T16:00:00Z"); // October 1, outside the last week
  await attempt("2026-09-30T15:59:59Z"); // September 30
  await attempt("2026-10-11T01:00:00Z"); // Future data must not inflate recent progress
  const { getGrowth } = await import("@/lib/services/growth");
  const growth = await getGrowth(id, "2026-10", now);
  expect(growth.events.filter(e => e.type === "thought" || e.type === "thought_review")).toHaveLength(4);
  expect(growth.events.find(e => e.type === "thought_review")).toMatchObject({ day: "2026-10-09", selfReported: true, seconds: 30, href: `/thoughts?thought=${t.id}` });
  expect(growth.week).toMatchObject({ days: 2, thoughtPractices: 2, thoughtReviews: 1, seconds: 0, speechSeconds: 0 });
  expect(growth.monthStats).toMatchObject({ days: 4, thoughtPractices: 4, thoughtReviews: 1, seconds: 0 });
  expect(growth.dailySeconds.every(d => d.seconds === 0)).toBe(true);
  await expect((await import("@/lib/services/rewards")).balance(db, id)).resolves.toBe(0);
  expect((await getGrowth(stranger, "2026-10", now)).events).toHaveLength(0);
  await lab.deleteThought(id, t.id);
  const deleted = await getGrowth(id, "2026-10", now);
  expect(deleted.events).toHaveLength(0); expect(deleted.monthStats.thoughtPractices).toBe(0);
});
