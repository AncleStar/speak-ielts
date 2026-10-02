import path from "node:path";
import fs from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";

const runDir = path.resolve(`data/verification/integration-${Date.now()}`);
Object.assign(process.env, {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5544/integration",
  BETTER_AUTH_SECRET: "integration-only-secret-00000000000000000", BETTER_AUTH_URL: "http://localhost:3100",
  AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: runDir,
  LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false",
  SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1",
});
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let s: typeof import("@/lib/services/sessions");
let a: typeof import("@/lib/services/answers");
let del: typeof import("@/lib/services/deletion");
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let first: { id: string; consentAt: Date };
let second: { id: string; consentAt: Date };
let sessionId: string;
let answerId: string;

beforeAll(async () => {
  const { startLocalPostgres } = await import("../../scripts/local-db");
  pg = await startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5544, dbName: "integration", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations();
  await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema");
  s = await import("@/lib/services/sessions"); a = await import("@/lib/services/answers"); del = await import("@/lib/services/deletion");
  const { createAccount } = await import("@/lib/auth");
  for (const name of ["alice", "bob"]) {
    const u = await createAccount({ email: `${name}@example.test`, password: "Integration-only-123!", name });
    await db.update(schema.user).set({ consentAt: new Date(), onboardedAt: new Date(), mustChangePassword: false, dailyQuotaMinutes: 1000 }).where(eq(schema.user.id, u.id));
    const lite = { id: u.id, consentAt: new Date() }; if (name === "alice") first = lite; else second = lite;
  }
}, 120000);
afterAll(async () => {
  await (await import("@/lib/queue")).stopBoss();
  await (await import("@/lib/db")).closeDb();
  await pg?.stop();
}, 30000);

describe("isolated PostgreSQL + recording pipeline", () => {
  it("rejects missing consent and reuses an unfinished level", async () => {
    await expect(s.createSession({ ...first, consentAt: null }, { mode: "level", levelId: "1-1" })).rejects.toMatchObject({ code: "consent_required" });
    sessionId = (await s.createSession(first, { mode: "level", levelId: "1-1" })).id;
    expect(await s.createSession(first, { mode: "level", levelId: "1-1" })).toEqual({ id: sessionId, reused: true });
    await expect(s.createSession(first, { mode: "level", levelId: "1-2" })).rejects.toMatchObject({ code: "level_locked" });
    await expect(s.getOwnedSession(second.id, sessionId)).rejects.toMatchObject({ status: 404 });
  });
  it("makes tickets, uploads and submissions idempotent", async () => {
    const input = { sessionId, planIndex: 0, kind: "main" as const, submissionId: "integration-upload-0001", clientDurationMs: 6000 };
    const [one, two] = await Promise.all([a.createUploadTicket(first.id, input), a.createUploadTicket(first.id, input)]);
    expect(one.answerId).toBe(two.answerId); answerId = one.answerId;
    await expect(a.receiveAudio(second.id, answerId, one.ticket, pcmFixture(6))).rejects.toMatchObject({ status: 403 });
    await expect(a.receiveAudio(first.id, answerId, one.ticket, Buffer.from("not audio"))).rejects.toMatchObject({ status: 415 });
    const uploaded = await Promise.all([a.receiveAudio(first.id, answerId, one.ticket, pcmFixture(6)), a.receiveAudio(first.id, answerId, one.ticket, pcmFixture(5))]);
    expect(uploaded.filter(x => x.duplicate)).toHaveLength(1);
    const submitted = await Promise.all([a.submitAnswer(first.id, answerId), a.submitAnswer(first.id, answerId)]);
    expect(submitted.filter(x => x.enqueued)).toHaveLength(1);
  });
  it("transcodes, analyzes, produces labelled mock feedback and isolates data", async () => {
    const { processAnswer } = await import("@/lib/jobs/process-answer");
    const result = await Promise.all([processAnswer({ answerId }, { finalAttempt: true }), processAnswer({ answerId }, { finalAttempt: true })]);
    expect(result.filter(r => r.status === "done")).toHaveLength(1);
    expect(result.filter(r => r.skipped === "processing" || r.skipped === "done")).toHaveLength(1);
    const d = await a.getAnswerDetail({ id: first.id, isAdmin: false }, answerId);
    expect(d.feedback?.mock).toBe(true); expect(d.answer.hasAudio).toBe(true); expect(d.answer.transcript?.length).toBeGreaterThan(20);
    await expect(a.getAnswerDetail({ id: second.id, isAdmin: true }, answerId)).rejects.toMatchObject({ status: 404 });
  });
  it("preserves original transcript during a corrected feedback run", async () => {
    const before = await a.getAnswerDetail({ id: first.id, isAdmin: false }, answerId);
    const correction = "I enjoy living in my city because it is convenient and my friends live nearby.";
    await a.submitCorrection(first.id, answerId, correction, true);
    await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId, mode: "correction" }, { finalAttempt: true });
    const after = await a.getAnswerDetail({ id: first.id, isAdmin: false }, answerId);
    expect(after.answer.transcript).toBe(before.answer.transcript); expect(after.feedback?.basedOnCorrection).toBe(true);
  });
  it("does not send silence or overlong audio to recognition, including retries", async () => {
    for (const [tag, audio, status] of [["silence", pcmFixture(5, true), "insufficient"], ["long", pcmFixture(40), "failed"]] as const) {
      const ticket = await a.createUploadTicket(first.id, { sessionId, planIndex: 1, kind: "main", submissionId: `test-${tag}-0001`, clientDurationMs: 5000 });
      await a.receiveAudio(first.id, ticket.answerId, ticket.ticket, audio); await a.submitAnswer(first.id, ticket.answerId);
      const processAnswer = (await import("@/lib/jobs/process-answer")).processAnswer;
      expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status });
      if (status === "failed") { await a.retryProcessing(first.id, ticket.answerId); expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status }); }
      const detail = await a.getAnswerDetail({ id: first.id, isAdmin: false }, ticket.answerId); expect(detail.answer.transcript).toBeNull();
    }
  });
  it("cannot jump parts or complete a mock without elapsed time and recordings", async () => {
    const m = await s.createSession(first, { mode: "mock", mockSetId: "mock-1" });
    await expect(s.recordEvent(first.id, m.id, { eventId: crypto.randomUUID(), type: "part_start", part: 2 })).rejects.toMatchObject({ code: "part_order" });
    const eventId = crypto.randomUUID();
    const [x, y] = await Promise.all([s.recordEvent(first.id, m.id, { eventId, type: "part_start", part: 1 }), s.recordEvent(first.id, m.id, { eventId, type: "part_start", part: 1 })]);
    expect([x, y].filter(r => r.duplicate)).toHaveLength(1);
    await s.recordEvent(first.id, m.id, { eventId: crypto.randomUUID(), type: "finish" });
    expect((await s.getOwnedSession(first.id, m.id)).status).toBe("interrupted");
  });
  it("caps concurrent admission at five even for one user", async () => {
    await db.update(schema.practiceSession).set({ status: "abandoned" });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => s.createSession(first, { mode: "practice", questionId: "P1-HOME-1" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter(r => r.status === "rejected").every(r => r.reason.code === "busy")).toBe(true);
    await db.update(schema.practiceSession).set({ status: "abandoned" });
  });
  it("reserves paid budget before concurrent calls and never calls the provider after exhaustion", async () => {
    const { billableCall } = await import("@/lib/usage"); const { setSetting } = await import("@/lib/settings");
    await setSetting("budget", { monthlyYuan: 0.015 }); let calls = 0;
    const results = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => billableCall({ service: "tts", model: "budget-test", mock: false, jobRef: `budget:${i}`, estimate: { chars: 125 }, units: () => ({ chars: 125 }), run: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { model: "budget-test", latencyMs: 20 }; } })));
    expect(calls).toBe(1); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await setSetting("budget", { monthlyYuan: 100 });
  });
  it("switches existing sessions to new audio without modifying their saved questions or timing", async () => {
    const { providers, setProvidersForTest } = await import("@/lib/providers");
    const { ensureTtsAssets, generateTtsAsset, ttsStatusCounts } = await import("@/lib/services/tts");
    const original = providers();
    const before = await s.getOwnedSession(first.id, sessionId);
    const previousView = await s.getSessionView(first.id, sessionId);
    let calls = 0;
    const text = "Please tell me about your hometown.";
    const oldAsset = (await ensureTtsAssets([text], { enqueueMissing: false })).get(text)!;
    setProvidersForTest({ ...original, ttsIdentity: () => ({ model: "mock-local-tts", voice: "new-voice" }), tts: async t => { calls++; return original.tts(t); } });
    try {
      await generateTtsAsset(oldAsset);
      expect(calls).toBe(0);
      const view = await s.getSessionView(first.id, sessionId);
      expect(view.plan.items[0].prompt.text).toBe(previousView.plan.items[0].prompt.text);
      expect(view.plan.items[0].prompt.ttsId).not.toBe(previousView.plan.items[0].prompt.ttsId);
      expect((await s.getOwnedSession(first.id, sessionId)).plan).toEqual(before.plan);
      expect(view.session.partDeadlines).toEqual(before.partDeadlines);
      expect((await ttsStatusCounts()).otherModels).toBeGreaterThan(0);
    } finally { setProvidersForTest(original); }
  });
  it("records local neural audio as real speech with zero API cost even after budget exhaustion", async () => {
    const { billableCall } = await import("@/lib/usage");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("budget", { monthlyYuan: 0 });
    try {
      await billableCall({ service: "tts", model: "local-neural-test", mock: false, billable: false, jobRef: "local-voice-test", estimate: { chars: 1000 }, units: () => ({ chars: 1000 }), run: async () => ({ model: "local-neural-test", latencyMs: 1 }) });
      const [event] = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.jobRef, "local-voice-test"));
      expect(event.mock).toBe(false); expect(event.costYuan).toBe(0); expect(event.ok).toBe(true);
    } finally { await setSetting("budget", { monthlyYuan: 100 }); }
  });
  it("revokes deleted audio access immediately and replays deletion after an old backup", async () => {
    const { dailyUsageSeconds } = await import("@/lib/quota");
    const beforeDelete = await dailyUsageSeconds(first.id);
    await del.deleteSession(first.id, sessionId, first.id);
    await expect(a.getAnswerDetail({ id: first.id, isAdmin: false }, answerId)).rejects.toMatchObject({ status: 404 });
    await expect(a.receiveAudio(first.id, answerId, a.signUploadTicket(answerId, first.id), pcmFixture(5))).rejects.toMatchObject({ status: 404 });
    await db.update(schema.practiceSession).set({ deletedAt: null }).where(eq(schema.practiceSession.id, sessionId));
    expect((await del.replayDeletions()).sessions).toBe(1);
    expect(await dailyUsageSeconds(first.id)).toBe(beforeDelete);
    expect(await db.select().from(schema.answer).where(eq(schema.answer.id, answerId))).toHaveLength(0);
    await fs.appendFile(del.DELETION_LOG_FILE(), "broken-line\n");
    await expect(del.replayDeletions()).rejects.toThrow();
  });
});
