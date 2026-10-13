import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "@/lib/env";
import { schema } from "@/db/schema";
import { runtimeConfigId, capturedWorkerBuildId } from "@/lib/worker-runtime";
import { taskContext, currentTaskContext, type TaskContext } from "@/lib/task-context";
import { AppError } from "@/lib/errors";
import { assertRecoveryReady } from "@/lib/recovery-state";
import { checkedTaskPayload } from "@/lib/task-schema";

export const TASK_RUNTIME_KEY = "runtime:task-contract:v1", TASK_LOCK = "speak-task-runtime-v1";
const global = globalThis as typeof globalThis & { __taskPool?: pg.Pool };
const pool = () => { if (!global.__taskPool) { global.__taskPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }); global.__taskPool.on("error", () => console.error("[task] 运行连接异常，请检查数据库。")); } return global.__taskPool; };
/** Stable across a coordinated rebuild/restart; change the protocol marker for breaking task schemas. */
export function taskRuntimeId() { return runtimeConfigId({ ...env(), LOCAL_APP_INSTANCE: "" }, "task-protocol-v1"); }
const unavailable = () => new AppError(503, "task_runtime_mismatch", "任务运行环境尚未匹配，请部署者核对网页与后台配置。已保存的录音和费用记录保留。");
async function read(client: pg.PoolClient) { return (await client.query("SELECT value FROM app_setting WHERE key=$1", [TASK_RUNTIME_KEY])).rows[0]?.value as { protocol?: number; id?: string } | undefined; }
export async function taskRuntimeStatus() {
  const client = await pool().connect(); try { const record = await read(client); return { registered: !!record, matches: record?.protocol === 1 && record.id === taskRuntimeId() }; } finally { client.release(); }
}
export async function taskRuntimeRecord() { const client = await pool().connect(); try { return await read(client); } finally { client.release(); } }
/** Initial publication is atomic; an existing deployment is never silently replaced by another configuration. */
export async function ensureTaskRuntime() {
  const parent = currentTaskContext(); if (parent) { if (parent.id !== taskRuntimeId()) throw unavailable(); return; }
  await assertRecoveryReady(); const client = await pool().connect();
  let locked = false, discard = false;
  try {
    const id = taskRuntimeId(), existing = await read(client);
    if (existing) { if (existing.protocol !== 1 || existing.id !== id) throw unavailable(); return; }
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [TASK_LOCK]); locked = true;
    const record = await read(client);
    if (!record) await client.query("INSERT INTO app_setting(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO NOTHING", [TASK_RUNTIME_KEY, JSON.stringify({ protocol: 1, id })]);
    const current = await read(client); if (current?.protocol !== 1 || current.id !== id) throw unavailable();
  } catch (error) { discard = true; throw error; }
  finally { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [TASK_LOCK]).catch(() => { discard = true; }); client.release(discard); }
}
/** Shared session lock spans the job and all its SQL. Activation waits for these readers to finish. */
export async function withTaskRuntime<T>(operation: () => Promise<T>, register = true): Promise<T> {
  const parent = currentTaskContext(); if (parent) { if (parent.id !== taskRuntimeId()) throw unavailable(); return operation(); }
  if (register) await ensureTaskRuntime(); else await assertRecoveryReady();
  const client = await pool().connect(), context: TaskContext = { id: taskRuntimeId(), client, database: null, active: true };
  // Query builders may outlive the callback; guard the actual connection dispatch too.
  const guarded = new Proxy(client, { get(target, property) {
    if (property === "query") return (...args: unknown[]) => {
      if (!context.active) throw new Error("任务运行连接已失效，已停止后续执行。");
      return Reflect.apply(target.query, target, args);
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  context.database = drizzle(guarded, { schema });
  const ended = () => { context.active = false; }; client.on("error", ended); client.on("end", ended); let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [TASK_LOCK]); locked = true;
    const record = await read(client); if (record?.protocol !== 1 || record.id !== context.id) throw unavailable();
    return await taskContext.run(context, operation);
  } finally { let discard = !context.active; context.active = false; if (locked) await client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [TASK_LOCK]).catch(() => { discard = true; }); client.removeListener("error", ended); client.removeListener("end", ended); client.release(discard); }
}
/** Explicit operator handoff. Existing records/jobs are retained; the caller must pause and stop old processes. */
export async function activateTaskRuntime(expectedId: string | null) {
  await assertRecoveryReady(); const client = await pool().connect(); let locked = false, discard = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [TASK_LOCK]); locked = true; await client.query("BEGIN");
    const current = await read(client); if ((current?.id ?? null) !== expectedId) throw new AppError(409, "task_runtime_changed", "运行环境已改变，请重新核对后再切换。");
    const settings = (await client.query("SELECT value FROM app_setting WHERE key='pauseNewSessions'")).rows[0];
    if (settings?.value !== true) throw new AppError(409, "pause_required", "切换任务环境前请先暂停新会话，并停止旧后台。");
    await client.query("INSERT INTO app_setting(key,value,updated_at)VALUES($1,$2,now()) ON CONFLICT(key)DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", [TASK_RUNTIME_KEY, JSON.stringify({ protocol: 1, id: taskRuntimeId() })]);
    await client.query("COMMIT");
  } catch (error) { discard = true; await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [TASK_LOCK]).catch(() => { discard = true; }); client.release(discard); }
}
export async function closeTaskRuntime() { const current = global.__taskPool; global.__taskPool = undefined; await current?.end(); }
export interface TaskEnvelope<T = object> { protocol: 1; runtime: string; sourceBuild: string; queue: string; payload: T }
export function taskEnvelope<T extends object>(queue: string, payload: T): TaskEnvelope<T> { return { protocol: 1, runtime: taskRuntimeId(), sourceBuild: capturedWorkerBuildId, queue, payload }; }
export function taskPayload<T>(queue: string, value: TaskEnvelope<T>): T {
  if (!currentTaskContext()) throw unavailable();
  if (!value || value.protocol !== 1 || value.runtime !== taskRuntimeId() || value.queue !== queue || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new AppError(409, "task_envelope_invalid", "任务来源或协议不匹配，已拒绝执行。原任务保留供核对。");
  return checkedTaskPayload(queue, value.payload) as T;
}
