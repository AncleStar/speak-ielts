import type { AnswerKind } from "./plan";

/** Only recordings present at pause may obtain a new ticket after the full-plan hold is released. */
export interface PausedUpload {
  submissionId: string;
  planIndex: number;
  kind: AnswerKind;
  followUpId?: string | null;
  consentVersion: number;
}
export function canResumeSession(s: { status: string; mode: string; startedAt?: unknown; interruptReason?: string | null }) {
  return s.status === "active" || ((s.status === "paused" || s.status === "abandoned" && s.interruptReason === "inactive") && (s.mode !== "mock" || !s.startedAt));
}
