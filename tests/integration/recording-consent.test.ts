import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { pcmFixture } from "../../scripts/make-fixtures";
const runDir = path.resolve(`data/verification/consent-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5554/consent", BETTER_AUTH_SECRET: "consent-test-only-secret-00000000000000", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1" });
vi.mock("@/lib/providers", async original => {
  const mod = await original<typeof import("@/lib/providers")>(); let fake: ReturnType<typeof mod.providers>;
  return { ...mod, providers: () => fake ??= { ...mod.providers(), name: "dashscope", asr: vi.fn(async input => ({ ...await mod.providers().asr(input), mock: false })), llmJson: vi.fn(async input => ({ ...await mod.providers().llmJson(input), mock: false })) } };
});
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), consent: typeof import("@/lib/services/recording-consent"), answers: typeof import("@/lib/services/answers"), sessions: typeof import("@/lib/services/sessions");
let owner: { id: string; consentAt: Date }, n = 0;
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(runDir, "pg"), port: 5554, dbName: "consent", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); consent = await import("@/lib/services/recording-consent"); answers = await import("@/lib/services/answers"); sessions = await import("@/lib/services/sessions");
  await (await import("@/lib/settings")).setSetting("budget", { monthlyYuan: 100 });
}, 120000);
beforeEach(async () => {
  vi.clearAllMocks(); const u = await (await import("@/lib/auth")).createAccount({ email: `consent-${++n}@example.test`, password: "Consent-test-only-123!", name: "Consent test" });
  await db.update(schema.user).set({ mustChangePassword: false, dailyQuotaMinutes: 1000 }).where(eq(schema.user.id, u.id));
  await consent.grantRecordingConsent(u.id, { targetBand: "7", selfLevel: "intermediate" }); owner = { id: u.id, consentAt: new Date() };
});
afterEach(async () => { await consent.withdrawRecordingConsent(owner.id); });
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await pg?.stop(); }, 30000);
async function ticket() {
  const s = await sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const input = { sessionId: s.id, planIndex: 0, kind: "main" as const, submissionId: crypto.randomUUID(), clientDurationMs: 6000 };
  return { input, ...await answers.createUploadTicket(owner.id, input) };
}
it("invalidates old tickets permanently and ignores a stale cached user's consent", async () => {
  const t = await ticket(), first = await consent.recordingConsent(owner.id);
  const withdrawn = await consent.withdrawRecordingConsent(owner.id);
  expect(withdrawn.version).toBe(first.version + 1); expect(await consent.withdrawRecordingConsent(owner.id)).toEqual(withdrawn);
  await expect(sessions.createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true })).rejects.toMatchObject({ code: "consent_required" });
  await expect(answers.receiveAudio(owner.id, t.answerId, t.ticket, pcmFixture(6))).rejects.toMatchObject({ code: "consent_required" });
  await expect(answers.submitAnswer(owner.id, t.answerId)).rejects.toMatchObject({ code: "consent_required" });
  const granted = await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "advanced" });
  expect(granted.version).toBe(withdrawn.version + 1); expect(await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "advanced" })).toEqual(granted);
  await expect(answers.receiveAudio(owner.id, t.answerId, t.ticket, pcmFixture(6))).rejects.toMatchObject({ code: "invalid_ticket" });
  await expect(answers.createUploadTicket(owner.id, t.input)).rejects.toMatchObject({ code: "consent_required" });
  await expect(answers.createUploadTicket(owner.id, { ...(await ticket()).input, consentVersion: first.version })).rejects.toMatchObject({ code: "consent_required" });
  expect(await (await import("@/lib/services/admin")).trialMetrics()).toMatchObject({ uploadSuccessRate: 0, processFailRate: null });
});
it("pauses a queued answer without new provider calls, retains audio and releases active reservations", async () => {
  const t = await ticket(); await answers.receiveAudio(owner.id, t.answerId, t.ticket, pcmFixture(6)); await answers.submitAnswer(owner.id, t.answerId);
  await consent.withdrawRecordingConsent(owner.id);
  const { processAnswer } = await import("@/lib/jobs/process-answer"); expect(await processAnswer({ answerId: t.answerId }, { finalAttempt: true })).toEqual({ skipped: "consent_wait" });
  const p = (await import("@/lib/providers")).providers(); expect(p.asr).not.toHaveBeenCalled(); expect(p.llmJson).not.toHaveBeenCalled();
  const detail = await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, t.answerId); expect(detail.answer.hasAudio).toBe(true); expect(detail.answer.processingStage).toBe("consent_wait");
  const st = await sessions.getOwnedSession(owner.id, t.input.sessionId); expect(st.status).toBe("abandoned"); expect(st.interruptReason).toBe("consent_withdrawn");
  expect((await (await import("@/lib/quota")).getQuotaStatus(owner.id)).reservedSeconds).toBe(0);
  await expect(answers.retryProcessing(owner.id, t.answerId)).rejects.toMatchObject({ code: "consent_required" });
  await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "intermediate" });
  expect(await processAnswer({ answerId: t.answerId }, { finalAttempt: true })).toEqual({ skipped: "consent_wait" });
  await answers.retryProcessing(owner.id, t.answerId); expect(await processAnswer({ answerId: t.answerId }, { finalAttempt: true })).toEqual({ status: "done" });
  expect(p.asr).toHaveBeenCalledTimes(1); expect(p.llmJson).toHaveBeenCalledTimes(1);
});
it("stops after an ASR already in flight, accounts for that call and reuses its transcript after manual retry", async () => {
  const t = await ticket(); await answers.receiveAudio(owner.id, t.answerId, t.ticket, pcmFixture(6));
  const p = (await import("@/lib/providers")).providers(), original = vi.mocked(p.asr).getMockImplementation()!;
  vi.mocked(p.asr).mockImplementationOnce(async input => { const result = await original(input); await consent.withdrawRecordingConsent(owner.id); await consent.grantRecordingConsent(owner.id, { targetBand: "7", selfLevel: "advanced" }); return result; });
  const { processAnswer } = await import("@/lib/jobs/process-answer"); expect(await processAnswer({ answerId: t.answerId }, { finalAttempt: true })).toEqual({ status: "consent_wait" });
  const detail = await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, t.answerId); expect(detail.answer.transcript).toBeTruthy(); expect(p.llmJson).not.toHaveBeenCalled();
  const usage = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner.id)); expect(usage).toHaveLength(1); expect(usage[0].ok).toBe(true); expect(usage[0].costYuan).toBeGreaterThan(0);
  await answers.retryProcessing(owner.id, t.answerId); expect(await processAnswer({ answerId: t.answerId }, { finalAttempt: true })).toEqual({ status: "done" });
  expect(p.asr).toHaveBeenCalledTimes(1);
  expect((await answers.getAnswerDetail({ id: owner.id, isAdmin: false }, t.answerId)).answer.transcript).toBe(detail.answer.transcript); expect(p.llmJson).toHaveBeenCalledTimes(1);
});
it("releases a budget reservation when consent changes before provider dispatch", async () => {
  const prior = await consent.recordingConsent(owner.id), provider = vi.fn(async () => ({ model: "synthetic-test", latencyMs: 0 }));
  const { billableCall } = await import("@/lib/usage");
  await expect(billableCall({ service: "asr", model: "synthetic-test", mock: false, userId: owner.id, jobRef: "consent-test:pre-dispatch", estimate: { seconds: 6 }, beforeRun: async () => { await consent.withdrawRecordingConsent(owner.id); await consent.assertRecordingConsent(owner.id, prior.version); }, run: provider, units: () => ({ seconds: 6 }) })).rejects.toMatchObject({ code: "consent_required" });
  expect(provider).not.toHaveBeenCalled(); const [usage] = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner.id)); expect(usage.costYuan).toBe(0); expect(usage.units).toMatchObject({ seconds: 0, cancelledBeforeDispatch: true, pending: false, cancelledEstimate: { seconds: 6 } });
  const account = await (await import("@/lib/ai/account")).getAiAccount(owner.id); expect(account.rows).toHaveLength(1); expect(account.totals[0]).toMatchObject({ calls: 0, seconds: 0, cost: 0 });
});
