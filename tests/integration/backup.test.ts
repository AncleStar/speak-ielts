import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createBackup, inspectBackup, restoreBackup } from "@/lib/backup";
import { pcmFixture } from "../../scripts/make-fixtures";

const root = path.resolve(`data/verification/backup-${Date.now()}`), sourceUrl = "postgres://postgres:postgres@127.0.0.1:5552/backup_source";
const restoreUrl = "postgres://postgres:postgres@127.0.0.1:5552/backup_restored", emptyUrl = "postgres://postgres:postgres@127.0.0.1:5552/backup_empty";
Object.assign(process.env, { DATABASE_URL: sourceUrl, BETTER_AUTH_SECRET: "backup-test-only-secret-000000000000000", USER_API_KEY_SECRET: "", BETTER_AUTH_URL: "http://localhost:3100",
  AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"),
  CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1", LOCAL_APP_INSTANCE: "backup-test" });
let server: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, s: typeof import("@/db/schema"), lab: typeof import("@/lib/services/thoughts"), deletion: typeof import("@/lib/services/deletion");
let ownerId = "", removedUserId = "", keptThoughtId = "", removedThoughtId = "", keptWordId = "", removedWordId = "", keptAnswerId = "", removedSessionId = "", inviteId = "", bundle = "";
const key = "test_key_backup_personal_only", audio = pcmFixture(6);
const options = () => ({ databaseUrl: sourceUrl, dataDirectory: root, storageDirectory: path.join(root, "storage"), backupDirectory: path.join(root, "backups"), storageDriver: "local" as const });
const restoreOptions = () => ({ bundle, databaseUrl: restoreUrl, dataDirectory: path.join(root, "restored"), currentDatabaseUrl: sourceUrl,
  currentDataDirectory: root, currentStorageDirectory: path.join(root, "storage"), latestDeletionLog: path.join(root, "deletion-log.jsonl") });
async function query(url: string, statement: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  try { await client.connect(); return await client.query(statement, params); } finally { await client.end(); }
}
async function createOwner(email: string) {
  const u = await (await import("@/lib/auth")).createAccount({ email, password: "Backup-test-only-123!", name: "Backup tester" });
  await db.update(s.user).set({ mustChangePassword: false, consentAt: new Date(), onboardedAt: new Date(), dailyQuotaMinutes: 1000 }).where(eq(s.user.id, u.id)); return u.id;
}
beforeAll(async () => {
  server = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5552, dbName: "backup_source", quiet: true });
  await server.createDatabase("backup_restored"); await server.createDatabase("backup_empty");
  await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema"); lab = await import("@/lib/services/thoughts"); deletion = await import("@/lib/services/deletion");
  ownerId = await createOwner("backup-owner@example.test"); removedUserId = await createOwner("backup-removed@example.test");
  const idea = () => lab.generateThought(ownerId, { sourceText: "I think students should gain practical experience.", requestId: crypto.randomUUID() });
  const kept = await idea(), removed = await idea(); keptThoughtId = kept.id; removedThoughtId = removed.id;
  await lab.enrollThought(ownerId, kept.id, 0); await lab.enrollThought(ownerId, removed.id, 0);
  await lab.recordThoughtPractice(ownerId, kept.id, { action: "practice", revision: 0, requestId: crypto.randomUUID(), outcome: "remembered", recalledText: "Students should learn by doing.", durationSeconds: 3 });
  await lab.saveThoughtVocabulary(ownerId, { thoughtId: kept.id, revision: 0, indices: [0, 1] });
  const words = await lab.listVocabulary(ownerId); keptWordId = words.items[0].id; removedWordId = words.items[1].id;
  const sessions = await import("@/lib/services/sessions"), answers = await import("@/lib/services/answers");
  for (const [i, questionId] of ["P1-HOME-1", "P1-HOME-2"].entries()) {
    const session = await sessions.createSession({ id: ownerId, consentAt: new Date() }, { mode: "practice", questionId, fresh: true });
    const ticket = await answers.createUploadTicket(ownerId, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 6000 });
    await answers.receiveAudio(ownerId, ticket.answerId, ticket.ticket, audio);
    await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
    if (i === 0) keptAnswerId = ticket.answerId; else removedSessionId = session.id;
  }
  await (await import("@/lib/ai/credentials")).saveAiConfig(ownerId, { mode: "personal", asrModel: "qwen3-asr-flash-2026-02-10", llmModel: "qwen-flash", monthlyBudgetYuan: 20, consent: true, apiKey: key });
  await (await import("@/lib/services/rewards")).checkIn(ownerId);
  await db.insert(s.session).values({ id: crypto.randomUUID(), token: "backup-test-session-only", userId: ownerId, expiresAt: new Date(Date.now() + 86400_000) });
  const [invite] = await db.insert(s.signupInvite).values({ codeHash: "backup-test-invite-only", createdBy: ownerId, expiresAt: new Date(Date.now() + 86400_000) }).returning(); inviteId = invite.id;
  await deletion.appendDeletionLog({ id: "old-backup-intent", kind: "vocabulary", targetId: crypto.randomUUID(), userId: ownerId, at: new Date().toISOString() });
}, 120000);
afterAll(async () => { await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb(); await server?.stop(); }, 30000);

it("creates a real pg_dump bundle containing audio, material, review, usage and encrypted configuration", async () => {
  const saved = await createBackup(options()); bundle = saved.directory;
  const inspected = await inspectBackup(bundle);
  expect(inspected.manifest.files.some(f => f.path.startsWith("storage/recordings/"))).toBe(true);
  expect(saved.files).toBeGreaterThan(2); expect((await fs.readFile(path.join(bundle, "database.dump"))).subarray(0, 5).toString()).toBe("PGDMP");
  expect((await fs.readdir(path.join(root, "backups"))).some(name => name.endsWith(".partial"))).toBe(false);
  expect(JSON.stringify(inspected.manifest)).not.toContain(key); expect(JSON.stringify(inspected.manifest)).not.toContain(sourceUrl);
});

it("restores the complete archive to a new database and replays newer deletion intents without changing the source", async () => {
  await lab.deleteThought(ownerId, removedThoughtId); await lab.deleteVocabulary(ownerId, removedWordId);
  await deletion.deleteSession(ownerId, removedSessionId, ownerId); await deletion.deleteUserAccount(removedUserId, removedUserId);
  const sourceAccount = (await db.select().from(s.userAiConfig).where(eq(s.userAiConfig.userId, ownerId)))[0];
  const sourceAnswer = (await db.select().from(s.answer).where(eq(s.answer.id, keptAnswerId)))[0];
  const originalAudio = await fs.readFile(path.join(root, "storage", sourceAnswer.storageKey!));
  const restored = await restoreBackup(restoreOptions()); expect(restored.deletionEntries).toBe(5);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM personal_thought WHERE id=$1", [keptThoughtId])).rows[0].n).toBe(1);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM personal_thought WHERE id=$1", [removedThoughtId])).rows[0].n).toBe(0);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM vocabulary_entry WHERE id=$1", [keptWordId])).rows[0].n).toBe(1);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM vocabulary_entry WHERE id=$1", [removedWordId])).rows[0].n).toBe(0);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM practice_session WHERE id=$1", [removedSessionId])).rows[0].n).toBe(0);
  expect((await query(restoreUrl, 'SELECT count(*)::int AS n FROM "user" WHERE id=$1', [removedUserId])).rows[0].n).toBe(0);
  const restoredAnswer = (await query(restoreUrl, "SELECT * FROM answer WHERE id=$1", [keptAnswerId])).rows[0];
  expect(restoredAnswer.transcript).toBe(sourceAnswer.transcript); expect(restoredAnswer.status).toBe("done");
  expect(await fs.readFile(path.join(restored.directory, "storage", restoredAnswer.storage_key))).toEqual(originalAudio);
  const restoredConfig = (await query(restoreUrl, "SELECT * FROM user_ai_config WHERE user_id=$1", [ownerId])).rows[0];
  expect(restoredConfig.key_ciphertext).toBe(sourceAccount.keyCiphertext); expect(restoredConfig.monthly_budget_yuan).toBe(20);
  expect((await import("@/lib/ai/credentials")).decryptApiKey(ownerId, restoredConfig.key_ciphertext)).toBe(key);
  expect((await query(restoreUrl, "SELECT completed_count FROM thought_review WHERE thought_id=$1", [keptThoughtId])).rows[0].completed_count).toBe(1);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM thought_practice WHERE thought_id=$1", [keptThoughtId])).rows[0].n).toBe(1);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM usage_event")).rows[0].n).toBeGreaterThan(0);
  expect((await query(restoreUrl, "SELECT sum(points)::int AS n FROM reward_ledger WHERE user_id=$1", [ownerId])).rows[0].n).toBe(5);
  expect((await query(restoreUrl, 'SELECT count(*)::int AS n FROM "session"')).rows[0].n).toBe(0);
  expect((await query(restoreUrl, "SELECT revoked_at FROM signup_invite WHERE id=$1", [inviteId])).rows[0].revoked_at).toBeTruthy();
  const report = JSON.parse(await fs.readFile(path.join(restored.directory, "restore-complete.json"), "utf8"));
  expect(report.deletions).toMatchObject({ entries: 5, sessions: 1, users: 1, thoughts: 1, vocabulary: 1 }); expect(report.servicesStarted).toBe(false);
  expect(report.oldPasswordsDisabled).toBe(true); expect(report.openingReviewRequired).toBe(true);
  expect((await query(restoreUrl, "SELECT password FROM account WHERE user_id=$1", [ownerId])).rows[0].password).toBeNull();
  expect((await query(restoreUrl, "SELECT value FROM app_setting WHERE key='pauseNewSessions'")).rows[0].value).toBe(true);
  expect(await fs.stat(path.join(restored.directory, "restore-review-pending.json"))).toBeTruthy();
  expect((await query(sourceUrl, 'SELECT count(*)::int AS n FROM "session"')).rows[0].n).toBe(1);
  expect((await query(sourceUrl, "SELECT revoked_at FROM signup_invite WHERE id=$1", [inviteId])).rows[0].revoked_at).toBeNull();
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ realPgDumpRestore: true, audioBytesVerified: true, personalKeyDecryptVerified: true, laterDeletionReplay: report.deletions,
    sourceUnaffected: true, authenticationReset: true, servicesStarted: false, externalApiCalls: 0 }, null, 2));
}, 120000);

it("rejects the current database, occupied databases and existing data directories before writing", async () => {
  const opts = restoreOptions();
  await expect(restoreBackup({ ...opts, databaseUrl: sourceUrl })).rejects.toThrow("禁止覆盖原库");
  await expect(restoreBackup({ ...opts, databaseUrl: emptyUrl, dataDirectory: root })).rejects.toThrow("不能覆盖");
  await expect(restoreBackup(opts)).rejects.toThrow("尚不存在");
  const rejected = path.join(root, "nonempty-target");
  await expect(restoreBackup({ ...opts, dataDirectory: rejected })).rejects.toThrow("不是空库");
  expect(await fs.stat(rejected).catch(() => null)).toBeNull();
});

it("refuses missing or corrupt latest journals instead of restoring deleted personal data", async () => {
  const target = path.join(root, "journal-target"), latest = path.join(root, "broken-log.jsonl");
  await expect(restoreBackup({ ...restoreOptions(), databaseUrl: emptyUrl, dataDirectory: target, latestDeletionLog: latest })).rejects.toThrow("最新删除日志");
  await fs.writeFile(latest, "invalid-json\n");
  await expect(restoreBackup({ ...restoreOptions(), databaseUrl: emptyUrl, dataDirectory: target, latestDeletionLog: latest })).rejects.toThrow("损坏");
  expect(await fs.stat(target).catch(() => null)).toBeNull();
  expect((await query(emptyUrl, "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n).toBe(0);
});

it("checks content hashes and path boundaries before executing a restore", async () => {
  const tampered = path.join(root, "tampered"); await fs.cp(bundle, tampered, { recursive: true });
  await fs.appendFile(path.join(tampered, "database.dump"), "tampered");
  await expect(inspectBackup(tampered)).rejects.toThrow("完整性");
  const escaped = path.join(root, "escaped"); await fs.cp(bundle, escaped, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(escaped, "manifest.json"), "utf8")); manifest.files[0].path = "storage/../database.dump";
  await fs.writeFile(path.join(escaped, "manifest.json"), JSON.stringify(manifest)); await expect(inspectBackup(escaped)).rejects.toThrow("无效文件路径");
});

it("does not publish an incomplete backup when audio or the journal is missing or damaged", async () => {
  const [row] = await db.select().from(s.answer).where(eq(s.answer.id, keptAnswerId));
  await db.update(s.answer).set({ storageKey: "recordings/missing.wav" }).where(eq(s.answer.id, keptAnswerId));
  try { await expect(createBackup(options())).rejects.toThrow("缺失的音频"); }
  finally { await db.update(s.answer).set({ storageKey: row.storageKey }).where(eq(s.answer.id, keptAnswerId)); }
  const badData = path.join(root, "bad-data"); await fs.mkdir(badData); await fs.writeFile(path.join(badData, "deletion-log.jsonl"), "broken\n");
  await expect(createBackup({ ...options(), dataDirectory: badData })).rejects.toThrow("损坏");
  expect((await fs.readdir(path.join(root, "backups"))).filter(name => name.endsWith(".partial"))).toHaveLength(0);
  await expect(createBackup({ ...options(), storageDriver: "oss" })).rejects.toThrow("OSS");
  await expect(createBackup({ ...options(), backupDirectory: path.join(root, "storage", "backups") })).rejects.toThrow("相互包含");
});

it("requires complete permissions and cost review, then rotates credentials and carries later fees without changing source budgets", async () => {
  const review = await import("@/lib/restore-review"), directory = path.join(root, "restored"), ledger = path.join(root, "latest-costs.json");
  await db.insert(s.usageEvent).values({ userId: ownerId, service: "asr", model: "synthetic-no-dispatch", billingSource: "personal", costYuan: 2.2, mock: false, units: { seconds: 10000 } });
  await db.insert(s.usageEvent).values({ service: "tts", model: "synthetic-no-dispatch", billingSource: "platform", costYuan: 0.5, mock: false, units: { chars: 1000 } });
  await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb();
  await review.exportRecoveryLedger(sourceUrl, ledger);
  expect(await fs.readFile(ledger, "utf8")).not.toContain(key);
  await expect(review.prepareRestoreReview(sourceUrl, directory, ledger)).rejects.toThrow("不匹配");
  const prepared = await review.prepareRestoreReview(restoreUrl, directory, ledger);
  const input = JSON.parse(await fs.readFile(prepared.file, "utf8"));
  expect(input.costs.find((cost: { source: string }) => cost.source === "personal").minimumKnownYuan).toBe(2.2);
  await expect(review.approveRestoreReview(restoreUrl, directory, prepared.file)).rejects.toThrow();
  input.checks = { accountsAndPermissions: true, costsIncludingPendingCalls: true, deploymentAndSecrets: true }; input.evidence = "Synthetic stopped-source ledger; no real provider calls";
  input.accounts[0].access = "admin";
  input.costs.forEach((cost: { totalYuan: number; minimumKnownYuan: number }) => { cost.totalYuan = cost.minimumKnownYuan; });
  const valid = structuredClone(input);
  for (const accounts of [[], [input.accounts[0], input.accounts[0]], [{ ...input.accounts[0], access: "user" }]]) {
    await fs.writeFile(prepared.file, JSON.stringify({ ...valid, accounts }));
    await expect(review.approveRestoreReview(restoreUrl, directory, prepared.file)).rejects.toThrow();
  }
  const floorFile = path.join(directory, "restore-cost-floor.json"), floorBytes = await fs.readFile(floorFile), floor = JSON.parse(floorBytes.toString());
  floor.totals.forEach((cost: { totalYuan: number }) => { cost.totalYuan = 0; });
  await fs.writeFile(floorFile, JSON.stringify(floor)); await fs.writeFile(prepared.file, JSON.stringify(valid));
  await expect(review.approveRestoreReview(restoreUrl, directory, prepared.file)).rejects.toThrow("被修改");
  await fs.writeFile(floorFile, floorBytes);
  const held = new pg.Client({ connectionString: restoreUrl }); await held.connect();
  try { await expect(review.approveRestoreReview(restoreUrl, directory, prepared.file)).rejects.toThrow("停止"); }
  finally { await held.end(); }
  expect((await query(restoreUrl, "SELECT value FROM app_setting WHERE key='recovery:opening-review'")).rows[0].value.status).toBe("pending");
  expect(await fs.stat(path.join(directory, "restore-credentials.json")).catch(() => null)).toBeNull();
  input.costs.find((cost: { source: string }) => cost.source === "personal").totalYuan = 0;
  await fs.writeFile(prepared.file, JSON.stringify(input));
  await expect(review.approveRestoreReview(restoreUrl, directory, prepared.file)).rejects.toThrow("低于");
  Object.assign(input, valid);
  await fs.writeFile(prepared.file, JSON.stringify(input));
  const approved = await review.approveRestoreReview(restoreUrl, directory, prepared.file);
  expect((await query(restoreUrl, "SELECT sum(cost_yuan)::float8 AS cost FROM usage_event WHERE billing_source='personal' AND mock=false")).rows[0].cost).toBe(2.2);
  expect((await query(restoreUrl, "SELECT sum(cost_yuan)::float8 AS cost FROM usage_event WHERE billing_source='platform' AND mock=false")).rows[0].cost).toBe(0.5);
  expect((await query(restoreUrl, "SELECT value FROM app_setting WHERE key='pauseNewSessions'")).rows[0].value).toBe(true);
  expect((await query(restoreUrl, "SELECT key_ciphertext,monthly_budget_yuan FROM user_ai_config WHERE user_id=$1", [ownerId])).rows[0]).toMatchObject({ key_ciphertext: null, monthly_budget_yuan: 20 });
  const credentials = JSON.parse(await fs.readFile(approved.credentialsFile, "utf8"));
  const hash = (await query(restoreUrl, "SELECT password FROM account WHERE user_id=$1", [ownerId])).rows[0].password;
  const { verifyPassword } = await import("better-auth/crypto");
  expect(await verifyPassword({ hash, password: credentials.accounts[0].temporaryPassword })).toBe(true);
  expect(await verifyPassword({ hash, password: "Backup-test-only-123!" })).toBe(false);
  expect((await query(restoreUrl, 'SELECT must_change_password FROM "user" WHERE id=$1', [ownerId])).rows[0].must_change_password).toBe(true);
  expect((await query(sourceUrl, "SELECT key_ciphertext FROM user_ai_config WHERE user_id=$1", [ownerId])).rows[0].key_ciphertext).toBeTruthy();
  expect((await query(sourceUrl, "SELECT value FROM app_setting WHERE key='pauseNewSessions'")).rows[0].value).toBe(false);
  expect((await review.approveRestoreReview(restoreUrl, directory, prepared.file)).alreadyApproved).toBe(true);
  expect((await query(restoreUrl, "SELECT count(*)::int AS n FROM usage_event WHERE service='recovery-adjustment'")).rows[0].n).toBe(2);
  expect(await fs.stat(path.join(directory, "restore-review-pending.json")).catch(() => null)).toBeNull();
}, 60000);
