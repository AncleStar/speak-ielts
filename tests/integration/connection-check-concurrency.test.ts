import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const root = path.resolve(`data/verification/connection-concurrency-${Date.now()}`);
Object.assign(process.env, {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5555/connection_concurrency",
  BETTER_AUTH_SECRET: "connection-concurrency-test-only-secret-000000", USER_API_KEY_SECRET: "",
  BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock",
  STORAGE_DRIVER: "local", DATA_DIR: root, LOCAL_STORAGE_DIR: path.join(root, "storage"),
  ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", DB_POOL_MAX: "1",
});
let database: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, credentials: typeof import("@/lib/ai/credentials");
let account: typeof import("@/lib/ai/account"), locks: typeof import("@/lib/lock");
const owners: string[] = [];
const config = { mode: "personal", asrModel: "qwen3-asr-flash", llmModel: "qwen-plus", monthlyBudgetYuan: 20, consent: true };
const state = globalThis as unknown as { __lockPool: pg.Pool };
beforeAll(async () => {
  database = await (await import("../../scripts/local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5555, dbName: "connection_concurrency", quiet: true });
  await (await import("../../scripts/migrate")).runMigrations();
  ({ db } = await import("@/lib/db")); credentials = await import("@/lib/ai/credentials");
  account = await import("@/lib/ai/account"); locks = await import("@/lib/lock");
  for (let i = 0; i < 7; i++) {
    const u = await (await import("@/lib/auth")).createAccount({ email: `connection-${i}@example.test`, password: "Test-only-12345!", name: "Synthetic connection check" });
    owners.push(u.id); await credentials.saveAiConfig(u.id, { ...config, apiKey: `test_key_connection_owner_${i}` });
  }
}, 120000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await (await import("@/lib/db")).closeDb(); await database?.stop(); }, 30000);
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));

it("four personal checks complete when all lock connections are occupied, with isolated billing and throttling", async () => {
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { keys.push(new Headers(init.headers).get("Authorization")!); return ok(); }));
  // Hold the only business connection until all four requests have taken their admission locks.
  // The previous implementation occupied all four lock clients, then waited forever for four more.
  const hold = await db.$client.connect(), diagnostics = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await diagnostics.connect(); let released = false, complete = false;
  const jobs = owners.slice(0, 4).map(id => account.testPersonalConnection(id));
  const results = Promise.allSettled(jobs); // Attach rejection handlers before any assertion can fail.
  try {
    await expect.poll(async () => {
      const result = await diagnostics.query("select count(*)::int n from pg_locks where locktype='advisory' and granted and database=(select oid from pg_database where datname=current_database())");
      return result.rows[0].n;
    }, { timeout: 5000 }).toBe(12);
    expect(state.__lockPool.totalCount).toBe(4); expect(keys).toEqual([]);
    hold.release(); released = true;
    const outcome = await Promise.race([results, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Personal checks stalled")), 5000))]);
    expect(outcome.every(row => row.status === "fulfilled")).toBe(true); complete = true;
    expect(keys.sort()).toEqual([0, 1, 2, 3].map(i => `Bearer test_key_connection_owner_${i}`).sort());
    for (const id of owners.slice(0, 4)) {
      const report = await account.getAiAccount(id);
      expect(report.rows).toHaveLength(1); expect(report.rows[0]).toMatchObject({ source: "personal", ok: true });
      const { usageEvent } = await import("@/db/schema");
      expect((await db.select().from(usageEvent).where(eq(usageEvent.userId, id)))[0].jobRef).toBe(`connection-check:${id}`);
      expect(report.rows[0].units.pending).toBe(false); expect(report.personalMonthCost).toBeGreaterThan(0);
      await expect(account.testPersonalConnection(id)).rejects.toMatchObject({ code: "check_rate_limit" });
    }
    expect(keys).toHaveLength(4); expect(await (await import("@/lib/usage")).monthCostYuan()).toBe(0);
  } finally {
    if (!released) hold.release();
    if (!complete) {
      // This is an owned isolated database: terminate only the test's lock backends to make a regression fail finitely.
      await diagnostics.query("select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database())").catch(() => {});
      await results;
    }
    await diagnostics.end();
  }
});

it("a settings change waits for its check, while a different user's check remains independent", async () => {
  let release!: () => void, dispatched = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get("Authorization")!; keys.push(key);
    if (key.endsWith("_4")) { dispatched = true; await gate; } return ok();
  }));
  const check = account.testPersonalConnection(owners[4]); let updated = false;
  const diagnostics = new pg.Client({ connectionString: process.env.DATABASE_URL }); await diagnostics.connect();
  let change: Promise<unknown> | undefined;
  try {
    await expect.poll(() => dispatched).toBe(true);
    change = credentials.saveAiConfig(owners[4], { ...config, mode: "platform" }).then(value => { updated = true; return value; });
    await expect.poll(async () => (await diagnostics.query("select count(*)::int n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())")).rows[0].n).toBe(1);
    expect(updated).toBe(false); expect((await credentials.getAiConfig(owners[4]))?.mode).toBe("personal");
    expect((await account.testPersonalConnection(owners[5])).ok).toBe(true);
  } finally { release(); await check; await change; await diagnostics.end(); }
  expect(updated).toBe(true); expect((await credentials.getAiConfig(owners[4]))?.mode).toBe("platform");
  expect(keys.sort()).toEqual([4, 5].map(i => `Bearer test_key_connection_owner_${i}`).sort());
  expect((await account.getAiAccount(owners[4])).rows[0].source).toBe("personal");
  expect(await (await import("@/lib/usage")).monthCostYuan()).toBe(0);
});

it("a zero personal budget rejects the check without dispatch or site fallback", async () => {
  const fetch = vi.fn(async () => ok()); vi.stubGlobal("fetch", fetch);
  await credentials.saveAiConfig(owners[6], { ...config, monthlyBudgetYuan: 0 });
  await expect(account.testPersonalConnection(owners[6])).rejects.toMatchObject({ code: "personal_budget_exceeded" });
  expect(fetch).not.toHaveBeenCalled(); expect((await account.getAiAccount(owners[6])).rows).toEqual([]);
});

it("declared nested locks reuse the connection; undeclared nesting fails and exceptions release admission locks", async () => {
  await locks.withLocks(["test-a", "test-b"], async () => {
    expect(state.__lockPool.totalCount - state.__lockPool.idleCount).toBe(1);
    await locks.withLock("test-b", async () => { expect(state.__lockPool.totalCount - state.__lockPool.idleCount).toBe(1); });
    await expect(locks.withLock("test-c", async () => {})).rejects.toThrow("must be declared together");
  });
  await expect(locks.withLock("test-a", async () => { throw new Error("Synthetic operation failure"); })).rejects.toThrow("Synthetic operation failure");
  await expect(locks.withLock("test-a", async () => "available")).resolves.toBe("available");
  expect(state.__lockPool.waitingCount).toBe(0); expect(state.__lockPool.totalCount - state.__lockPool.idleCount).toBe(0);
});
