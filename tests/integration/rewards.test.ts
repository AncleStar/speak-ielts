import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
const runDir = path.resolve(`data/verification/rewards-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5546/rewards", BETTER_AUTH_SECRET: "rewards-test-only-secret-000000000000000", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), rewards: typeof import("@/lib/services/rewards"), quota: typeof import("@/lib/quota"), sessions: typeof import("@/lib/services/sessions");
let owner: { id: string; consentAt: Date };
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5546, dbName: "rewards", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); rewards = await import("@/lib/services/rewards"); quota = await import("@/lib/quota"); sessions = await import("@/lib/services/sessions");
  const u = await (await import("@/lib/auth")).createAccount({ email: "rewards@example.test", password: "Rewards-test-only-123!", name: "Rewards tester" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(schema.user).set({ consentAt: owner.consentAt, onboardedAt: new Date(), mustChangePassword: false, dailyQuotaMinutes: 0 }).where(eq(schema.user.id, u.id));
}, 120000);
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);
describe("rewards, consumable quota and growth", () => {
  it("uses UTC+8 boundaries and only grants one check-in under concurrent requests", async () => {
    expect(rewards.rewardDay(new Date("2026-01-01T16:00:00Z"))).toBe("2026-01-02");
    const now = new Date(); const results = await Promise.all(Array.from({ length: 8 }, () => rewards.checkIn(owner.id, now)));
    expect(results.filter(r => !r.duplicate)).toHaveLength(1); expect(await rewards.balance(db, owner.id)).toBe(5);
  });
  it("awards each seven-day milestone once and broken streak keeps points", async () => {
    for (let i = 1; i <= 6; i++) await rewards.checkIn(owner.id, new Date(Date.now() + i * 86400_000));
    const before = await rewards.balance(db, owner.id); expect(before).toBe(55);
    expect((await rewards.checkIn(owner.id, new Date(Date.now() + 8 * 86400_000))).streak).toBe(1);
    expect(await rewards.balance(db, owner.id)).toBe(before + 5);
  });
  it("atomically debits and grants, deduplicates retries, and prevents negative balances", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => rewards.redeemMinutes(owner.id, "redemption-same-001")));
    expect(new Set(responses.map(r => r.id)).size).toBe(1); expect(await rewards.balance(db, owner.id)).toBe(10);
    await expect(rewards.redeemMinutes(owner.id, "redemption-different-002")).rejects.toMatchObject({ code: "insufficient_points" });
    await expect(rewards.adjustPoints(owner.id, owner.id, -100, "test debit", "adjust-test-001")).rejects.toMatchObject({ status: 400 });
    expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(600);
  });
  it("reserves extra time, releases unused time, preserves consumed time after deletion and midnight", async () => {
    const s = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1" });
    const held = (await quota.getQuotaStatus(owner.id)).extraSeconds!; expect(held).toBeLessThan(600);
    const a = await (await import("@/lib/services/answers")).createUploadTicket(owner.id, { sessionId: s.id, planIndex: 0, kind: "main", submissionId: "credit-answer-001", clientDurationMs: 10000 });
    await db.update(schema.answer).set({ status: "done", durationMs: 10000, metrics: { speechSec: 7 }, storageKey: "test-only" }).where(eq(schema.answer.id, a.answerId));
    await db.update(schema.practiceSession).set({ status: "completed", endedAt: new Date() }).where(eq(schema.practiceSession.id, s.id));
    expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(590);
    await (await import("@/lib/services/deletion")).purgeSession(s.id);
    expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(590);
    expect((await quota.getQuotaStatus(owner.id, new Date(Date.now() + 86400_000))).extraSeconds).toBe(590);
    expect((await quota.getQuotaStatus(owner.id, new Date(Date.now() + 8 * 86400_000))).extraSeconds).toBe(0);
  });
  it("serializes competing sessions without double-spending voucher minutes", async () => {
    await db.update(schema.minuteCredit).set({ remainingSeconds: 80 }).where(eq(schema.minuteCredit.userId, owner.id));
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const all = await db.select().from(schema.practiceSession).where(eq(schema.practiceSession.userId, owner.id));
    expect(all).toHaveLength(1);
    await db.update(schema.practiceSession).set({ status: "abandoned" }).where(eq(schema.practiceSession.userId, owner.id));
    expect((await quota.getQuotaStatus(owner.id)).extraSeconds).toBe(80);
    await db.update(schema.user).set({ dailyQuotaMinutes: 1000 }).where(eq(schema.user.id, owner.id));
  });
  it("requires real speech, caps rewards, records review plus retry, and excludes deleted growth", async () => {
    const answers = await import("@/lib/services/answers");
    let source = "", firstId = "";
    for (let i = 0; i < 4; i++) {
      const s = await sessions.createSession(owner, i === 3 ? { mode: "retry", sourceAnswerId: source } : { mode: "practice", questionId: "P1-HOME-1" });
      const a = await answers.createUploadTicket(owner.id, { sessionId: s.id, planIndex: 0, kind: "main", submissionId: `real-practice-${i}`, clientDurationMs: 10000 });
      await db.update(schema.practiceSession).set({ status: "completed", endedAt: new Date() }).where(eq(schema.practiceSession.id, s.id));
      await rewards.rewardCompletedPractice(s.id);
      // Keep fixtures on the application's clock; DB timestamps can be milliseconds ahead.
      await db.update(schema.answer).set({ createdAt: new Date(), durationMs: 10000, metrics: { speechSec: 7 }, storageKey: "test-only", status: "done" }).where(eq(schema.answer.id, a.answerId));
      await Promise.all([rewards.rewardCompletedPractice(s.id), rewards.rewardCompletedPractice(s.id)]);
      if (i === 0) { source = a.answerId; firstId = s.id; await rewards.markReviewed(owner.id, source); }
    }
    const rows = await db.select().from(schema.rewardLedger).where(and(eq(schema.rewardLedger.userId, owner.id), eq(schema.rewardLedger.day, rewards.rewardDay())));
    expect(rows.filter(r => r.kind === "practice")).toHaveLength(2); expect(rows.filter(r => r.kind === "review")).toHaveLength(1);
    expect(rows.filter(r => ["checkin", "practice", "review"].includes(r.kind)).reduce((n, r) => n + r.points, 0)).toBe(30);
    const { getGrowth } = await import("@/lib/services/growth");
    const before = await getGrowth(owner.id); expect(before.monthStats.seconds).toBe(40); expect(before.monthStats.topics).toBe(1);
    expect(before.events.some(e => e.href === `/answers/${source}`)).toBe(true);
    await db.update(schema.practiceSession).set({ deletedAt: new Date() }).where(eq(schema.practiceSession.id, firstId));
    expect((await getGrowth(owner.id)).monthStats.seconds).toBe(30);
  });
  it("blocks exchange during budget exhaustion and does not retroactively reward older sessions", async () => {
    await rewards.adjustPoints(owner.id, owner.id, 100, "test compensation", "adjust-test-002");
    const { setSetting } = await import("@/lib/settings"); await setSetting("budget", { monthlyYuan: 0 });
    try { await expect(rewards.redeemMinutes(owner.id, "budget-redemption-001")).rejects.toMatchObject({ code: "budget_exceeded" }); }
    finally { await setSetting("budget", { monthlyYuan: 100 }); }
    const before = await rewards.balance(db, owner.id);
    await db.update(schema.practiceSession).set({ createdAt: new Date("2020-01-01") }).where(eq(schema.practiceSession.userId, owner.id));
    for (const row of await db.select().from(schema.practiceSession)) await rewards.rewardCompletedPractice(row.id);
    expect(await rewards.balance(db, owner.id)).toBe(before);
  });
});
