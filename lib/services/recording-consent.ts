import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { answer, practiceSession, user } from "@/db/schema";
import { db } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { withLock, withLocks } from "@/lib/lock";
import { getQuotaStatus } from "@/lib/quota";

export async function recordingConsent(userId: string) {
  const [u] = await db.select({ consentAt: user.consentAt, version: user.recordingConsentVersion, deletedAt: user.deletedAt, banned: user.banned }).from(user).where(eq(user.id, userId));
  return { allowed: !!u?.consentAt && !u.deletedAt && !u.banned, version: u?.version ?? -1 };
}
export async function assertRecordingConsent(userId: string, expectedVersion?: number) {
  const current = await recordingConsent(userId);
  if (!current.allowed || (expectedVersion !== undefined && current.version !== expectedVersion)) throw forbidden("录音授权已撤回或改变。请重新同意后开始新录音；已保存的回答可手动重试处理。", "consent_required");
  return current;
}
/** Admission and withdrawal share a cross-process lock; a returned withdrawal invalidates all older tickets. */
export function withRecordingConsent<T>(userId: string, operation: (version: number) => Promise<T>, admissionKeys: string[] = []) {
  return withLocks([`recording-consent:${userId}`, ...admissionKeys], async () => operation((await assertRecordingConsent(userId)).version));
}
export async function grantRecordingConsent(userId: string, preferences: { targetBand: string; selfLevel: string }) {
  return withLock(`recording-consent:${userId}`, async () => {
    const [row] = await db.update(user).set({ ...preferences, consentAt: sql`coalesce(${user.consentAt}, now())`, recordingConsentVersion: sql`${user.recordingConsentVersion} + case when ${user.consentAt} is null then 1 else 0 end`, onboardedAt: new Date(), updatedAt: new Date() }).where(eq(user.id, userId)).returning();
    return { allowed: !!row.consentAt, version: row.recordingConsentVersion };
  });
}
export async function withdrawRecordingConsent(userId: string) {
  const result = await withLock(`recording-consent:${userId}`, () => db.transaction(async tx => {
    const [row] = await tx.update(user).set({ consentAt: null, recordingConsentVersion: sql`${user.recordingConsentVersion} + case when ${user.consentAt} is not null then 1 else 0 end`, updatedAt: new Date() }).where(eq(user.id, userId)).returning({ version: user.recordingConsentVersion });
    await tx.update(practiceSession).set({ status: sql`case when ${practiceSession.mode} = 'mock' and ${practiceSession.startedAt} is not null then 'interrupted' else 'abandoned' end`, interruptReason: "consent_withdrawn", endedAt: new Date(), stateVersion: sql`${practiceSession.stateVersion} + 1`, pausedUploads: [] }).where(and(eq(practiceSession.userId, userId), inArray(practiceSession.status, ["active", "paused"]), isNull(practiceSession.deletedAt)));
    await tx.update(answer).set({ status: "failed", processingStage: "consent_wait", error: "录音授权已撤回，后续处理已暂停。已保存录音可在重新同意后手动重试；尚未上传的回答需重新录音。", updatedAt: new Date() }).where(and(eq(answer.userId, userId), inArray(answer.status, ["created", "uploaded", "queued"])));
    return { allowed: false, version: row.version };
  }));
  // Release unused practice reservations through the existing wallet settlement, without deleting history.
  await getQuotaStatus(userId);
  return result;
}
