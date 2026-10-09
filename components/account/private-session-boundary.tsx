"use client";
import { useEffect, useState } from "react";
import { activateLocalAccount, localIdentity, readLocalIdentity } from "@/lib/client/idb";
import { announcePrivateSession, clearPrivateSession, isSigningOut, PRIVATE_SESSION_SIGNAL, stopPrivateWork } from "@/lib/client/private-session";

/** Confirm identity before showing private recovery data. Old tabs stop immediately on a login change. */
export function PrivateSessionBoundary({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [readyFor, setReadyFor] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true, ending = false, checking = false, queued = false;
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
        if (response.ok && (await response.json()).user.id !== userId) await finish(false);
      } catch { /* Offline use retains this account; mutations still check the IDB login epoch. */ }
      finally { checking = false; if (queued && live && !ending) { queued = false; void verify(); } }
    }
    void (async () => {
      try {
        const response = await fetch("/api/me", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!live || ending) return;
        if (response.status === 401) { await finish(true); return; }
        if (!response.ok) throw new Error("无法确认当前账号");
        if (response.ok && (await response.json()).user.id !== userId) { await finish(false); return; }
        if (!live || ending) return;
        await activateLocalAccount(userId, controller.signal); if (!live || ending) return;
        announcePrivateSession(); setReadyFor(userId);
      } catch { if (live && !ending) setError("暂时无法确认账号或恢复本机资料，请检查连接后重新载入；浏览器限制存储时可使用其他浏览器。"); }
    })();
    const changed = () => {
      if (!live || ending || isSigningOut()) return;
      // A pending network check must not delay a local logout or account-switch notification.
      void (async () => { const scope = localIdentity(), current = await readLocalIdentity();
        if (scope && current && (scope.epoch !== current.epoch || current.userId !== userId)) await finish(false); else await verify();
      })().catch(() => { void verify(); });
    }, visible = () => { if (!document.hidden) changed(); };
    let channel: BroadcastChannel | undefined; try { channel = new BroadcastChannel(PRIVATE_SESSION_SIGNAL); channel.onmessage = changed; } catch { /* use focus and storage events */ }
    const storage = (event: StorageEvent) => { if (event.key === PRIVATE_SESSION_SIGNAL) changed(); };
    const expired = () => { void finish(true); };
    window.addEventListener("storage", storage); window.addEventListener("focus", changed); window.addEventListener("speak-auth-expired", expired);
    document.addEventListener("visibilitychange", visible); const timer = setInterval(changed, 30_000);
    return () => { live = false; controller.abort(); clearInterval(timer); channel?.close(); window.removeEventListener("storage", storage); window.removeEventListener("focus", changed); window.removeEventListener("speak-auth-expired", expired); document.removeEventListener("visibilitychange", visible); };
  }, [userId]);
  return readyFor === userId ? children : <div className="private-session-status" role="status">{error || "正在恢复个人终端…"}{error && <button type="button" onClick={() => location.reload()}>重新载入</button>}</div>;
}
