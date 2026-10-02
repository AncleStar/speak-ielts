import { createHash } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { appSetting } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const WORKER_STALE_MS = 60_000;
export function workerConfigId() {
  const e = env();
  // Fingerprint excludes credentials. A stale worker with old model settings must not count as ready.
  return createHash("sha256").update(JSON.stringify([e.AI_PROVIDER, e.TTS_PROVIDER, e.ASR_MODEL, e.LLM_MODEL, e.TTS_MODEL, e.LOCAL_TTS_VOICE, e.STORAGE_DRIVER, e.LOCAL_APP_INSTANCE])).digest("hex").slice(0,16);
}
export async function getWorkerHealth(now = new Date()) {
  const rows = await db.select({ value: appSetting.value, at: appSetting.updatedAt }).from(appSetting).where(like(appSetting.key, "runtime:worker:%"));
  const matching = rows.filter(r => (r.value as { configId?: string }).configId === workerConfigId()).sort((a,b) => b.at.getTime() - a.at.getTime());
  const at = matching[0]?.at ?? null;
  return { ready: !!at && now.getTime() - at.getTime() < WORKER_STALE_MS, lastHeartbeat: at };
}
export async function startWorkerHeartbeat() {
  const key = `runtime:worker:${process.pid}:${crypto.randomUUID()}`;
  const write = () => db.insert(appSetting).values({ key, value: { configId: workerConfigId() }, updatedAt: new Date() }).onConflictDoUpdate({ target: appSetting.key, set: { value: { configId: workerConfigId() }, updatedAt: new Date() } });
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
