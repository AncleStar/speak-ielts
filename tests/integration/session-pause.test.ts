import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";
const root = path.resolve("data/verification", `session-pause-${randomUUID()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5558/pauseintegration", BETTER_AUTH_SECRET: "pause-integration-only-secret-000000000000000", BETTER_AUTH_URL: "http://localhost:3198", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), STORAGE_DRIVER: "local", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", DASHSCOPE_API_KEY: "", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), sessions: typeof import("@/lib/services/sessions"), quota: typeof import("@/lib/quota"), answers: typeof import("@/lib/services/answers"), consent: typeof import("@/lib/services/recording-consent");
let owner: { id: string; consentAt: Date }, consentVersion = 0, sequence = 0;
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5558, dbName: "pauseintegration", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); sessions = await import("@/lib/services/sessions"); quota = await import("@/lib/quota"); answers = await import("@/lib/services/answers"); consent = await import("@/lib/services/recording-consent");
}, 120000);
beforeEach(async () => {
  const u = await (await import("@/lib/auth")).createAccount({ email: `pause-${++sequence}@example.test`, password: "Pause-test-only-123!", name: "Synthetic pause" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(schema.user).set({ dailyQuotaMinutes: 0, mustChangePassword: false }).where(eq(schema.user.id, u.id));
  consentVersion = (await consent.grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" })).version;
  await db.insert(schema.minuteCredit).values({ userId: u.id, redemptionKey: randomUUID(), totalSeconds: 600, remainingSeconds: 600, expiresAt: new Date(Date.now() + 86400_000) });
});
afterEach(async () => {
  // Fixture teardown only: this fresh database contains no developer accounts.
  await db.update(schema.practiceSession).set({ status: "abandoned", endedAt: new Date() }).where(eq(schema.practiceSession.status, "active"));
  const { setSetting } = await import("@/lib/settings"); await setSetting("pauseNewSessions", false); await setSetting("budget", { monthlyYuan: 100 });
});
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);
const practice = () => sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
const start = (id: string, expectedVersion: number, eventId = randomUUID()) => sessions.recordEvent(owner.id, id, { type: "start", eventId, expectedVersion });
const pause = (id: string, expectedVersion: number, extra: Partial<import("@/lib/services/sessions").SessionEventInput> = {}) => sessions.recordEvent(owner.id, id, { type: "pause", eventId: randomUUID(), expectedVersion, ...extra });

it("returns unused credits and capacity on pause; the same disc resumes and duplicate exits do not refund twice", async () => {
  const s = await practice(); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(555);
  const eventId = randomUUID(); const closed = await pause(s.id, 0, { eventId }); expect(closed.status).toBe("paused"); expect(closed.stateVersion).toBe(1);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 600, reservedSeconds: 0 });
  expect(await quota.activeSessionCount(await (await import("@/lib/settings")).getSettings())).toBe(0);
  expect(await pause(s.id, 0, { eventId })).toMatchObject({ duplicate: true, status: "paused" });
  const resumed = await start(s.id, 1); expect(resumed).toMatchObject({ status: "active", stateVersion: 2 }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(555);
  await pause(s.id, 2); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600);
});
it("only retained recordings can obtain a paused ticket, charge actual submitted time and remain resumable at the same question", async () => {
  const s = await practice(); await start(s.id, 0);
  const submissionId = "paused-pending-answer-001", input = { sessionId: s.id, planIndex: 0, kind: "main" as const, submissionId, clientDurationMs: 12000, interrupted: true, consentVersion };
  await pause(s.id, 1, { pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600);
  const ticket = await answers.createUploadTicket(owner.id, input); await answers.createUploadTicket(owner.id, input);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, reservedSeconds: 0 });
  await expect(answers.createUploadTicket(owner.id, { ...input, submissionId: "new-unretained-answer-001" })).rejects.toMatchObject({ code: "session_closed" });
  await expect(answers.createUploadTicket(owner.id, { ...input, submissionId: "another-answer-001", planIndex: 1 })).rejects.toMatchObject({ code: "session_closed" });
  await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(12)); await answers.submitAnswer(owner.id, ticket.answerId);
  const view = await sessions.getSessionView(owner.id, s.id); expect(view.answers).toHaveLength(1); expect(view.answers[0]).toMatchObject({ planIndex: 0, interrupted: true });
  const resumed = await start(s.id, 2); expect(resumed.status).toBe("active"); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(543); // 12 spent, 45 available for a complete retry
  const replacement = await answers.createUploadTicket(owner.id, { ...input, submissionId: "completed-retry-answer-001", clientDurationMs: 10000, interrupted: false });
  await answers.receiveAudio(owner.id, replacement.answerId, replacement.ticket, pcmFixture(10)); await answers.submitAnswer(owner.id, replacement.answerId);
  expect(await sessions.recordEvent(owner.id, s.id, { type: "finish", eventId: randomUUID(), expectedVersion: 3 })).toMatchObject({ status: "completed", finished: true });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 578, reservedSeconds: 0 });
});
it("resuming rechecks remaining credit, site pause and monthly budget without reopening on rejection", async () => {
  const s = await practice(); await pause(s.id, 0); const { setSetting } = await import("@/lib/settings");
  await setSetting("pauseNewSessions", true); await expect(start(s.id, 1)).rejects.toMatchObject({ code: "paused" }); await setSetting("pauseNewSessions", false);
  await setSetting("budget", { monthlyYuan: 0 }); await expect(start(s.id, 1)).rejects.toMatchObject({ code: "budget_exceeded" }); await setSetting("budget", { monthlyYuan: 100 });
  await db.update(schema.minuteCredit).set({ remainingSeconds: 20 }).where(eq(schema.minuteCredit.userId, owner.id));
  await expect(start(s.id, 1)).rejects.toMatchObject({ code: "quota_exceeded" }); expect(await sessions.getOwnedSession(owner.id, s.id)).toMatchObject({ status: "paused", stateVersion: 1 });
  await db.update(schema.minuteCredit).set({ remainingSeconds: 60 }).where(eq(schema.minuteCredit.userId, owner.id));
  expect(await start(s.id, 1)).toMatchObject({ status: "active" }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(15);
});
it("cannot restart a started mock; unstarted mock exits release their reservation and interrupted audio can still upload", async () => {
  await db.update(schema.user).set({ dailyQuotaMinutes: 30 }).where(eq(schema.user.id, owner.id));
  const m = await sessions.createSession(owner, { mode: "mock", mockSetId: "mock-1", fresh: true }); await pause(m.id, 0);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ usedSeconds: 0, reservedSeconds: 0 });
  const started = await start(m.id, 1); const submissionId = "paused-mock-answer-001";
  await expect(start(m.id, started.stateVersion)).rejects.toMatchObject({ code: "session_closed" });
  await pause(m.id, started.stateVersion, { pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  const closed = await sessions.getOwnedSession(owner.id, m.id); expect(closed.status).toBe("interrupted"); expect(closed.interruptReason).toBe("user_exit");
  await expect(start(m.id, closed.stateVersion)).rejects.toMatchObject({ code: "session_closed" });
  expect(await answers.createUploadTicket(owner.id, { sessionId: m.id, submissionId, planIndex: 0, kind: "main", consentVersion, interrupted: true, clientDurationMs: 6000 })).toHaveProperty("answerId");
});
it("stale starts/exits and old heartbeat events cannot revive or pause another page's newer activation", async () => {
  const first = await practice(); await pause(first.id, 0); await expect(start(first.id, 0)).rejects.toMatchObject({ code: "session_changed" });
  const second = await practice(), startId = randomUUID(); await start(second.id, 0, startId);
  await expect(pause(second.id, 0, { startEventId: randomUUID() })).rejects.toMatchObject({ code: "session_changed" });
  const lateExit = await pause(second.id, 0, { startEventId: startId }); expect(lateExit).toMatchObject({ status: "paused", stateVersion: 2 });
  expect(await start(second.id, 0, startId)).toMatchObject({ duplicate: true, status: "paused", stateVersion: 2 });
  await expect(sessions.recordEvent(owner.id, second.id, { type: "heartbeat", eventId: randomUUID(), expectedVersion: 1 })).rejects.toMatchObject({ code: "session_changed" });
  await start(second.id, 2); await expect(pause(second.id, 0, { startEventId: startId })).rejects.toMatchObject({ code: "session_changed" });
});
it("six concurrent resumptions preserve the global five-session limit and settle the rejected session's credits", async () => {
  const discs = []; for (let i = 0; i < 6; i++) { const s = await practice(); await pause(s.id, 0); discs.push(s.id); }
  const results = await Promise.allSettled(discs.map(id => start(id, 1))); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
  const rejected = results.find(r => r.status === "rejected"); expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toMatchObject({ code: "busy" });
  expect(await quota.activeSessionCount(await (await import("@/lib/settings")).getSettings())).toBe(5);
  expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(375);
});
it("cross-day continuation reserves a complete remaining answer and cannot revive expired unused credit", async () => {
  const s = await practice(), a = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId: "cross-day-answer-001", planIndex: 0, kind: "main", clientDurationMs: 10000, interrupted: true, consentVersion });
  await db.update(schema.answer).set({ status: "uploaded", durationMs: 10000 }).where(eq(schema.answer.id, a.answerId)); await pause(s.id, 0);
  const yesterday = new Date(Date.now() - 86400_000), day = (await import("@/lib/services/rewards")).rewardDay(yesterday);
  await db.update(schema.answer).set({ createdAt: yesterday }).where(eq(schema.answer.id, a.answerId)); await db.update(schema.quotaHold).set({ day }).where(eq(schema.quotaHold.sessionId, s.id));
  const resumed = await start(s.id, 1); expect((await sessions.getOwnedSession(owner.id, s.id)).reservedSeconds).toBe(45); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(545);
  await pause(s.id, resumed.stateVersion); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(590);
  await db.update(schema.minuteCredit).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.minuteCredit.userId, owner.id));
  await expect(start(s.id, resumed.stateVersion + 1)).rejects.toMatchObject({ code: "quota_exceeded" });
});
it("withdrawal closes paused sessions and invalidates their retained recordings even after reconsent", async () => {
  const s = await practice(), submissionId = "revoked-pause-answer-001";
  await pause(s.id, 0, { pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] }); await consent.withdrawRecordingConsent(owner.id);
  const granted = await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "intermediate" }), closed = await sessions.getOwnedSession(owner.id, s.id);
  expect(closed).toMatchObject({ status: "abandoned", interruptReason: "consent_withdrawn", pausedUploads: [] });
  await expect(start(s.id, closed.stateVersion)).rejects.toMatchObject({ code: "session_closed" });
  await expect(answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId, planIndex: 0, kind: "main", consentVersion: granted.version, clientDurationMs: 6000 })).rejects.toMatchObject({ code: "session_closed" });
});
it("foreign accounts and malformed retained lists cannot modify the original disc", async () => {
  const s = await practice(), u = await (await import("@/lib/auth")).createAccount({ email: `foreign-${sequence}@example.test`, password: "Foreign-test-only-123!", name: "Synthetic foreign" });
  await consent.grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" });
  await expect(sessions.recordEvent(u.id, s.id, { type: "pause", expectedVersion: 0, eventId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  await expect(pause(s.id, 0, { pendingUploads: [{ submissionId: "wrong-position-001", planIndex: 55, kind: "main", consentVersion }] })).rejects.toMatchObject({ status: 400 });
  expect(await sessions.getOwnedSession(owner.id, s.id)).toMatchObject({ status: "active", stateVersion: 0 });
  const usage = await db.select().from(schema.usageEvent); expect(usage.every(u => !u.costYuan)).toBe(true);
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ passed: true, syntheticOnly: true, paidCalls: 0, originalDatabaseUnchanged: true }, null, 2));
});
