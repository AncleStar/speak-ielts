"use client";
import { api, ApiError } from "./api";
import { deletePendingUploadDiscard, isPersistent, listPendingUploadDiscards, localIdentity, LocalConsentEnded, stageRecordingDiscard, type PendingUploadDiscard, type RecordingMeta } from "./idb";
import { PRIVATE_SESSION_EVENT, RECORDING_CONSENT_EVENT } from "./private-session";
import { announceSessionState } from "./session-pause";
export const DISCARD_SYNC_EVENT = "speak-upload-discard-synced";
type Receipt = { discarded: boolean; alreadyStored: boolean; wholePlanActive: boolean };
const pending = new Map<string, Promise<Receipt | null>>();
function current(row: PendingUploadDiscard) {
  const scope = localIdentity(); return scope?.userId === row.userId && scope.epoch === row.epoch && scope.consentAllowed === true && scope.consentVersion === row.consentVersion;
}
async function sync(row: PendingUploadDiscard, signal?: AbortSignal): Promise<Receipt | null> {
  if (!current(row) || !navigator.onLine || signal?.aborted) return null;
  const existing = pending.get(row.eventId); if (existing) return existing;
  const request = (async () => {
    const controller = new AbortController(), stop = () => controller.abort();
    window.addEventListener(PRIVATE_SESSION_EVENT, stop); window.addEventListener(RECORDING_CONSENT_EVENT, stop);
    try {
      let receipt: Receipt;
      try {
        receipt = await api<Receipt>("/api/answers/discard-pending", { body: { sessionId: row.sessionId, submissionId: row.submissionId }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) return null;
        receipt = { discarded: true, alreadyStored: false, wholePlanActive: false };
      }
      if (!current(row) || controller.signal.aborted || signal?.aborted) return null;
      await deletePendingUploadDiscard(row);
      if (!current(row)) return null;
      announceSessionState(); window.dispatchEvent(new Event(DISCARD_SYNC_EVENT)); return receipt;
    } finally { window.removeEventListener(PRIVATE_SESSION_EVENT, stop); window.removeEventListener(RECORDING_CONSENT_EVENT, stop); }
  })().finally(() => pending.delete(row.eventId)); pending.set(row.eventId, request); return request;
}
export async function requestUploadDiscard(meta: RecordingMeta, onStaged?: () => void) {
  const scope = localIdentity();
  if (!scope?.userId || !scope.consentAllowed || meta.userId !== scope.userId || meta.localEpoch !== scope.epoch || meta.consentVersion !== scope.consentVersion) throw new LocalConsentEnded();
  const row: PendingUploadDiscard = { id: `discard:${meta.sessionId}:${meta.id}`, kind: "upload-discard", userId: scope.userId, epoch: scope.epoch, consentVersion: scope.consentVersion!, sessionId: meta.sessionId, submissionId: meta.id, eventId: crypto.randomUUID(), savedAt: Date.now() };
  const durable = await stageRecordingDiscard(row); onStaged?.();
  return { receipt: await sync(row), persistent: durable && await isPersistent() };
}
export async function flushPendingUploadDiscards(signal?: AbortSignal) {
  let synced = 0; for (const row of await listPendingUploadDiscards()) if (await sync(row, signal)) synced++; return synced;
}
