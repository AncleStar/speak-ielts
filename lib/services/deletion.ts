import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { answer, deletionLog, personalThought, vocabularyEntry, practiceSession, signupInvite, usageEvent, user, userAiConfig } from "@/db/schema";
import { db } from "@/lib/db";
import { dataDir } from "@/lib/env";
import { notFound } from "@/lib/errors";
import { logOps } from "@/lib/ops";
import { QUEUES, enqueue } from "@/lib/queue";
import { revokeAllSessions } from "@/lib/auth";
import { storage } from "@/lib/storage";
import { settleQuotaHolds } from "@/lib/quota";
import { walletLock } from "@/lib/services/rewards";
import { parseDeletionLog, type DeletionEntry } from "@/lib/deletion-log";
import { consumedRecordingMs, PENDING_UPLOAD_TTL_MS } from "@/lib/answer-quota";
import { withLock } from "@/lib/lock";
export type { DeletionEntry } from "@/lib/deletion-log";

export const DELETION_LOG_FILE = () => path.join(dataDir(), "deletion-log.jsonl");

/** 删除记录同时追加写入数据库之外的日志文件（恢复旧备份后可重放） */
export async function appendDeletionLog(entry: DeletionEntry) {
  const file = DELETION_LOG_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf8", flush: true });
}

export async function readDeletionLog(): Promise<DeletionEntry[]> {
  try {
    const text = await fs.readFile(DELETION_LOG_FILE(), "utf8");
    return parseDeletionLog(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 删除一次练习：立即撤销访问，后台清理录音、转写和反馈 */
export async function deleteSession(userId: string, sessionId: string, requestedBy: string) {
  return withLock(`recording-consent:${userId}`, () => deleteSessionLocked(userId, sessionId, requestedBy));
}
async function deleteSessionLocked(userId: string, sessionId: string, requestedBy: string) {
  const [owned] = await db.select({ id: practiceSession.id }).from(practiceSession)
    .where(and(eq(practiceSession.id, sessionId), eq(practiceSession.userId, userId), isNull(practiceSession.deletedAt)));
  if (!owned) throw notFound("会话");
  const intent = { id: crypto.randomUUID(), kind: "session" as const, targetId: sessionId, userId, at: new Date().toISOString() };
  await appendDeletionLog(intent);
  const [s] = await db
    .update(practiceSession)
    .set({ deletedAt: new Date(), status: sql`case when ${practiceSession.status} = 'active' then 'abandoned' else ${practiceSession.status} end` })
    .where(and(eq(practiceSession.id, sessionId), eq(practiceSession.userId, userId), isNull(practiceSession.deletedAt)))
    .returning({ id: practiceSession.id });
  if (!s) throw notFound("会话");
  const [log] = await db
    .insert(deletionLog)
    .values({ id: intent.id, kind: "session", targetId: sessionId, userId, requestedBy })
    .returning({ id: deletionLog.id, createdAt: deletionLog.createdAt });
  await enqueue(QUEUES.cleanupSession, { sessionId, logId: log.id }).catch(async (e) => {
    await logOps("error", "deletion", sessionId, `清理任务排队失败：${(e as Error).message}`);
  });
  return { ok: true };
}

/** 清理会话的存储文件与数据库记录（幂等） */
export async function purgeSession(sessionId: string) {
  const [owner] = await db.select({ userId: practiceSession.userId }).from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (!owner) return;
  return withLock(`recording-consent:${owner.userId}`, () => purgeSessionLocked(sessionId));
}
async function purgeSessionLocked(sessionId: string) {
  const rows = await db.select({ key: answer.storageKey }).from(answer).where(eq(answer.sessionId, sessionId));
  const st = storage();
  for (const r of rows) if (r.key) await st.delete(r.key);
  const [s] = await db.select({ userId: practiceSession.userId }).from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (s) await st.deletePrefix(`recordings/${s.userId}/${sessionId}/`).catch(() => 0);
  await db.transaction(async tx => {
    if (s) {
      await walletLock(tx, s.userId);
      await tx.update(practiceSession).set({ status: "abandoned" }).where(and(eq(practiceSession.id, sessionId), eq(practiceSession.status, "active")));
      // A deleted session cannot receive these declarations. They are not consumed recordings.
      await tx.update(answer).set({ status: "failed", processingStage: "upload_discarded" }).where(and(eq(answer.sessionId, sessionId), isNull(answer.storageKey), isNull(answer.durationMs)));
      await settleQuotaHolds(tx, s.userId);
    }
    const [current] = await tx.select({ userId: practiceSession.userId }).from(practiceSession).where(eq(practiceSession.id, sessionId)).for("update");
    if (!current) return;
    const recordedDay = sql<Date>`date_trunc('day', ${answer.createdAt} at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'`;
    const used = await tx.select({ day: recordedDay, seconds: sql<number>`coalesce(sum(${consumedRecordingMs()}), 0)::float8 / 1000` }).from(answer)
      .where(eq(answer.sessionId, sessionId)).groupBy(recordedDay);
    for (const row of used) if (Number(row.seconds) > 0) await tx.insert(usageEvent).values({ userId: current.userId, service: "deleted-audio-quota", model: "quota-ledger", mock: true, costYuan: 0,
      units: { seconds: Number(row.seconds), day: new Date(row.day).toISOString() } });
    await tx.delete(practiceSession).where(eq(practiceSession.id, sessionId));
  });
  await db
    .update(deletionLog)
    .set({ completedAt: new Date() })
    .where(and(eq(deletionLog.kind, "session"), eq(deletionLog.targetId, sessionId), isNull(deletionLog.completedAt)));
}

/** 删除账号：立即封禁并撤销登录，后台删除全部录音与记录 */
export async function deleteUserAccount(userId: string, requestedBy: string) {
  const [owned] = await db.select({ id: user.id }).from(user).where(and(eq(user.id, userId), isNull(user.deletedAt)));
  if (!owned) throw notFound("账号");
  const intent = { id: crypto.randomUUID(), kind: "user" as const, targetId: userId, userId, at: new Date().toISOString() };
  await appendDeletionLog(intent);
  const [u] = await db
    .update(user)
    .set({ deletedAt: new Date(), banned: true, banReason: "account_deleted" })
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .returning({ id: user.id });
  if (!u) throw notFound("账号");
  await db.delete(userAiConfig).where(eq(userAiConfig.userId, userId));
  await revokeAllSessions(userId);
  await db.update(practiceSession).set({ deletedAt: new Date() }).where(and(eq(practiceSession.userId, userId), isNull(practiceSession.deletedAt)));
  const [log] = await db
    .insert(deletionLog)
    .values({ id: intent.id, kind: "user", targetId: userId, userId, requestedBy })
    .returning({ id: deletionLog.id, createdAt: deletionLog.createdAt });
  await enqueue(QUEUES.cleanupUser, { userId, logId: log.id });
  return { ok: true };
}

export async function purgeUser(userId: string) {
  await storage().deletePrefix(`recordings/${userId}/`);
  await db.transaction(async tx => {
    const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
    await tx.update(signupInvite).set({ email: null, usedBy: null, revokedAt: new Date() })
      .where(or(eq(signupInvite.usedBy, userId), u ? eq(signupInvite.email, u.email) : undefined));
    await tx.delete(user).where(eq(user.id, userId));
  });
  await db
    .update(deletionLog)
    .set({ completedAt: new Date() })
    .where(and(eq(deletionLog.kind, "user"), eq(deletionLog.targetId, userId), isNull(deletionLog.completedAt)));
}

/** 恢复备份后重放删除记录：数据库中仍存在的已删除对象再次清理 */
export async function replayDeletions() {
  const entries = await readDeletionLog();
  let sessions = 0;
  let users = 0;
  let thoughts = 0;
  let vocabulary = 0;
  for (const e of entries) {
    if (e.kind === "session") {
      const [s] = await db.select({ id: practiceSession.id }).from(practiceSession).where(eq(practiceSession.id, e.targetId));
      if (s) {
        await db.update(practiceSession).set({ deletedAt: new Date(e.at) }).where(eq(practiceSession.id, e.targetId));
        await purgeSession(e.targetId);
        sessions++;
      }
    } else if (e.kind === "user") {
      const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, e.targetId));
      if (u) {
        await db.update(user).set({ deletedAt: new Date(e.at), banned: true }).where(eq(user.id, e.targetId));
        await purgeUser(e.targetId);
        users++;
      }
    } else if (e.kind === "thought") {
      const removed = await db.delete(personalThought).where(and(eq(personalThought.id, e.targetId), e.userId ? eq(personalThought.userId, e.userId) : undefined)).returning({ id: personalThought.id });
      thoughts += removed.length;
    } else if (e.kind === "vocabulary") {
      const removed = await db.delete(vocabularyEntry).where(and(eq(vocabularyEntry.id, e.targetId), e.userId ? eq(vocabularyEntry.userId, e.userId) : undefined)).returning({ id: vocabularyEntry.id });
      vocabulary += removed.length;
    }
  }
  return { entries: entries.length, sessions, users, thoughts, vocabulary };
}

/**
 * 每日清理：
 * - 超过 30 天的录音（文本报告保留）；
 * - 超过 24 小时未确认的上传；
 * - 已删除会话 / 账号的残留。
 */
export async function dailyCleanup(now = new Date()) {
  const st = storage();
  const cutoff = new Date(now.getTime() - 30 * 86400_000);
  const old = await db
    .select({ id: answer.id, key: answer.storageKey })
    .from(answer)
    .where(and(isNotNull(answer.storageKey), isNull(answer.audioDeletedAt), lt(answer.createdAt, cutoff)));
  for (const a of old) {
    if (a.key) await st.delete(a.key);
    await db.update(answer).set({ audioDeletedAt: now }).where(eq(answer.id, a.id));
  }
  const staleCutoff = new Date(now.getTime() - PENDING_UPLOAD_TTL_MS);
  const stale = await db
    .select({ id: answer.id, userId: answer.userId })
    .from(answer)
    .where(and(eq(answer.status, "created"), isNull(answer.storageKey), isNull(answer.durationMs), lt(answer.createdAt, staleCutoff)));
  let staleRemoved = 0;
  for (const a of stale) {
    staleRemoved += await withLock(`recording-consent:${a.userId}`, () => db.transaction(async tx => {
      await walletLock(tx, a.userId);
      // Recheck under admission and wallet locks; an upload selected before cleanup may have completed.
      const removed = await tx.delete(answer).where(and(eq(answer.id, a.id), eq(answer.status, "created"), isNull(answer.storageKey), isNull(answer.durationMs), lt(answer.createdAt, staleCutoff))).returning({ id: answer.id });
      if (removed.length) await settleQuotaHolds(tx, a.userId, now);
      return removed.length;
    }));
  }
  const deletedSessions = await db
    .select({ id: practiceSession.id })
    .from(practiceSession)
    .where(and(isNotNull(practiceSession.deletedAt), lt(practiceSession.deletedAt, new Date(now.getTime() - 3600_000))));
  for (const s of deletedSessions) await purgeSession(s.id);
  const deletedUsers = await db
    .select({ id: user.id })
    .from(user)
    .where(and(isNotNull(user.deletedAt), lt(user.deletedAt, new Date(now.getTime() - 3600_000))));
  for (const u of deletedUsers) await purgeUser(u.id);
  const result = { expiredAudio: old.length, staleUploads: staleRemoved, purgedSessions: deletedSessions.length, purgedUsers: deletedUsers.length };
  await logOps("info", "cleanup", null, `每日清理：${JSON.stringify(result)}`);
  return result;
}
