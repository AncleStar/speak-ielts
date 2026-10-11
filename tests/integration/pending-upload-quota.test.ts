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
async function groupedDeclarations(durations: number[], storedIndex = -1) {
  const s = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true }), nonces = durations.map(() => randomUUID());
  await sessions.recordEvent(owner.id, s.id, { type: "pause", expectedVersion: 0, eventId: randomUUID(), pendingUploads: nonces.map(submissionId => ({ submissionId, planIndex: 0, kind: "main", consentVersion: version })) });
  const tickets = [];
  for (let i = 0; i < durations.length; i++) {
    const ticket = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId: nonces[i], planIndex: 0, kind: "main", interrupted: true, clientDurationMs: durations[i] * 1000, consentVersion: version });
    if (i === storedIndex) await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(durations[i])); tickets.push(ticket);
  }
  return { s, nonces, tickets };
}
async function evidence(key: string, value: unknown) {
  if (process.env.RECORD_ROUND12_BASELINE !== "true") return;
  const file = "data/verification/round12-baseline.json", before = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
  await fs.writeFile(file, JSON.stringify({ ...before, actualPostgres: true, syntheticOnly: true, sourceCommit: "b56ca34d7ded1ed9d890df141141bcc7c710d082", paidCostYuan: 0, [key]: value }, null, 2));
}
it("fractional declarations in separate sessions display the same protected seconds as their voucher holds", async () => {
  await declaration(1.001); await declaration(1.001); const q = await quota.getQuotaStatus(owner.id);
  await evidence("fractionalSeparateSessions", { displayedSeconds: q.pendingUploadSeconds, voucherHeldSeconds: 600 - q.extraSeconds! });
  expect(q).toMatchObject({ pendingUploadSeconds: 4, extraSeconds: 596 });
});
it("fractional daily usage cannot allocate more base seconds than its daily limit", async () => {
  await db.update(schema.user).set({ dailyQuotaMinutes: 1 }).where(eq(schema.user.id, owner.id));
  await declaration(12.1); await declaration(12.1); const active = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const holds = await db.select().from(schema.quotaHold).where(eq(schema.quotaHold.userId, owner.id)), base = holds.reduce((n, h) => n + h.baseSeconds, 0), q = await quota.getQuotaStatus(owner.id);
  await evidence("fractionalBaseAllowance", { allocatedBaseSeconds: base, configuredBaseSeconds: 60, newHold: await hold(active.id), quota: q });
  expect(base).toBe(60); expect(await hold(active.id)).toMatchObject({ baseSeconds: 34, credits: [{ id: creditId, seconds: 11 }] }); expect(q).toMatchObject({ usedSeconds: 60, extraSeconds: 589, baseRemainingSeconds: 0 });
});
it("stored and pending fractions in one record day round together without charging an extra second", async () => {
  const { s, nonces } = await groupedDeclarations([1.001, 1.001], 0), q = await quota.getQuotaStatus(owner.id);
  await evidence("fractionalMixedAudio", { displayedPendingSeconds: q.pendingUploadSeconds, voucherHeldSeconds: 600 - q.extraSeconds!, consumedSeconds: (await hold(s.id)).usedSeconds });
  expect(q).toMatchObject({ pendingUploadSeconds: 1, extraSeconds: 597 }); expect((await hold(s.id)).usedSeconds).toBe(2);
  await answers.discardPendingUpload(owner.id, s.id, nonces[1]); expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ pendingUploadSeconds: 0, extraSeconds: 598 });
});
it("fractional consumption stays rounded per session and day after deletion", async () => {
  const first = await declaration(1.001, true); await declaration(1.001, true);
  expect(await quota.dailyUsageSeconds(owner.id)).toBe(4); await deletion.purgeSession(first.s.id);
  expect(await quota.dailyUsageSeconds(owner.id)).toBe(4); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(596);
});
it("a pending fraction inside an already consumed rounded second needs no extra voucher time", async () => {
  const { s, nonces } = await groupedDeclarations([1.001, 0.998], 0);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ pendingUploadSeconds: 0, extraSeconds: 598 }); expect((await hold(s.id)).usedSeconds).toBe(2);
  await answers.discardPendingUpload(owner.id, s.id, nonces[1]); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(598);
});
it("one session spanning two Shanghai record days protects each day's fraction independently", async () => {
  const { s, tickets } = await groupedDeclarations([1.001, 1.001]);
  const past = new Date((await import("@/lib/timing")).startOfDayShanghai(new Date()).getTime() - 1), pastDay = (await import("@/lib/services/rewards")).rewardDay(past);
  await db.update(schema.answer).set({ createdAt: past }).where(eq(schema.answer.id, tickets[0].answerId));
  await db.insert(schema.quotaHold).values({ userId: owner.id, sessionId: s.id, day: pastDay, baseLimitSeconds: 0, baseSeconds: 0, credits: [], usedSeconds: 0, settled: true });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ pendingUploadSeconds: 4, extraSeconds: 596 });
  expect(await quota.dailyUsageSeconds(owner.id, past, db, undefined, false, new Date())).toBe(2);
});
it("a report containing only discarded declarations is empty rather than all answers processed", async () => {
  const { s, input } = await declaration(); await answers.discardPendingUpload(owner.id, s.id, input.submissionId);
  const report = await (await import("@/lib/services/reports")).getSessionReport(owner.id, s.id);
  await evidence("discardedReport", { state: report.state, answers: report.summary.answers, failed: report.summary.failed, complete: report.summary.complete });
  expect(report).toMatchObject({ state: "empty", discardedAnswers: 1, summary: { answers: 0, failed: 0, durationSec: 0, complete: false } });
  expect(report.items[0].attempts[0].answer).toMatchObject({ durationMs: null, hasAudio: false, processingStage: "upload_discarded" });
  expect((await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, report.items[0].attempts[0].answer.id)).answer).toMatchObject({ durationMs: null, hasAudio: false });
});
it("discarded declarations remain visible without inflating real processing failures or pending answers", async () => {
  const { s, nonces } = await groupedDeclarations([8, 12], 0); await answers.discardPendingUpload(owner.id, s.id, nonces[1]);
  const report = await (await import("@/lib/services/reports")).getSessionReport(owner.id, s.id);
  expect(report).toMatchObject({ state: "processing", discardedAnswers: 1, summary: { answers: 1, pending: 1, failed: 0, durationSec: 8 } }); expect(report.items[0].attempts).toHaveLength(2);
});
it("a discarded mock answer can start an ordinary exact-question retry without resuming its interrupted exam", async () => {
  await db.update(schema.user).set({ dailyQuotaMinutes: 30 }).where(eq(schema.user.id, owner.id));
  const s = await sessions.createSession(owner, { mode: "mock", mockSetId: "mock-1", fresh: true });
  await sessions.recordEvent(owner.id, s.id, { type: "start", eventId: randomUUID(), expectedVersion: 0 });
  const nonce = randomUUID(), interrupted = await sessions.recordEvent(owner.id, s.id, { type: "pause", eventId: randomUUID(), expectedVersion: 1, pendingUploads: [{ submissionId: nonce, planIndex: 0, kind: "main", consentVersion: version }] });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId: nonce, planIndex: 0, kind: "main", clientDurationMs: 1001, consentVersion: version });
  await answers.discardPendingUpload(owner.id, s.id, nonce);
  const retry = await sessions.createSession(owner, { mode: "retry", sourceAnswerId: ticket.answerId, fresh: true }), retryView = await sessions.getSessionView(owner.id, retry.id), original = await sessions.getSessionView(owner.id, s.id);
  expect(interrupted.status).toBe("interrupted"); expect(original.session.status).toBe("interrupted"); expect(retryView.plan.items[0].prompt.text).toBe(original.plan.items[0].prompt.text); expect(retryView.plan.mode).toBe("retry");
  await expect(sessions.recordEvent(owner.id, s.id, { type: "start", eventId: randomUUID(), expectedVersion: original.session.stateVersion })).rejects.toMatchObject({ code: "session_closed" });
});
