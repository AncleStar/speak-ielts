import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { answer, deletionLog, practiceSession, signupInvite, usageEvent, user, userAiConfig } from "@/db/schema";
import { db } from "@/lib/db";
import { dataDir } from "@/lib/env";
import { notFound } from "@/lib/errors";
import { logOps } from "@/lib/ops";
import { QUEUES, enqueue } from "@/lib/queue";
import { revokeAllSessions } from "@/lib/auth";
import { storage } from "@/lib/storage";
import { startOfDayShanghai } from "@/lib/timing";
import { settleQuotaHolds } from "@/lib/quota";
import { walletLock } from "@/lib/services/rewards";

export const DELETION_LOG_FILE = () => path.join(dataDir(), "deletion-log.jsonl");

export interface DeletionEntry {
  id: string;
  kind: "session" | "user";
  targetId: string;
  userId: string | null;
  at: string;
}

/** 删除记录同时追加写入数据库之外的日志文件（恢复旧备份后可重放） */
export async function appendDeletionLog(entry: DeletionEntry) {
  const file = DELETION_LOG_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf8", flush: true });
}

export async function readDeletionLog(): Promise<DeletionEntry[]> {
  try {
    const text = await fs.readFile(DELETION_LOG_FILE(), "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const entry = JSON.parse(l) as DeletionEntry;
        if (!["session", "user"].includes(entry.kind) || !entry.targetId || !Number.isFinite(Date.parse(entry.at))) throw new Error("删除日志损坏，禁止继续恢复");
        return entry;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 删除一次练习：立即撤销访问，后台清理录音、转写和反馈 */
export async function deleteSession(userId: string, sessionId: string, requestedBy: string) {
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
  const rows = await db.select({ key: answer.storageKey }).from(answer).where(eq(answer.sessionId, sessionId));
  const st = storage();
  for (const r of rows) if (r.key) await st.delete(r.key);
  const [s] = await db.select({ userId: practiceSession.userId }).from(practiceSession).where(eq(practiceSession.id, sessionId));
  if (s) await st.deletePrefix(`recordings/${s.userId}/${sessionId}/`).catch(() => 0);
  await db.transaction(async tx => {
    if (s) {
      await walletLock(tx, s.userId);
      await tx.update(practiceSession).set({ status: "abandoned" }).where(and(eq(practiceSession.id, sessionId), eq(practiceSession.status, "active")));
      await settleQuotaHolds(tx, s.userId);
    }
    const [current] = await tx.select({ userId: practiceSession.userId }).from(practiceSession).where(eq(practiceSession.id, sessionId)).for("update");
    if (!current) return;
    const [used] = await tx.select({ seconds: sql<number>`coalesce(sum(coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0)), 0)::float8 / 1000` }).from(answer)
      .where(and(eq(answer.sessionId, sessionId), sql`${answer.createdAt} >= ${startOfDayShanghai()}`));
    if (Number(used.seconds) > 0) await tx.insert(usageEvent).values({ userId: current.userId, service: "deleted-audio-quota", model: "quota-ledger", mock: true, costYuan: 0,
      units: { seconds: Number(used.seconds), day: startOfDayShanghai().toISOString() } });
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
    }
  }
  return { entries: entries.length, sessions, users };
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
  const staleCutoff = new Date(now.getTime() - 24 * 3600_000);
  const stale = await db
    .select({ id: answer.id, key: answer.storageKey })
    .from(answer)
    .where(and(eq(answer.status, "created"), lt(answer.createdAt, staleCutoff)));
  for (const a of stale) {
    if (a.key) await st.delete(a.key);
    await db.delete(answer).where(eq(answer.id, a.id));
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
  const result = { expiredAudio: old.length, staleUploads: stale.length, purgedSessions: deletedSessions.length, purgedUsers: deletedUsers.length };
  await logOps("info", "cleanup", null, `每日清理：${JSON.stringify(result)}`);
  return result;
}
