import path from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";

const runDir = path.resolve(`data/verification/round3-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5548/round3", BETTER_AUTH_SECRET: "round3-test-only-secret-000000000000000", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1", LOCAL_APP_INSTANCE: "round3-test" });
// Exercise real budget reservations, using deterministic local providers only.
vi.mock("@/lib/providers", async (original) => {
  const mod = await original<typeof import("@/lib/providers")>();
  let fake: ReturnType<typeof mod.providers>;
  return { ...mod, providers: () => fake ??= { ...mod.providers(), name: "dashscope", asr: vi.fn(async input => ({ ...await mod.providers().asr(input), mock: false })), llmJson: vi.fn(async input => ({ ...await mod.providers().llmJson(input), mock: false })) } };
});
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, s: typeof import("@/db/schema");
let sessions: typeof import("@/lib/services/sessions"), answers: typeof import("@/lib/services/answers");
let owner: { id: string; consentAt: Date };
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5548, dbName: "round3", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema"); sessions = await import("@/lib/services/sessions"); answers = await import("@/lib/services/answers");
  const u = await (await import("@/lib/auth")).createAccount({ email: "round3@example.test", password: "Round3-test-only-123!", name: "Round 3 tester" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(s.user).set({ consentAt: owner.consentAt, onboardedAt: new Date(), mustChangePassword: false, dailyQuotaMinutes: 1000 }).where(eq(s.user.id, u.id));
}, 120000);
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);

it("recommends untried papers using only this user's started full-duration mock history", async () => {
  const { getMockCatalog } = await import("@/lib/services/mock-selection");
  expect((await getMockCatalog(owner.id)).recommendedId).toBe("mock-1");
  const ordinary = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1" });
  await db.update(s.practiceSession).set({ status: "completed", startedAt: new Date() }).where(eq(s.practiceSession.id, ordinary.id));
  expect((await getMockCatalog(owner.id)).recommendedId).toBe("mock-1");
  const first = await sessions.createSession(owner, { mode: "mock", mockSetId: "mock-1" });
  let catalog = await getMockCatalog(owner.id);
  expect(catalog.items[0].activeSessionId).toBe(first.id); expect(catalog.items[0].attempts).toBe(0);
  expect(catalog.recommendedId).toBe("mock-2");
  await db.update(s.practiceSession).set({ status: "completed", startedAt: new Date("2026-01-01") }).where(eq(s.practiceSession.id, first.id));
  expect((await getMockCatalog("another-user")).recommendedId).toBe("mock-1");
  for (let n = 2; n <= 5; n++) {
    const mock = await sessions.createSession(owner, { mode: "mock", mockSetId: `mock-${n}` });
    await db.update(s.practiceSession).set({ status: "completed", startedAt: new Date(`2026-01-0${n}`) }).where(eq(s.practiceSession.id, mock.id));
  }
  catalog = await getMockCatalog(owner.id);
  expect(catalog.recommendedId).toBe("mock-1"); expect(catalog.items.every(i => i.attempts === 1 && i.completed === 1)).toBe(true);
  await db.update(s.practiceSession).set({ deletedAt: new Date() }).where(eq(s.practiceSession.mockSetId, "mock-3"));
  expect((await getMockCatalog(owner.id)).recommendedId).toBe("mock-3");
  const [firstRow] = await db.select().from(s.practiceSession).where(eq(s.practiceSession.id, first.id));
  await db.update(s.practiceSession).set({ plan: { ...(firstRow.plan as object), timeScale: 0.1 } }).where(eq(s.practiceSession.id, first.id));
  expect((await getMockCatalog(owner.id)).items[0].attempts).toBe(0);
});

it("pauses on exhausted budget and reuses the paid transcript after manual recovery, even if audio expired", async () => {
  const { setSetting } = await import("@/lib/settings");
  const { processAnswer } = await import("@/lib/jobs/process-answer");
  const p = (await import("@/lib/providers")).providers();
  const session = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 6000 });
  await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(6));
  await setSetting("budget", { monthlyYuan: 6 * 0.00022 });
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: false })).toEqual({ status: "budget_wait" });
  const [paused] = await db.select().from(s.answer).where(eq(s.answer.id, ticket.answerId));
  expect(paused.transcript).toBeTruthy(); expect(paused.storageKey).toBeTruthy(); expect(paused.processAttempts).toBe(1);
  expect(p.asr).toHaveBeenCalledTimes(1); expect(p.llmJson).not.toHaveBeenCalled();
  await expect(answers.retryProcessing(owner.id, ticket.answerId)).rejects.toMatchObject({ code: "budget_exceeded" });
  await setSetting("budget", { monthlyYuan: 100 });
  await db.update(s.answer).set({ storageKey: null, audioDeletedAt: new Date() }).where(eq(s.answer.id, ticket.answerId));
  await answers.retryProcessing(owner.id, ticket.answerId);
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "done" });
  expect(p.asr).toHaveBeenCalledTimes(1); expect(p.llmJson).toHaveBeenCalledTimes(1);
  const detail = await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, ticket.answerId);
  expect(detail.answer.transcript).toBe(paused.transcript); expect(detail.answer.hasAudio).toBe(false);
});

it("rejects retry when an untranscribed recording has expired", async () => {
  const session = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 6000 });
  await db.update(s.answer).set({ status: "failed", audioDeletedAt: new Date() }).where(eq(s.answer.id, ticket.answerId));
  await expect(answers.retryProcessing(owner.id, ticket.answerId)).rejects.toMatchObject({ code: "audio_expired" });
});

it("denies expired playback before maintenance deletes the file, preserving the transcript", async () => {
  const session = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 6000 });
  await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(6));
  const viewer = { id: owner.id, isAdmin: false };
  expect((await answers.getAnswerDetail(viewer, ticket.answerId)).answer.hasAudio).toBe(true);
  const history = (await sessions.listSessions(owner.id)).find(row => row.id === session.id)!;
  expect(history.answerCount).toBe(1); expect(history.durationMs).toBe(6000);
  await db.update(s.answer).set({ createdAt: new Date(Date.now() - 31 * 86400_000), transcript: "A preserved answer." }).where(eq(s.answer.id, ticket.answerId));
  const expired = await answers.getAnswerDetail(viewer, ticket.answerId);
  expect(expired.answer.hasAudio).toBe(false); expect(expired.answer.transcript).toBe("A preserved answer.");
  await expect(answers.getAnswerAudio(viewer, ticket.answerId)).rejects.toMatchObject({ code: "audio_expired" });
});

it("counts idle workers as healthy, rejects stale or other-run heartbeats, and removes stopped heartbeats", async () => {
  const { startWorkerHeartbeat, getWorkerHealth, workerConfigId, WORKER_STALE_MS } = await import("@/lib/worker-health");
  expect((await getWorkerHealth()).ready).toBe(false);
  await db.insert(s.appSetting).values({ key: "runtime:worker:other", value: { configId: "another-run" } });
  expect((await getWorkerHealth()).ready).toBe(false);
  const stop = await startWorkerHeartbeat(); expect((await getWorkerHealth()).ready).toBe(true);
  await db.update(s.appSetting).set({ updatedAt: new Date(Date.now() - WORKER_STALE_MS - 1000) }).where(like(s.appSetting.key, "runtime:worker:%"));
  expect((await getWorkerHealth()).ready).toBe(false);
  await stop();
  expect((await db.select().from(s.appSetting)).filter(row => (row.value as {configId?: string}).configId === workerConfigId())).toHaveLength(0);
});
