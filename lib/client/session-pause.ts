"use client";
import { api, ApiError } from "./api";
import { deletePendingPause, isPersistent, listPendingPauses, localIdentity, savePendingPause, type PendingSessionPause } from "./idb";
export const SESSION_STATE_SIGNAL = "speak-session-state-change", PAUSE_SYNC_EVENT = "speak-session-pause-synced";
const pending = new Map<string, Promise<boolean>>();
export function announceSessionState() {
  try { const channel = new BroadcastChannel(SESSION_STATE_SIGNAL); channel.postMessage("changed"); channel.close(); } catch { /* storage/focus checks remain */ }
  try { localStorage.setItem(SESSION_STATE_SIGNAL, crypto.randomUUID()); } catch { /* no private values in this signal */ }
}
async function sync(row: PendingSessionPause) {
  const identity = localIdentity(); if (!identity || identity.epoch !== row.epoch || identity.userId !== row.userId || identity.consentVersion !== row.consentVersion || !identity.consentAllowed || !navigator.onLine) return false;
  const existing = pending.get(row.eventId); if (existing) return existing;
  const request = (async () => {
    try {
      await api(`/api/sessions/${encodeURIComponent(row.sessionId)}/events`, { body: { eventId: row.eventId, type: "pause", expectedVersion: row.expectedVersion, startEventId: row.startEventId, pendingUploads: row.pendingUploads }, signal: AbortSignal.timeout(8000) });
    } catch (error) {
      if (!(error instanceof ApiError && (["session_changed", "session_closed", "consent_required"].includes(error.code) || error.status === 404))) return false;
      // A stale queued exit cannot pause a newer activation; drop only this old event.
    }
    await deletePendingPause(row); announceSessionState(); window.dispatchEvent(new CustomEvent(PAUSE_SYNC_EVENT, { detail: { eventId: row.eventId, sessionId: row.sessionId } })); return true;
  })().finally(() => pending.delete(row.eventId)); pending.set(row.eventId, request); return request;
}
export async function requestSessionPause(row: PendingSessionPause) {
  const persistent = await savePendingPause(row); return { synced: await sync(row), persistent: persistent && await isPersistent() };
}
export async function flushPendingPauses() {
  let synced = 0; for (const row of await listPendingPauses()) if (await sync(row)) synced++; return synced;
}
