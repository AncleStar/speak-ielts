"use client";
import { endLocalAccount, invalidateLocalMemory, localIdentity, readLocalIdentity, syncLocalRecordingConsent, type LocalIdentity, type RecordingConsentState } from "./idb";
import { uploadQueue } from "./uploader";
export const PRIVATE_SESSION_EVENT = "speak-private-session-change";
export const PRIVATE_SESSION_SIGNAL = "speak-private-cache-change";
export const RECORDING_CONSENT_EVENT = "speak-recording-consent-change";
export const RECORDING_CONSENT_SIGNAL = "speak-recording-consent-revoked";
let signingOut = false;
export function isSigningOut() { return signingOut; }
export function announcePrivateSession() {
  try { const channel = new BroadcastChannel(PRIVATE_SESSION_SIGNAL); channel.postMessage({ changed: true }); channel.close(); } catch { /* storage event and focus check remain */ }
  try { localStorage.setItem(PRIVATE_SESSION_SIGNAL, crypto.randomUUID()); } catch { /* no private values in this signal */ }
}
export function stopPrivateWork() { invalidateLocalMemory(); uploadQueue.cancelAll(); window.dispatchEvent(new Event(PRIVATE_SESSION_EVENT)); }
export function stopRecordingWork(allowed = false) { uploadQueue.cancelAll(); window.dispatchEvent(new CustomEvent(RECORDING_CONSENT_EVENT, { detail: { allowed } })); }
export async function syncRecordingConsent(userId: string, consent: RecordingConsentState) {
  const before = localIdentity(), current = await syncLocalRecordingConsent(userId, consent);
  if (before?.userId === userId && current?.userId === userId && (before.consentAllowed !== current.consentAllowed || before.consentVersion !== current.consentVersion)) stopRecordingWork(current.consentAllowed === true);
  return current;
}
/** Contains no account, recording, transcript or credential data. Stop first even if IDB/network is unavailable. */
export function announceConsentWithdrawal() {
  try { const channel = new BroadcastChannel(RECORDING_CONSENT_SIGNAL); channel.postMessage("revoked"); channel.close(); } catch { /* focus, storage and server admission still apply */ }
  try { localStorage.setItem(RECORDING_CONSENT_SIGNAL, crypto.randomUUID()); } catch { /* storage may be disabled */ }
  announcePrivateSession();
}
export async function clearPrivateSession(captured?: LocalIdentity | null) {
  const expected = captured === undefined ? localIdentity() ?? await readLocalIdentity() : captured;
  stopPrivateWork();
  try { await endLocalAccount(expected); } finally { announcePrivateSession(); }
}
export async function signOutPrivateSession() {
  const expected = localIdentity() ?? await readLocalIdentity(), current = await readLocalIdentity();
  if (expected && current && expected.epoch !== current.epoch) throw new Error("账号已切换，请刷新后操作。");
  signingOut = true; stopPrivateWork();
  try {
    const response = await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("退出登录请求失败");
    let cleaned = true; try { await endLocalAccount(expected); } catch { cleaned = false; }
    announcePrivateSession(); window.location.replace(cleaned ? "/login" : "/login?localCleanup=failed");
  } finally { signingOut = false; }
}
