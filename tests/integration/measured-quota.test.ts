import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";
const root = path.resolve("data/verification", `measured-quota-${randomUUID()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5561/measuredquota", BETTER_AUTH_SECRET: "measured-quota-test-only-0000000000000000000000", BETTER_AUTH_URL: "http://localhost:3199", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), STORAGE_DRIVER: "local", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", DASHSCOPE_API_KEY: "", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), sessions: typeof import("@/lib/services/sessions"), quota: typeof import("@/lib/quota"), answers: typeof import("@/lib/services/answers"), processAnswer: typeof import("@/lib/jobs/process-answer").processAnswer;
let owner: { id: string; consentAt: Date }, consentVersion = 0, sequence = 0, creditId = "";
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5561, dbName: "measuredquota", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); sessions = await import("@/lib/services/sessions"); quota = await import("@/lib/quota"); answers = await import("@/lib/services/answers"); ({ processAnswer } = await import("@/lib/jobs/process-answer"));
}, 120000);
beforeEach(async () => {
  const u = await (await import("@/lib/auth")).createAccount({ email: `measured-${++sequence}@example.test`, password: "Measured-test-only-123!", name: "Synthetic measured time" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(schema.user).set({ dailyQuotaMinutes: 0, mustChangePassword: false }).where(eq(schema.user.id, u.id));
  consentVersion = (await (await import("@/lib/services/recording-consent")).grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" })).version;
  const [credit] = await db.insert(schema.minuteCredit).values({ userId: u.id, redemptionKey: randomUUID(), totalSeconds: 600, remainingSeconds: 600, expiresAt: new Date(Date.now() + 3 * 86400_000) }).returning(); creditId = credit.id;
});
afterEach(async () => { await db.update(schema.practiceSession).set({ status: "abandoned", endedAt: new Date() }).where(eq(schema.practiceSession.status, "active")); });
afterAll(async () => {
  const [usage] = await db.select({ cost: sql<number>`coalesce(sum(${schema.usageEvent.costYuan}),0)::float8` }).from(schema.usageEvent); expect(Number(usage.cost)).toBe(0);
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ syntheticOnly: true, actualPostgres: true, actualFfmpegAndWorkerFunction: true, paidCostYuan: Number(usage.cost) }, null, 2));
  await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop();
}, 30000);
const practice = () => sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
async function recording(declared: number, actual: number, paused = true, interrupted = true) {
  const s = await practice(), submissionId = randomUUID();
  if (paused) await sessions.recordEvent(owner.id, s.id, { type: "pause", eventId: randomUUID(), expectedVersion: 0, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion }] });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId, planIndex: 0, kind: "main", clientDurationMs: declared * 1000, interrupted, consentVersion });
  await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(actual)); await answers.submitAnswer(owner.id, ticket.answerId); return { s, ticket };
}
async function decoded(seconds: number) {
  const file = path.join(root, `measurement-${randomUUID()}.wav`); await fs.writeFile(file, pcmFixture(seconds));
  const metrics = await (await import("@/lib/audio")).analyzeWav(file); return { metrics, durationMs: Math.round(metrics.durationSec * 1000) };
}
async function hold(sessionId: string) { const [h] = await db.select().from(schema.quotaHold).where(eq(schema.quotaHold.sessionId, sessionId)); return h; }
it("decodes an underdeclared recording, charges the real 12 seconds once, and cannot regain 11 seconds tomorrow", async () => {
  const { s, ticket } = await recording(1, 12); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(599);
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "done" });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, remainingSeconds: 588, uncoveredSeconds: 0 });
  expect(await hold(s.id)).toMatchObject({ usedSeconds: 12, uncoveredSeconds: 0, settled: true });
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ skipped: "done" });
  expect((await quota.getQuotaStatus(owner.id, new Date(Date.now() + 86400_000))).extraSeconds).toBe(588);
});
it("refunds overdeclared time from server-decoded audio and repeated insufficient-audio jobs do not refund again", async () => {
  const { s, ticket } = await recording(12, 1); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(588);
  for (let i = 0; i < 3; i++) expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "insufficient" });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 599, uncoveredSeconds: 0 }); expect((await hold(s.id)).usedSeconds).toBe(1);
});
it("keeps an active whole-answer reservation, then settles its actual time on exit", async () => {
  const { s, ticket } = await recording(1, 12, false); await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 555, reservedSeconds: 45 });
  await sessions.recordEvent(owner.id, s.id, { type: "pause", expectedVersion: 0, eventId: randomUUID() });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, reservedSeconds: 0 });
});
it("persists an uncovered shortfall before any ASR, blocks repeated processing and starts, then resumes after a new voucher", async () => {
  await db.update(schema.minuteCredit).set({ totalSeconds: 50, remainingSeconds: 50 }).where(eq(schema.minuteCredit.id, creditId));
  const { s, ticket } = await recording(1, 12), competitor = await practice();
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "quota_wait" });
  const [a] = await db.select().from(schema.answer).where(eq(schema.answer.id, ticket.answerId)); expect(a).toMatchObject({ durationMs: 12000, transcript: null, processingStage: "quota_wait" });
  expect((await hold(s.id)).uncoveredSeconds).toBe(7); expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 0, remainingSeconds: 0, uncoveredSeconds: 7 });
  const calls = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner.id)); expect(calls).toHaveLength(0);
  await expect(answers.retryProcessing(owner.id, ticket.answerId)).rejects.toMatchObject({ code: "quota_exceeded" }); await expect(practice()).rejects.toMatchObject({ code: "quota_exceeded" });
  await db.insert(schema.minuteCredit).values({ userId: owner.id, redemptionKey: randomUUID(), totalSeconds: 20, remainingSeconds: 20, expiresAt: new Date(Date.now() + 86400_000) });
  await answers.retryProcessing(owner.id, ticket.answerId); expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "done" });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 13, uncoveredSeconds: 0 });
  await sessions.recordEvent(owner.id, competitor.id, { type: "pause", expectedVersion: 0, eventId: randomUUID() }); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(58);
});
it("concurrent retries after covering a shortfall queue and process the same recording once", async () => {
  const { s, ticket } = await recording(1, 12); await db.update(schema.minuteCredit).set({ remainingSeconds: 0 }).where(eq(schema.minuteCredit.id, creditId));
  expect(await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true })).toEqual({ status: "quota_wait" }); expect((await hold(s.id)).uncoveredSeconds).toBe(11);
  await db.insert(schema.minuteCredit).values({ userId: owner.id, redemptionKey: randomUUID(), totalSeconds: 11, remainingSeconds: 11, expiresAt: new Date(Date.now() + 86400_000) });
  const retries = await Promise.allSettled(Array.from({ length: 4 }, () => answers.retryProcessing(owner.id, ticket.answerId))); expect(retries.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const results = await Promise.all(Array.from({ length: 4 }, () => processAnswer({ answerId: ticket.answerId }, { finalAttempt: true }))); expect(results.filter(r => "status" in r && r.status === "done")).toHaveLength(1);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 0, uncoveredSeconds: 0 });
  const calls = await db.select().from(schema.usageEvent).where(and(eq(schema.usageEvent.userId, owner.id), eq(schema.usageEvent.service, "asr"))); expect(calls).toHaveLength(1);
});
it("historical measured time uses its recorded-day base snapshot, not tomorrow's new free allowance", async () => {
  const { s, ticket } = await recording(1, 12), yesterday = new Date(Date.now() - 86400_000), { rewardDay } = await import("@/lib/services/rewards");
  await db.update(schema.answer).set({ createdAt: yesterday }).where(eq(schema.answer.id, ticket.answerId)); await db.update(schema.quotaHold).set({ day: rewardDay(yesterday) }).where(eq(schema.quotaHold.sessionId, s.id));
  await db.update(schema.user).set({ dailyQuotaMinutes: 1 }).where(eq(schema.user.id, owner.id));
  await quota.reconcileAnswerQuota(ticket.answerId, await decoded(12)); expect((await hold(s.id)).baseSeconds).toBe(0);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 588, baseRemainingSeconds: 60, uncoveredSeconds: 0 });
});
it("an uncovered historical recording blocks new-day practice and keeps its gap after midnight", async () => {
  const { s, ticket } = await recording(1, 12); await db.update(schema.minuteCredit).set({ remainingSeconds: 0 }).where(eq(schema.minuteCredit.id, creditId)); await quota.reconcileAnswerQuota(ticket.answerId, await decoded(12));
  const tomorrow = new Date(Date.now() + 86400_000); await db.update(schema.user).set({ dailyQuotaMinutes: 30 }).where(eq(schema.user.id, owner.id));
  expect(await quota.getQuotaStatus(owner.id, tomorrow)).toMatchObject({ uncoveredSeconds: 11, remainingSeconds: 0 }); expect((await hold(s.id)).usedSeconds).toBe(12);
});
it("corrects an originally valid voucher after expiry without renewing it for a new practice", async () => {
  const { s, ticket } = await recording(1, 12), future = new Date(Date.now() + 4 * 86400_000);
  await quota.reconcileAnswerQuota(ticket.answerId, await decoded(12), future); expect(await quota.getQuotaStatus(owner.id, future)).toMatchObject({ extraSeconds: 0, uncoveredSeconds: 0 });
  const [credit] = await db.select().from(schema.minuteCredit).where(eq(schema.minuteCredit.id, creditId)); expect(credit.remainingSeconds).toBe(588); expect((await hold(s.id)).credits[0].seconds).toBe(12);
});
it("concurrent measurement retries debit a single voucher only once", async () => {
  const { ticket } = await recording(1, 12), measurement = await decoded(12);
  await Promise.all(Array.from({ length: 4 }, () => quota.reconcileAnswerQuota(ticket.answerId, measurement))); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(588);
});
it("deleting the original recording preserves measured consumption and a later day cannot refund it", async () => {
  const { s, ticket } = await recording(1, 12); await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
  await (await import("@/lib/services/deletion")).purgeSession(s.id);
  expect((await hold(s.id)).usedSeconds).toBe(12); expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(588); expect((await quota.getQuotaStatus(owner.id, new Date(Date.now() + 86400_000))).extraSeconds).toBe(588);
  await expect(quota.reconcileAnswerQuota(ticket.answerId, await decoded(12))).rejects.toMatchObject({ status: 404 });
});
it("deleting a record cannot erase its shortfall; releasing another reservation covers it without double charging", async () => {
  await db.update(schema.minuteCredit).set({ totalSeconds: 50, remainingSeconds: 50 }).where(eq(schema.minuteCredit.id, creditId));
  const { s, ticket } = await recording(1, 12), competitor = await practice(); await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
  await (await import("@/lib/services/deletion")).purgeSession(s.id); expect((await quota.getQuotaStatus(owner.id)).uncoveredSeconds).toBe(7);
  await sessions.recordEvent(owner.id, competitor.id, { type: "pause", expectedVersion: 0, eventId: randomUUID() });
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ uncoveredSeconds: 0, extraSeconds: 38 });
});
it("competing actual durations never allocate the same daily base seconds twice", async () => {
  await db.update(schema.user).set({ dailyQuotaMinutes: 1 }).where(eq(schema.user.id, owner.id));
  const first = await recording(1, 37, false), second = await recording(1, 38, false);
  await Promise.all([quota.reconcileAnswerQuota(first.ticket.answerId, await decoded(37)), quota.reconcileAnswerQuota(second.ticket.answerId, await decoded(38))]);
  for (const { s } of [first, second]) await sessions.recordEvent(owner.id, s.id, { type: "pause", expectedVersion: 0, eventId: randomUUID() });
  const rows = await db.select().from(schema.quotaHold).where(eq(schema.quotaHold.userId, owner.id)); expect(rows.reduce((n, h) => n + h.baseSeconds, 0)).toBe(60);
  expect(await quota.getQuotaStatus(owner.id)).toMatchObject({ extraSeconds: 585, uncoveredSeconds: 0 });
});
it("an interrupted required answer cannot complete or unlock a level; a complete replacement can", async () => {
  const [firstLevel] = await db.select().from(schema.level).orderBy(schema.level.chapter, schema.level.order).limit(1);
  const s = await sessions.createSession(owner, { mode: "level", levelId: firstLevel.id, fresh: true }), view = await sessions.getSessionView(owner.id, s.id), slots = (await import("@/lib/sessions/plan")).requiredSlots(view.plan);
  for (const [i, slot] of slots.entries()) {
    const ticket = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId: randomUUID(), planIndex: slot.index, kind: slot.kind, clientDurationMs: 5000, interrupted: i === 0, consentVersion });
    await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, pcmFixture(5));
  }
  expect(await sessions.recordEvent(owner.id, s.id, { type: "finish", eventId: randomUUID() })).toMatchObject({ status: "active", finished: false, missing: [slots[0]] });
  const [before] = await db.select().from(schema.progress).where(and(eq(schema.progress.userId, owner.id), eq(schema.progress.levelId, firstLevel.id))); expect(before.completedAt).toBeNull();
  expect(await db.select().from(schema.rewardLedger).where(eq(schema.rewardLedger.userId, owner.id))).toHaveLength(0);
  const slot = slots[0], replacement = await answers.createUploadTicket(owner.id, { sessionId: s.id, submissionId: randomUUID(), planIndex: slot.index, kind: slot.kind, clientDurationMs: 5000, interrupted: false, consentVersion });
  await answers.receiveAudio(owner.id, replacement.answerId, replacement.ticket, pcmFixture(5));
  expect(await sessions.recordEvent(owner.id, s.id, { type: "finish", eventId: randomUUID() })).toMatchObject({ status: "completed", finished: true });
  const [after] = await db.select().from(schema.progress).where(and(eq(schema.progress.userId, owner.id), eq(schema.progress.levelId, firstLevel.id))); expect(after.completedAt).not.toBeNull();
});
it("upgrades existing settled and active allocations without treating their spent credits as newly available", async () => {
  // Real PostgreSQL execution of the shipped migration against a minimal pre-upgrade schema.
  await db.transaction(async tx => {
    await tx.execute(sql.raw('create schema quota_upgrade_fixture; set local search_path to quota_upgrade_fixture; create table "user" (id text primary key, daily_quota_minutes integer); create table app_setting (key text primary key, value jsonb); create table quota_hold (id text primary key, user_id text, base_seconds integer, credits jsonb, settled boolean);'));
    await tx.execute(sql.raw(`insert into "user" values ('owner',0),('default',null); insert into app_setting values ('limits','{"dailyMinutes":1}'); insert into quota_hold values ('spent','owner',0,'[{"id":"credit","seconds":12}]',true),('active','default',45,'[{"id":"credit","seconds":15}]',false);`));
    await tx.execute(sql.raw(await fs.readFile("db/migrations/0008_measured_quota.sql", "utf8")));
    const rows = await tx.execute<{ id: string; used_seconds: number; base_limit_seconds: number; uncovered_seconds: number }>(sql.raw('select * from quota_hold order by id'));
    expect(rows.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "spent", used_seconds: 12, base_limit_seconds: 0, uncovered_seconds: 0 }), expect.objectContaining({ id: "active", used_seconds: 0, base_limit_seconds: 60 })]));
    await tx.execute(sql.raw('drop schema quota_upgrade_fixture cascade;'));
  });
});
it("interrupted feedback cannot satisfy a learning goal, while its actually recorded time remains in the summary", async () => {
  const [firstLevel] = await db.select().from(schema.level).orderBy(schema.level.chapter, schema.level.order).limit(1);
  const s = await sessions.createSession(owner, { mode: "level", levelId: firstLevel.id, fresh: true }), view = await sessions.getSessionView(owner.id, s.id);
  const summary = (await import("@/lib/services/outcome")).summarize(view.plan, "completed", [
    { id: "partial", planIndex: 0, kind: "main", status: "done", durationMs: 12000, clientDurationMs: 12000, interrupted: true, metrics: { speechSec: 10 } },
    { id: "complete", planIndex: 1, kind: "main", status: "done", durationMs: 10000, clientDurationMs: 10000, interrupted: false, metrics: { speechSec: 8 } },
  ], [{ answerId: "partial", goalMet: true, goalReason: "Synthetic positive", mock: false }, { answerId: "complete", goalMet: false, goalReason: "Synthetic not met", mock: false }]);
  expect(summary.goal.metCount).toBe(0); expect(summary.goal.items[0]).toMatchObject({ evaluated: false, reason: "录音中断，请完整作答后再评价目标" }); expect(summary.durationSec).toBe(22); expect(summary.speechSec).toBe(18);
});
