"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { activateLocalAccount, localIdentity, LocalSessionEnded, readLocalIdentity, type LocalIdentity } from "@/lib/client/idb";
import { announcePrivateSession, clearPrivateSession, isSigningOut, PRIVATE_SESSION_SIGNAL, RECORDING_CONSENT_SIGNAL, stopPrivateWork, stopRecordingWork, syncRecordingConsent } from "@/lib/client/private-session";
import { flushPendingPauses } from "@/lib/client/session-pause";

/** Confirm identity before showing private recovery data. Old tabs stop immediately on a login change. */
export function PrivateSessionBoundary({ userId, children }: { userId: string; children: React.ReactNode }) {
  const router = useRouter();
  const [readyFor, setReadyFor] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true, ending = false, checking = false, queued = false;
    let initialIdentity: LocalIdentity | null | undefined;
    const controller = new AbortController();
    async function finish(revoke: boolean) {
      if (!live || ending) return; ending = true; const captured = localIdentity(); controller.abort(); setReadyFor(null); stopPrivateWork();
      try { if (revoke && captured?.userId === userId) await clearPrivateSession(captured); }
      catch { if (live) setError("浏览器未能清理本机资料，请在浏览器设置中清除本站数据后重新登录。"); return; }
      if (live) window.location.replace("/login?reason=session-ended");
    }
    async function verify() {
      if (!live || ending || isSigningOut()) return;
      if (checking) { queued = true; return; } checking = true;
      try {
        const scope = localIdentity(), current = await readLocalIdentity();
        if (scope && current && (scope.epoch !== current.epoch || current.userId !== userId)) { await finish(false); return; }
        const response = await fetch("/api/me", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (response.status === 401) { await finish(true); return; }
        if (response.ok) { const u = (await response.json()).user; if (u.id !== userId) await finish(false); else if (live && !ending) { await syncRecordingConsent(userId, { allowed: !!u.consentAt, version: u.recordingConsentVersion }); if (await flushPendingPauses() && live && !ending) router.refresh(); } }
      } catch { /* Offline use retains this account; mutations still check the IDB login epoch. */ }
      finally { checking = false; if (queued && live && !ending) { queued = false; void verify(); } }
    }
    void (async () => {
      try {
        initialIdentity = await readLocalIdentity();
        if (!live || ending) return;
        const response = await fetch("/api/me", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!live || ending) return;
        if (response.status === 401) { await finish(true); return; }
        if (!response.ok) throw new Error("无法确认当前账号");
        const u = (await response.json()).user;
        if (u.id !== userId) { await finish(false); return; }
        if (!live || ending) return;
        await activateLocalAccount(userId, controller.signal, { allowed: !!u.consentAt, version: u.recordingConsentVersion }, initialIdentity); if (!live || ending) return;
        if (await flushPendingPauses() && live && !ending) router.refresh(); if (!live || ending) return;
        announcePrivateSession(); setReadyFor(userId);
      } catch (error) { if (error instanceof LocalSessionEnded) { await finish(false); return; } if (live && !ending) setError("暂时无法确认账号或恢复本机资料，请检查连接后重新载入；浏览器限制存储时可使用其他浏览器。"); }
    })();
    const changed = () => {
      if (!live || ending || isSigningOut()) return;
      // A pending network check must not delay a local logout or account-switch notification.
      void (async () => { const scope = localIdentity(), current = await readLocalIdentity();
        if (scope && current && (scope.epoch !== current.epoch || current.userId !== userId)) await finish(false);
        else if (!scope && initialIdentity !== undefined && (initialIdentity ? !current || initialIdentity.epoch !== current.epoch || initialIdentity.userId !== current.userId : current && current.userId !== userId)) await finish(false);
        else { if (current?.userId === userId) await syncRecordingConsent(userId, { allowed: current.consentAllowed === true, version: current.consentVersion ?? 0 }); await verify(); }
      })().catch(() => { void verify(); });
    }, visible = () => { if (!document.hidden) changed(); };
    let channel: BroadcastChannel | undefined; try { channel = new BroadcastChannel(PRIVATE_SESSION_SIGNAL); channel.onmessage = changed; } catch { /* use focus and storage events */ }
    const revoked = () => { if (!live || ending) return; stopRecordingWork(); changed(); };
    let consentChannel: BroadcastChannel | undefined; try { consentChannel = new BroadcastChannel(RECORDING_CONSENT_SIGNAL); consentChannel.onmessage = revoked; } catch { /* use storage and focus */ }
    const storage = (event: StorageEvent) => { if (event.key === RECORDING_CONSENT_SIGNAL) revoked(); else if (event.key === PRIVATE_SESSION_SIGNAL) changed(); };
    const expired = () => { void finish(true); };
    window.addEventListener("storage", storage); window.addEventListener("focus", changed); window.addEventListener("online", changed); window.addEventListener("speak-auth-expired", expired);
    document.addEventListener("visibilitychange", visible); const timer = setInterval(changed, 30_000);
    return () => { live = false; controller.abort(); clearInterval(timer); channel?.close(); consentChannel?.close(); window.removeEventListener("storage", storage); window.removeEventListener("focus", changed); window.removeEventListener("online", changed); window.removeEventListener("speak-auth-expired", expired); document.removeEventListener("visibilitychange", visible); };
  }, [userId, router]);
  return readyFor === userId ? children : <div className="private-session-status" role="status">{error || "正在恢复个人终端…"}{error && <button type="button" onClick={() => location.reload()}>重新载入</button>}</div>;
}
