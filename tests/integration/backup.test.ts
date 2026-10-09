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
