import { and, eq, isNull } from "drizzle-orm";
import { answer, practiceSession, ttsAsset, user } from "@/db/schema";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getBoss, QUEUES, taskQueueName, type QueueName } from "@/lib/queue";
import { withTaskRuntime, taskEnvelope, taskPayload } from "@/lib/task-runtime";
import { checkedTaskPayload } from "@/lib/task-schema";
import { currentTaskContext } from "@/lib/task-context";
import { providers } from "@/lib/providers";
import { AppError } from "@/lib/errors";

async function eligible(name: QueueName, value: unknown) {
  const payload = checkedTaskPayload(name, value);
  if (name === QUEUES.hourly || name === QUEUES.daily) return null; // New schedules supersede old cron deliveries.
  if ("answerId" in payload) {
    const [row] = await db.select({ status: answer.status, stage: answer.processingStage, updated: answer.updatedAt }).from(answer)
      .innerJoin(practiceSession, eq(practiceSession.id, answer.sessionId)).innerJoin(user, eq(user.id, answer.userId))
      .where(and(eq(answer.id, payload.answerId), isNull(practiceSession.deletedAt), isNull(user.deletedAt)));
    if (!row || row.status !== "queued" && !(row.status === "processing" && +row.updated < Date.now() - 15 * 60000)) return null;
    if (["budget_wait", "consent_wait", "quota_wait"].includes(row.stage ?? "")) return null;
  } else if ("assetId" in payload) {
    if (payload.force) return null;
    const [row] = await db.select().from(ttsAsset).where(eq(ttsAsset.id, payload.assetId));
    const current = providers().ttsIdentity(); if (!row || row.status === "ready" || row.model !== current.model || row.voice !== current.voice) return null;
  } else if ("sessionId" in payload) {
    const [row] = await db.select({ deleted: practiceSession.deletedAt }).from(practiceSession).where(eq(practiceSession.id, payload.sessionId)); if (!row?.deleted) return null;
  } else if ("userId" in payload) {
    const [row] = await db.select({ deleted: user.deletedAt }).from(user).where(eq(user.id, payload.userId)); if (!row?.deleted) return null;
  }
  return payload;
}

/** Operator-approved transfer of known waiting legacy messages, never active/failed/unknown work. */
export async function recoverLegacyTasks(confirmStopped: boolean) {
  if (!confirmStopped) throw new AppError(409, "legacy_review_required", "请先停止旧后台并核对原存储、模型与费用，再明确确认迁移。");
  if (!(await getSettings()).pauseNewSessions) throw new AppError(409, "pause_required", "迁移前请先暂停新会话。");
  return withTaskRuntime(async () => {
    const boss = await getBoss(), client = currentTaskContext()!.client, result = { moved: 0, retained: 0, schedulesStopped: 0 };
    const adapter = { executeSql: async (text: string, values?: unknown[]) => client.query(text, values) };
    const existing = await client.query("SELECT name FROM pgboss.queue WHERE name=ANY($1::text[])", [Object.values(QUEUES)]);
    for (const queue of existing.rows) {
      const name = queue.name as QueueName;
      const waiting = await client.query("SELECT id FROM pgboss.job WHERE name=$1 AND state IN('created','retry') ORDER BY created_on LIMIT 1000", [name]);
      for (const candidate of waiting.rows) {
        await client.query("BEGIN");
        try {
          const lock = await client.query("SELECT id FROM pgboss.job WHERE name=$1 AND id=$2 AND state IN('created','retry') FOR UPDATE SKIP LOCKED", [name, candidate.id]);
          if (!lock.rowCount) { await client.query("ROLLBACK"); continue; }
          const old = await boss.getJobById(name, candidate.id, { db: adapter });
          if (!old || old.blocked || old.blocking || old.pendingDependencies || old.groupId || old.groupTier || old.deadLetter || old.singletonOn || old.keepUntil && +old.keepUntil <= Date.now()) { result.retained++; await client.query("ROLLBACK"); continue; }
          let payload: object | null = null; try { payload = await eligible(name, old.data); } catch { /* unsupported data stays intact */ }
          if (!payload) { result.retained++; await client.query("ROLLBACK"); continue; }
          const destination = taskQueueName(name), previous = await boss.getJobById(destination, old.id, { db: adapter });
          if (previous) {
            let same = false;
            try { same = JSON.stringify(taskPayload(name, previous.data as never)) === JSON.stringify(payload); } catch { /* conflicting target remains for review */ }
            if (!same || ["failed", "cancelled"].includes(previous.state)) { result.retained++; await client.query("ROLLBACK"); continue; }
          }
          if (!previous) {
            const created = await boss.send(destination, taskEnvelope(name, payload), { db: adapter, id: old.id, priority: old.priority, startAfter: old.startAfter, retryLimit: Math.max(0, old.retryLimit - old.retryCount), retryDelay: old.retryDelay, retryBackoff: old.retryBackoff, retryDelayMax: old.retryDelayMax, expireInSeconds: old.expireInSeconds, deleteAfterSeconds: old.deleteAfterSeconds, singletonKey: old.singletonKey ?? undefined, ...(old.heartbeatSeconds && old.heartbeatSeconds >= 10 ? { heartbeatSeconds: old.heartbeatSeconds } : {}) });
            if (!created) throw new Error("目标任务未确认创建，原任务仍保留。");
            // Keep the original age/deadline instead of granting a fresh retention window.
            await client.query("UPDATE pgboss.job SET created_on=$3,keep_until=$4 WHERE name=$1 AND id=$2", [destination, old.id, old.createdOn, old.keepUntil]);
          }
          await boss.cancel(name, old.id, { db: adapter }); await client.query("COMMIT"); result.moved++;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    }
    for (const name of [QUEUES.hourly, QUEUES.daily]) if (existing.rows.some(row => row.name === name)) { await boss.unschedule(name); result.schedulesStopped++; }
    return result;
  });
}
