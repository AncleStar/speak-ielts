import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";

const root = path.resolve("data/verification", `device-takeover-${randomUUID()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5554/device_source", BETTER_AUTH_SECRET: "device-test-only-secret-000000000000000", BETTER_AUTH_URL: "http://localhost:3154", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), STORAGE_DRIVER: "local", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", DASHSCOPE_API_KEY: "", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", TIME_SCALE: "1", ENABLE_AUDIO_DIAGNOSIS: "false" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), sessions: typeof import("@/lib/services/sessions"), answers: typeof import("@/lib/services/answers");
let owner: { id: string; consentAt: Date }, consentVersion: number, sequence = 0;
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5554, dbName: "device_source", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); sessions = await import("@/lib/services/sessions"); answers = await import("@/lib/services/answers");
}, 120000);
beforeEach(async () => {
  const u = await (await import("@/lib/auth")).createAccount({ email: `device-${++sequence}@example.test`, password: "Device-test-only-123!", name: "Synthetic device" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(schema.user).set({ dailyQuotaMinutes: 100, mustChangePassword: false }).where(eq(schema.user.id, u.id));
  consentVersion = (await (await import("@/lib/services/recording-consent")).grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" })).version;
});
afterEach(async () => { await db.update(schema.practiceSession).set({ status: "abandoned", endedAt: new Date() }).where(eq(schema.practiceSession.status, "active")); });
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);
const practice = () => sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
const event = (id: string, input: Omit<import("@/lib/services/sessions").SessionEventInput, "eventId"> & { eventId?: string }) => sessions.recordEvent(owner.id, id, { eventId: randomUUID(), ...input });
const ticket = (id: string, activationId?: string | null, extra: Partial<import("@/lib/services/answers").TicketInput> = {}) => answers.createUploadTicket(owner.id, { sessionId: id, activationId, planIndex: 0, kind: "main", submissionId: randomUUID(), clientDurationMs: 6000, interrupted: false, consentVersion, ...extra });

it("requires explicit takeover of the exact activation and does not charge for rejected starts", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const { getQuotaStatus } = await import("@/lib/quota"), before = await getQuotaStatus(owner.id);
  await expect(event(s.id, { type: "start", expectedVersion: 1 })).rejects.toMatchObject({ code: "session_in_use" });
  await expect(event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: randomUUID() })).rejects.toMatchObject({ code: "session_in_use" });
  expect(await getQuotaStatus(owner.id)).toEqual(before);
  const b = await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a });
  expect(b).toMatchObject({ status: "active", stateVersion: 2 }); expect(b.activationId).not.toBe(a);
  await expect(event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a })).rejects.toMatchObject({ code: "session_changed" });
});
it("fences every old controller event even when its state version is omitted or current", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const b = await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a });
  for (const type of ["pause", "heartbeat", "position", "skip", "finish", "interrupt", "part_start"] as const) {
    await expect(event(s.id, { type, expectedVersion: 2, startEventId: a, position: 1, planIndex: 0, part: 1 })).rejects.toMatchObject({ code: "session_changed" });
    if (type !== "pause") await expect(event(s.id, { type, startEventId: a })).rejects.toMatchObject({ code: "session_changed" });
  }
  await expect(event(s.id, { type: "pause", expectedVersion: 2 })).rejects.toMatchObject({ code: "session_changed" });
  expect(await sessions.getSessionState(owner.id, s.id)).toMatchObject({ status: "active", stateVersion: 2, activationId: b.activationId });
});
it("preserves and decodes stale audio as interrupted, charges actual time and cannot finish the new slot", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const b = await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a });
  const old = await ticket(s.id, a); expect(old).toMatchObject({ interrupted: true, recordingSource: "previous_device" });
  await answers.receiveAudio(owner.id, old.answerId, old.ticket, pcmFixture(6)); await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: old.answerId }, { finalAttempt: true });
  const detail = await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, old.answerId);
  expect(detail.answer).toMatchObject({ interrupted: true, recordingSource: "previous_device", durationMs: 6000, hasAudio: true });
  expect(await event(s.id, { type: "finish", expectedVersion: 2, startEventId: b.activationId! })).toMatchObject({ status: "active", finished: false });
  expect(await (await import("@/lib/quota")).dailyUsageSeconds(owner.id, new Date(), db, undefined, false)).toBe(6);
  const current = await ticket(s.id, b.activationId); expect(current).toMatchObject({ interrupted: false, recordingSource: "current_device" });
  await answers.receiveAudio(owner.id, current.answerId, current.ticket, pcmFixture(6));
  expect(await event(s.id, { type: "finish", expectedVersion: 2, startEventId: b.activationId! })).toMatchObject({ status: "completed", finished: true });
});
it("keeps full tickets already admitted before takeover and never rewrites their classification", async () => {
  const s = await practice(), a = randomUUID(), submissionId = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const first = await ticket(s.id, a, { submissionId }); await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a });
  expect(await ticket(s.id, a, { submissionId })).toMatchObject({ answerId: first.answerId, interrupted: false, recordingSource: "current_device" });
  await answers.receiveAudio(owner.id, first.answerId, first.ticket, pcmFixture(6));
  expect((await sessions.getSessionView(owner.id, s.id)).answers[0].interrupted).toBe(false);
});
it("keeps finalized submissions retained by their original pause full after resuming on another device", async () => {
  const s = await practice(), a = randomUUID(), submissionId = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  await event(s.id, { type: "pause", expectedVersion: 1, startEventId: a, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  await event(s.id, { type: "start", expectedVersion: 2 });
  expect(await ticket(s.id, a, { submissionId })).toMatchObject({ interrupted: false, recordingSource: "retained_before_pause" });
  expect(await ticket(s.id, a)).toMatchObject({ interrupted: true, recordingSource: "previous_device" });
});
it("does not promote stale fragments merely because a later device included them in its pause", async () => {
  const s = await practice(), a = randomUUID(), submissionId = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const b = await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a });
  await event(s.id, { type: "pause", expectedVersion: 2, startEventId: b.activationId!, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  expect(await ticket(s.id, a, { submissionId, interrupted: true })).toMatchObject({ interrupted: true, recordingSource: "previous_device" });
});
it("quarantines missing legacy activation markers without changing historical accepted answers", async () => {
  const s = await practice(), historical = await ticket(s.id); // Existing unstarted compatibility admission.
  await event(s.id, { type: "start", expectedVersion: 0 });
  expect(await ticket(s.id)).toMatchObject({ interrupted: true, recordingSource: "unverified_device" });
  expect(await ticket(s.id, undefined, { submissionId: (await db.select().from(schema.answer).where(eq(schema.answer.id, historical.answerId)))[0].submissionId! })).toMatchObject({ answerId: historical.answerId, interrupted: false });
});
it("read-only mock checks do not stop its clock; explicit end accepts only known interrupted fragments", async () => {
  const m = await sessions.createSession(owner, { mode: "mock", mockSetId: "mock-1", fresh: true }), a = randomUUID();
  await event(m.id, { type: "start", eventId: a, expectedVersion: 0 }); await event(m.id, { type: "part_start", part: 1, startEventId: a });
  const before = await sessions.getOwnedSession(owner.id, m.id);
  for (let i = 0; i < 5; i++) expect(await sessions.getSessionState(owner.id, m.id)).toMatchObject({ status: "active", activationId: a });
  expect((await sessions.getOwnedSession(owner.id, m.id)).partDeadlines).toEqual(before.partDeadlines);
  const ended = await event(m.id, { type: "interrupt", reason: "device_end", expectedVersion: 1, startEventId: a });
  expect(ended.status).toBe("interrupted"); await expect(event(m.id, { type: "start", expectedVersion: ended.stateVersion })).rejects.toMatchObject({ code: "session_closed" });
  expect(await ticket(m.id, a, { interrupted: true })).toMatchObject({ interrupted: true });
  await expect(ticket(m.id, randomUUID(), { interrupted: true })).rejects.toMatchObject({ code: "session_closed" });
  await expect(ticket(m.id, a)).rejects.toMatchObject({ code: "session_closed" });
  expect((await (await import("@/lib/quota")).getQuotaStatus(owner.id)).reservedSeconds).toBe(0);
});
it("expires pause authorization and checks owner scope before device metadata", async () => {
  const s = await practice(), a = randomUUID(), submissionId = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  await event(s.id, { type: "pause", expectedVersion: 1, startEventId: a, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  await event(s.id, { type: "start", expectedVersion: 2 });
  await db.update(schema.sessionEvent).set({ createdAt: new Date(Date.now() - 25 * 3600000) }).where(and(eq(schema.sessionEvent.sessionId, s.id), eq(schema.sessionEvent.type, "pause")));
  expect(await ticket(s.id, a, { submissionId })).toMatchObject({ interrupted: true, recordingSource: "previous_device" });
  await expect(sessions.getSessionState("foreign-user", s.id)).rejects.toMatchObject({ status: 404 });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.usageEvent).where(sql`${schema.usageEvent.costYuan} > 0`); expect(n).toBe(0);
});

it("admits a known inactive interrupted batch without reopening or reserving the complete question", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  await db.update(schema.practiceSession).set({ status: "abandoned", interruptReason: "inactive", endedAt: new Date(), stateVersion: 2 }).where(eq(schema.practiceSession.id, s.id));
  const t = await ticket(s.id, a, { interrupted: true });
  expect(await sessions.getSessionState(owner.id, s.id)).toMatchObject({ status: "abandoned", stateVersion: 2 });
  const quota = await (await import("@/lib/quota")).getQuotaStatus(owner.id); expect(quota.reservedSeconds).toBe(0); expect(quota.pendingUploadSeconds).toBe(6);
  await answers.receiveAudio(owner.id, t.answerId, t.ticket, pcmFixture(6)); await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: t.answerId }, { finalAttempt: true });
  expect(await (await import("@/lib/quota")).dailyUsageSeconds(owner.id, new Date(), db, undefined, false)).toBe(6);
});

it("closed legacy copies are forced interrupted, decode and charge actual time without reopening", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  await event(s.id, { type: "pause", expectedVersion: 1, startEventId: a });
  const copy = await ticket(s.id, undefined, { fragmentCopy: true, interrupted: false });
  expect(copy).toMatchObject({ interrupted: true, recordingSource: "local_snapshot" });
  await answers.receiveAudio(owner.id, copy.answerId, copy.ticket, pcmFixture(6)); await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: copy.answerId }, { finalAttempt: true });
  expect(await sessions.getSessionState(owner.id, s.id)).toMatchObject({ status: "paused", stateVersion: 2 });
  const q = await (await import("@/lib/quota")).getQuotaStatus(owner.id); expect(q.reservedSeconds).toBe(0); expect(q.usedSeconds).toBe(6);
  expect((await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, copy.answerId)).answer).toMatchObject({ hasAudio: true, durationMs: 6000, interrupted: true });
});
it("late old-device audio preserves a completed session and its full answer's synthetic evaluation", async () => {
  const s = await practice(), a = randomUUID(); await event(s.id, { type: "start", eventId: a, expectedVersion: 0 });
  const b = await event(s.id, { type: "start", expectedVersion: 1, takeover: true, expectedActivationId: a }), full = await ticket(s.id, b.activationId);
  await answers.receiveAudio(owner.id, full.answerId, full.ticket, pcmFixture(6)); await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: full.answerId }, { finalAttempt: true });
  // Protocol fixture only: a known non-mock evaluation marker, not a real teaching-quality claim.
  await db.update(schema.feedback).set({ mock: false, goalMet: true, goalReason: "Synthetic protocol evaluation" }).where(eq(schema.feedback.answerId, full.answerId));
  await event(s.id, { type: "finish", expectedVersion: 2, startEventId: b.activationId! });
  const late = await ticket(s.id, a, { interrupted: true }); expect(late).toMatchObject({ interrupted: true, recordingSource: "previous_device" });
  await answers.receiveAudio(owner.id, late.answerId, late.ticket, pcmFixture(6));
  const report = await (await import("@/lib/services/reports")).getSessionReport(owner.id, s.id); expect(report.session.status).toBe("completed"); expect(report.summary.pending).toBe(1); expect(report.summary.goal.met).toBe(true);
  expect((await (await import("@/lib/quota")).getQuotaStatus(owner.id)).reservedSeconds).toBe(0);
});
it("copy declarations cannot rewrite prior full tickets or bypass expired, deleted and foreign session scope", async () => {
  const s = await practice(), nonce = randomUUID(), full = await ticket(s.id, undefined, { submissionId: nonce });
  await expect(ticket(s.id, undefined, { submissionId: nonce, fragmentCopy: true })).rejects.toMatchObject({ code: "submission_changed" });
  expect((await db.select().from(schema.answer).where(eq(schema.answer.id, full.answerId)))[0].interrupted).toBe(false);
  await event(s.id, { type: "pause", expectedVersion: 0 }); await db.update(schema.practiceSession).set({ endedAt: new Date(Date.now() - 25 * 3600000) }).where(eq(schema.practiceSession.id, s.id));
  await expect(ticket(s.id, undefined, { fragmentCopy: true })).rejects.toMatchObject({ code: "session_closed" });
  await db.update(schema.practiceSession).set({ deletedAt: new Date() }).where(eq(schema.practiceSession.id, s.id)); await expect(ticket(s.id, undefined, { fragmentCopy: true })).rejects.toMatchObject({ status: 404 });
  const u = await (await import("@/lib/auth")).createAccount({ email: `copy-foreign-${sequence}@example.test`, password: "Device-test-only-123!", name: "Synthetic foreign" }); await (await import("@/lib/services/recording-consent")).grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" });
  await expect(answers.createUploadTicket(u.id, { sessionId: s.id, planIndex: 0, kind: "main", submissionId: randomUUID(), clientDurationMs: 6000, fragmentCopy: true })).rejects.toMatchObject({ status: 404 });
});
