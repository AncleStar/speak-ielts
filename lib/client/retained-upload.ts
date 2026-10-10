"use client";

import { api, randomId } from "./api";
import { listRecordings, localIdentity, LocalConsentEnded, type RecordingMeta } from "./idb";
import { RECORDING_GUARD } from "./recording-owner";
import { requestSessionPause } from "./session-pause";
import { canResumeSession } from "@/lib/sessions/lifecycle";

/** Explicit retry may prepare an inactive ordinary practice for retained fragments, without opening a mic. */
export async function prepareRetainedUpload(meta: RecordingMeta, signal?: AbortSignal) {
  if (!meta.interrupted || meta.recordingGuard !== RECORDING_GUARD) return false;
  const scope = localIdentity();
  const check = () => { signal?.throwIfAborted(); const current = localIdentity(); if (!scope?.consentAllowed || current?.epoch !== scope.epoch || current.userId !== scope.userId || current.consentVersion !== scope.consentVersion || !current.consentAllowed) throw new LocalConsentEnded(); };
  check();
  const view = await api<{ session: { mode: string; status: string; stateVersion: number; startedAt: string | null; interruptReason: string | null } }>(`/api/sessions/${meta.sessionId}`, { signal });
  check();
  if (view.session.status === "active" || !canResumeSession(view.session)) return false;
  const eventId = randomId("ev");
  // Use the ordinary admission path: quota, budget, consent, capacity and state version all still apply.
  const started = await api<{ status: string; stateVersion: number; activationId: string }>(`/api/sessions/${meta.sessionId}/events`, { signal, body: { type: "start", eventId, expectedVersion: view.session.stateVersion } });
  check();
  if (started.status !== "active" || started.activationId !== eventId) return false;
  const rows = await listRecordings(meta.sessionId);
  const paused = await requestSessionPause({ id: `pause:${meta.sessionId}`, kind: "session-pause", sessionId: meta.sessionId, eventId: randomId("ev"), expectedVersion: started.stateVersion, startEventId: eventId, userId: scope!.userId!, epoch: scope!.epoch, consentVersion: scope!.consentVersion!, savedAt: Date.now(), pendingUploads: rows.map(row => ({ submissionId: row.id, planIndex: row.planIndex, kind: row.kind, followUpId: row.followUpId, consentVersion: row.consentVersion! })) });
  check();
  if (!paused.synced) throw new Error("补传准备尚未确认，已保留暂停任务；预留额度暂未释放。请联网后重试，录音仍在本机。");
  return true;
}
