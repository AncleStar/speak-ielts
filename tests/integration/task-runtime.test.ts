import path from "node:path";
import { spawn } from "node:child_process";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
const root = path.resolve(`data/verification/task-runtime-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5560/tasks", BETTER_AUTH_SECRET: "task-runtime-synthetic-auth-secret-000", USER_API_KEY_SECRET: "", DASHSCOPE_API_KEY: "", AI_PROVIDER: "mock", TTS_PROVIDER: "kokoro", LOCAL_TTS_SPEED: "0.95", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), LOCAL_APP_INSTANCE: "task-fixture", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true" });
let embedded: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, schema: typeof import("@/db/schema"), runtime: typeof import("@/lib/task-runtime"), queue: typeof import("@/lib/queue"), reset: typeof import("@/lib/env").resetEnvCache;
beforeAll(async () => {
 embedded = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5560, dbName: "tasks", quiet: true }); await (await import("../../scripts/migrate")).runMigrations(); await (await import("../../scripts/seed")).seed({ tts: false, quiet: true });
 ({ db } = await import("@/lib/db")); schema = await import("@/db/schema"); runtime = await import("@/lib/task-runtime"); queue = await import("@/lib/queue"); reset = (await import("@/lib/env")).resetEnvCache;
});
afterEach(async () => { vi.restoreAllMocks(); await queue.stopBoss(); process.env.LOCAL_TTS_SPEED = "0.95"; reset(); if ((await db.execute(sql`select to_regclass('pgboss.job') as name`)).rows[0].name) await db.execute(sql`delete from pgboss.job`); await db.delete(schema.appSetting).where(eq(schema.appSetting.key, runtime.TASK_RUNTIME_KEY)); await (await import("@/lib/settings")).setSetting("pauseNewSessions", false); });
afterAll(async () => { await queue.stopBoss(); await (await import("@/lib/db")).closeDb(); await embedded.stop(); });
it("first publisher binds the deployment, wrong configuration cannot acquire jobs or bootstrap queues", async () => {
 await runtime.ensureTaskRuntime(); const name = queue.taskQueueName(queue.QUEUES.processAnswer), boss = await queue.getBoss(), id = await queue.enqueue(queue.QUEUES.processAnswer, { answerId: "synthetic-only" });
 await boss.createQueue(queue.QUEUES.processAnswer); expect(await boss.fetch(queue.QUEUES.processAnswer)).toEqual([]);
 process.env.LOCAL_TTS_SPEED = "0.85"; reset(); expect(queue.taskQueueName(queue.QUEUES.processAnswer)).not.toBe(name);
 await expect(queue.getBoss({ worker: true })).rejects.toMatchObject({ code: "task_runtime_mismatch" }); await expect(queue.enqueue(queue.QUEUES.processAnswer, { answerId: "wrong" })).rejects.toMatchObject({ code: "task_runtime_mismatch" });
 let effects = 0; await expect(runtime.withTaskRuntime(async () => { effects++; }, false)).rejects.toMatchObject({ code: "task_runtime_mismatch" }); expect(effects).toBe(0);
 process.env.LOCAL_TTS_SPEED = "0.95"; reset(); const jobs = await boss.fetch(queue.taskQueueName(queue.QUEUES.processAnswer)); expect(jobs).toHaveLength(1); expect(jobs[0].id).toBe(id);
 await runtime.withTaskRuntime(async () => { expect(runtime.taskPayload(queue.QUEUES.processAnswer, jobs[0].data as never)).toEqual({ answerId: "synthetic-only" }); });
});
it("protocol and malformed destructive payloads are rejected before their operations", async () => {
 await runtime.withTaskRuntime(async () => {
   const valid = runtime.taskEnvelope(queue.QUEUES.cleanupUser, { userId: "synthetic-user" }); expect(runtime.taskPayload(queue.QUEUES.cleanupUser, valid)).toEqual({ userId: "synthetic-user" });
   for (const bad of [{ ...valid, protocol: 2 }, { ...valid, runtime: "other" }, { ...valid, payload: {} }, { ...valid, payload: { userId: 1 } }]) expect(() => runtime.taskPayload(queue.QUEUES.cleanupUser, bad as never)).toThrow();
 });
});
it("lost lease connection cannot continue SQL or publication on an unrelated pool", async () => {
 const controller = new pg.Client({ connectionString: process.env.DATABASE_URL }); await controller.connect();
 try { await runtime.withTaskRuntime(async () => {
   const [{ id }] = await db.select({ id: sql<number>`pg_backend_pid()` }).from(schema.appSetting).limit(1);
   await controller.query("select pg_terminate_backend($1)", [id]); await new Promise(resolve => setTimeout(resolve, 50));
   await expect(async () => db.insert(schema.appSetting).values({ key: "synthetic-illegal-write", value: true })).rejects.toThrow();
 }); expect((await controller.query("select count(*)::int as n from app_setting where key='synthetic-illegal-write'")).rows[0].n).toBe(0); } finally { await controller.end(); }
});
it("a query captured during a task cannot execute after that task releases its lease", async () => {
 const deferred = await runtime.withTaskRuntime(async () => ({ query: db.insert(schema.appSetting).values({ key: "synthetic-escaped-query", value: true }) }));
 await expect(async () => deferred.query).rejects.toThrow();
 expect(await db.select().from(schema.appSetting).where(eq(schema.appSetting.key, "synthetic-escaped-query"))).toHaveLength(0);
});
it("activation waits for the actual reader session, then rejects the former runtime", async () => {
 await runtime.ensureTaskRuntime(); await (await import("@/lib/settings")).setSetting("pauseNewSessions", true);
 let release!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), hold = runtime.withTaskRuntime(async () => { entered(); await gate; });
 await started;
 const child = spawn(process.execPath, ["--import", "tsx", "scripts/queue-runtime.ts", "--activate", "--confirm-stopped"], { env: { ...process.env, LOCAL_TTS_SPEED: "0.85" }, windowsHide: true, stdio: "ignore" });
 let finished = false; const done = new Promise<number | null>(resolve => child.once("exit", code => { finished = true; resolve(code); }));
 try { await new Promise(resolve => setTimeout(resolve, 500)); expect(finished).toBe(false); } finally { release(); await hold; }
 expect(await done).toBe(0);
 expect((await runtime.taskRuntimeStatus()).matches).toBe(false); await expect(runtime.withTaskRuntime(async () => {})).rejects.toMatchObject({ code: "task_runtime_mismatch" });
}, 20000);

it("ordinary manager restart keeps queue names stable, and activation requires pause and a current review", async () => {
 await runtime.ensureTaskRuntime(); const previous = await runtime.taskRuntimeRecord(), name = queue.taskQueueName(queue.QUEUES.tts);
 process.env.LOCAL_APP_INSTANCE = "restarted-manager"; reset(); expect(queue.taskQueueName(queue.QUEUES.tts)).toBe(name); expect((await runtime.taskRuntimeStatus()).matches).toBe(true);
 await expect(runtime.activateTaskRuntime(previous!.id!)).rejects.toMatchObject({ code: "pause_required" });
 await (await import("@/lib/settings")).setSetting("pauseNewSessions", true);
 await expect(runtime.activateTaskRuntime("outdated-review")).rejects.toMatchObject({ code: "task_runtime_changed" }); expect((await runtime.taskRuntimeStatus()).matches).toBe(true);
});

async function legacyAsset(text: string) {
 const assetId = (await (await import("@/lib/services/tts")).ensureTtsAssets([text], { enqueueMissing: false })).get(text)!;
 const boss = await queue.getBoss(); await boss.createQueue(queue.QUEUES.tts);
 const id = (await boss.send(queue.QUEUES.tts, { assetId }, { retryLimit: 2, priority: 7, startAfter: 30 }))!;
 return { boss, id, assetId };
}
it("reviewed legacy transfer is atomic, preserves identity/deadline, and leaves malformed or active work intact", async () => {
 const { boss, id, assetId } = await legacyAsset("Legacy runtime safe transfer"); const original = await boss.getJobById(queue.QUEUES.tts, id);
 const malformed = (await boss.send(queue.QUEUES.tts, { assetId: 123 }))!, active = (await boss.send(queue.QUEUES.tts, { assetId }))!;
 await db.execute(sql`update pgboss.job set state='active' where name=${queue.QUEUES.tts} and id=${active}`);
 const recovery = await import("@/lib/task-recovery"); await expect(recovery.recoverLegacyTasks(true)).rejects.toMatchObject({ code: "pause_required" });
 await (await import("@/lib/settings")).setSetting("pauseNewSessions", true); await expect(recovery.recoverLegacyTasks(false)).rejects.toMatchObject({ code: "legacy_review_required" });
 const result = await recovery.recoverLegacyTasks(true); expect(result.moved).toBe(1); expect(result.retained).toBe(1);
 expect((await boss.getJobById(queue.QUEUES.tts, id))!.state).toBe("cancelled");
 const moved = (await boss.getJobById(queue.taskQueueName(queue.QUEUES.tts), id))!;
 expect(moved).toMatchObject({ id, state: "created", priority: 7, retryLimit: 2, startAfter: original!.startAfter, keepUntil: original!.keepUntil, createdOn: original!.createdOn });
 await runtime.withTaskRuntime(async () => expect(runtime.taskPayload(queue.QUEUES.tts, moved.data as never)).toEqual({ assetId }));
 expect((await boss.getJobById(queue.QUEUES.tts, malformed))!.state).toBe("created"); expect((await boss.getJobById(queue.QUEUES.tts, active))!.state).toBe("active");
 expect((await recovery.recoverLegacyTasks(true)).moved).toBe(0);
});
it("target publication failure rolls back transfer, and a conflicting target is retained for review", async () => {
 const { boss, id, assetId } = await legacyAsset("Legacy rollback and target conflict"); await (await import("@/lib/settings")).setSetting("pauseNewSessions", true);
 const recovery = await import("@/lib/task-recovery"), send = vi.spyOn(boss, "send").mockRejectedValueOnce(new Error("synthetic publication failure"));
 await expect(recovery.recoverLegacyTasks(true)).rejects.toThrow("synthetic publication failure"); send.mockRestore();
 expect((await boss.getJobById(queue.QUEUES.tts, id))!.state).toBe("created"); expect(await boss.getJobById(queue.taskQueueName(queue.QUEUES.tts), id)).toBeNull();
 await boss.send(queue.taskQueueName(queue.QUEUES.tts), runtime.taskEnvelope(queue.QUEUES.tts, { assetId: `${assetId}-other` }), { id });
 expect((await recovery.recoverLegacyTasks(true)).retained).toBe(1); expect((await boss.getJobById(queue.QUEUES.tts, id))!.state).toBe("created");
});

it("maintenance retains corrected-answer intent when recovering stalled processing", async () => {
 const owner = await (await import("@/lib/auth")).createAccount({ email: "maintenance-runtime@example.test", password: "Synthetic-maintenance-123!", name: "runtime fixture" });
 const [session] = await db.insert(schema.practiceSession).values({ userId: owner.id, mode: "practice", status: "completed", plan: [] }).returning();
 const records = await db.insert(schema.answer).values([false, true].map(corrected => ({ sessionId: session.id, userId: owner.id, questionId: "synthetic-question", questionVersionId: "synthetic-version", planIndex: corrected ? 1 : 0, part: 1, promptText: "synthetic prompt", submissionId: crypto.randomUUID(), status: "queued", feedbackUsesCorrection: corrected, updatedAt: new Date(Date.now() - 16 * 60000) }))).returning();
 expect((await (await import("@/lib/jobs/maintenance")).hourlyMaintenance()).requeued).toBe(2);
 const { rows } = await db.execute(sql`select data from pgboss.job where name=${queue.taskQueueName(queue.QUEUES.processAnswer)}`);
 await runtime.withTaskRuntime(async () => { for (const row of records) { const envelope = rows.find(job => (job.data as { payload: {answerId:string} }).payload.answerId === row.id)!.data; expect(runtime.taskPayload(queue.QUEUES.processAnswer, envelope as never)).toEqual({ answerId: row.id, mode: row.feedbackUsesCorrection ? "correction" : "full" }); } });
});
