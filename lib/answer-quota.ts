import { sql } from "drizzle-orm";
import { answer } from "@/db/schema";

/** A ticket protects time for the same retention window as local fragments; renewal cannot extend it. */
export const PENDING_UPLOAD_TTL_MS = 24 * 3600_000;
export function consumedRecordingMs() {
  return sql<number>`case when ${answer.storageKey} is not null or ${answer.durationMs} is not null then coalesce(${answer.durationMs}, ${answer.clientDurationMs}, 0) else 0 end`;
}
export function pendingRecordingMs(now = new Date()) {
  return sql<number>`case when ${answer.storageKey} is null and ${answer.durationMs} is null and ${answer.status} = 'created' and ${answer.createdAt} > ${new Date(now.getTime() - PENDING_UPLOAD_TTL_MS)} then coalesce(${answer.clientDurationMs}, 0) else 0 end`;
}
export function accountedRecordingMs(now = new Date()) { return sql<number>`${consumedRecordingMs()} + ${pendingRecordingMs(now)}`; }
