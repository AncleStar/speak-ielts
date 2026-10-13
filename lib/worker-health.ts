import { and, eq, like, sql } from "drizzle-orm";
import { appSetting } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { evaluateWorkerHealth, runtimeConfigId } from "@/lib/worker-runtime";
export { WORKER_STALE_MS } from "@/lib/worker-runtime";

export function workerConfigId() {
  return runtimeConfigId(env());
}
export async function getWorkerHealth(now = new Date()) {
  const rows = await db.select({ value: appSetting.value, at: appSetting.updatedAt }).from(appSetting).where(like(appSetting.key, "runtime:worker:%"));
  return evaluateWorkerHealth(rows, workerConfigId(), now);
}
export async function startWorkerHeartbeat() {
  const key = `runtime:worker:${process.pid}:${crypto.randomUUID()}`;
  const configId = workerConfigId();
  const write = () => db.insert(appSetting).values({ key, value: { configId }, updatedAt: new Date() }).onConflictDoUpdate({ target: appSetting.key, set: { value: { configId }, updatedAt: new Date() } });
  await db.delete(appSetting).where(and(like(appSetting.key, "runtime:worker:%"), sql`${appSetting.updatedAt} < now() - interval '1 day'`));
  await write();
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = (async () => {
      try { await write(); } catch { console.error("[worker] 心跳写入失败，请检查数据库"); } finally { pending = null; }
    })();
  }, 15_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; await db.delete(appSetting).where(eq(appSetting.key, key)); };
}
