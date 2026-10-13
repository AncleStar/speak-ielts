import path from "node:path";
import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = path.resolve(`data/verification/worker-health-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5556/health", BETTER_AUTH_SECRET: "worker-health-synthetic-secret-0000000", AI_PROVIDER: "mock", TTS_PROVIDER: "kokoro", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"), USER_API_KEY_SECRET: "", DASHSCOPE_API_KEY: "", LOCAL_TTS_SPEED: "0.95", LOCAL_APP_INSTANCE: "health-fixture" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>, db: typeof import("@/lib/db").db, table: typeof import("@/db/schema").appSetting;
let health: typeof import("@/lib/worker-health"), reset: typeof import("@/lib/env").resetEnvCache;
beforeAll(async () => { pg = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5556, dbName: "health", quiet: true }); await (await import("../../scripts/migrate")).runMigrations(); ({ db } = await import("@/lib/db")); table = (await import("@/db/schema")).appSetting; health = await import("@/lib/worker-health"); reset = (await import("@/lib/env")).resetEnvCache; });
afterEach(async () => { await db.delete(table).where(like(table.key, "runtime:worker:%")); process.env.LOCAL_TTS_SPEED = "0.95"; reset(); });
afterAll(async () => { await (await import("@/lib/db")).closeDb(); await pg.stop(); });
it("actual database health refuses an original worker after web speed changes; a new matching worker restores readiness", async () => {
  const stop = await health.startWorkerHeartbeat(); try {
    expect((await health.getWorkerHealth()).ready).toBe(true); process.env.LOCAL_TTS_SPEED = "0.85"; reset(); expect(await health.getWorkerHealth()).toMatchObject({ ready: false, state: "mismatch" });
  } finally { await stop(); }
  const replacement = await health.startWorkerHeartbeat(); try { expect((await health.getWorkerHealth()).ready).toBe(true); } finally { await replacement(); }
});
it("mixed and future heartbeat rows cannot make a real database look ready", async () => {
  const stop = await health.startWorkerHeartbeat(); try {
    await db.insert(table).values({ key: "runtime:worker:wrong", value: { configId: "different-build" } }); expect(await health.getWorkerHealth()).toMatchObject({ ready: false, state: "mixed" });
    await db.delete(table).where(eq(table.key, "runtime:worker:wrong")); await db.insert(table).values({ key: "runtime:worker:future", value: { configId: health.workerConfigId() }, updatedAt: new Date(Date.now() + 3600000) }); expect(await health.getWorkerHealth()).toMatchObject({ ready: false, state: "clock" });
  } finally { await stop(); }
});
it("the actual doctor command is read-only, redacts failures and reports missing schema without migrating it", async () => {
  const p = new (await import("pg")).default.Client({ connectionString: process.env.DATABASE_URL }); await p.connect();
  const run = async (options: Record<string, string> = {}) => {
    try { const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/doctor.ts", "--json"], { cwd: process.cwd(), env: { ...process.env, LOCAL_APP_INSTANCE: "health-fixture", TTS_PROVIDER: "mock", BETTER_AUTH_URL: "http://localhost:3000", ...options }, timeout: 25000, windowsHide: true }); return JSON.parse(result.stdout); }
    catch (e) { const error = e as { stdout?: string }; if (error.stdout) return JSON.parse(error.stdout); throw e; }
  };
  try {
    const before = (await p.query("SELECT count(*)::int AS n FROM app_setting")).rows[0].n;
    const result = await run(); expect(result.readOnly).toBe(true); expect(result.paidCalls).toBe(0); expect(result.checks.find((c: { id: string }) => c.id === "schema").state).toBe("pass"); expect(result.checks.find((c: { id: string }) => c.id === "worker").state).toBe("fail");
    expect((await p.query("SELECT count(*)::int AS n FROM app_setting")).rows[0].n).toBe(before); expect((await p.query("SELECT to_regclass('pgboss.queue') AS present")).rows[0].present).toBeNull();
    await p.query("CREATE DATABASE doctor_empty"); const empty = await run({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5556/doctor_empty" });
    expect(empty.checks.some((c: { id: string; state: string }) => c.id === "schema" && c.state === "fail")).toBe(true);
    const fail = await run({ DATABASE_URL: "postgres://postgres:synthetic-hidden-password@127.0.0.1:1/unavailable" }); expect(fail.status).toBe("blocked"); expect(JSON.stringify(fail)).not.toContain("synthetic-hidden-password");
  } finally { await p.end(); }
}, 60000);
