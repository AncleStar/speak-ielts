import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
const runDir = path.resolve(`data/verification/round2-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5547/round2", BETTER_AUTH_SECRET: "round2-test-only-secret-000000000000000", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, s: typeof import("@/db/schema"), invites: typeof import("@/lib/services/invites"), reviews: typeof import("@/lib/services/reviews");
let owner: { id: string; consentAt: Date };
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5547, dbName: "round2", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema"); invites = await import("@/lib/services/invites"); reviews = await import("@/lib/services/reviews");
  const u = await (await import("@/lib/auth")).createAccount({ email: "round2@example.test", password: "Round2-test-only-123!", name: "Round 2 tester" });
  owner = { id: u.id, consentAt: new Date() }; await db.update(s.user).set({ consentAt: owner.consentAt, onboardedAt: new Date(), mustChangePassword: false, dailyQuotaMinutes: 1000 }).where(eq(s.user.id, u.id));
}, 120000);
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);
const registration = (code: string, email: string) => invites.registerWithInvite({ code, email, name: "Invited learner", password: "Invitation-test-123!" });
describe("invitation accounts", () => {
  it("consumes once under concurrency and creates a usable ordinary credential", async () => {
    const invite = await invites.createInvite(owner.id, null, 7);
    const r = await Promise.allSettled(Array.from({ length: 4 }, (_,i) => registration(invite.code, `concurrent-${i}@example.test`)));
    expect(r.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const [stored] = await db.select().from(s.signupInvite).where(eq(s.signupInvite.id, invite.id));
    expect(stored.codeHash).not.toBe(invite.code); expect(stored.usedBy).toBeTruthy();
    const [u] = await db.select().from(s.user).where(eq(s.user.id, stored.usedBy!));
    expect(u.role).toBe("user"); expect(u.mustChangePassword).toBe(false); expect(u.emailVerified).toBe(false); expect(u.onboardedAt).toBeNull();
    expect(await (await import("@/lib/auth")).verifyUserPassword(u.id, "Invitation-test-123!")).toBe(true);
  });
  it("enforces expiry, revocation and intended email", async () => {
    const a = await invites.createInvite(owner.id, "specific@example.test", 1);
    await expect(registration(a.code, "wrong@example.test")).rejects.toMatchObject({ code: "invalid_invite" });
    await db.update(s.signupInvite).set({ expiresAt: new Date(0) }).where(eq(s.signupInvite.id, a.id));
    await expect(registration(a.code, "specific@example.test")).rejects.toMatchObject({ code: "invalid_invite" });
    const b = await invites.createInvite(owner.id, null, 1); await invites.revokeInvite(b.id);
    await expect(registration(b.code, "revoked@example.test")).rejects.toMatchObject({ code: "invalid_invite" });
  });
  it("rolls back invite consumption on email collision; normal signup stays disabled", async () => {
    const a = await invites.createInvite(owner.id, null, 7);
    await expect(registration(a.code, "round2@example.test")).rejects.toMatchObject({ code: "email_unavailable" });
    expect((await db.select().from(s.signupInvite).where(eq(s.signupInvite.id, a.id)))[0].usedAt).toBeNull();
    await expect(registration(a.code, "after-collision@example.test")).resolves.toEqual({ ok: true });
    await expect((await import("@/lib/auth")).getAuth().api.signUpEmail({ body: { email: "bypass@example.test", password: "Invitation-test-123!", name: "bypass" } })).rejects.toBeTruthy();
  });
  it("limits repeated attempts without storing raw emails or invite codes in limit keys", async () => {
    for (let i = 0; i < 8; i++) await invites.limitSignup("rate@example.test", "rate-code");
    await expect(invites.limitSignup("rate@example.test", "rate-code")).rejects.toMatchObject({ status: 429 });
    expect((await db.select().from(s.signupLimit)).every(x => !x.key.includes("@") && !x.key.includes("rate-code"))).toBe(true);
  });
  it("removes invite email details when a registered account is deleted", async () => {
    const invite = await invites.createInvite(owner.id, "delete-invited@example.test", 7);
    await registration(invite.code, "delete-invited@example.test");
    const [row] = await db.select().from(s.signupInvite).where(eq(s.signupInvite.id, invite.id));
    await (await import("@/lib/services/deletion")).purgeUser(row.usedBy!);
    const [remaining] = await db.select().from(s.signupInvite).where(eq(s.signupInvite.id, invite.id));
    expect(remaining.email).toBeNull(); expect(remaining.usedBy).toBeNull(); expect(remaining.revokedAt).toBeTruthy();
    await expect(registration(invite.code, "reuse-after-delete@example.test")).rejects.toMatchObject({ code: "invalid_invite" });
  });
});
async function completed(at: Date, status = "done") {
  const session = await (await import("@/lib/services/sessions")).createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const a = await (await import("@/lib/services/answers")).createUploadTicket(owner.id, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 12000 });
  await db.update(s.answer).set({ createdAt: at, status, durationMs: 12000, metrics: { speechSec: 8 }, transcriptMock: true, transcript: "mock demonstration only", storageKey: "test-only" }).where(eq(s.answer.id, a.answerId));
  await db.update(s.practiceSession).set({ status: "completed", createdAt: at, endedAt: at }).where(eq(s.practiceSession.id, session.id));
  return { sessionId: session.id, answerId: a.answerId };
}
describe("review scheduling and source truth", () => {
  it("deduplicates processing, keeps manual reasons, and schedules the next review", async () => {
    const first = await completed(new Date(Date.now() - 8 * 86400000));
    await Promise.all([reviews.scheduleCompletedReview(first.sessionId), reviews.scheduleCompletedReview(first.sessionId)]);
    expect((await db.select().from(s.reviewSchedule))[0].completedCount).toBe(1);
    await (await import("@/lib/services/answers")).addRetryItem(owner.id, first.answerId, "练习补充细节");
    // A real re-practice takes time. Keep this fixture strictly before the next
    // completion: PostgreSQL preserves microseconds while JS Date uses milliseconds.
    await db.update(s.retryItem).set({createdAt:new Date(Date.now()-60_000)}).where(eq(s.retryItem.userId,owner.id));
    const firstQueue = await reviews.getReviewQueue(owner.id);
    expect(firstQueue.due[0].reason).toContain("你标记");
    const second = await completed(new Date()); await reviews.scheduleCompletedReview(second.sessionId);
    const queue = await reviews.getReviewQueue(owner.id); expect(queue.due).toHaveLength(0); expect(queue.upcoming).toHaveLength(1);
    expect(queue.upcoming[0].reason).toContain("间隔 3 天");
    expect((await db.select().from(s.retryItem))[0].doneAt).toBeTruthy();
    const failed = await completed(new Date(), "insufficient"); await reviews.scheduleCompletedReview(failed.sessionId);
    expect((await db.select().from(s.reviewSchedule))[0].completedCount).toBe(2);
    expect((await reviews.getReviewQueue("other-user")).due).toHaveLength(0);
    await db.update(s.practiceSession).set({ deletedAt: new Date() }).where(eq(s.practiceSession.id, second.sessionId));
    expect((await reviews.getReviewQueue(owner.id)).due.every(i => i.sourceAnswerId !== second.answerId)).toBe(true);
  });
  it("does not turn mock feedback into an ability outcome", async () => {
    const { summarize } = await import("@/lib/services/outcome");
    const row = (await db.select().from(s.practiceSession))[0]; const plan = row.plan as import("@/lib/sessions/plan").SessionPlan;
    const result = summarize(plan, "completed", [{ id: "a", planIndex: 0, kind: "main", status: "done", durationMs: 12000, clientDurationMs: 12000, metrics: { speechSec: 8 } }], [{ answerId: "a", goalMet: true, goalReason: "demo", mock: true }]);
    expect(result.goal.met).toBeNull(); expect(result.goal.metCount).toBe(0);
  });
  it("rejects a changed offer before charging and exposes calendar time and signed points", async () => {
    const r = await import("@/lib/services/rewards"); await r.adjustPoints(owner.id, owner.id, 100, "test allocation", "round2-adjust-001");
    await expect(r.redeemMinutes(owner.id, "round2-redemption-001", new Date(), { cost: 1, minutes: 10, days: 7 })).rejects.toMatchObject({ code: "offer_changed" });
    expect(await r.balance(db, owner.id)).toBe(100);
    await r.redeemMinutes(owner.id, "round2-redemption-001", new Date(), { cost: 50, minutes: 10, days: 7 });
    const calendar = await (await import("@/lib/services/growth")).getGrowth(owner.id);
    expect(calendar.events.some(e => e.type === "points" && e.points === -50 && Number.isFinite(Date.parse(e.at)))).toBe(true);
  });
});
