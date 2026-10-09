"use client";
import { endLocalAccount, invalidateLocalMemory, localIdentity, readLocalIdentity, type LocalIdentity } from "./idb";
import { uploadQueue } from "./uploader";
export const PRIVATE_SESSION_EVENT = "speak-private-session-change";
export const PRIVATE_SESSION_SIGNAL = "speak-private-cache-change";
let signingOut = false;
export function isSigningOut() { return signingOut; }
export function announcePrivateSession() {
  try { const channel = new BroadcastChannel(PRIVATE_SESSION_SIGNAL); channel.postMessage({ changed: true }); channel.close(); } catch { /* storage event and focus check remain */ }
  try { localStorage.setItem(PRIVATE_SESSION_SIGNAL, crypto.randomUUID()); } catch { /* no private values in this signal */ }
}
export function stopPrivateWork() { invalidateLocalMemory(); uploadQueue.cancelAll(); window.dispatchEvent(new Event(PRIVATE_SESSION_EVENT)); }
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
