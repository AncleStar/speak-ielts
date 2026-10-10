import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";
const root = path.resolve("data/verification", `pending-quota-${randomUUID()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5563/pendingquota", BETTER_AUTH_SECRET: "pending-quota-test-only-0000000000000000000000", BETTER_AUTH_URL: "http://localhost:3199", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), STORAGE_DRIVER: "local", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", DASHSCOPE_API_KEY: "", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), sessions: typeof import("@/lib/services/sessions"), quota: typeof import("@/lib/quota"), answers: typeof import("@/lib/services/answers"), deletion: typeof import("@/lib/services/deletion"), consent: typeof import("@/lib/services/recording-consent");
let owner: { id: string; consentAt: Date }, version = 0, sequence = 0, creditId = "";
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5563, dbName: "pendingquota", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); sessions = await import("@/lib/services/sessions"); quota = await import("@/lib/quota"); answers = await import("@/lib/services/answers"); deletion = await import("@/lib/services/deletion"); consent = await import("@/lib/services/recording-consent");
}, 120000);
beforeEach(async () => {
  const u = await (await import("@/lib/auth")).createAccount({ email: `pending-${++sequence}@example.test`, password: "Pending-test-only-123!", name: "Synthetic pending time" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(schema.user).set({ dailyQuotaMinutes: 0, mustChangePassword: false }).where(eq(schema.user.id, u.id));
  version = (await consent.grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" })).version;
  const [credit] = await db.insert(schema.minuteCredit).values({ userId: u.id, redemptionKey: randomUUID(), totalSeconds: 600, remainingSeconds: 600, expiresAt: new Date(Date.now() + 3 * 86400_000) }).returning(); creditId = credit.id;
});
afterEach(async () => { vi.restoreAllMocks(); await db.update(schema.practiceSession).set({ status: "abandoned", endedAt: new Date() }).where(and(eq(schema.practiceSession.userId, owner.id), eq(schema.practiceSession.status, "active"))); });
afterAll(async () => {
  try {
    const [usage] = await db.select({ cost: sql<number>`coalesce(sum(${schema.usageEvent.costYuan}),0)::float8` }).from(schema.usageEvent); expect(Number(usage.cost)).toBe(0);
    await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ syntheticOnly: true, actualPostgres: true, pendingVsStored: true, concurrencyTested: true, paidCostYuan: Number(usage.cost) }, null, 2));
  } finally { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }
}, 30000);
async function declaration(seconds = 12, stored = false) {
  const s = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true }), submissionId = randomUUID();
  await sessions.recordEvent(owner.id, s.id, { type: "pause", eventId: randomUUID(), expectedVersion: 0, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion: version }] });
  const input = { sessionId: s.id, submissionId, planIndex: 0, kind: "main" as const, clientDurationMs: seconds * 1000, interrupted: true, consentVersion: version };
  const ticket = await answers.createUploadTicket(owner.id, input); if (stored) await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(seconds)); return { s, input, ticket };
}
async function hold(sessionId: string) { return (await db.select().from(schema.quotaHold).where(eq(schema.quotaHold.sessionId, sessionId)))[0]; }
async function answerRow(id: string) { return (await db.select().from(schema.answer).where(eq(schema.answer.id, id)))[0]; }
it("protects an unuploaded declaration without marking it consumed, and releases it after 24h without daily cleanup", async () => {
  const { s } = await declaration();
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, pendingUploadSeconds: 12, reservedSeconds: 0, warn: false }); expect(await hold(s.id)).toMatchObject({ usedSeconds: 0, settled: true });
  expect(await sessions.totalTrainingSeconds(owner.id)).toBe(0); expect((await sessions.listSessions(owner.id))[0]).toMatchObject({ durationMs: 0, answerCount: 0 });
  for (let i = 0; i < 3; i++) expect(await quota.getQuotaStatus(owner.id, new Date(Date.now() + 86400_001))).toMatchObject({ extraSeconds: 600, pendingUploadSeconds: 0 });
  expect((await hold(s.id)).credits).toEqual([]);
});
it("purging an unuploaded session never creates spent audio or permanently consumes its voucher", async () => {
  const { s } = await declaration(); await deletion.purgeSession(s.id); await deletion.purgeSession(s.id);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 600, pendingUploadSeconds: 0 }); expect((await hold(s.id)).usedSeconds).toBe(0);
  expect(await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner.id))).toHaveLength(0);
});
it("deletion preserves stored audio consumption while releasing a separate unuploaded declaration", async () => {
  const stored = await declaration(12, true), pending = await declaration(8); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(580);
  expect(await sessions.totalTrainingSeconds(owner.id)).toBe(12); expect((await sessions.listSessions(owner.id)).reduce((n, r) => n + r.answerCount, 0)).toBe(1);
  await Promise.all([deletion.purgeSession(stored.s.id), deletion.purgeSession(pending.s.id), quota.getQuotaStatus(owner.id)]);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, pendingUploadSeconds: 0 });
  expect((await hold(stored.s.id)).usedSeconds).toBe(12); expect((await hold(pending.s.id)).usedSeconds).toBe(0);
  const events = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner.id)); expect(events).toHaveLength(1); expect(events[0].units).toMatchObject({ seconds: 12 });
});
it("withdrawing consent releases declarations but keeps audio already received and invalidates old tickets", async () => {
  const stored = await declaration(12, true), pending = await declaration(8); await consent.withdrawRecordingConsent(owner.id);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, pendingUploadSeconds: 0 });
  const renewed = await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "intermediate" }); expect(renewed.version).toBeGreaterThan(version);
  await expect(answers.receiveAudio(owner.id, pending.ticket.answerId, pending.ticket.ticket, pcmFixture(8))).rejects.toMatchObject({ code: "invalid_ticket" });
  await expect(answers.createUploadTicket(owner.id, { ...pending.input, consentVersion: renewed.version })).rejects.toMatchObject({ code: "consent_required" }); expect((await hold(stored.s.id)).usedSeconds).toBe(12);
});
it("renewing a ticket cannot extend the original retention deadline and an expired body is rejected", async () => {
  const { input, ticket } = await declaration(), created = new Date(Date.now() - 86400_000 + 5 * 60000);
  await db.update(schema.answer).set({ createdAt: created }).where(eq(schema.answer.id, ticket.answerId));
  const renewed = await answers.createUploadTicket(owner.id, input); expect(Number(renewed.ticket.split(".")[1])).toBe(created.getTime() + 86400_000);
  await db.update(schema.answer).set({ createdAt: new Date(Date.now() - 86400_001) }).where(eq(schema.answer.id, ticket.answerId));
  await expect(answers.createUploadTicket(owner.id, input)).rejects.toMatchObject({ code: "upload_expired" });
  await expect(answers.receiveAudio(owner.id, ticket.answerId, answers.signUploadTicket(ticket.answerId, owner.id, Date.now(), version), pcmFixture(12))).rejects.toMatchObject({ code: "upload_expired" }); expect((await answerRow(ticket.answerId)).storageKey).toBeNull();
});
it("discard is idempotent, prevents old PUT and renewal, and cannot satisfy a complete answer", async () => {
  const { s, ticket, input } = await declaration();
  const results = await Promise.all(Array.from({ length: 4 }, () => answers.discardPendingUpload(owner.id, s.id, input.submissionId))); expect(results.every(r => r.discarded)).toBe(true);
  expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600); expect(await answerRow(ticket.answerId)).toMatchObject({ status: "failed", processingStage: "upload_discarded", interrupted: true, storageKey: null });
  await expect(answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(12))).rejects.toMatchObject({ code: "upload_discarded" }); await expect(answers.createUploadTicket(owner.id, input)).rejects.toMatchObject({ code: "upload_discarded" });
  expect(await db.select().from(schema.sessionEvent).where(and(eq(schema.sessionEvent.sessionId, s.id), eq(schema.sessionEvent.type, "upload_discard")))).toHaveLength(1);
  const view = await sessions.getSessionView(owner.id, s.id);
  const report = (await import("@/lib/services/outcome")).summarize(view.plan, "paused", [{ id: ticket.answerId, planIndex: 0, kind: "main", status: "failed", durationMs: null, clientDurationMs: 12000, storageKey: null, metrics: null, interrupted: true }], []); expect(report.durationSec).toBe(0);
  expect((await sessions.recordEvent(owner.id, s.id, { type: "finish", eventId: randomUUID() })).status).not.toBe("completed");
});
it("discarding before ticket admission leaves a tombstone and keeps the active whole-plan reservation", async () => {
  const s = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true }), submissionId = randomUUID();
  expect(await answers.discardPendingUpload(owner.id, s.id, submissionId)).toMatchObject({ discarded: true, wholePlanActive: true }); expect((await quota.getQuotaStatus(owner.id)).reservedSeconds).toBe(45);
  await expect(answers.createUploadTicket(owner.id, { sessionId: s.id, planIndex: 0, kind: "main", submissionId, clientDurationMs: 12000, consentVersion: version })).rejects.toMatchObject({ code: "upload_discarded" });
  await sessions.recordEvent(owner.id, s.id, { type: "pause", eventId: randomUUID(), expectedVersion: 0 }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600);
});
it("a received recording wins against concurrent discard without refunding its time", async () => {
  const { s, input, ticket } = await declaration(); const st = (await import("@/lib/storage")).storage(), put = st.put.bind(st);
  let entered!: () => void, release!: () => void; const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  vi.spyOn(st, "put").mockImplementation(async (...args) => { entered(); await gate; await put(...args); });
  const receiving = answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(12)); await started;
  const cancelling = answers.discardPendingUpload(owner.id, s.id, input.submissionId); release(); await receiving;
  expect(await cancelling).toMatchObject({ discarded: false, alreadyStored: true }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(588); expect((await hold(s.id)).usedSeconds).toBe(12);
});
it("discard and concurrent renewal cannot re-admit a cancelled nonce or charge it twice", async () => {
  const { s, input, ticket } = await declaration();
  await Promise.allSettled([answers.createUploadTicket(owner.id, input), answers.discardPendingUpload(owner.id, s.id, input.submissionId), quota.getQuotaStatus(owner.id)]);
  await expect(answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(12))).rejects.toMatchObject({ code: "upload_discarded" }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600);
  expect(await db.select().from(schema.answer).where(eq(schema.answer.sessionId, s.id))).toHaveLength(1);
});
it("historical pending declarations expire against the accounting clock, while actual recordings remain spent", async () => {
  const pending = await declaration(), stored = await declaration(8, true), originalDay = new Date();
  const future = new Date(Date.now() + 86400_001);
  expect(await quota.dailyUsageSeconds(owner.id, originalDay, db, undefined, false, future)).toBe(8);
  expect(await quota.getQuotaStatus(owner.id, future)).toMatchObject({ extraSeconds: 592, pendingUploadSeconds: 0 });
  expect((await hold(pending.s.id)).usedSeconds).toBe(0); expect((await hold(stored.s.id)).usedSeconds).toBe(8);
});
it("daily cleanup removes only expired unreceived declarations and repeated cleanup cannot refund audio", async () => {
  const pending = await declaration(), stored = await declaration(8, true); const future = new Date(Date.now() + 86400_001);
  const cleaned = await deletion.dailyCleanup(future); expect(cleaned.staleUploads).toBeGreaterThanOrEqual(1); expect(await answerRow(pending.ticket.answerId)).toBeUndefined(); expect((await answerRow(stored.ticket.answerId)).storageKey).not.toBeNull();
  expect((await quota.getQuotaStatus(owner.id, future)).extraSeconds).toBe(592); await deletion.dailyCleanup(future); expect((await quota.getQuotaStatus(owner.id, future)).extraSeconds).toBe(592);
});
it("ownership is required and releasing a temporary hold does not renew an expired voucher", async () => {
  const { s, input } = await declaration(); await expect(answers.discardPendingUpload("other-owner", s.id, input.submissionId)).rejects.toMatchObject({ status: 404 });
  await db.update(schema.minuteCredit).set({ expiresAt: new Date(Date.now() + 3600_000) }).where(eq(schema.minuteCredit.id, creditId));
  expect((await quota.getQuotaStatus(owner.id, new Date(Date.now() + 86400_001))).extraSeconds).toBe(0);
  expect((await db.select().from(schema.minuteCredit).where(eq(schema.minuteCredit.id, creditId)))[0].remainingSeconds).toBe(600);
});
